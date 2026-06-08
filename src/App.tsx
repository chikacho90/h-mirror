import { useEffect, useRef, useState } from 'react'
import {
  FilesetResolver,
  ObjectDetector,
  ImageSegmenter,
  type ObjectDetectorResult,
  type ImageSegmenterResult,
} from '@mediapipe/tasks-vision'
import { EnrollView } from './EnrollView'
import { extractAllEmbeddings, loadFaceModels } from './lib/faceApi'
import { matchFace, type MatchResult } from './lib/supabase'

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const OBJ_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite'
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite'

const MAX_DETECTIONS = 20
const TRACK_TIMEOUT_MS = 800
const TRACK_MATCH_IOU = 0.2
const SCORE_THRESHOLD = 0.45
const POSITION_ALPHA = 0.35
const SCORE_ALPHA = 0.15
const FS_UI_HIDE_MS = 3000
const MASK_REFRESH_MS = 60
const OBJECT_REFRESH_MS = 25
const FPS_UPDATE_MS = 500
const FACE_REFRESH_MS = 700        // 얼굴 검출 + 임베딩 호출 주기 (≈1.4fps — DB 쿼리 부담 줄임)
const MATCH_THRESHOLD = 0.3        // pgvector cosine similarity 컷오프
const MATCH_TOP_K = 3

type Status = 'idle' | 'loading-model' | 'requesting-camera' | 'running' | 'error'
type BBox = { x: number; y: number; w: number; h: number }
type ShapeMode = 'none' | 'box' | 'silhouette-bg' | 'silhouette-fg' | 'silhouette-outline'
type TargetMode = 'none' | 'full-body' | 'face'

const DISPLAY_OPTIONS: ShapeMode[] = ['box', 'silhouette-bg', 'silhouette-fg', 'silhouette-outline']
const TARGET_OPTIONS: TargetMode[] = ['full-body', 'face']

type Track = {
  id: number
  bbox: BBox
  score: number
  firstSeenAt: number
  lastSeenAt: number
  matches: MatchResult[]
  lastFaceProcessedAt: number
}

