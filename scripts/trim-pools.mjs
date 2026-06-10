#!/usr/bin/env node
/*
 * 인물별 임베딩 상한(CAP)을 DB 전체에 일괄 적용 — 다양성 보존 방식.
 * supabase.ts의 insertEmployeeWithDiversityCap와 동일 로직(전역 최근접이웃 기반)으로,
 * CAP 초과 인물의 "가장 중복된" 임베딩부터 제거해 가장 넓게 퍼진 CAP장만 남긴다.
 *
 * 실행:  node scripts/trim-pools.mjs            # CAP=30(기본)
 *        CAP=30 node scripts/trim-pools.mjs
 *        DRY=1 node scripts/trim-pools.mjs      # 미리보기(삭제 안 함)
 *
 * ⚠ supabase.ts의 MAX_PHOTOS_PER_PERSON과 값을 맞춰 둘 것.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..')
function loadEnv() {
  for (const f of ['.env', '.env.local']) {
    const p = join(ROOT, f); if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
}
loadEnv()

const SB = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!SB || !KEY) { console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 없음'); process.exit(1) }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }
const CAP = +(process.env.CAP || 30)
const DRY = !!process.env.DRY

function parseEmb(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return null } }
  return null
}
function euclid(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d } return Math.sqrt(s) }

async function fetchAll() {
  const all = []; let from = 0; const PAGE = 1000
  while (true) {
    const r = await fetch(`${SB}/rest/v1/employees?select=id,name,embedding`, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } })
    if (!r.ok) throw new Error('fetch ' + r.status)
    const rows = await r.json(); all.push(...rows)
    if (rows.length < PAGE) break; from += PAGE
  }
  return all
}

// pts(파싱된 임베딩 배열)에서 CAP 이하가 될 때까지 가장 중복된 점부터 제거 → 제거된 id 목록 반환
function pickToDelete(pts) {
  const work = pts.slice()
  const removed = []
  while (work.length > CAP) {
    let idx = -1, smallestNN = Infinity
    for (let i = 0; i < work.length; i++) {
      let nn = Infinity
      for (let j = 0; j < work.length; j++) {
        if (i === j) continue
        const d = euclid(work[i].emb, work[j].emb)
        if (d < nn) nn = d
      }
      if (nn < smallestNN) { smallestNN = nn; idx = i }
    }
    if (idx < 0) break
    removed.push(work[idx].id)
    work.splice(idx, 1)
  }
  return removed
}

async function main() {
  console.log(`📥 employees 조회… (CAP=${CAP}${DRY ? ', DRY' : ''})`)
  const rows = await fetchAll()
  const byName = new Map()
  for (const e of rows) { const l = byName.get(e.name) || []; l.push(e); byName.set(e.name, l) }

  const over = [...byName.entries()].filter(([, l]) => l.length > CAP)
  console.log(`   초과 인물 ${over.length}명`)
  let totalDel = 0
  for (const [name, list] of over) {
    const pts = []
    for (const r of list) { const e = parseEmb(r.embedding); if (e) pts.push({ id: r.id, emb: e }) }
    const del = pickToDelete(pts)
    console.log(`  ${name}: ${list.length} → ${list.length - del.length} (삭제 ${del.length})`)
    totalDel += del.length
    if (!DRY && del.length) {
      // id IN (...) 일괄 삭제 (URL 길이 고려해 100개씩)
      for (let i = 0; i < del.length; i += 100) {
        const chunk = del.slice(i, i + 100)
        const inList = chunk.map((id) => `"${id}"`).join(',')
        const r = await fetch(`${SB}/rest/v1/employees?id=in.(${encodeURIComponent(inList)})`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } })
        if (!r.ok) throw new Error(`delete ${name}: ${r.status} ${await r.text()}`)
      }
    }
  }
  console.log(`=== ${DRY ? '[DRY] 삭제 예정' : '삭제 완료'}: ${totalDel}개 ===`)
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
