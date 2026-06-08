#!/usr/bin/env node
// employees.image_data 백필 — notes 컬럼의 상대경로에서 원본 사진 읽어와
// 200x200 center-crop JPEG 썸네일을 base64로 저장.

import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import sharp from 'sharp'

const SCRIPT_DIR = new URL('.', import.meta.url).pathname
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..')

function loadEnv() {
  const envPath = join(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
loadEnv()

const SB_URL = process.env.SB_URL || process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.SB_KEY || process.env.VITE_SUPABASE_ANON_KEY
if (!SB_URL || !SB_KEY) { console.error('SB_URL/SB_KEY missing'); process.exit(1) }

const HOME = process.env.HOME
const SIZE = 200
const PAGE = 500

const headers = {
  Authorization: `Bearer ${SB_KEY}`,
  apikey: SB_KEY,
  'Content-Type': 'application/json',
}

async function fetchAllPending() {
  const all = []
  let offset = 0
  while (true) {
    const url = `${SB_URL}/rest/v1/employees?select=id,notes&image_data=is.null&notes=not.is.null&order=created_at.asc&offset=${offset}&limit=${PAGE}`
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`)
    const rows = await res.json()
    all.push(...rows)
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return all
}

async function updateThumb(id, image_data) {
  const res = await fetch(`${SB_URL}/rest/v1/employees?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ image_data }),
  })
  if (!res.ok) throw new Error(`update ${id}: ${res.status} ${await res.text()}`)
}

async function centerCropToBase64(buf) {
  // sharp가 메타 읽고 cover 모드로 center crop + resize → JPEG
  const out = await sharp(buf)
    .rotate()                                 // EXIF orientation 적용
    .resize(SIZE, SIZE, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 75 })
    .toBuffer()
  return `data:image/jpeg;base64,${out.toString('base64')}`
}

async function main() {
  console.log('📥 fetching pending rows…')
  const rows = await fetchAllPending()
  console.log(`   ${rows.length} rows need image_data`)

  let ok = 0, missing = 0, fail = 0
  const t0 = Date.now()
  let lastLog = t0

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const path = join(HOME, r.notes)
    if (!existsSync(path)) {
      missing++
    } else {
      try {
        const buf = readFileSync(path)
        const dataUrl = await centerCropToBase64(buf)
        await updateThumb(r.id, dataUrl)
        ok++
      } catch (e) {
        fail++
        console.log(`✗ ${r.id} ${r.notes}: ${e.message}`)
      }
    }
    const now = Date.now()
    if (now - lastLog > 2000) {
      const elapsed = ((now - t0) / 1000).toFixed(0)
      console.log(`[${i + 1}/${rows.length}] ✓${ok} ✗${fail} ⊘${missing} (${elapsed}s)`)
      lastLog = now
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
  console.log('=== DONE ===')
  console.log(`total: ${rows.length}`)
  console.log(`✓ backfilled: ${ok}`)
  console.log(`⊘ source file missing: ${missing}`)
  console.log(`✗ errors: ${fail}`)
  console.log(`elapsed: ${elapsed}s`)
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