export default function App() {
  const [view, setView] = useState<'recognize' | 'enroll'>(
    typeof window !== 'undefined' && window.location.hash === '#enroll' ? 'enroll' : 'recognize'
  )
  useEffect(() => {
    function onHash() {
      setView(window.location.hash === '#enroll' ? 'enroll' : 'recognize')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (view === 'enroll') return <EnrollView />
  return <RecognizeView />
}

function RecognizeView() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const detectorRef = useRef<ObjectDetector | null>(null)
  const segmenterRef = useRef<ImageSegmenter | null>(null)

  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [fps, setFps] = useState(0)
  const [trackCount, setTrackCount] = useState(0)
  const [shape, setShape] = useState<ShapeMode>('box')
  const [target, setTarget] = useState<TargetMode>('full-body')
  const [statusVisible, setStatusVisible] = useState(true)
  const [fsUiVisible, setFsUiVisible] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [cameraDeviceId, setCameraDeviceId] = useState<string | null>(null)

  const mirrorRef = useRef(true)
  const refs = {
    shape: useRef(shape),
    target: useRef(target),
  }
  useEffect(() => { refs.shape.current = shape }, [shape])
  useEffect(() => { refs.target.current = target }, [target])

  const tracksRef = useRef<Track[]>([])
  const nextIdRef = useRef(1)
  const lastSegMaskRef = useRef<ImageSegmenterResult | null>(null)
  const lastObjectTsRef = useRef(0)
  const fpsLastUpdateRef = useRef(0)
  const silhouetteCacheRef = useRef<{ canvas: HTMLCanvasElement; shape: ShapeMode; ts: number } | null>(null)
  const faceProcessingRef = useRef(false)
  const lastFaceRunAtRef = useRef(0)
  const [faceReady, setFaceReady] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    function show() {
      setFsUiVisible(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setFsUiVisible(false), FS_UI_HIDE_MS)
    }
    window.addEventListener('mousemove', show)
    window.addEventListener('touchstart', show)
    window.addEventListener('pointerdown', show)
    show()
    return () => {
      window.removeEventListener('mousemove', show)
      window.removeEventListener('touchstart', show)
      window.removeEventListener('pointerdown', show)
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    function onChange() { setIsFullscreen(!!document.fullscreenElement) }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    let cancelled = false
    let raf: number | null = null
    let lastTs = performance.now()
    const fpsBuf: number[] = []

    async function init() {
      try {
        setStatus('loading-model')
        const vision = await FilesetResolver.forVisionTasks(WASM_URL)
        const [detector, segmenter] = await Promise.all([
          ObjectDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: OBJ_MODEL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            scoreThreshold: SCORE_THRESHOLD,
            maxResults: MAX_DETECTIONS,
            categoryAllowlist: ['person'],
          }),
          ImageSegmenter.createFromOptions(vision, {
            baseOptions: { modelAssetPath: SEG_MODEL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            outputCategoryMask: true,
            outputConfidenceMasks: false,
          }),
        ])
        if (cancelled) { detector.close(); segmenter.close(); return }
        detectorRef.current = detector
        segmenterRef.current = segmenter
        setStatus('running')

        // face-api 모델 비동기 로드 (실시간 인식용). 로딩 끝나면 인식 활성화
        loadFaceModels().then(() => { if (!cancelled) setFaceReady(true) })
          .catch((e) => console.warn('face-api load failed:', e))

        const loop = () => {
          if (cancelled) return
          const now = performance.now()
          const dt = now - lastTs
          lastTs = now
          if (dt > 0) { fpsBuf.push(1000 / dt); if (fpsBuf.length > 30) fpsBuf.shift() }
          if (fpsBuf.length === 30 && now - fpsLastUpdateRef.current >= FPS_UPDATE_MS) {
            const avg = fpsBuf.reduce((a, b) => a + b, 0) / fpsBuf.length
            setFps(Math.round(avg))
            fpsLastUpdateRef.current = now
          }
          detectAndRender(now)
          raf = requestAnimationFrame(loop)
        }
        raf = requestAnimationFrame(loop)
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setErrorMsg(e instanceof Error ? e.message : String(e))
      }
    }
    init()

    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      detectorRef.current?.close(); detectorRef.current = null
      segmenterRef.current?.close(); segmenterRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    async function start() {
      try {
        setStatus((s) => (s === 'error' ? s : s === 'running' ? s : 'requesting-camera'))
        const videoConstraint: MediaTrackConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
        }
        if (cameraDeviceId) videoConstraint.deviceId = { exact: cameraDeviceId }
        else videoConstraint.facingMode = 'user'
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        const video = videoRef.current
        if (video) {
          if (video.srcObject) (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
          video.srcObject = stream
          await video.play()
        }
        try {
          const devs = await navigator.mediaDevices.enumerateDevices()
          if (!cancelled) setCameras(devs.filter((d) => d.kind === 'videoinput'))
        } catch { /* skip */ }
      } catch (e) {
        if (!cancelled) {
          setStatus('error')
          setErrorMsg(e instanceof Error ? e.message : String(e))
        }
      }
    }
    start()
    return () => {
      cancelled = true
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }, [cameraDeviceId])

  useEffect(() => {
    async function reload() {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices()
        setCameras(devs.filter((d) => d.kind === 'videoinput'))
      } catch { /* skip */ }
    }
    navigator.mediaDevices.addEventListener('devicechange', reload)
    return () => navigator.mediaDevices.removeEventListener('devicechange', reload)
  }, [])

  function detectAndRender(ts: number) {
    const video = videoRef.current
    const canvas = canvasRef.current
    const detector = detectorRef.current
    const segmenter = segmenterRef.current
    if (!video || !canvas || !detector || !segmenter) return
    if (video.readyState < 2) return

    const vw = video.videoWidth
    const vh = video.videoHeight
    if (canvas.width !== vw) canvas.width = vw
    if (canvas.height !== vh) canvas.height = vh

    const ctx = canvas.getContext('2d')!
    const mirrored = mirrorRef.current

    ctx.save()
    if (mirrored) { ctx.translate(vw, 0); ctx.scale(-1, 1) }
    ctx.drawImage(video, 0, 0, vw, vh)
    ctx.restore()

    const targetMode = refs.target.current
    if (targetMode !== 'none' && ts - lastObjectTsRef.current >= OBJECT_REFRESH_MS) {
      let objResult: ObjectDetectorResult | undefined
      try { objResult = detector.detectForVideo(video, ts) } catch { return }
      const detections: { bbox: BBox; score: number }[] = []
      if (objResult) {
        for (const d of objResult.detections) {
          const c = d.categories?.[0]
          if (!c || c.categoryName !== 'person' || c.score < SCORE_THRESHOLD) continue
          const b = d.boundingBox
          if (!b) continue
          let bbox: BBox = { x: b.originX, y: b.originY, w: b.width, h: b.height }
          if (targetMode === 'face') {
            bbox = { x: bbox.x + bbox.w * 0.18, y: bbox.y, w: bbox.w * 0.64, h: bbox.h * 0.38 }
          }
          detections.push({ bbox, score: c.score })
        }
      }
      updateTracks(tracksRef.current, detections, ts, nextIdRef)
      lastObjectTsRef.current = ts
      if (tracksRef.current.length !== trackCount) setTrackCount(tracksRef.current.length)
    } else if (targetMode === 'none' && tracksRef.current.length > 0) {
      tracksRef.current.length = 0
      if (trackCount !== 0) setTrackCount(0)
    }

    const shapeMode = refs.shape.current
    if (shapeMode === 'silhouette-bg' || shapeMode === 'silhouette-fg' || shapeMode === 'silhouette-outline') {
      const cache = silhouetteCacheRef.current
      const cacheStale = !cache || cache.shape !== shapeMode || (ts - cache.ts) > MASK_REFRESH_MS
      if (cacheStale) {
        try {
          const seg = segmenter.segmentForVideo(video, ts)
          if (seg) {
            lastSegMaskRef.current = seg
            const cc = buildSilhouetteCanvas(seg, tracksRef.current, vw, vh, shapeMode)
            if (cc) silhouetteCacheRef.current = { canvas: cc, shape: shapeMode, ts }
          }
        } catch { /* skip */ }
      }
      const finalCache = silhouetteCacheRef.current
      if (finalCache && finalCache.shape === shapeMode) {
        renderSilhouetteCache(ctx, finalCache.canvas, vw, vh, mirrored, shapeMode)
      }
    } else if (silhouetteCacheRef.current) {
      silhouetteCacheRef.current = null
    }

    if (shapeMode === 'box') {
      for (const t of tracksRef.current) drawBBox(ctx, t, vw, mirrored)
    }

    // 얼굴 인식 — 트랙이 있고 충분히 시간이 지났을 때만 (전체 프레임에서 얼굴 검출 + 임베딩 + DB 매칭)
    if (faceReady && tracksRef.current.length > 0 &&
        !faceProcessingRef.current &&
        ts - lastFaceRunAtRef.current >= FACE_REFRESH_MS) {
      lastFaceRunAtRef.current = ts
      faceProcessingRef.current = true
      processFaceMatching(video, tracksRef.current).finally(() => {
        faceProcessingRef.current = false
      })
    }

    if (targetMode !== 'none') {
      tracksRef.current.forEach((t, i) => drawIdentityLabel(ctx, t, i + 1, vw, mirrored))
    }
  }

  return (
    <div style={containerStyle}>
      <video ref={videoRef} playsInline muted style={{ display: 'none' }} />
      <canvas ref={canvasRef} style={canvasStyle} />

      <button
        type="button"
        onClick={() => setStatusVisible((v) => !v)}
        style={hiddenToggleStyle}
        title="Toggle status"
        aria-label="Toggle status"
      />
      {statusVisible && (
        <StatusOverlay status={status} errorMsg={errorMsg} fps={fps} trackCount={trackCount} faceReady={faceReady} />
      )}

      {/* 우상단 Enroll 링크 — 등록 화면으로 */}
      <a href="#enroll" style={enrollLinkStyle}>Enroll →</a>

      <BottomPanel
        open={panelOpen}
        toggle={() => setPanelOpen((v) => !v)}
        shape={shape}
        target={target}
        cameras={cameras}
        cameraDeviceId={cameraDeviceId}
        setShape={setShape}
        setTarget={setTarget}
        setCameraDeviceId={setCameraDeviceId}
      />

      {fsUiVisible && (<FullscreenButton isFullscreen={isFullscreen} />)}
    </div>
  )
}

