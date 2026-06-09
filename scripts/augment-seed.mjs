#!/usr/bin/env node
/*
 * 시드 증강 부트스트랩 — flex 스튜디오 사진 1장뿐인 인물의 임베딩을 보강한다.
 * ------------------------------------------------------------
 * 저장된 얼굴 썸네일(image_data)을 "배포 카메라 화질"에 가깝게 변형
 * (저해상/블러/밝기·대비/압축)해서 추가 임베딩을 만들어 등록한다.
 * → 첫날 스튜디오사진 ↔ 그레이니 웹캠 매칭 갭을 좁혀, 자동수집 플라이휠을 점화.
 *
 * 자세(각도) 변화는 못 만든다(원본이 정면 1장). 화질/조명 갭을 메우는 용도.
 * 효과는 실제 카메라에 따라 다르므로, 며칠 운영해 보고 필요하면 실행 권장.
 *
 * 실행:   node scripts/augment-seed.mjs           # 샘플 적은 인물에 증강 임베딩 추가
 *         node scripts/augment-seed.mjs undo      # 추가분(notes=augment-*) 전부 삭제(되돌리기)
 *         AUGMENT_IF_SAMPLES_LE=3 node scripts/augment-seed.mjs   # 임계 조정
 */
import { chromium } from 'playwright'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import sharp from 'sharp'

const DIR = new URL('.', import.meta.url).pathname
const ROOT = resolve(DIR, '..')

function loadEnv() {
  for (const f of ['.env', '.env.local']) {
    const p = join(ROOT, f)
    if (!existsSync(p)) continue
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

const SAMPLES_LE = +(process.env.AUGMENT_IF_SAMPLES_LE || 2)   // 샘플 수 이하인 인물만 대상
const TAG = 'augment-' + new Date().toISOString().slice(0, 10)

async function undo() {
  console.log('↩ 증강분(notes=augment-*) 삭제 중…')
  const r = await fetch(`${SB}/rest/v1/employees?notes=like.augment-*`, { method: 'DELETE', headers: { ...H, Prefer: 'count=exact' } })
  if (!r.ok) { console.error('삭제 실패', r.status, await r.text()); process.exit(1) }
  console.log('✓ 삭제 완료:', (r.headers.get('content-range') || '/?').split('/')[1])
}

async function fetchEmployees() {
  const all = []; let from = 0; const PAGE = 1000
  while (true) {
    const r = await fetch(`${SB}/rest/v1/employees?select=id,name,image_data,notes&order=created_at.asc`, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } })
    if (!r.ok) throw new Error('fetch employees ' + r.status)
    const rows = await r.json(); all.push(...rows)
    if (rows.length < PAGE) break; from += PAGE
  }
  return all
}

// 원본 썸네일(base64) → 카메라 화질 모사 변형 3종(base64 data URL)
async function variants(dataUrl) {
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
  const buf = Buffer.from(b64, 'base64')
  const mk = async (pipe) => 'data:image/jpeg;base64,' + (await pipe.jpeg({ quality: 72 }).toBuffer()).toString('base64')
  return [
    await mk(sharp(buf).resize(112, 112, { fit: 'cover' })),                          // 저해상(거리감)
    await mk(sharp(buf).resize(168, 168, { fit: 'cover' }).blur(1.1).modulate({ brightness: 1.18 })), // 블러+밝게
    await mk(sharp(buf).resize(168, 168, { fit: 'cover' }).modulate({ brightness: 0.84 }).linear(1.15, -8)), // 어둡게+대비
  ]
}

async function insert(name, embedding, image_data) {
  const r = await fetch(`${SB}/rest/v1/employees`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ name, embedding, image_data, notes: TAG + '/' + name }),
  })
  if (!r.ok) throw new Error('insert ' + r.status + ' ' + (await r.text()).slice(0, 80))
}

async function main() {
  if (process.argv[2] === 'undo') return undo()

  console.log('📥 employees 조회…')
  const rows = await fetchEmployees()
  const byName = new Map()
  for (const e of rows) { const l = byName.get(e.name) || []; l.push(e); byName.set(e.name, l) }

  // 대상: 샘플 수 ≤ SAMPLES_LE 이고, 증강분이 아직 없는 인물 + 썸네일 보유
  const targets = []
  for (const [name, list] of byName) {
    const augCount = list.filter((e) => (e.notes || '').startsWith('augment-')).length
    const baseCount = list.length - augCount
    if (baseCount > SAMPLES_LE || augCount > 0) continue
    const base = list.find((e) => e.image_data && e.image_data.length > 100)
    if (!base) continue
    targets.push({ name, base })
  }
  console.log(`   대상 인물 ${targets.length}명 (샘플 ≤ ${SAMPLES_LE}, 증강 미적용)`)
  if (targets.length === 0) return

  console.log('🌐 face-api(headless) 로딩…')
  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const page = await browser.newPage()
  await page.setContent(`<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js"></script>
</head><body><script>
window.__ready=false; window.__err=null;
(async()=>{ try{
  await faceapi.tf.setBackend('cpu'); await faceapi.tf.ready();
  const M='https://h-mirror.wooo.uk/face-api-models';
  await faceapi.nets.tinyFaceDetector.loadFromUri(M);
  await faceapi.nets.faceLandmark68Net.loadFromUri(M);
  await faceapi.nets.faceRecognitionNet.loadFromUri(M);
  window.__ready=true;
}catch(e){ window.__err=String(e&&e.message||e) } })();
window.__embed=async(b64)=>{ const img=new Image(); img.src=b64;
  await new Promise((r,j)=>{img.onload=r;img.onerror=j});
  const r=await faceapi.detectSingleFace(img,new faceapi.TinyFaceDetectorOptions({inputSize:320,scoreThreshold:0.3})).withFaceLandmarks().withFaceDescriptor();
  return r? Array.from(r.descriptor): null;
};
</script></body></html>`)
  await page.waitForFunction(() => window.__ready === true || window.__err !== null, { timeout: 120000 })
  const err = await page.evaluate(() => window.__err)
  if (err) { console.error('face-api init 실패:', err); await browser.close(); process.exit(1) }
  console.log('✓ face-api 준비')

  let added = 0, noFace = 0
  const t0 = Date.now()
  for (let i = 0; i < targets.length; i++) {
    const { name, base } = targets[i]
    try {
      const vs = await variants(base.image_data)
      for (const v of vs) {
        const emb = await page.evaluate((b) => window.__embed(b), v)
        if (!emb) { noFace++; continue }
        await insert(name, emb, base.image_data)  // 미리보기는 원본 썸네일 유지
        added++
      }
    } catch (e) { console.log(`✗ ${name}: ${e.message}`) }
    if ((i + 1) % 10 === 0) console.log(`  [${i + 1}/${targets.length}] +${added} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  }
  await browser.close()
  console.log(`=== 완료 === 추가 임베딩 ${added}, 얼굴미검출 변형 ${noFace}`)
  console.log('되돌리기: node scripts/augment-seed.mjs undo')
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
