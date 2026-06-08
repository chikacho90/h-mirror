import { useEffect, useRef, useState } from 'react'
import { extractSingleEmbedding, loadFaceModels } from './lib/faceApi'
import { deleteEmployee, insertEmployee, listEmployees, type Employee } from './lib/supabase'

type BulkProgress = {
  total: number
  done: number
  succeeded: number
  noFace: number
  skipped: number
  failed: number
  current: string
  log: string[]    // 최근 처리 결과 (최대 200줄)
}

export function EnrollView() {
  const [name, setName] = useState('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bulkInputRef = useRef<HTMLInputElement>(null)
  const cancelBulkRef = useRef(false)

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

  async function handleBulkFiles(files: FileList) {
    if (bulkRunning) return
    cancelBulkRef.current = false
    setBulkRunning(true)
    setMessage(null)

    // 이미지 파일만 필터
    const imageFiles: File[] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      if (/\.(jpe?g|png)$/i.test(f.name)) imageFiles.push(f)
    }

    const progress: BulkProgress = {
      total: imageFiles.length,
      done: 0,
      succeeded: 0,
      noFace: 0,
      skipped: 0,
      failed: 0,
      current: '',
      log: [],
    }
    setBulkProgress({ ...progress })

    function pushLog(line: string) {
      progress.log.unshift(line)
      if (progress.log.length > 200) progress.log.length = 200
    }

    for (const file of imageFiles) {
      if (cancelBulkRef.current) break
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      progress.current = relPath
      progress.done++
      setBulkProgress({ ...progress })

      // 이름 추출: 파일명에서 한글 2-4자 우선, 실패 시 부모 폴더에서
      const personName = extractPersonName(file.name) || extractPersonName(parentName(relPath))
      if (!personName) {
        progress.skipped++
        pushLog(`⊘ skip (no name): ${relPath}`)
        continue
      }

      let url: string | null = null
      try {
        url = URL.createObjectURL(file)
        const img = await loadImage(url)
        const result = await extractSingleEmbedding(img)
        if (!result) {
          progress.noFace++
          pushLog(`✗ no face: ${personName} ← ${relPath}`)
          continue
        }
        await insertEmployee(personName, Array.from(result.descriptor), relPath)
        progress.succeeded++
        pushLog(`✓ ${personName} ← ${relPath}`)
      } catch (e) {
        progress.failed++
        pushLog(`✗ error: ${personName} ← ${relPath}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (url) URL.revokeObjectURL(url)
      }

      // UI 업데이트 (배치)
      if (progress.done % 5 === 0 || progress.done === imageFiles.length) {
        setBulkProgress({ ...progress })
        // event loop에 양보 — UI 반응성 유지
        await new Promise((r) => setTimeout(r, 0))
      }
    }

    progress.current = ''
    setBulkProgress({ ...progress })
    setBulkRunning(false)
    if (bulkInputRef.current) bulkInputRef.current.value = ''
    await refreshList()
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

  // 같은 이름끼리 묶어서 표시
  const grouped = groupByName(employees)

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>h-mirror — Enroll</h1>
        <a href="#" style={linkStyle}>← Back to recognition</a>
      </div>

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Add a person (single)</h2>
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
        <h2 style={sectionTitleStyle}>Bulk upload (folder)</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={mutedStyle}>
            폴더 통째 선택. 파일명에서 한글 이름 2~4자를 자동 추출 (예: <code>강부민.jpg</code>, <code>김민아_VX.jpg</code>).
            한 사람당 사진이 여러 장이면 모두 동일 이름으로 등록 → 인식 정확도 ↑
          </div>
          <input
            ref={(el) => {
              bulkInputRef.current = el
              if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', '') }
            }}
            type="file"
            multiple
            accept="image/jpeg,image/jpg,image/png"
            onChange={(e) => {
              const files = e.target.files
              if (files && files.length > 0) handleBulkFiles(files)
            }}
            disabled={bulkRunning || loadingModels}
            style={inputStyle}
          />
          {bulkRunning && (
            <button type="button" onClick={() => { cancelBulkRef.current = true }} style={cancelBtnStyle}>
              Cancel
            </button>
          )}
          {bulkProgress && (
            <BulkProgressView progress={bulkProgress} running={bulkRunning} />
          )}
        </div>
      </section>

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Capture from camera</h2>
        <CameraCapture
          name={name}
          disabled={loadingModels}
          onEnrolled={(captured) => {
            setMessage({ text: `Captured & enrolled "${captured}"`, ok: true })
            refreshList()
          }}
          onError={(text) => setMessage({ text, ok: false })}
        />
      </section>

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Enrolled ({employees.length} embeddings · {grouped.length} people)</h2>
        {grouped.length === 0 ? (
          <div style={mutedStyle}>No one enrolled yet.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {grouped.map((g) => (
              <li key={g.name} style={rowStyle}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{g.name}</div>
                  <div style={mutedStyle}>
                    {g.items.length} photo{g.items.length === 1 ? '' : 's'}
                    {' · '}
                    {new Date(g.items[0].created_at).toLocaleString()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm(`Delete all ${g.items.length} embedding(s) for "${g.name}"?`)) return
                    for (const item of g.items) await handleDelete(item.id, g.name)
                  }}
                  style={deleteBtnStyle}
                >
                  Delete all
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p style={tipStyle}>
        Tip: 정면, 균일한 조명, 얼굴이 사진의 30% 이상인 사진을 사용하세요. 한 사람당 1장이면 충분하지만, 3-5장을 등록하면 인식률이 더 좋아집니다 (이름은 동일하게).
      </p>
    </div>
  )
}

function CameraCapture(props: {
  name: string
  disabled: boolean
  onEnrolled: (capturedName: string) => void
  onError: (message: string) => void
}) {
  const { name, disabled, onEnrolled, onError } = props
  const [open, setOpen] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [recentCount, setRecentCount] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play()
        }
      } catch (e) {
        onError(`Camera open failed: ${e instanceof Error ? e.message : String(e)}`)
        setOpen(false)
      }
    }
    start()
    return () => {
      cancelled = true
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
    }
  }, [open, onError])

  async function capture() {
    if (!name.trim()) {
      onError('Enter a name first.')
      return
    }
    const video = videoRef.current
    if (!video || video.readyState < 2) {
      onError('Camera not ready')
      return
    }
    setCapturing(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      // 좌우 반전된 미리보기와 매칭되도록 그대로 그림 (실제 이미지는 mirror 안 함 = 실제 얼굴 방향)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0)

      const result = await extractSingleEmbedding(canvas)
      if (!result) {
        onError('No face detected. Center your face in the frame.')
        return
      }
      const captured = name.trim()
      await insertEmployee(captured, Array.from(result.descriptor), `webcam-${new Date().toISOString()}`)
      setRecentCount((c) => c + 1)
      onEnrolled(captured)
    } catch (e) {
      onError(`Capture failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCapturing(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={mutedStyle}>
        위 "Add a person" 섹션에서 이름을 입력하신 뒤 카메라를 켜고 촬영하세요. 한 사람당 다른 각도/표정으로 여러 장 촬영하면 인식률이 크게 올라갑니다.
      </div>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled}
          style={primaryBtnStyle}
        >
          Open camera
        </button>
      ) : (
        <>
          <div style={{ position: 'relative', maxWidth: 480 }}>
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ width: '100%', borderRadius: 8, transform: 'scaleX(-1)', background: '#000' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={capture} disabled={capturing || disabled || !name.trim()} style={primaryBtnStyle}>
              {capturing ? 'Processing…' : '📸 Capture'}
            </button>
            <button type="button" onClick={() => setOpen(false)} style={secondaryBtnStyle}>
              Close camera
            </button>
            {recentCount > 0 && (
              <span style={{ ...mutedStyle, alignSelf: 'center' }}>
                이번 세션에서 {recentCount}장 등록됨
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function BulkProgressView({ progress, running }: { progress: BulkProgress; running: boolean }) {
  const pct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,0.08)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: running ? '#7ee' : 'rgba(126,238,238,0.5)' }} />
        </div>
        <span style={{ fontSize: 13, minWidth: 90, textAlign: 'right' }}>{progress.done}/{progress.total}</span>
      </div>
      <div style={{ fontSize: 12, display: 'flex', gap: 12, opacity: 0.8 }}>
        <span style={{ color: '#7ee' }}>✓ {progress.succeeded}</span>
        <span style={{ color: '#ff7' }}>∅ no face: {progress.noFace}</span>
        <span style={{ opacity: 0.6 }}>⊘ skipped: {progress.skipped}</span>
        <span style={{ color: '#f77' }}>✗ failed: {progress.failed}</span>
      </div>
      {progress.current && (
        <div style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>처리 중: {progress.current}</div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 12, opacity: 0.6, cursor: 'pointer' }}>Log (최근 {progress.log.length}건)</summary>
        <div style={{
          marginTop: 6, maxHeight: 220, overflow: 'auto',
          background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 4, padding: 8, fontSize: 11, fontFamily: 'ui-monospace, monospace',
        }}>
          {progress.log.map((line, i) => (
            <div key={i} style={{ whiteSpace: 'pre', opacity: line.startsWith('✓') ? 0.9 : 0.7 }}>{line}</div>
          ))}
        </div>
      </details>
    </div>
  )
}

function extractPersonName(s: string): string | null {
  // 확장자 제거
  const noExt = s.replace(/\.[^.]+$/, '')
  // 한글 2-4자 첫 단어
  const m = noExt.match(/[가-힣]{2,4}/)
  if (!m) return null
  // 흔한 가짜 매칭 제외
  const candidate = m[0]
  const BANNED = new Set([
    '정방형', '이름', '없음', '폴더', '사진', '프로필', '편집', '원본',
    '최종', '수정', '파일',
  ])
  if (BANNED.has(candidate)) return null
  return candidate
}

function parentName(relPath: string): string {
  const parts = relPath.split('/')
  if (parts.length < 2) return ''
  return parts[parts.length - 2] // 부모 폴더명
}

function groupByName(employees: Employee[]): Array<{ name: string; items: Employee[] }> {
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
    .sort((a, b) => a.name.localeCompare(b.name))
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
const tipStyle: React.CSSProperties = {
  maxWidth: 720, margin: '0 auto', padding: '4px 4px 24px',
  opacity: 0.6, fontSize: 13, lineHeight: 1.5,
}
const messageStyle: React.CSSProperties = { fontSize: 13, marginTop: 4 }
const previewStyle: React.CSSProperties = { maxWidth: 180, maxHeight: 180, borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)' }
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '8px 10px', background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
}
const primaryBtnStyle: React.CSSProperties = {
  background: 'rgba(126,238,238,0.18)', border: '1px solid rgba(126,238,238,0.7)',
  color: '#fff', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 14,
}
const secondaryBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 14,
}
const deleteBtnStyle: React.CSSProperties = {
  background: 'rgba(255,80,80,0.15)', border: '1px solid rgba(255,80,80,0.5)',
  color: '#f77', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}
const cancelBtnStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  background: 'rgba(255,180,80,0.15)', border: '1px solid rgba(255,180,80,0.5)',
  color: '#fb7', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
}
