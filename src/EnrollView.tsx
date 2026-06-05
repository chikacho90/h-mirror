import { useEffect, useRef, useState } from 'react'
import { extractSingleEmbedding, loadFaceModels } from './lib/faceApi'
import { deleteEmployee, insertEmployee, listEmployees, type Employee } from './lib/supabase'

export function EnrollView() {
  const [name, setName] = useState('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadFaceModels().then(() => setLoadingModels(false)).catch((e) => {
      setMessage({ text: `Model load failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    })
    refreshList()
  }, [])

  async function refreshList() {
    try {
      const list = await listEmployees()
      setEmployees(list)
    } catch (e) {
      setMessage({ text: `Load employees failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    }
  }

  async function handleFile(file: File) {
    if (!name.trim()) {
      setMessage({ text: 'Enter a name first.', ok: false })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const url = URL.createObjectURL(file)
      setPreviewUrl(url)
      const img = await loadImage(url)
      const result = await extractSingleEmbedding(img)
      if (!result) {
        setMessage({ text: 'No face detected in the photo. Use a clear, frontal photo.', ok: false })
        return
      }
      await insertEmployee(name.trim(), Array.from(result.descriptor))
      setMessage({ text: `Enrolled "${name.trim()}"`, ok: true })
      setName('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      await refreshList()
    } catch (e) {
      setMessage({ text: `Enroll failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"?`)) return
    try {
      await deleteEmployee(id)
      await refreshList()
    } catch (e) {
      setMessage({ text: `Delete failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    }
  }

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>h-mirror — Enroll</h1>
        <a href="#" style={linkStyle}>← Back to recognition</a>
      </div>

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Add a person</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g., 홍길동)"
            style={inputStyle}
            disabled={busy}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFile(file)
            }}
            disabled={busy || loadingModels}
            style={inputStyle}
          />
          {loadingModels && <div style={mutedStyle}>Loading face models…</div>}
          {busy && <div style={mutedStyle}>Processing…</div>}
          {previewUrl && (
            <div style={{ marginTop: 8 }}>
              <img src={previewUrl} alt="preview" style={previewStyle} />
            </div>
          )}
          {message && (
            <div style={{ ...messageStyle, color: message.ok ? '#7ee' : '#f77' }}>
              {message.text}
            </div>
          )}
        </div>
      </section>

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Enrolled ({employees.length})</h2>
        {employees.length === 0 ? (
          <div style={mutedStyle}>No one enrolled yet.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {employees.map((e) => (
              <li key={e.id} style={rowStyle}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{e.name}</div>
                  <div style={mutedStyle}>{new Date(e.created_at).toLocaleString()}</div>
                </div>
                <button type="button" onClick={() => handleDelete(e.id, e.name)} style={deleteBtnStyle}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p style={mutedStyle}>
        Tip: 정면, 균일한 조명, 얼굴이 사진의 30% 이상인 사진을 사용하세요. 한 사람당 1장이면 충분하지만, 3-5장을 등록하면 인식률이 더 좋아집니다 (이름은 동일하게).
      </p>
    </div>
  )
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(e)
    img.src = url
  })
}

const pageStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: '#0b0d10', color: '#e8e8e8',
  overflow: 'auto', padding: '24px 16px',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
}
const headerStyle: React.CSSProperties = {
  maxWidth: 720, margin: '0 auto 16px',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const titleStyle: React.CSSProperties = { fontSize: 22, fontWeight: 700, margin: 0 }
const linkStyle: React.CSSProperties = { color: '#7ee', textDecoration: 'none', fontSize: 14 }
const cardStyle: React.CSSProperties = {
  maxWidth: 720, margin: '0 auto 16px',
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 10, padding: 16,
}
const sectionTitleStyle: React.CSSProperties = { fontSize: 16, margin: '0 0 12px 0', opacity: 0.85 }
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.2)',
  color: '#fff', padding: '10px 12px', borderRadius: 6, fontSize: 14, outline: 'none',
}
const mutedStyle: React.CSSProperties = { opacity: 0.6, fontSize: 13 }
const messageStyle: React.CSSProperties = { fontSize: 13, marginTop: 4 }
const previewStyle: React.CSSProperties = { maxWidth: 180, maxHeight: 180, borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)' }
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '8px 10px', background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
}
const deleteBtnStyle: React.CSSProperties = {
  background: 'rgba(255,80,80,0.15)', border: '1px solid rgba(255,80,80,0.5)',
  color: '#f77', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}
