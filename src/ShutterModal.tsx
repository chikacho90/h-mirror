import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { extractAllEmbeddings } from './lib/faceApi'
import {
  insertEmployeeWithDiversityCap, matchFace, uploadShot, type MatchResult,
} from './lib/supabase'

export type ShutterShotState = {
  imageDataUrl: string
  imageBlob: Blob
  imageW: number
  imageH: number
}

type FaceData = {
  box: { x: number; y: number; width: number; height: number }
  descriptor: Float32Array
  matches: MatchResult[]
  thumbDataUrl: string
  savedAs: string | null
}

const FACE_CROP_SIZE = 200

export function ShutterModal(props: { shot: ShutterShotState; onClose: () => void }) {
  const { shot, onClose } = props
  const [uploadUrl, setUploadUrl] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [faces, setFaces] = useState<FaceData[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  // QR (always: 업로드 → public URL → QR)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const url = await uploadShot(shot.imageBlob)
        if (cancelled) return
        setUploadUrl(url)
        const qr = await QRCode.toDataURL(url, { width: 256, margin: 1 })
        if (cancelled) return
        setQrDataUrl(qr)
      } catch (e) {
        if (!cancelled) setUploadError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [shot])

  // help 패널 열릴 때만 얼굴 검출 (불필요한 매칭 회피)
  useEffect(() => {
    if (!helpOpen || faces.length > 0 || analyzing) return
    let cancelled = false
    setAnalyzing(true)
    ;(async () => {
      try {
        const img = await loadImage(shot.imageDataUrl)
        if (cancelled) return
        const detected = await extractAllEmbeddings(img)
        if (cancelled) return
        const sorted = [...detected].sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height))
        const result: FaceData[] = []
        for (const f of sorted) {
          let matches: MatchResult[] = []
          try { matches = await matchFace(Array.from(f.descriptor), 15, 0.0) } catch { /* skip */ }
          const dedup: MatchResult[] = []
          for (const m of matches) {
            if (!dedup.find((d) => d.name === m.name)) dedup.push(m)
            if (dedup.length >= 3) break
          }
          const thumbDataUrl = await cropFaceFromImage(img, f.box)
          result.push({ box: f.box, descriptor: f.descriptor, matches: dedup, thumbDataUrl, savedAs: null })
        }
        if (!cancelled) setFaces(result)
      } catch {
        // skip
      } finally {
        if (!cancelled) setAnalyzing(false)
      }
    })()
    return () => { cancelled = true }
  }, [helpOpen, shot, faces.length, analyzing])

  async function handleAssign(idx: number, name: string) {
    const trimmed = name.trim()
    const face = faces[idx]
    if (!trimmed || !face) return
    try {
      await insertEmployeeWithDiversityCap({
        name: trimmed,
        embedding: Array.from(face.descriptor),
        image_data: face.thumbDataUrl,
        notes: `shutter-${new Date().toISOString()}`,
      })
      setFaces((prev) => prev.map((f, i) => i === idx ? { ...f, savedAs: trimmed } : f))
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={contentStyle} onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="Close">✕</button>

        <div style={mainAreaStyle}>
          <div style={previewWrapStyle}>
            <img src={shot.imageDataUrl} alt="" style={previewImgStyle} />
          </div>
          <div style={sideStyle}>
            <div style={qrWrapStyle}>
              <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 8 }}>📱 모바일로 다운로드</div>
              {qrDataUrl ? (
                <>
                  <img src={qrDataUrl} alt="QR" style={qrImgStyle} />
                  {uploadUrl && (
                    <a href={uploadUrl} target="_blank" rel="noreferrer" style={qrLinkStyle}>또는 링크 열기</a>
                  )}
                </>
              ) : uploadError ? (
                <div style={{ color: '#f77', fontSize: 12, textAlign: 'center' }}>업로드 실패<br />{uploadError}</div>
              ) : (
                <div style={{ opacity: 0.6, fontSize: 13 }}>업로드 중…</div>
              )}
            </div>
            {!helpOpen ? (
              <button type="button" onClick={() => setHelpOpen(true)} style={helpToggleBtnStyle}>
                개선에 도움주기 ▾
              </button>
            ) : (
              <button type="button" onClick={() => setHelpOpen(false)} style={helpToggleBtnStyleOpen}>
                개선에 도움주기 ▴
              </button>
            )}
          </div>
        </div>

        {helpOpen && (
          <div style={helpPanelStyle}>
            {analyzing ? (
              <div style={mutedStyle}>얼굴 분석 중…</div>
            ) : faces.length === 0 ? (
              <div style={mutedStyle}>얼굴이 검출되지 않았어요.</div>
            ) : (
              <div style={facesGridStyle}>
                {faces.map((f, i) => (
                  <FaceCard
                    key={i}
                    face={f}
                    onAssign={(name) => handleAssign(i, name)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function FaceCard(props: { face: FaceData; onAssign: (name: string) => void }) {
  const { face, onAssign } = props
  const [otherActive, setOtherActive] = useState(false)
  const [otherInput, setOtherInput] = useState('')
  const [saving, setSaving] = useState<string | null>(null)

  async function go(name: string) {
    setSaving(name)
    try { await onAssign(name) } finally { setSaving(null) }
  }

  return (
    <div style={faceCardStyle}>
      <div style={faceThumbWrapStyle}>
        <img src={face.thumbDataUrl} alt="" style={faceThumbImgStyle} />
      </div>
      {face.savedAs ? (
        <div style={{ color: '#7ee', fontSize: 13, marginTop: 8, textAlign: 'center' }}>
          ✓ {face.savedAs}
        </div>
      ) : (
        <div style={faceBtnsStyle}>
          <div style={faceLabelStyle}>이 사람은</div>
          {face.matches.map((m) => (
            <button
              key={m.name}
              type="button"
              onClick={() => go(m.name)}
              disabled={saving !== null}
              style={assignBtnStyle(saving === m.name)}
            >
              {saving === m.name ? '저장 중…' : `${m.name}입니다 (${(m.similarity * 100).toFixed(0)}%)`}
            </button>
          ))}
          {!otherActive ? (
            <button
              type="button"
              onClick={() => setOtherActive(true)}
              disabled={saving !== null}
              style={assignBtnStyle(false)}
            >
              다른 사람입니다
            </button>
          ) : (
            <div style={otherRowStyle}>
              <input
                type="text"
                autoFocus
                placeholder="이름"
                value={otherInput}
                onChange={(e) => setOtherInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && otherInput.trim()) go(otherInput) }}
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => go(otherInput)}
                disabled={saving !== null || !otherInput.trim()}
                style={assignBtnStyle(saving === otherInput.trim())}
              >
                등록
              </button>
              <button
                type="button"
                onClick={() => { setOtherActive(false); setOtherInput('') }}
                style={cancelBtnStyle}
              >
                취소
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataUrl
  })
}

async function cropFaceFromImage(
  img: HTMLImageElement,
  box: { x: number; y: number; width: number; height: number },
): Promise<string> {
  const PAD = 0.25
  const padW = box.width * PAD
  const padH = box.height * PAD
  const sx = Math.max(0, box.x - padW)
  const sy = Math.max(0, box.y - padH)
  const sw = Math.min(img.width - sx, box.width + padW * 2)
  const sh = Math.min(img.height - sy, box.height + padH * 2)
  const canvas = document.createElement('canvas')
  canvas.width = FACE_CROP_SIZE
  canvas.height = FACE_CROP_SIZE
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, FACE_CROP_SIZE, FACE_CROP_SIZE)
  return canvas.toDataURL('image/jpeg', 0.78)
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 100,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '5vh 5vw',
}
const contentStyle: React.CSSProperties = {
  position: 'relative',
  background: '#13161a', color: '#e8e8e8',
  borderRadius: 14, padding: 22,
  width: '90vw', maxWidth: 1600,
  maxHeight: '90vh',
  border: '1px solid rgba(255,255,255,0.1)',
  overflow: 'auto',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  display: 'flex', flexDirection: 'column', gap: 16,
}
const closeBtnStyle: React.CSSProperties = {
  position: 'absolute', top: 12, right: 14,
  background: 'transparent', border: 'none', color: '#aaa',
  cursor: 'pointer', fontSize: 24, padding: 6, zIndex: 1,
}
const mainAreaStyle: React.CSSProperties = {
  display: 'flex', gap: 18, flexWrap: 'wrap', minHeight: 0,
}
const previewWrapStyle: React.CSSProperties = {
  flex: '1 1 0', minWidth: 280,
  background: '#000', borderRadius: 8, overflow: 'hidden',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  minHeight: 200,
}
const previewImgStyle: React.CSSProperties = {
  maxWidth: '100%', maxHeight: '70vh', height: 'auto', width: 'auto', display: 'block',
}
const sideStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 14, minWidth: 280, maxWidth: 320,
}
const qrWrapStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  padding: 14, background: 'rgba(255,255,255,0.04)', borderRadius: 8,
}
const qrImgStyle: React.CSSProperties = { width: 240, height: 240, borderRadius: 6, background: '#fff' }
const qrLinkStyle: React.CSSProperties = { color: '#7ee', fontSize: 12, marginTop: 8, textDecoration: 'none' }
const helpToggleBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.3)',
  color: '#fff', padding: '12px 18px', borderRadius: 8, cursor: 'pointer',
  fontSize: 14, fontFamily: 'inherit',
}
const helpToggleBtnStyleOpen: React.CSSProperties = {
  ...helpToggleBtnStyle,
  background: 'rgba(126,238,238,0.18)', borderColor: 'rgba(126,238,238,0.7)',
}
const helpPanelStyle: React.CSSProperties = {
  borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 16,
}
const facesGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14,
}
const faceCardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10, padding: 12,
  display: 'flex', flexDirection: 'column',
}
const faceThumbWrapStyle: React.CSSProperties = {
  width: '100%', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden',
  background: '#000',
}
const faceThumbImgStyle: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' }
const faceBtnsStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10,
}
const faceLabelStyle: React.CSSProperties = { fontSize: 12, opacity: 0.75 }
const assignBtnStyle = (loading: boolean): React.CSSProperties => ({
  background: loading ? 'rgba(126,238,238,0.35)' : 'rgba(126,238,238,0.18)',
  border: '1px solid rgba(126,238,238,0.7)',
  color: '#fff', padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
  fontSize: 13, fontFamily: 'inherit', textAlign: 'left',
})
const cancelBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
}
const otherRowStyle: React.CSSProperties = { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }
const inputStyle: React.CSSProperties = {
  flex: 1, minWidth: 110,
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.35)',
  color: '#fff', padding: '6px 10px', borderRadius: 5, fontSize: 13, outline: 'none',
}
const mutedStyle: React.CSSProperties = { opacity: 0.7, fontSize: 13 }