function updateTracks(
  tracks: Track[],
  detections: { bbox: BBox; score: number }[],
  now: number,
  nextIdRef: { current: number },
) {
  const used = new Set<number>()
  for (const track of tracks) {
    let bestIdx = -1
    let bestIoU = TRACK_MATCH_IOU
    for (let i = 0; i < detections.length; i++) {
      if (used.has(i)) continue
      const iou = iouOf(track.bbox, detections[i].bbox)
      if (iou > bestIoU) { bestIoU = iou; bestIdx = i }
    }
    if (bestIdx >= 0) {
      const det = detections[bestIdx]
      track.bbox = {
        x: lerp(track.bbox.x, det.bbox.x, POSITION_ALPHA),
        y: lerp(track.bbox.y, det.bbox.y, POSITION_ALPHA),
        w: lerp(track.bbox.w, det.bbox.w, POSITION_ALPHA),
        h: lerp(track.bbox.h, det.bbox.h, POSITION_ALPHA),
      }
      track.score = lerp(track.score, det.score, SCORE_ALPHA)
      track.lastSeenAt = now
      used.add(bestIdx)
    }
  }
  for (let i = 0; i < detections.length; i++) {
    if (used.has(i)) continue
    const det = detections[i]
    tracks.push({
      id: nextIdRef.current++,
      bbox: det.bbox,
      score: det.score,
      firstSeenAt: now,
      lastSeenAt: now,
      matches: [],
      lastFaceProcessedAt: 0,
    })
  }
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (now - tracks[i].lastSeenAt > TRACK_TIMEOUT_MS) tracks.splice(i, 1)
  }
}

