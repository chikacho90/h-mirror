import { useEffect, useMemo, useState } from 'react'
import {
  assignPendingClusterToName, deleteEmployee, deletePendingByIds,
  listEmployees, listPendingCapturesWithEmbedding, updateEmployeeName,
  type Employee, type PendingCaptureWithEmbedding,
} from './lib/supabase'

type PersonGroup = { name: string; items: Employee[] }
const CLUSTER_DIST_THRESHOLD = 0.5  // 같은 사람으로 묶을 임베딩 거리 한계

export function AdminView() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [pending, setPending] = useState<PendingCaptureWithEmbedding[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  useEffect(() => { refresh() }, [])

  async function refresh() {
    setLoading(true)
    try {
      const [list, pend] = await Promise.all([listEmployees(), listPendingCapturesWithEmbedding()])
      setEmployees(list)
      setPending(pend)
    } catch (e) {
      setMessage({ text: `Load failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    } finally {
      setLoading(false)
    }
  }

  const grouped = useMemo<PersonGroup[]>(() => {
    const map = new Map<string, Employee[]>()
    for (const e of employees) {
      const list = map.get(e.name) || []
      list.push(e)
      map.set(e.name, list)
    }
    return Array.from(map.entries())
      .map(([name, items]) => ({
        name,
        items: items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
      }))
      .filter((g) => !filter.trim() || g.name.includes(filter.trim()))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [employees, filter])

  const allNames = useMemo(() => Array.from(new Set(employees.map((e) => e.name))).sort(), [employees])

  const pendingClusters = useMemo(() => clusterByEmbedding(pending, CLUSTER_DIST_THRESHOLD), [pending])

  async function handleAssignCluster(cluster: PendingCaptureWithEmbedding[], name: string) {
    if (!name.trim() || cluster.length === 0) return
    try {
      await assignPendingClusterToName({
        ids: cluster.map((c) => c.id),
        embeddings: cluster.map((c) => c.embedding),
        image_datas: cluster.map((c) => c.image_data),
        name: name.trim(),
      })
      setMessage({ text: `${cluster.length}장을 "${name.trim()}"의 사진으로 추가`, ok: true })
      await refresh()
    } catch (e) {
      setMessage({ text: `Assign failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    }
  }

  async function handleDeleteCluster(cluster: PendingCaptureWithEmbedding[]) {
    if (!confirm(`이 그룹 ${cluster.length}장을 삭제할까요?`)) return
    try {
      await deletePendingByIds(cluster.map((c) => c.id))
      await refresh()
    } catch (e) {
      setMessage({ text: `Delete failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    }
  }

  async function handleReassign(rowId: string, newName: string) {
    if (!newName.trim()) return
    try {
      await updateEmployeeName(rowId, newName.trim())
      setMessage({ text: `Reassigned to "${newName.trim()}"`, ok: true })
      setEditingId(null)
      await refresh()
    } catch (e) {
      setMessage({ text: `Reassign failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    }
  }

  async function handleDelete(rowId: string) {
    if (!confirm('Delete this photo?')) return
    try {
      await deleteEmployee(rowId)
      await refresh()
    } catch (e) {
      setMessage({ text: `Delete failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    }
  }

  async function handleDeleteWholePerson(name: string, items: Employee[]) {
    if (!confirm(`"${name}" 전부 삭제 (${items.length}장)? 되돌릴 수 없음.`)) return
    try {
      for (const it of items) await deleteEmployee(it.id)
      await refresh()
    } catch (e) {
      setMessage({ text: `Delete failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    }
  }

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>h-mirror · Admin</h1>
        <a href="#" style={linkStyle}>← Live recognition</a>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14 }}>
            {employees.length} embeddings · {grouped.length} people
          </span>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search name…"
            style={searchStyle}
          />
          <button type="button" onClick={refresh} style={refreshBtnStyle}>↻ Refresh</button>
        </div>
      </div>

      {message && (
        <div style={{ ...cardStyle, color: message.ok ? '#7ee' : '#f77' }}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div style={cardStyle}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1080, margin: '0 auto' }}>
          {pendingClusters.length > 0 && (
            <section style={personCardStyle}>
              <div style={personHeaderStyle}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>🆕 새 얼굴 후보</div>
                  <div style={mutedStyle}>
                    {pending.length}장 · {pendingClusters.length}그룹 (유사도로 자동 묶임)
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {pendingClusters.map((cluster, idx) => (
                  <ClusterCard
                    key={cluster[0].id}
                    cluster={cluster}
                    index={idx}
                    allNames={allNames}
                    onAssign={(name) => handleAssignCluster(cluster, name)}
                    onDelete={() => handleDeleteCluster(cluster)}
                  />
                ))}
              </div>
            </section>
          )}
          {grouped.map((g) => (
            <section key={g.name} style={personCardStyle}>
              <div style={personHeaderStyle}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{g.name}</div>
                  <div style={mutedStyle}>{g.items.length}장 등록됨</div>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteWholePerson(g.name, g.items)}
                  style={dangerBtnStyle}
                >
                  Delete person
                </button>
              </div>
              <div style={photoGridStyle}>
                {g.items.map((item) => (
                  <PhotoCard
                    key={item.id}
                    item={item}
                    allNames={allNames}
                    isEditing={editingId === item.id}
                    draftName={draftName}
                    onStartEdit={() => { setEditingId(item.id); setDraftName(item.name) }}
                    onCancelEdit={() => setEditingId(null)}
                    onChangeDraft={setDraftName}
                    onConfirmReassign={() => handleReassign(item.id, draftName)}
                    onDelete={() => handleDelete(item.id)}
                  />
                ))}
              </div>
            </section>
          ))}
          {grouped.length === 0 && (
            <div style={cardStyle}>No people enrolled.</div>
          )}
        </div>
      )}
    </div>
  )
}

