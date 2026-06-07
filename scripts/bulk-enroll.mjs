#!/usr/bin/env node
// 사람 프로필 사진 일괄 등록 스크립트
// 사용: node scripts/bulk-enroll.mjs <루트 폴더>

import { chromium } from 'playwright'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join, relative, basename, dirname, extname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const SCRIPT_DIR = new URL('.', import.meta.url).pathname
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..')

function loadEnv() {
  const envPath = join(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return
  const text = readFileSync(envPath, 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
loadEnv()

const SB_URL = process.env.SB_URL || process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.SB_KEY || process.env.VITE_SUPABASE_ANON_KEY
if (!SB_URL || !SB_KEY) { console.error('SB_URL/SB_KEY missing'); process.exit(1) }

const ROOT = process.argv[2]
if (!ROOT) { console.error('Usage: node scripts/bulk-enroll.mjs <root-folder>'); process.exit(1) }

async function walk(dir) {
  const out = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(full)))
    else if (ent.isFile()) {
      const ext = extname(ent.name).toLowerCase()
      if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') out.push(full)
    }
  }
  return out
}

const BANNED = new Set([
  '정방형', '이름', '없음', '폴더', '사진', '프로필', '편집', '원본',
  '최종', '수정', '파일', '업로드', '정리중',
])
function extractName(s) {
  // macOS는 파일명을 NFD로 저장 — 한글 매칭을 위해 NFC로 정규화
  const normalized = s.normalize('NFC')
  const noExt = normalized.replace(/\.[^.]+$/, '')
  const m = noExt.match(/[가-힣]{2,4}/)
  if (!m) return null
  if (BANNED.has(m[0])) return null
  return m[0]
}
function personNameOf(filePath) {
  const fromFile = extractName(basename(filePath))
  if (fromFile) return fromFile
  let dir = dirname(filePath)
  for (let i = 0; i < 3; i++) {
    const fromDir = extractName(basename(dir))
    if (fromDir) return fromDir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function insertEmployee(name, embedding, notes) {
  const res = await fetch(`${SB_URL}/rest/v1/employees`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SB_KEY}`,
      apikey: SB_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ name, embedding, notes }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
}

async function fetchProcessedPaths() {
  // 이미 DB에 들어간 notes(=상대경로) 전체 수집 (페이지네이션)
  const set = new Set()
  let from = 0
  const PAGE = 1000
  while (true) {
    const url = `${SB_URL}/rest/v1/employees?select=notes&notes=not.is.null`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${SB_KEY}`,
        apikey: SB_KEY,
        Range: `${from}-${from + PAGE - 1}`,
      },
    })
    if (!res.ok) throw new Error(`fetch processed failed: HTTP ${res.status}`)
    const rows = await res.json()
    for (const r of rows) if (r.notes) set.add(r.notes)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return set
}

async function main() {
  console.log(`📂 walk: ${ROOT}`)
  const allFiles = await walk(ROOT)
  console.log(`   ${allFiles.length} images`)

  console.log('🗃 fetching already-processed paths from Supabase…')
  const processed = await fetchProcessedPaths()
  console.log(`   already processed: ${processed.size} rows`)

  console.log('🌐 launching Playwright Chromium…')
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('PAGE ERR:', msg.text()) })

  await page.setContent(`<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js"></script>
</head><body><script>
window.__ready = false
window.__error = null
async function init() {
  try {
    await faceapi.tf.setBackend('cpu')
    await faceapi.tf.ready()
    const MODEL_URL = 'https://h-mirror.wooo.uk/face-api-models'
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL)
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL)
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    window.__ready = true
  } catch (e) {
    window.__error = String(e && e.message || e)
    console.error('init failed:', window.__error)
  }
}
window.__processBase64 = async (b64) => {
  const img = new Image()
  img.src = b64
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
  const r = await faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor()
  if (!r) return null
  return Array.from(r.descriptor)
}
init()
</script></body></html>`)

  console.log('⏳ loading face-api (CPU backend)…')
  await page.waitForFunction(() => window.__ready === true || window.__error !== null, { timeout: 120000 })
  const err = await page.evaluate(() => window.__error)
  if (err) { console.error('face-api init failed:', err); await browser.close(); process.exit(1) }
  console.log('✓ face-api ready')

  const stats = { total: allFiles.length, done: 0, succeeded: 0, noName: 0, noFace: 0, failed: 0 }
  const t0 = Date.now()
  let lastLog = t0

  let skippedAlreadyDone = 0
  for (const file of allFiles) {
    stats.done++
    const notes = relative(process.env.HOME, file)
    if (processed.has(notes)) {
      skippedAlreadyDone++
      continue
    }
    const name = personNameOf(file)
    if (!name) {
      stats.noName++
      console.log(`⊘ no name: ${relative(ROOT, file)}`)
      continue
    }

    try {
      const buf = await readFile(file)
      const ext = extname(file).toLowerCase()
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
      const b64 = `data:${mime};base64,${buf.toString('base64')}`

      // 60초 timeout — 멈춘 페이지 방지
      const embedding = await Promise.race([
        page.evaluate(async (b) => window.__processBase64(b), b64),
        new Promise((_, rej) => setTimeout(() => rej(new Error('page.evaluate timeout 60s')), 60000)),
      ])
      if (!embedding) {
        stats.noFace++
        console.log(`✗ no face: ${name} ← ${relative(ROOT, file)}`)
        continue
      }
      await insertEmployee(name, embedding, notes)
      stats.succeeded++

      const now = Date.now()
      if (now - lastLog > 2000) {
        const elapsed = ((now - t0) / 1000).toFixed(0)
        console.log(`[${stats.done}/${stats.total}] ✓${stats.succeeded} ✗${stats.noFace} ⊘${stats.noName} (${elapsed}s)`)
        lastLog = now
      }
    } catch (e) {
      stats.failed++
      console.log(`✗ error: ${name} ← ${relative(ROOT, file)}: ${e.message}`)
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
  console.log('')
  console.log('=== DONE ===')
  console.log(`processed: ${stats.done}/${stats.total}`)
  console.log(`✓ enrolled (this run): ${stats.succeeded}`)
  console.log(`↺ already in DB (skipped): ${skippedAlreadyDone}`)
  console.log(`✗ no face: ${stats.noFace}`)
  console.log(`⊘ skipped (no name): ${stats.noName}`)
  console.log(`✗ errors: ${stats.failed}`)
  console.log(`elapsed: ${elapsed}s`)

  await browser.close()
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