function iouOf(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h)
  if (x2 <= x1 || y2 <= y1) return 0
  const inter = (x2 - x1) * (y2 - y1)
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }

// 전체 비디오 프레임에서 얼굴 검출 + 임베딩 → DB 매칭 → 트랙에 결과 캐싱
async function processFaceMatching(video: HTMLVideoElement, tracks: Track[]) {
  const now = performance.now()

  // 시도 자체는 매 사이클 기록 — "Searching…"이 영구적이지 않게
  for (const t of tracks) {
    if (t.lastFaceProcessedAt === 0) t.lastFaceProcessedAt = now
  }

  let faces: Awaited<ReturnType<typeof extractAllEmbeddings>>
  try {
    faces = await extractAllEmbeddings(video)
  } catch {
    return
  }
  if (faces.length === 0) return

  // 각 face의 중심을 가장 가까운 트랙의 head 영역(상단 35%)에 매칭
  for (const face of faces) {
    const fcx = face.box.x + face.box.width / 2
    const fcy = face.box.y + face.box.height / 2
    let best: Track | null = null
    let bestDist = Infinity
    for (const t of tracks) {
      const headCx = t.bbox.x + t.bbox.w / 2
      const headCy = t.bbox.y + Math.min(t.bbox.h * 0.25, face.box.height * 0.8)
      const d = Math.hypot(fcx - headCx, fcy - headCy)
      const inside = fcx >= t.bbox.x && fcx <= t.bbox.x + t.bbox.w &&
                     fcy >= t.bbox.y && fcy <= t.bbox.y + t.bbox.h * 0.6
      const dScore = inside ? d * 0.5 : d
      if (dScore < bestDist) { bestDist = dScore; best = t }
    }
    if (!best) continue

    try {
      const results = await matchFace(Array.from(face.descriptor), MATCH_TOP_K, MATCH_THRESHOLD)
      best.matches = results
      best.lastFaceProcessedAt = performance.now()
    } catch {
      // skip on transient errors
    }
  }
}

function drawBBox(ctx: CanvasRenderingContext2D, t: Track, vw: number, mirrored: boolean) {
  let x = t.bbox.x
  if (mirrored) x = vw - t.bbox.x - t.bbox.w
  const { y, w, h } = t.bbox
  ctx.save()
  ctx.strokeStyle = colorForId(t.id)
  ctx.lineWidth = 3
  ctx.strokeRect(x, y, w, h)
  ctx.restore()
}

