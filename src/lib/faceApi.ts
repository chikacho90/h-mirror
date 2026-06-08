import * as faceapi from '@vladmandic/face-api'

let loadingPromise: Promise<void> | null = null
let loaded = false

export async function loadFaceModels(): Promise<void> {
  if (loaded) return
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    const MODEL_URL = `${import.meta.env.BASE_URL || '/'}face-api-models`.replace(/\/+/g, '/')
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL)
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL)
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    loaded = true
  })()
  return loadingPromise
}

export function isLoaded(): boolean { return loaded }

type Source = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap

export async function extractSingleEmbedding(source: Source): Promise<{
  descriptor: Float32Array
  box: { x: number; y: number; width: number; height: number }
} | null> {
  await loadFaceModels()
  const result = await faceapi
    .detectSingleFace(source as faceapi.TNetInput, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
    .withFaceLandmarks()
    .withFaceDescriptor()
  if (!result) return null
  const box = result.detection.box
  return { descriptor: result.descriptor, box: { x: box.x, y: box.y, width: box.width, height: box.height } }
}

export async function extractAllEmbeddings(source: Source): Promise<Array<{
  descriptor: Float32Array
  box: { x: number; y: number; width: number; height: number }
}>> {
  await loadFaceModels()
  const results = await faceapi
    .detectAllFaces(source as faceapi.TNetInput, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
    .withFaceLandmarks()
    .withFaceDescriptors()
  return results.map((r) => {
    const box = r.detection.box
    return { descriptor: r.descriptor, box: { x: box.x, y: box.y, width: box.width, height: box.height } }
  })
}
