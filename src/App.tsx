import { useEffect, useRef, useState } from 'react'
import {
  FilesetResolver,
  ObjectDetector,
  ImageSegmenter,
  type ObjectDetectorResult,
  type ImageSegmenterResult,
} from '@mediapipe/tasks-vision'
import { AdminView } from './AdminView'
import { ReviewModal } from './ReviewModal'
import { extractAllEmbeddings, loadFaceModels } from './lib/faceApi'
import {
  countPendingCaptures, insertEmployee, insertPendingCapture,
  listEmployeeNames, matchFace, type MatchResult,
} from './lib/supabase'

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
// RPC가 Euclidean 거리 기반 (face-api 표준). 같은 사람 80-100%, 닮은 60-80%, 무관 50% 이하
// similarity = 1 - euclidean_distance (모든 후보에 동일 공식 = 같은 스케일)
const MATCH_THRESHOLD = 0.0        // 임계 0 — top-4 표시용이라 낮은 후보도 받음 (의미 없으면 row 자체가 없음)
const MATCH_TOP_K = 30             // dedupe 후 unique 4명 확보용
const DISPLAY_TOP_N = 4            // 1+3 (큰 + 작은 inline)
// 자동 캡쳐 — 메인페이지에 지나가는 사람들을 모아서 review 풀에 쌓아둠
const AUTO_CAPTURE_MIN_TRACK_AGE_MS = 1500   // 트랙이 안정될 때까지 기다림
const AUTO_CAPTURE_COOLDOWN_MS = 30000       // 같은 트랙은 30초마다 1장만
const AUTO_CAPTURE_MIN_FACE_PX = 56          // 너무 작은 얼굴 (먼 거리) 스킵
const PENDING_COUNT_REFRESH_MS = 30000       // 도움 버튼 배지 새로고침

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
  const [view, setView] = useState<'recognize' | 'admin'>(
    typeof window !== 'undefined' && window.location.hash === '#admin' ? 'admin' : 'recognize'
  )
  useEffect(() => {
    function onHash() {
      setView(window.location.hash === '#admin' ? 'admin' : 'recognize')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (view === 'admin') return <AdminView />
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
  const [captureModal, setCaptureModal] = useState<CaptureModalState | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [cameraDeviceId, setCameraDeviceId] = useState<string | null>(null)
  const [showReview, setShowReview] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  // 트랙 id 별 마지막 자동 캡쳐 시각 — 같은 사람 spam 방지
  const autoCaptureCooldownRef = useRef<Map<number, number>>(new Map())

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
  // closure 안에서 최신 값 읽기 위한 ref (state는 init useEffect에서 false로 캡쳐됨)
  const faceReadyRef = useRef(false)
  useEffect(() => { faceReadyRef.current = faceReady }, [faceReady])

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

  // pending capture 개수 주기적 새로고침 (도움 버튼 배지용)
  useEffect(() => {
    let cancelled = false
    async function fetchCount() {
      try {
        const c = await countPendingCaptures()
        if (!cancelled) setPendingCount(c)
      } catch { /* skip */ }
    }
    fetchCount()
    const id = setInterval(fetchCount, PENDING_COUNT_REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
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
    if (faceReadyRef.current && tracksRef.current.length > 0 &&
        !faceProcessingRef.current &&
        ts - lastFaceRunAtRef.current >= FACE_REFRESH_MS) {
      lastFaceRunAtRef.current = ts
      faceProcessingRef.current = true
      processFaceMatching(video, tracksRef.current, {
        cooldown: autoCaptureCooldownRef.current,
        onCaptured: () => setPendingCount((c) => c + 1),
      }).finally(() => {
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

      {/* Enroll 링크 제거됨 — 관리 페이지는 #admin 으로 URL 직접 입력해서 진입 */}

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

      {/* 우하단 도움 버튼 — 자동 캡쳐된 얼굴 분류/확정 모달 열기 */}
      {fsUiVisible && (
        <button
          type="button"
          onClick={() => setShowReview(true)}
          title="Help improve recognition"
          style={helpBtnStyle}
        >
          💡
          {pendingCount > 0 && <span style={helpBadgeStyle}>{pendingCount > 99 ? '99+' : pendingCount}</span>}
        </button>
      )}

      {showReview && (
        <ReviewModal
          onClose={() => setShowReview(false)}
          onChange={async () => {
            try { setPendingCount(await countPendingCaptures()) } catch { /* skip */ }
          }}
        />
      )}

      {/* 좌하단 캡쳐 버튼 — 현재 프레임 잡아서 인물 태깅 모달 띄움 */}
      {fsUiVisible && (
        <button
          type="button"
          onClick={handleCapture}
          disabled={!faceReady || capturing}
          title="Capture & tag faces"
          style={captureBtnStyle(capturing)}
        >
          {capturing ? '…' : '📸'}
        </button>
      )}

      {captureModal && (
        <CaptureTagModal
          state={captureModal}
          onCancel={() => setCaptureModal(null)}
          onSave={async (assignments) => {
            for (const a of assignments) {
              await insertEmployee(
                a.name,
                Array.from(a.descriptor),
                `webcam-${new Date().toISOString()}`,
                a.image_data,
              )
            }
            setCaptureModal(null)
          }}
        />
      )}
    </div>
  )

  async function handleCapture() {
    if (capturing) return
    const video = videoRef.current
    if (!video || video.readyState < 2) return
    setCapturing(true)
    try {
      const cap = document.createElement('canvas')
      cap.width = video.videoWidth
      cap.height = video.videoHeight
      const ctx = cap.getContext('2d')!
      if (mirrorRef.current) {
        ctx.translate(cap.width, 0)
        ctx.scale(-1, 1)
      }
      ctx.drawImage(video, 0, 0)
      ctx.setTransform(1, 0, 0, 1, 0, 0)

      const faces = await extractAllEmbeddings(cap)
      if (faces.length === 0) {
        alert('No faces detected in the captured frame.')
        return
      }
      const existingNames = await listEmployeeNames()
      const detected: CaptureFaceState[] = []
      for (const f of faces) {
        let topMatches: MatchResult[] = []
        try { topMatches = await matchFace(Array.from(f.descriptor), 3, 0.2) } catch { /* skip */ }
        detected.push({
          box: f.box,
          descriptor: f.descriptor,
          topMatches,
          assignment: {
            name: topMatches[0]?.name ?? '',
            mode: topMatches.length > 0 ? 'existing' : 'new',
          },
        })
      }
      setCaptureModal({
        imageDataUrl: cap.toDataURL('image/jpeg', 0.85),
        imageW: cap.width,
        imageH: cap.height,
        faces: detected,
        existingNames,
      })
    } catch (e) {
      alert(`Capture failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCapturing(false)
    }
  }
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
// + 트랙이 안정적이면 자동 캡쳐해서 pending pool에 적재 (review 모달에서 사람 확인)
async function processFaceMatching(
  video: HTMLVideoElement,
  tracks: Track[],
  autoCfg: { cooldown: Map<number, number>; onCaptured: () => void },
) {
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

    // 자동 캡쳐 — 트랙 안정 + cooldown OK + 얼굴 충분히 큰 경우
    const trackAge = now - best.firstSeenAt
    const lastCap = autoCfg.cooldown.get(best.id) ?? 0
    if (
      trackAge >= AUTO_CAPTURE_MIN_TRACK_AGE_MS &&
      now - lastCap >= AUTO_CAPTURE_COOLDOWN_MS &&
      face.box.width >= AUTO_CAPTURE_MIN_FACE_PX
    ) {
      autoCfg.cooldown.set(best.id, now)
      const thumb = cropFaceThumb(video, face.box)
      const top = best.matches[0]
      // fire-and-forget — UI를 막지 않도록
      insertPendingCapture({
        image_data: thumb,
        embedding: Array.from(face.descriptor),
        auto_top_name: top?.name ?? null,
        auto_top_similarity: top?.similarity ?? null,
      }).then(() => autoCfg.onCaptured()).catch(() => { /* skip */ })
    }
  }
}

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataUrl
  })
}

function cropFromImage(img: HTMLImageElement, box: { x: number; y: number; width: number; height: number }): string {
  const SIZE = 200
  const PAD = 0.25
  const padW = box.width * PAD
  const padH = box.height * PAD
  const sx = Math.max(0, box.x - padW)
  const sy = Math.max(0, box.y - padH)
  const sw = Math.min(img.width - sx, box.width + padW * 2)
  const sh = Math.min(img.height - sy, box.height + padH * 2)
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, SIZE, SIZE)
  return canvas.toDataURL('image/jpeg', 0.78)
}

function cropFaceThumb(video: HTMLVideoElement, box: { x: number; y: number; width: number; height: number }): string {
  const SIZE = 200
  const PAD = 0.25
  const padW = box.width * PAD
  const padH = box.height * PAD
  const sx = Math.max(0, box.x - padW)
  const sy = Math.max(0, box.y - padH)
  const sw = Math.min(video.videoWidth - sx, box.width + padW * 2)
  const sh = Math.min(video.videoHeight - sy, box.height + padH * 2)
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, SIZE, SIZE)
  return canvas.toDataURL('image/jpeg', 0.78)
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

  // 매칭 결과 — 이름 기준 dedupe 후 unique top-N 추출
  const dedup: { name: string; similarity: number }[] = []
  for (const m of t.matches) {
    if (!dedup.find((d) => d.name === m.name)) dedup.push(m)
    if (dedup.length >= DISPLAY_TOP_N) break
  }

  ctx.save()
  ctx.font = 'bold 20px ui-sans-serif, system-ui, sans-serif'
  const headFont = ctx.font
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
  const subFont = ctx.font

  // 1줄: 큰 1위 / 2줄: 2~4위 가로 inline
  const headLine = dedup.length > 0
    ? `${dedup[0].name} (${(dedup[0].similarity * 100).toFixed(0)}%)`
    : (t.lastFaceProcessedAt === 0 ? 'Searching…' : 'Unknown')

  const others = dedup.slice(1)
  const subLine = others.map((d) => `${d.name} (${(d.similarity * 100).toFixed(0)}%)`).join('   ')

  ctx.font = headFont
  const headW = ctx.measureText(headLine).width
  ctx.font = subFont
  const subW = subLine ? ctx.measureText(subLine).width : 0

  const padX = 14
  const padY = 8
  const headH = 26
  const subH = subLine ? 18 : 0
  const gap = subLine ? 4 : 0
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
  ctx.font = headFont
  ctx.fillStyle = '#fff'
  ctx.fillText(headLine, bx + padX, by + padY)
  if (subLine) {
    ctx.font = subFont
    ctx.fillStyle = '#aaa'
    ctx.fillText(subLine, bx + padX, by + padY + headH + gap)
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

// ─── 캡쳐 모달 — 잡은 프레임에서 인물 태깅 ─────────────

type CaptureFaceState = {
  box: { x: number; y: number; width: number; height: number }
  descriptor: Float32Array
  topMatches: MatchResult[]
  assignment: { name: string; mode: 'existing' | 'new' }
}
type CaptureModalState = {
  imageDataUrl: string
  imageW: number
  imageH: number
  faces: CaptureFaceState[]
  existingNames: string[]
}

function CaptureTagModal(props: {
  state: CaptureModalState
  onCancel: () => void
  onSave: (assignments: Array<{ name: string; descriptor: Float32Array; image_data: string }>) => Promise<void>
}) {
  const { state, onCancel, onSave } = props
  const [faces, setFaces] = useState<CaptureFaceState[]>(state.faces)
  const [saving, setSaving] = useState(false)

  function patchFace(idx: number, patch: Partial<CaptureFaceState['assignment']>) {
    setFaces((prev) => prev.map((f, i) => (i === idx ? { ...f, assignment: { ...f.assignment, ...patch } } : f)))
  }

  const validAssignments = faces.filter((f) => f.assignment.name.trim())

  async function handleSave() {
    if (validAssignments.length === 0) return
    setSaving(true)
    try {
      // 저장 시 각 얼굴을 캡쳐 이미지에서 잘라 200x200 썸네일로 같이 저장
      const sourceImg = await loadImageFromDataUrl(state.imageDataUrl)
      const payload = validAssignments.map((f) => ({
        name: f.assignment.name.trim(),
        descriptor: f.descriptor,
        image_data: cropFromImage(sourceImg, f.box),
      }))
      await onSave(payload)
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  // 이미지 표시 시 박스 오버레이용 비율
  const previewMaxW = 540
  const scale = state.imageW > previewMaxW ? previewMaxW / state.imageW : 1
  const previewW = state.imageW * scale
  const previewH = state.imageH * scale

  return (
    <div style={modalBackdropStyle} onClick={onCancel}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Tag {faces.length} face{faces.length === 1 ? '' : 's'}</h2>
          <button type="button" onClick={onCancel} style={modalCloseStyle}>✕</button>
        </div>
        <div style={{ position: 'relative', maxWidth: previewW, marginBottom: 16 }}>
          <img src={state.imageDataUrl} alt="capture" style={{ width: previewW, height: previewH, borderRadius: 6, display: 'block' }} />
          {faces.map((f, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: f.box.x * scale,
                top: f.box.y * scale,
                width: f.box.width * scale,
                height: f.box.height * scale,
                border: `2px solid ${cycleColor(i)}`,
                borderRadius: 4,
                boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
                pointerEvents: 'none',
              }}
            >
              <span style={{
                position: 'absolute', top: -22, left: 0,
                background: cycleColor(i), color: '#000',
                fontSize: 12, padding: '2px 6px', borderRadius: 3, fontWeight: 700,
              }}>#{i + 1}</span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {faces.map((f, i) => (
            <CaptureFaceCard
              key={i}
              index={i}
              face={f}
              existingNames={state.existingNames}
              onChange={(patch) => patchFace(i, patch)}
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onCancel} style={modalSecondaryBtnStyle}>Cancel</button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || validAssignments.length === 0}
            style={modalPrimaryBtnStyle}
          >
            {saving ? 'Saving…' : `Save ${validAssignments.length}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function CaptureFaceCard(props: {
  index: number
  face: CaptureFaceState
  existingNames: string[]
  onChange: (patch: Partial<CaptureFaceState['assignment']>) => void
}) {
  const { index, face, existingNames, onChange } = props
  const color = cycleColor(index)
  const listId = `existing-names-${index}`

  return (
    <div style={faceCardStyle(color)}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span style={{ background: color, color: '#000', padding: '2px 7px', borderRadius: 3, fontWeight: 700, fontSize: 12 }}>#{index + 1}</span>
        {face.topMatches.length > 0 ? (
          <span style={{ fontSize: 13 }}>
            Top match: <b>{face.topMatches[0].name}</b> ({(face.topMatches[0].similarity * 100).toFixed(0)}%)
            {face.topMatches[1] && (
              <span style={{ opacity: 0.7 }}>
                {' '}· {face.topMatches[1].name} ({(face.topMatches[1].similarity * 100).toFixed(0)}%)
              </span>
            )}
          </span>
        ) : (
          <span style={{ fontSize: 13, opacity: 0.7 }}>No match in DB</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13 }}>
          <input
            type="radio"
            checked={face.assignment.mode === 'existing'}
            onChange={() => onChange({ mode: 'existing' })}
          />
          Existing
        </label>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13 }}>
          <input
            type="radio"
            checked={face.assignment.mode === 'new'}
            onChange={() => onChange({ mode: 'new', name: '' })}
          />
          New person
        </label>
        <input
          type="text"
          list={face.assignment.mode === 'existing' ? listId : undefined}
          value={face.assignment.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={face.assignment.mode === 'existing' ? 'Select or type existing' : 'New name'}
          style={modalInputStyle}
        />
        <datalist id={listId}>
          {existingNames.map((n) => <option key={n} value={n} />)}
        </datalist>
      </div>
    </div>
  )
}

const MODAL_COLORS = ['#7ee', '#ff7', '#f7f', '#7f7', '#f77', '#77f', '#fa7', '#7fa', '#a7f', '#f7a']
function cycleColor(i: number): string { return MODAL_COLORS[i % MODAL_COLORS.length] }

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
const modalBackdropStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 20, overflow: 'auto',
}
const modalContentStyle: React.CSSProperties = {
  background: '#13161a', color: '#e8e8e8',
  borderRadius: 12, padding: 20, maxWidth: 640, width: '100%',
  border: '1px solid rgba(255,255,255,0.1)',
  maxHeight: 'calc(100vh - 40px)', overflow: 'auto',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
}
const modalCloseStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#aaa',
  cursor: 'pointer', fontSize: 18, padding: 4,
}
const modalInputStyle: React.CSSProperties = {
  flex: 1, minWidth: 140,
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '6px 10px', borderRadius: 5, fontSize: 13, outline: 'none',
}
const modalPrimaryBtnStyle: React.CSSProperties = {
  background: 'rgba(126,238,238,0.18)', border: '1px solid rgba(126,238,238,0.7)',
  color: '#fff', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 14,
}
const modalSecondaryBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 14,
}
const faceCardStyle = (color: string): React.CSSProperties => ({
  background: 'rgba(255,255,255,0.04)',
  border: `1px solid ${color}55`,
  borderRadius: 8, padding: 12,
})

const captureBtnStyle = (busy: boolean): React.CSSProperties => ({
  position: 'fixed', left: 16, bottom: 16, zIndex: 11,
  width: 52, height: 52, borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.45)',
  background: busy ? 'rgba(255,180,80,0.4)' : 'rgba(0,0,0,0.6)',
  backdropFilter: 'blur(8px)',
  color: '#fff', cursor: busy ? 'wait' : 'pointer', padding: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 22,
  boxShadow: '0 2px 8px rgba(0,0,0,0.5)', transition: 'opacity 200ms',
})

const fsBtnStyle: React.CSSProperties = {
  position: 'fixed', right: 16, bottom: 16, zIndex: 11,
  width: 42, height: 42, borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.4)',
  background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)',
  color: '#fff', cursor: 'pointer', padding: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 2px 8px rgba(0,0,0,0.5)', transition: 'opacity 200ms',
}

const helpBtnStyle: React.CSSProperties = {
  position: 'fixed', right: 66, bottom: 16, zIndex: 11,
  width: 42, height: 42, borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.4)',
  background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)',
  color: '#fff', cursor: 'pointer', padding: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 2px 8px rgba(0,0,0,0.5)', transition: 'opacity 200ms',
  fontSize: 18,
}
const helpBadgeStyle: React.CSSProperties = {
  position: 'absolute', top: -4, right: -4,
  minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
  background: '#ff5050', color: '#fff', fontSize: 11, fontWeight: 700,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: '1px solid rgba(0,0,0,0.4)',
  fontFamily: 'ui-monospace, monospace',
}