function drawIdentityLabel(
  ctx: CanvasRenderingContext2D,
  t: Track,
  _displayNum: number,
  vw: number,
  mirrored: boolean,
) {
  let cx = t.bbox.x + t.bbox.w / 2
  if (mirrored) cx = vw - cx
  const yTop = Math.max(28, t.bbox.y)
  const color = colorForId(t.id)

  // 매칭 결과 줄들 구성 — 넘버 제거, 이름만 (또는 검색/없음)
  const lines: string[] = []
  if (t.matches.length === 0) {
    lines.push(t.lastFaceProcessedAt === 0 ? 'Searching…' : 'Unknown')
  } else {
    const top = t.matches[0]
    const second = t.matches[1]
    const topPct = (top.similarity * 100).toFixed(0)
    const ambiguous = second && (top.similarity - second.similarity) < 0.10
    lines.push(`${top.name} (${topPct}%)`)
    if (ambiguous) {
      lines.push(`or ${second.name} (${(second.similarity * 100).toFixed(0)}%)`)
    }
  }

  ctx.save()
  ctx.font = 'bold 20px ui-sans-serif, system-ui, sans-serif'
  const headFont = ctx.font
  ctx.font = '14px ui-sans-serif, system-ui, sans-serif'
  const subFont = ctx.font

  // 첫 줄: 크게 / 두 번째 줄: 작게
  ctx.font = headFont
  const headW = ctx.measureText(lines[0]).width
  ctx.font = subFont
  const subW = lines[1] ? ctx.measureText(lines[1]).width : 0
  const padX = 14
  const padY = 8
  const headH = 26
  const subH = lines[1] ? 18 : 0
  const gap = lines[1] ? 2 : 0
  const boxW = Math.max(headW, subW) + padX * 2
  const boxH = padY + headH + gap + subH + padY

  let bx = cx - boxW / 2
  let by = yTop - boxH - 10
  if (by < 6) by = t.bbox.y + t.bbox.h + 6
  if (bx < 6) bx = 6
  if (bx + boxW > vw - 6) bx = vw - boxW - 6

  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)'
  ctx.fillRect(bx, by, boxW, boxH)
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.strokeRect(bx, by, boxW, boxH)

  ctx.textBaseline = 'top'
  // head line
  ctx.font = headFont
  ctx.fillStyle = '#fff'
  ctx.fillText(lines[0], bx + padX, by + padY)
  // sub line
  if (lines[1]) {
    ctx.font = subFont
    ctx.fillStyle = '#aaa'
    ctx.fillText(lines[1], bx + padX, by + padY + headH + gap)
  }
  ctx.restore()
}

function buildSilhouetteCanvas(
  seg: ImageSegmenterResult,
  tracks: Track[],
  vw: number,
  vh: number,
  mode: ShapeMode,
): HTMLCanvasElement | null {
  const mask = seg.categoryMask
  if (!mask) return null
  const w = mask.width
  const h = mask.height
  const data = mask.getAsUint8Array()
  void vh
  const off = document.createElement('canvas')
  off.width = w; off.height = h
  const offCtx = off.getContext('2d')!
  const img = offCtx.createImageData(w, h)

  const rawIsPerson = (v: number) => v !== 0
  const sx = vw / w
  const sy = vh / h
  const padded = tracks.map((t) => {
    const pad = Math.max(t.bbox.w * 0.10, 12)
    return {
      x1: t.bbox.x - pad,
      y1: t.bbox.y - pad,
      x2: t.bbox.x + t.bbox.w + pad,
      y2: t.bbox.y + t.bbox.h + pad,
    }
  })
  const hasTracks = padded.length > 0
  const isPersonFn = (v: number, xx: number, yy: number) => {
    if (!rawIsPerson(v)) return false
    if (!hasTracks) return false
    const px = xx * sx, py = yy * sy
    for (const b of padded) {
      if (px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2) return true
    }
    return false
  }

  const rawMask = new Uint8Array(data.length)
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx
      if (isPersonFn(data[i], xx, yy)) rawMask[i] = 1
    }
  }
  const eroded = erodeBinary(rawMask, w, h, 1)
  const seeds: number[] = []
  for (const t of tracks) {
    const cxv = t.bbox.x + t.bbox.w * 0.5
    const ys = [t.bbox.y + t.bbox.h * 0.18, t.bbox.y + t.bbox.h * 0.32, t.bbox.y + t.bbox.h * 0.5]
    for (const yv of ys) {
      const mx = Math.floor(cxv / sx)
      const my = Math.floor(yv / sy)
      if (mx >= 0 && mx < w && my >= 0 && my < h) seeds.push(my * w + mx)
    }
  }
  const flooded = floodFillFromSeeds(eroded, w, h, seeds)
  const personMask = dilateBinary(flooded, w, h, 2)

  if (mode === 'silhouette-outline') {
    const dilatedForEdge = dilateBinary(personMask, w, h, 2)
    const baseR = 255, baseG = 60, baseB = 60
    for (let i = 0; i < personMask.length; i++) {
      const isEdge = dilatedForEdge[i] === 1 && personMask[i] === 0
      const o = i * 4
      if (isEdge) { img.data[o] = baseR; img.data[o + 1] = baseG; img.data[o + 2] = baseB; img.data[o + 3] = 230 }
      else { img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 0 }
    }
  } else {
    const targetIsPerson = mode === 'silhouette-fg'
    const baseR = targetIsPerson ? 255 : 0
    const baseG = targetIsPerson ? 120 : 255
    const baseB = targetIsPerson ? 60 : 200
    for (let i = 0; i < data.length; i++) {
      const matches = targetIsPerson ? (personMask[i] === 1) : (personMask[i] === 0)
      const o = i * 4
      if (matches) { img.data[o] = baseR; img.data[o + 1] = baseG; img.data[o + 2] = baseB; img.data[o + 3] = 120 }
      else { img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 0 }
    }
  }
  offCtx.putImageData(img, 0, 0)
  return off
}