function PhotoCard(props: {
  item: Employee
  allNames: string[]
  isEditing: boolean
  draftName: string
  onStartEdit: () => void
  onCancelEdit: () => void
  onChangeDraft: (v: string) => void
  onConfirmReassign: () => void
  onDelete: () => void
}) {
  const { item, allNames, isEditing, draftName, onStartEdit, onCancelEdit, onChangeDraft, onConfirmReassign, onDelete } = props
  const listId = `names-${item.id}`
  return (
    <div style={photoCardStyle}>
      <div style={photoThumbWrapStyle}>
        {item.image_data ? (
          <img src={item.image_data} alt="" style={photoImgStyle} />
        ) : (
          <div style={photoPlaceholderStyle}>
            <span style={{ opacity: 0.5, fontSize: 12 }}>no image</span>
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6, wordBreak: 'break-all' }}>
        {item.notes || ''}
      </div>
      {isEditing ? (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <input
            type="text"
            list={listId}
            value={draftName}
            onChange={(e) => onChangeDraft(e.target.value)}
            placeholder="Move to person…"
            style={inputStyle}
            autoFocus
          />
          <datalist id={listId}>
            {allNames.map((n) => <option key={n} value={n} />)}
          </datalist>
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" onClick={onConfirmReassign} style={confirmBtnStyle}>Save</button>
            <button type="button" onClick={onCancelEdit} style={cancelMicroBtnStyle}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
          <button type="button" onClick={onStartEdit} style={editBtnStyle}>Move</button>
          <button type="button" onClick={onDelete} style={deleteMicroBtnStyle}>Delete</button>
        </div>
      )}
    </div>
  )
}

// 단일-링크 클러스터링: Euclidean distance < threshold면 같은 사람으로 묶음
function clusterByEmbedding(
  items: PendingCaptureWithEmbedding[],
  threshold: number,
): PendingCaptureWithEmbedding[][] {
  const n = items.length
  if (n === 0) return []
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r]
    while (parent[i] !== r) { const p = parent[i]; parent[i] = r; i = p }
    return r
  }
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ea = items[i].embedding, eb = items[j].embedding
      let s = 0
      for (let k = 0; k < ea.length; k++) { const d = ea[k] - eb[k]; s += d * d }
      if (Math.sqrt(s) <= threshold) union(i, j)
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const arr = groups.get(r) || []
    arr.push(i)
    groups.set(r, arr)
  }
  return Array.from(groups.values())
    .sort((a, b) => b.length - a.length)
    .map((arr) => arr.map((idx) => items[idx]))
}

