import { useEffect, useMemo, useState } from 'react'
import {
  confirmPendingCapture,
  getPendingCaptureEmbedding,
  listEmployeeNames,
  listPendingCaptures,
  rejectPendingCapture,
  type PendingCapture,
} from './lib/supabase'

type AssignmentMode = 'auto' | 'pick' | 'new' | 'reject'

type DraftAssignment = {
  mode: AssignmentMode
  name: string  // mode === 'pick' | 'new' | 'auto'(읽기전용 = auto_top_name)
}

export function ReviewModal(props: { onClose: () => void; onChange?: () => void }) {
  const { onClose, onChange } = props
  const [list, setList] = useState<PendingCapture[]>([])
  const [allNames, setAllNames] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, DraftAssignment>>({})
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)

  useEffect(() => { refresh() }, [])

  async function refresh() {
    setLoading(true)
    try {
      const [items, names] = await Promise.all([listPendingCaptures(200), listEmployeeNames()])
      setList(items)
      setAllNames(names)
      const init: Record<string, DraftAssignment> = {}
      for (const it of items) {
        if (it.auto_top_name) init[it.id] = { mode: 'auto', name: it.auto_top_name }
        else init[it.id] = { mode: 'new', name: '' }
      }
      setDrafts(init)
    } catch (e) {
      alert(`Load failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  // 자동 태그별 그룹화 — iOS People 비슷한 느낌
  const groups = useMemo(() => {
    const map = new Map<string, PendingCapture[]>()
    for (const it of list) {
      const key = it.auto_top_name ?? '__unknown__'
      const arr = map.get(key) || []
      arr.push(it)
      map.set(key, arr)
    }
    return Array.from(map.entries())
      .map(([key, items]) => ({ key, items }))
      .sort((a, b) => {
        if (a.key === '__unknown__') return 1
        if (b.key === '__unknown__') return -1
        return a.key.localeCompare(b.key)
      })
  }, [list])

  function setDraft(id: string, patch: Partial<DraftAssignment>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  async function handleApply(item: PendingCapture) {
    const draft = drafts[item.id]
    if (!draft) return
    setSavingId(item.id)
    try {
      if (draft.mode === 'reject') {
        await rejectPendingCapture(item.id)
      } else {
        const name = draft.name.trim()
        if (!name) { alert('Name required'); return }
        const embedding = await getPendingCaptureEmbedding(item.id)
        await confirmPendingCapture({
          id: item.id, embedding, name, image_data: item.image_data,
        })
      }
      setList((prev) => prev.filter((p) => p.id !== item.id))
      onChange?.()
    } catch (e) {
      alert(`Apply failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={contentStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Help improve recognition</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" onClick={refresh} style={refreshBtnStyle}>↻ Refresh</button>
            <button type="button" onClick={onClose} style={closeBtnStyle}>✕</button>
          </div>
        </div>
        <div style={{ ...mutedStyle, marginBottom: 12 }}>
          자동으로 캡쳐된 얼굴들을 확인하세요. 자동 분류가 맞으면 ✓ Confirm, 다른 사람이면 Move 또는 New로 바꿔주세요.
        </div>

        {loading ? (
          <div>Loading…</div>
        ) : list.length === 0 ? (
          <div style={mutedStyle}>대기 중인 캡쳐가 없습니다.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {groups.map((g) => (
              <div key={g.key}>
                <div style={groupHeaderStyle}>
                  {g.key === '__unknown__' ? 'Unknown' : g.key} <span style={mutedStyle}>({g.items.length})</span>
                </div>
                <div style={gridStyle}>
                  {g.items.map((item) => (
                    <ReviewCard
                      key={item.id}
                      item={item}
                      allNames={allNames}
                      draft={drafts[item.id] ?? { mode: 'new', name: '' }}
                      onChangeDraft={(patch) => setDraft(item.id, patch)}
                      onApply={() => handleApply(item)}
                      saving={savingId === item.id}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ReviewCard(props: {
  item: PendingCapture
  allNames: string[]
  draft: DraftAssignment
  onChangeDraft: (patch: Partial<DraftAssignment>) => void
  onApply: () => void
  saving: boolean
}) {
  const { item, allNames, draft, onChangeDraft, onApply, saving } = props
  const listId = `names-${item.id}`
  const sim = item.auto_top_similarity != null ? (item.auto_top_similarity * 100).toFixed(0) : null
  return (
    <div style={cardStyle}>
      <div style={thumbWrapStyle}>
        <img src={item.image_data} alt="" style={imgStyle} />
      </div>
      <div style={{ ...mutedStyle, marginTop: 6 }}>
        {item.auto_top_name
          ? <>Auto: {item.auto_top_name}{sim ? ` (${sim}%)` : ''}</>
          : <>No match</>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
        {item.auto_top_name && (
          <label style={radioRowStyle}>
            <input type="radio" checked={draft.mode === 'auto'} onChange={() => onChangeDraft({ mode: 'auto', name: item.auto_top_name! })} />
            ✓ Confirm as {item.auto_top_name}
          </label>
        )}
        <label style={radioRowStyle}>
          <input type="radio" checked={draft.mode === 'pick'} onChange={() => onChangeDraft({ mode: 'pick', name: '' })} />
          Move to existing
        </label>
        <label style={radioRowStyle}>
          <input type="radio" checked={draft.mode === 'new'} onChange={() => onChangeDraft({ mode: 'new', name: '' })} />
          + New person
        </label>
        <label style={radioRowStyle}>
          <input type="radio" checked={draft.mode === 'reject'} onChange={() => onChangeDraft({ mode: 'reject', name: '' })} />
          ✕ Reject (delete)
        </label>
      </div>

      {(draft.mode === 'pick' || draft.mode === 'new') && (
        <>
          <input
            type="text"
            list={draft.mode === 'pick' ? listId : undefined}
            value={draft.name}
            onChange={(e) => onChangeDraft({ name: e.target.value })}
            placeholder={draft.mode === 'pick' ? 'Existing name' : 'New name'}
            style={inputStyle}
          />
          <datalist id={listId}>
            {allNames.map((n) => <option key={n} value={n} />)}
          </datalist>
        </>
      )}

      <button
        type="button"
        onClick={onApply}
        disabled={saving || (draft.mode !== 'auto' && draft.mode !== 'reject' && !draft.name.trim())}
        style={applyBtnStyle(draft.mode)}
      >
        {saving ? 'Saving…' : 'Apply'}
      </button>
    </div>
  )
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 20, overflow: 'auto',
}
const contentStyle: React.CSSProperties = {
  background: '#13161a', color: '#e8e8e8',
  borderRadius: 12, padding: 20, maxWidth: 980, width: '100%',
  border: '1px solid rgba(255,255,255,0.1)',
  maxHeight: 'calc(100vh - 40px)', overflow: 'auto',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
}
const groupHeaderStyle: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, marginBottom: 6, opacity: 0.9,
}
const gridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12,
}
const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8, padding: 10,
}
const thumbWrapStyle: React.CSSProperties = {
  width: '100%', aspectRatio: '1 / 1', overflow: 'hidden', borderRadius: 6,
  background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const imgStyle: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' }
const mutedStyle: React.CSSProperties = { opacity: 0.65, fontSize: 12 }
const radioRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer',
}
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '4px 8px', borderRadius: 4, fontSize: 12, outline: 'none',
  marginTop: 4,
}
const applyBtnStyle = (mode: AssignmentMode): React.CSSProperties => ({
  marginTop: 8,
  background: mode === 'reject' ? 'rgba(255,80,80,0.15)' : 'rgba(126,238,238,0.18)',
  border: `1px solid ${mode === 'reject' ? 'rgba(255,80,80,0.5)' : 'rgba(126,238,238,0.7)'}`,
  color: '#fff', padding: '6px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 13,
  width: '100%',
})
const refreshBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '4px 10px', borderRadius: 5, fontSize: 12, cursor: 'pointer',
}
const closeBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#aaa',
  cursor: 'pointer', fontSize: 20, padding: 4,
}