function renderSilhouetteCache(
  ctx: CanvasRenderingContext2D,
  off: HTMLCanvasElement,
  vw: number,
  vh: number,
  mirrored: boolean,
  mode: ShapeMode,
) {
  ctx.save()
  if (mirrored) { ctx.translate(vw, 0); ctx.scale(-1, 1) }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  if (mode === 'silhouette-outline') {
    ctx.filter = 'blur(6px)'
    ctx.globalCompositeOperation = 'lighter'
    ctx.drawImage(off, 0, 0, vw, vh)
    ctx.filter = 'none'
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(off, 0, 0, vw, vh)
  } else {
    ctx.globalCompositeOperation = 'screen'
    ctx.drawImage(off, 0, 0, vw, vh)
    if (mode === 'silhouette-fg') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.shadowColor = 'rgba(255, 120, 60, 0.9)'
      ctx.shadowBlur = 16
      ctx.drawImage(off, 0, 0, vw, vh)
      ctx.shadowBlur = 0
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  ctx.restore()
}

const COLORS = ['#7ee', '#ff7', '#f7f', '#7f7', '#f77', '#77f', '#fa7', '#7fa', '#a7f', '#f7a']
function colorForId(id: number): string { return COLORS[id % COLORS.length] }

function erodeBinary(src: Uint8Array, w: number, h: number, steps: number): Uint8Array {
  let curr = src
  for (let s = 0; s < steps; s++) {
    const next = new Uint8Array(curr.length)
    for (let yy = 1; yy < h - 1; yy++) {
      const row = yy * w
      for (let xx = 1; xx < w - 1; xx++) {
        const i = row + xx
        if (curr[i] && curr[i - 1] && curr[i + 1] && curr[i - w] && curr[i + w]) next[i] = 1
      }
    }
    curr = next
  }
  return curr
}

function dilateBinary(src: Uint8Array, w: number, h: number, steps: number): Uint8Array {
  let curr = src
  for (let s = 0; s < steps; s++) {
    const next = new Uint8Array(curr.length)
    for (let yy = 0; yy < h; yy++) {
      const row = yy * w
      for (let xx = 0; xx < w; xx++) {
        const i = row + xx
        if (curr[i]) { next[i] = 1; continue }
        if (xx > 0 && curr[i - 1]) { next[i] = 1; continue }
        if (xx < w - 1 && curr[i + 1]) { next[i] = 1; continue }
        if (yy > 0 && curr[i - w]) { next[i] = 1; continue }
        if (yy < h - 1 && curr[i + w]) { next[i] = 1; continue }
      }
    }
    curr = next
  }
  return curr
}

function floodFillFromSeeds(mask: Uint8Array, w: number, h: number, seedIndices: number[]): Uint8Array {
  const out = new Uint8Array(mask.length)
  const visited = new Uint8Array(mask.length)
  const stack: number[] = []
  for (const seed of seedIndices) {
    if (seed < 0 || seed >= mask.length) continue
    if (!mask[seed] || visited[seed]) continue
    stack.push(seed)
    while (stack.length > 0) {
      const j = stack.pop()!
      if (visited[j] || !mask[j]) continue
      visited[j] = 1
      out[j] = 1
      const xx = j % w
      const yy = (j - xx) / w
      if (xx > 0) stack.push(j - 1)
      if (xx < w - 1) stack.push(j + 1)
      if (yy > 0) stack.push(j - w)
      if (yy < h - 1) stack.push(j + w)
    }
  }
  return out
}

function StatusOverlay(props: { status: Status; errorMsg: string; fps: number; trackCount: number; faceReady: boolean }) {
  const { status, errorMsg, fps, trackCount, faceReady } = props
  const label: Record<Status, string> = {
    idle: 'idle',
    'loading-model': 'loading model',
    'requesting-camera': 'requesting camera',
    running: 'running',
    error: 'error',
  }
  const fpsColor = fps >= 50 ? '#7ee' : fps >= 30 ? '#ff7' : '#f77'
  return (
    <div style={statusOverlayStyle}>
      <span>{label[status]}</span>
      {status === 'running' && (
        <>
          <span style={{ opacity: 0.4 }}>·</span>
          <span style={{ color: fpsColor }}>{fps} fps</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{trackCount} tracked</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span style={{ color: faceReady ? '#7ee' : '#ff7' }}>face {faceReady ? 'ready' : 'loading'}</span>
        </>
      )}
      {status === 'error' && <span style={{ color: '#f77', marginLeft: 6 }}>{errorMsg}</span>}
    </div>
  )
}

function BottomPanel(props: {
  open: boolean
  toggle: () => void
  shape: ShapeMode
  target: TargetMode
  cameras: MediaDeviceInfo[]
  cameraDeviceId: string | null
  setShape: React.Dispatch<React.SetStateAction<ShapeMode>>
  setTarget: React.Dispatch<React.SetStateAction<TargetMode>>
  setCameraDeviceId: React.Dispatch<React.SetStateAction<string | null>>
}) {
  const { open, toggle, shape, target, cameras, cameraDeviceId,
    setShape, setTarget, setCameraDeviceId } = props
  return (
    <div style={bottomWrapStyle}>
      {open && (
        <div style={panelStyle}>
          {cameras.length > 0 && (
            <Row label="Camera">
              {cameras.map((c, i) => (
                <Toggle
                  key={c.deviceId || i}
                  on={cameraDeviceId === c.deviceId || (cameraDeviceId === null && i === 0)}
                  onClick={() => setCameraDeviceId((prev) => prev === c.deviceId ? null : c.deviceId)}
                >
                  {c.label || `Camera ${i + 1}`}
                </Toggle>
              ))}
            </Row>
          )}
          {TARGET_OPTIONS.length > 0 && (
            <Row label="Target">
              {TARGET_OPTIONS.map((t) => (
                <Toggle key={t} on={target === t} onClick={() => setTarget((prev) => prev === t ? 'none' : t)}>{targetLabel(t)}</Toggle>
              ))}
            </Row>
          )}
          {DISPLAY_OPTIONS.length > 0 && (
            <Row label="Display">
              {DISPLAY_OPTIONS.map((s) => (
                <Toggle key={s} on={shape === s} onClick={() => setShape((prev) => prev === s ? 'none' : s)}>{shapeLabel(s)}</Toggle>
              ))}
            </Row>
          )}
        </div>
      )}
      <button type="button" onClick={toggle} title="Settings" style={fabStyle(open)}>
        <GearIcon />
      </button>
    </div>
  )
}

function shapeLabel(s: ShapeMode): string {
  return ({ 'none': 'None', 'box': 'Box', 'silhouette-bg': 'Silhouette-bg', 'silhouette-fg': 'Silhouette-fg', 'silhouette-outline': 'Outline' } as const)[s]
}
function targetLabel(t: TargetMode): string {
  return ({ 'none': 'None', 'full-body': 'Full body', 'face': 'Face' } as const)[t]
}

function FullscreenButton({ isFullscreen }: { isFullscreen: boolean }) {
  function onClick() {
    if (isFullscreen) document.exitFullscreen().catch(() => {})
    else document.documentElement.requestFullscreen().catch(() => {})
  }
  return (
    <button type="button" onClick={onClick} style={fsBtnStyle} title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
      {isFullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
    </button>
  )
}

function GearIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .4 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.4 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .4-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.4H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.4 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}
function FullscreenEnterIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9 V4 H9" /><path d="M20 9 V4 H15" /><path d="M4 15 V20 H9" /><path d="M20 15 V20 H15" />
    </svg>
  )
}
function FullscreenExitIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 4 V9 H4" /><path d="M15 4 V9 H20" /><path d="M9 20 V15 H4" /><path d="M15 20 V15 H20" />
    </svg>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={rowLabelStyle}>{label}</span>
      <div style={rowChildrenStyle}>{children}</div>
    </div>
  )
}
function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} style={toggleStyle(on)}>{children}</button>
}

const containerStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: '#000', overflow: 'hidden',
}
const canvasStyle: React.CSSProperties = {
  width: '100%', height: '100%', objectFit: 'cover', display: 'block',
}
const hiddenToggleStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, width: 28, height: 28,
  background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, zIndex: 11,
}
const statusOverlayStyle: React.CSSProperties = {
  position: 'fixed', top: 14, left: 14, zIndex: 10,
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 13, fontWeight: 600,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.85)',
  pointerEvents: 'none', maxWidth: 'calc(100vw - 28px)',
}
const bottomWrapStyle: React.CSSProperties = {
  position: 'fixed', left: '50%', bottom: 16, transform: 'translateX(-50%)',
  zIndex: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
  maxWidth: 'calc(100vw - 28px)', width: 'max-content',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.85)',
}
const panelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  fontSize: 13, maxWidth: 'min(720px, calc(100vw - 28px))', alignItems: 'flex-start',
}
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
}
const rowLabelStyle: React.CSSProperties = {
  fontSize: 11, opacity: 0.7, letterSpacing: 0.5, textTransform: 'uppercase', minWidth: 70,
}
const rowChildrenStyle: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6,
}
const toggleStyle = (on: boolean): React.CSSProperties => ({
  background: on ? 'rgba(126,238,238,0.18)' : 'rgba(255,255,255,0.04)',
  border: `1px solid ${on ? 'rgba(126,238,238,0.7)' : 'rgba(255,255,255,0.25)'}`,
  color: '#fff', padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
  fontSize: 12, fontFamily: 'inherit', textShadow: '0 1px 2px rgba(0,0,0,0.6)',
})
const fabStyle = (open: boolean): React.CSSProperties => ({
  width: 48, height: 48, borderRadius: '50%',
  border: `1px solid ${open ? 'rgba(126,238,238,0.7)' : 'rgba(255,255,255,0.4)'}`,
  background: open ? 'rgba(126,238,238,0.18)' : 'rgba(0,0,0,0.55)',
  backdropFilter: 'blur(8px)',
  color: '#fff', cursor: 'pointer', padding: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  boxShadow: open ? '0 0 16px rgba(126,238,238,0.5)' : '0 2px 8px rgba(0,0,0,0.5)',
})
const enrollLinkStyle: React.CSSProperties = {
  position: 'fixed', top: 12, right: 14, zIndex: 11,
  color: '#fff', textDecoration: 'none', fontSize: 13,
  background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)',
  border: '1px solid rgba(255,255,255,0.35)', borderRadius: 6,
  padding: '6px 12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  textShadow: '0 1px 2px rgba(0,0,0,0.85)',
}
const fsBtnStyle: React.CSSProperties = {
  position: 'fixed', right: 16, bottom: 16, zIndex: 11,
  width: 42, height: 42, borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.4)',
  background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)',
  color: '#fff', cursor: 'pointer', padding: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 2px 8px rgba(0,0,0,0.5)', transition: 'opacity 200ms',
}