function ClusterCard(props: {
  cluster: PendingCaptureWithEmbedding[]
  index: number
  allNames: string[]
  onAssign: (name: string) => void
  onDelete: () => void
}) {
  const { cluster, index, allNames, onAssign, onDelete } = props
  const [mode, setMode] = useState<'closed' | 'assign'>('closed')
  const [draft, setDraft] = useState('')

  // 클러스터의 자동 태그 힌트 — 가장 자주 나온 auto_top_name
  const hint = useMemo(() => {
    const tally = new Map<string, number>()
    for (const c of cluster) {
      if (c.auto_top_name) tally.set(c.auto_top_name, (tally.get(c.auto_top_name) || 0) + 1)
    }
    if (tally.size === 0) return null
    return Array.from(tally.entries()).sort((a, b) => b[1] - a[1])[0][0]
  }, [cluster])

  const listId = `cluster-names-${index}`

  return (
    <div style={clusterCardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          그룹 #{index + 1} · {cluster.length}장 {hint && <span style={mutedStyle}>(추정: {hint})</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {mode === 'closed' ? (
            <>
              {hint && (
                <button type="button" onClick={() => onAssign(hint)} style={hintBtnStyle}>
                  ✓ {hint}에 추가
                </button>
              )}
              <button type="button" onClick={() => { setMode('assign'); setDraft('') }} style={editBtnStyle}>
                ✎ 다른 사람
              </button>
              <button type="button" onClick={onDelete} style={deleteMicroBtnStyle}>삭제</button>
            </>
          ) : (
            <>
              <input
                type="text"
                autoFocus
                list={listId}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="이름 (기존/신규)"
                style={inlineInputStyle}
                onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) onAssign(draft) }}
              />
              <datalist id={listId}>
                {allNames.map((n) => <option key={n} value={n} />)}
              </datalist>
              <button type="button" onClick={() => onAssign(draft)} disabled={!draft.trim()} style={confirmBtnStyle}>저장</button>
              <button type="button" onClick={() => setMode('closed')} style={cancelMicroBtnStyle}>취소</button>
            </>
          )}
        </div>
      </div>
      <div style={clusterThumbsStyle}>
        {cluster.slice(0, 20).map((c) => (
          <img key={c.id} src={c.image_data} alt="" style={clusterThumbStyle} />
        ))}
        {cluster.length > 20 && (
          <div style={{ ...mutedStyle, alignSelf: 'center' }}>+{cluster.length - 20}</div>
        )}
      </div>
    </div>
  )
}

const clusterCardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,200,80,0.3)',
  borderRadius: 8, padding: 12,
}
const clusterThumbsStyle: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 4,
}
const clusterThumbStyle: React.CSSProperties = {
  width: 64, height: 64, objectFit: 'cover', borderRadius: 4, background: '#000',
}
const hintBtnStyle: React.CSSProperties = {
  background: 'rgba(126,238,238,0.18)', border: '1px solid rgba(126,238,238,0.7)',
  color: '#fff', padding: '4px 10px', borderRadius: 5, fontSize: 12, cursor: 'pointer',
}
const inlineInputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '4px 8px', borderRadius: 4, fontSize: 12, outline: 'none',
  minWidth: 140,
}

const pageStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: '#0b0d10', color: '#e8e8e8',
  overflow: 'auto', padding: '24px 16px',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
}
const headerStyle: React.CSSProperties = {
  maxWidth: 1080, margin: '0 auto 16px',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const titleStyle: React.CSSProperties = { fontSize: 22, fontWeight: 700, margin: 0 }
const linkStyle: React.CSSProperties = { color: '#7ee', textDecoration: 'none', fontSize: 14 }
const cardStyle: React.CSSProperties = {
  maxWidth: 1080, margin: '0 auto 16px',
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 10, padding: 16,
}
const personCardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 10, padding: 16,
}
const personHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
  gap: 12, marginBottom: 12,
}
const photoGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10,
}
const photoCardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 8, padding: 8,
}
const photoThumbWrapStyle: React.CSSProperties = {
  width: '100%', aspectRatio: '1 / 1', overflow: 'hidden', borderRadius: 6,
  background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const photoImgStyle: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' }
const photoPlaceholderStyle: React.CSSProperties = {
  width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const mutedStyle: React.CSSProperties = { opacity: 0.6, fontSize: 12 }
const searchStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '6px 10px', borderRadius: 5, fontSize: 13, outline: 'none', minWidth: 180,
}
const refreshBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '6px 10px', borderRadius: 5, fontSize: 13, cursor: 'pointer',
}
const dangerBtnStyle: React.CSSProperties = {
  background: 'rgba(255,80,80,0.15)', border: '1px solid rgba(255,80,80,0.5)',
  color: '#f77', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '4px 8px', borderRadius: 4, fontSize: 12, outline: 'none',
}
const editBtnStyle: React.CSSProperties = {
  background: 'rgba(126,238,238,0.15)', border: '1px solid rgba(126,238,238,0.5)',
  color: '#fff', padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11, flex: 1,
}
const deleteMicroBtnStyle: React.CSSProperties = {
  background: 'rgba(255,80,80,0.12)', border: '1px solid rgba(255,80,80,0.4)',
  color: '#f77', padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
}
const confirmBtnStyle: React.CSSProperties = {
  background: 'rgba(126,238,238,0.2)', border: '1px solid rgba(126,238,238,0.7)',
  color: '#fff', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11, flex: 1,
}
const cancelMicroBtnStyle: React.CSSProperties = {
  background: 'transparent', border: '1px solid rgba(255,255,255,0.25)',
  color: '#bbb', padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
}
