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
}

const FACE_CROP_SIZE = 200

export function ShutterModal(props: { shot: ShutterShotState; onClose: () => void }) {
  const { shot, onClose } = props
  const [uploadUrl, setUploadUrl] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [primary, setPrimary] = useState<FaceData | null>(null)
  const [analyzing, setAnalyzing] = useState(true)
  const [savingName, setSavingName] = useState<string | null>(null)
  const [savedAs, setSavedAs] = useState<string | null>(null)
  const [otherInput, setOtherInput] = useState('')
  const [otherActive, setOtherActive] = useState(false)

  // 업로드 → public URL → QR
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

  // 얼굴 검출 + 가장 큰 얼굴(primary)에 대해 top-3 매칭
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const img = await loadImage(shot.imageDataUrl)
        if (cancelled) return
        const faces = await extractAllEmbeddings(img)
        if (cancelled) return
        if (faces.length === 0) { setPrimary(null); setAnalyzing(false); return }
        const sorted = [...faces].sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height))
        const top = sorted[0]
        let matches: MatchResult[] = []
        try { matches = await matchFace(Array.from(top.descriptor), 12, 0.0) } catch { /* skip */ }
        // 이름 dedupe → top-3
        const dedup: MatchResult[] = []
        for (const m of matches) {
          if (!dedup.find((d) => d.name === m.name)) dedup.push(m)
          if (dedup.length >= 3) break
        }
        if (!cancelled) {
          setPrimary({ box: top.box, descriptor: top.descriptor, matches: dedup })
          setAnalyzing(false)
        }
      } catch {
        if (!cancelled) setAnalyzing(false)
      }
    })()
    return () => { cancelled = true }
  }, [shot])

  async function handleAssign(name: string) {
    if (!primary) return
    const trimmed = name.trim()
    if (!trimmed) return
    setSavingName(trimmed)
    try {
      const thumb = cropFaceFromDataUrl(shot.imageDataUrl, primary.box)
      await thumb.then((dataUrl) =>
        insertEmployeeWithDiversityCap({
          name: trimmed,
          embedding: Array.from(primary.descriptor),
          image_data: dataUrl,
          notes: `shutter-${new Date().toISOString()}`,
        })
      )
      setSavedAs(trimmed)
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSavingName(null)
    }
  }

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={contentStyle} onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="Close">✕</button>

        <div style={topRowStyle}>
          <div style={previewWrapStyle}>
            <img src={shot.imageDataUrl} alt="" style={previewImgStyle} />
          </div>
          <div style={qrWrapStyle}>
            <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>📱 모바일로 다운로드</div>
            {qrDataUrl ? (
              <>
                <img src={qrDataUrl} alt="QR" style={{ width: 220, height: 220, borderRadius: 6, background: '#fff' }} />
                {uploadUrl && (
                  <a href={uploadUrl} target="_blank" rel="noreferrer" style={qrLinkStyle}>또는 링크 열기</a>
                )}
              </>
            ) : uploadError ? (
              <div style={{ color: '#f77', fontSize: 12 }}>업로드 실패: {uploadError}</div>
            ) : (
              <div style={{ opacity: 0.6, fontSize: 13 }}>업로드 중…</div>
            )}
          </div>
        </div>

        <div style={assignSectionStyle}>
          <div style={assignTitleStyle}>개선에 도움주기</div>
          {savedAs ? (
            <div style={{ color: '#7ee', fontSize: 14 }}>✓ {savedAs}의 사진으로 추가됨</div>
          ) : analyzing ? (
            <div style={mutedStyle}>얼굴 분석 중…</div>
          ) : !primary ? (
            <div style={mutedStyle}>얼굴이 검출되지 않았어요.</div>
          ) : (
            <>
              <div style={mutedStyle}>이 사람은</div>
              <div style={btnColStyle}>
                {primary.matches.map((m) => (
                  <button
                    key={m.name}
                    type="button"
                    onClick={() => handleAssign(m.name)}
                    disabled={savingName !== null}
                    style={assignBtnStyle(savingName === m.name)}
                  >
                    {savingName === m.name ? '저장 중…' : `${m.name}입니다 (${(m.similarity * 100).toFixed(0)}%)`}
                  </button>
                ))}
                {!otherActive ? (
                  <button
                    type="button"
                    onClick={() => setOtherActive(true)}
                    disabled={savingName !== null}
                    style={assignBtnStyle(false)}
                  >
                    다른 사람입니다
                  </button>
                ) : (
                  <div style={otherRowStyle}>
                    <input
                      type="text"
                      autoFocus
                      placeholder="이 사람의 이름"
                      value={otherInput}
                      onChange={(e) => setOtherInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && otherInput.trim()) handleAssign(otherInput) }}
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => handleAssign(otherInput)}
                      disabled={savingName !== null || !otherInput.trim()}
                      style={assignBtnStyle(savingName === otherInput.trim())}
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
            </>
          )}
        </div>
      </div>
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

async function cropFaceFromDataUrl(
  dataUrl: string,
  box: { x: number; y: number; width: number; height: number },
): Promise<string> {
  const img = await loadImage(dataUrl)
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
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', zIndex: 100,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 20, overflow: 'auto',
}
const contentStyle: React.CSSProperties = {
  position: 'relative',
  background: '#13161a', color: '#e8e8e8',
  borderRadius: 14, padding: 20, maxWidth: 880, width: '100%',
  border: '1px solid rgba(255,255,255,0.1)',
  maxHeight: 'calc(100vh - 40px)', overflow: 'auto',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
}
const closeBtnStyle: React.CSSProperties = {
  position: 'absolute', top: 10, right: 12,
  background: 'transparent', border: 'none', color: '#aaa',
  cursor: 'pointer', fontSize: 22, padding: 6,
}
const topRowStyle: React.CSSProperties = {
  display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16, marginTop: 6,
}
const previewWrapStyle: React.CSSProperties = {
  flex: '1 1 320px', minWidth: 280, maxWidth: 540,
  background: '#000', borderRadius: 8, overflow: 'hidden',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const previewImgStyle: React.CSSProperties = { width: '100%', height: 'auto', display: 'block' }
const qrWrapStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  padding: 12, background: 'rgba(255,255,255,0.04)', borderRadius: 8,
  minWidth: 240,
}
const qrLinkStyle: React.CSSProperties = { color: '#7ee', fontSize: 12, marginTop: 8, textDecoration: 'none' }
const assignSectionStyle: React.CSSProperties = {
  borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 14,
}
const assignTitleStyle: React.CSSProperties = { fontSize: 14, fontWeight: 700, marginBottom: 6 }
const mutedStyle: React.CSSProperties = { opacity: 0.7, fontSize: 13, marginBottom: 8 }
const btnColStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const assignBtnStyle = (loading: boolean): React.CSSProperties => ({
  background: loading ? 'rgba(126,238,238,0.35)' : 'rgba(126,238,238,0.18)',
  border: '1px solid rgba(126,238,238,0.7)',
  color: '#fff', padding: '10px 14px', borderRadius: 6, cursor: 'pointer',
  fontSize: 15, fontFamily: 'inherit', textAlign: 'left',
})
const cancelBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
}
const otherRowStyle: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }
const inputStyle: React.CSSProperties = {
  flex: 1, minWidth: 160,
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.35)',
  color: '#fff', padding: '8px 12px', borderRadius: 6, fontSize: 14, outline: 'none',
}
