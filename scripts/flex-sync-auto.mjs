#!/usr/bin/env node
/*
 * flex.team → h-mirror 무인 자동 동기화
 * ------------------------------------------------------------
 * Playwright로 전용 프로필 Chrome을 (헤드리스로) 띄워서:
 *   1) flex.team 로그인 (전용 프로필에 세션 유지 → 보통은 자동 통과,
 *      세션 없으면 .env.local의 구글 계정·비번으로 자동 로그인)
 *   2) 구성원 페이지에서 현직 명단을 가져와 Supabase DB와 대조
 *   3) 신규/새사진 → 얼굴 임베딩 생성 후 등록, 퇴사자 → 삭제
 *
 * 실행:
 *   bun run sync            # 헤드리스(스케줄용)
 *   HEADED=1 bun run sync   # 창 띄워서(최초 1회 권장: 구글이 기기를 신뢰하게 됨)
 *   DRY=1 bun run sync      # 변경 없이 차이만 출력
 *
 * 필요한 .env.local 값:
 *   FLEX_EMAIL=kyungmin.woo@hnine.com
 *   FLEX_PASSWORD=...(구글 계정 비번)
 */
import { chromium } from 'playwright'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'

// 실패 시 macOS 알림 (무인 운영 중 문제 인지용)
function notify(msg) {
  try { execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "flex 동기화"`]) } catch { /* skip */ }
}

const DIR = new URL('.', import.meta.url).pathname
const ROOT = resolve(DIR, '..')

function loadEnv() {
  for (const f of ['.env', '.env.local']) {
    const p = join(ROOT, f)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
}
loadEnv()

const SB = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const EMAIL = process.env.FLEX_EMAIL
const PASSWORD = process.env.FLEX_PASSWORD
const CID = process.env.FLEX_CUSTOMER_ID || 'PM0v716lzX'
const MODELS = process.env.FACE_MODELS_URL || 'https://h-mirror.wooo.uk/face-api-models'
const FACEAPI = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js'
const PROFILE = join(DIR, '.flex-profile')
// 기본 창 모드(HEADED). 헤드리스는 세션 만료 시 구글이 "본인 인증"으로 막으므로 재로그인 불가.
// 세션이 확실히 살아있을 때 창 없이 돌리려면 HEADLESS=1.
const HEADED = process.env.HEADLESS !== '1'
const DRY = !!process.env.DRY

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)

if (!SB || !KEY) { console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 없음 (.env)'); process.exit(1) }
if (!EMAIL || !PASSWORD) { console.error('FLEX_EMAIL / FLEX_PASSWORD 없음 (.env.local)'); process.exit(1) }

mkdirSync(PROFILE, { recursive: true })

// flex 로그인 여부 확인: 구성원 검색 API가 200이면 로그인됨
async function isLoggedIn(page) {
  try {
  return await page.evaluate(async (cid) => {
    try {
      const r = await fetch(`/action/v2/search/customers/${cid}/time-series/search-users?size=1`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sorts: [{ sortType: 'DISPLAY_NAME', directionType: 'ASC' }], filter: { userStatuses: ['IN_EMPLOY'], jobTitleIdHashes: [], jobRankIdHashes: [], jobRoleIdHashes: [], departmentIdHashes: [], jobGroupIdHashes: [], headUsers: [] } }),
      })
      return r.status === 200
    } catch { return false }
  }, CID)
  } catch { return false }  // 내비게이션 중 컨텍스트 파괴 등
}

// flex 앱 안(로그인 완료)인가? — 로그인 페이지(/auth)는 제외
const inApp = (u) => /flex\.team/.test(u) && !/\/auth(\/|$|\?)/.test(u)

async function doLogin(page) {
  log('로그인 시도…')
  await page.goto('https://flex.team/auth/login', { waitUntil: 'domcontentloaded' })
  await page.getByText('Google 계정으로 로그인', { exact: false }).first().click({ timeout: 15000 })

  // ★ 반드시 구글 페이지로 넘어간 뒤에 입력 (안 그러면 flex 로그인칸을 잘못 채움)
  await page.waitForURL(/accounts\.google\.com/, { timeout: 25000 })
  await page.waitForLoadState('domcontentloaded').catch(() => {})

  // 구글 이메일칸 또는 계정선택칸 (숨겨진 decoy 제외 → :visible)
  const emailIn = page.locator('input[type="email"]:visible').first()
  const chooser = page.locator(`[data-identifier="${EMAIL}"]`).first()
  await Promise.race([
    emailIn.waitFor({ state: 'visible', timeout: 25000 }),
    chooser.waitFor({ state: 'visible', timeout: 25000 }),
  ]).catch(() => {})

  if (await chooser.isVisible({ timeout: 1000 }).catch(() => false)) {
    log('계정 선택'); await chooser.click().catch(() => {})
  } else if (await emailIn.isVisible({ timeout: 1000 }).catch(() => false)) {
    log('이메일 입력'); await emailIn.click(); await emailIn.fill(EMAIL)
    if (!(await emailIn.inputValue().catch(() => ''))) { await emailIn.pressSequentially(EMAIL, { delay: 30 }) }
    await page.keyboard.press('Enter')
  } else {
    log('구글 로그인 폼을 못 찾음 (이미 로그인됐을 수도)')
  }

  // 비번 페이지 (계정선택/이메일 양쪽 이후 공통) — 보이는 필드만
  const pwIn = page.locator('input[type="password"]:visible').first()
  if (await pwIn.waitFor({ state: 'visible', timeout: 25000 }).then(() => true).catch(() => false)) {
    log('비번 입력'); await pwIn.click(); await pwIn.fill(PASSWORD)
    if (!(await pwIn.inputValue().catch(() => ''))) { await pwIn.pressSequentially(PASSWORD, { delay: 30 }) }
    await page.keyboard.press('Enter')
  }

  // 동의 화면이 나올 수 있음 (best-effort)
  await page.waitForTimeout(2500)
  const cont = page.getByRole('button', { name: /계속|허용|Continue|Allow|확인/ })
  if (await cont.first().isVisible({ timeout: 1500 }).catch(() => false)) { log('동의'); await cont.first().click().catch(() => {}) }

  // 로그인 완료(구성원 API 200)까지 폴링. 구글 "본인 인증"(휴대폰 탭) 화면이면 안내 후 대기.
  log('로그인 완료 대기…')
  let warned = false
  const iters = HEADED ? 120 : 30 // HEADED면 휴대폰 탭 시간(~3분) 확보
  for (let i = 0; i < iters; i++) {
    if (inApp(page.url()) && await isLoggedIn(page)) return
    if (!warned && /본인 인증|verify it.?s you|Verify it/i.test(await page.content().catch(() => ''))) {
      warned = true
      log('⚠ 구글 본인 인증 요구 — 휴대폰 Gmail 앱에서 표시된 번호를 탭하세요(대기 중)…')
      notify('구글 본인 인증 — 휴대폰에서 번호를 탭하세요')
    }
    await page.waitForTimeout(1500)
  }
}

// 인페이지 동기화 — 북마클릿과 동일 로직, 결과를 객체로 반환
async function runSync(page) {
  await page.addScriptTag({ url: FACEAPI })
  return await page.evaluate(async ({ SB, KEY, CID, MODELS, DRY }) => {
    const SBH = { apikey: KEY, Authorization: 'Bearer ' + KEY }
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS)
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODELS)
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODELS)

    const body = { sorts: [{ sortType: 'DISPLAY_NAME', directionType: 'ASC' }], filter: { jobTitleIdHashes: [], jobRankIdHashes: [], jobRoleIdHashes: [], departmentIdHashes: [], userStatuses: ['LEAVE_OF_ABSENCE', 'LEAVE_OF_ABSENCE_SCHEDULED', 'RESIGNATION_SCHEDULED', 'IN_APPRENTICESHIP', 'IN_EMPLOY'], jobGroupIdHashes: [], headUsers: [] } }
    const rr = await fetch(`/action/v2/search/customers/${CID}/time-series/search-users?size=500`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!rr.ok) throw new Error('roster ' + rr.status)
    const roster = (await rr.json()).list
    const persons = roster.filter((x) => (x.employeeInfo?.positions || []).length > 0)
      .map((x) => ({ name: x.basicInfo.name, email: x.basicInfo.email, fileKey: x.basicInfo.profileImageFileKey }))
    const flexNames = new Set(persons.map((p) => p.name))

    const dbRows = await fetch(`${SB}/rest/v1/employees?select=name`, { headers: SBH }).then((r) => r.json())
    const dbNames = new Set(dbRows.map((x) => x.name))

    const newcomers = persons.filter((p) => p.fileKey && !dbNames.has(p.name))
    const noPhoto = persons.filter((p) => !p.fileKey && !dbNames.has(p.name)).map((p) => p.name)
    const departed = [...dbNames].filter((n) => !flexNames.has(n))

    if (DRY) return { persons: persons.length, db: dbNames.size, newcomers: newcomers.map((p) => p.name), departed, noPhoto, dry: true }

    async function embed(fileKey) {
      const blob = await (await fetch('https://flex.team/api/v2/file/files/' + fileKey)).blob()
      const url = URL.createObjectURL(blob)
      const img = new Image(); img.src = url
      await new Promise((r, j) => { img.onload = r; img.onerror = j })
      let det = null
      for (const opt of [{ inputSize: 416, scoreThreshold: 0.4 }, { inputSize: 608, scoreThreshold: 0.3 }, { inputSize: 800, scoreThreshold: 0.15 }, { inputSize: 1024, scoreThreshold: 0.08 }]) {
        const all = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions(opt)).withFaceLandmarks().withFaceDescriptors()
        if (all.length) { det = all.sort((a, b) => b.detection.box.area - a.detection.box.area)[0]; break }
      }
      if (!det) { URL.revokeObjectURL(url); return null }
      const box = det.detection.box, S = 200, PAD = 0.3
      const pw = box.width * PAD, ph = box.height * PAD
      const sx = Math.max(0, box.x - pw), sy = Math.max(0, box.y - ph)
      const sw = Math.min(img.width - sx, box.width + pw * 2), sh = Math.min(img.height - sy, box.height + ph * 2)
      const c = document.createElement('canvas'); c.width = S; c.height = S
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, S, S)
      URL.revokeObjectURL(url)
      return { descriptor: det.descriptor, thumb: c.toDataURL('image/jpeg', 0.8) }
    }

    const tag = 'flex-sync-' + new Date().toISOString().slice(0, 10)
    const enrolled = [], failed = []
    for (const p of newcomers) {
      try {
        const d = await embed(p.fileKey)
        if (!d) { failed.push(p.name + '(얼굴X)'); continue }
        const ins = await fetch(`${SB}/rest/v1/employees`, { method: 'POST', headers: { ...SBH, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ name: p.name, embedding: Array.from(d.descriptor), image_data: d.thumb, notes: tag + '/' + p.email }) })
        if (!ins.ok) { failed.push(p.name + '(' + ins.status + ')'); continue }
        enrolled.push(p.name)
      } catch (e) { failed.push(p.name + '(' + (e.message || e) + ')') }
    }

    let deleted = 0
    if (departed.length) {
      const inList = departed.map((n) => '"' + n.replace(/"/g, '\\"') + '"').join(',')
      const dr = await fetch(`${SB}/rest/v1/employees?name=in.(${encodeURIComponent(inList)})`, { method: 'DELETE', headers: { ...SBH, Prefer: 'count=exact' } })
      if (dr.ok) deleted = +(dr.headers.get('content-range') || '/0').split('/')[1] || departed.length
    }

    return { persons: persons.length, db: dbNames.size, enrolled, failed, departed, deleted, noPhoto }
  }, { SB, KEY, CID, MODELS, DRY })
}

async function main() {
  log(`시작 (headless=${!HEADED}, dry=${DRY})`)
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !HEADED,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    args: [
      '--disable-blink-features=AutomationControlled',
      // HEADED일 때 창을 화면 밖으로 보내 최대한 안 보이게 (구글은 창 모드를 신뢰 → 본인인증 회피)
      ...(HEADED ? ['--window-position=-2400,-2400', '--window-size=1280,900'] : []),
    ],
  })
  const page = ctx.pages()[0] || await ctx.newPage()
  try {
    await page.goto('https://flex.team/people/users', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    if (!(await isLoggedIn(page))) {
      // 세션 만료 시 자격증명으로 자동 재로그인 — 최대 2회 시도
      for (let attempt = 1; attempt <= 2 && !(await isLoggedIn(page)); attempt++) {
        log(`자동 로그인 시도 ${attempt}/2`)
        await doLogin(page).catch((e) => log('  로그인 중 예외:', e.message || e))
        await page.waitForTimeout(2000)
      }
      if (!(await isLoggedIn(page))) {
        await page.screenshot({ path: join(DIR, 'login-failed.png') }).catch(() => {})
        notify('자동 로그인 실패 — scripts/login-failed.png 확인')
        throw new Error('자동 로그인 실패 — scripts/login-failed.png 확인 (구글이 자동화를 차단했을 수 있음)')
      }
    }
    log('로그인 OK, 동기화 실행…')
    const res = await runSync(page)
    if (res.dry) {
      log(`[DRY] 현직 ${res.persons} / DB ${res.db}`)
      log(`[DRY] 신규(${res.newcomers.length}): ${res.newcomers.join(', ') || '-'}`)
      log(`[DRY] 삭제(${res.departed.length}): ${res.departed.join(', ') || '-'}`)
      log(`[DRY] 사진없음(${res.noPhoto.length}): ${res.noPhoto.join(', ') || '-'}`)
    } else {
      log(`완료 ✓ 등록 ${res.enrolled.length} [${res.enrolled.join(', ')}], 삭제 ${res.deleted} [${res.departed.join(', ')}]`)
      if (res.failed?.length) log(`실패: ${res.failed.join(', ')}`)
      if (res.noPhoto?.length) log(`사진없음(대기): ${res.noPhoto.join(', ')}`)
    }
  } finally {
    await ctx.close()
  }
}

main().catch((e) => { log('FATAL:', e.message || e); notify('동기화 실패: ' + (e.message || e)); process.exitCode = 1; setTimeout(() => process.exit(1), 100) })
