import { createClient } from '@supabase/supabase-js'

const URL = import.meta.env.VITE_SUPABASE_URL as string
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!URL || !ANON) {
  console.warn('Supabase env vars missing; .env에 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 필요')
}

export const supabase = createClient(URL ?? '', ANON ?? '')

export type Employee = {
  id: string
  name: string
  photo_url: string | null
  notes: string | null
  image_data: string | null    // base64 jpeg thumbnail (있으면 미리보기 가능)
  created_at: string
}

export type PendingCapture = {
  id: string
  image_data: string
  auto_top_name: string | null
  auto_top_similarity: number | null
  status: 'pending' | 'confirmed' | 'rejected'
  resolved_name: string | null
  created_at: string
}

export type MatchResult = {
  id: string
  name: string
  similarity: number
}

export async function listEmployees(): Promise<Employee[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('id,name,photo_url,notes,image_data,created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function updateEmployeeName(id: string, newName: string) {
  const { error } = await supabase.from('employees').update({ name: newName }).eq('id', id)
  if (error) throw error
}

// 자동 캡쳐 풀
export async function insertPendingCapture(args: {
  image_data: string
  embedding: number[]
  auto_top_name: string | null
  auto_top_similarity: number | null
}) {
  const { error } = await supabase.from('pending_captures').insert({ ...args, status: 'pending' })
  if (error) throw error
}

export async function listPendingCaptures(limit = 200): Promise<PendingCapture[]> {
  const { data, error } = await supabase
    .from('pending_captures')
    .select('id,image_data,auto_top_name,auto_top_similarity,status,resolved_name,created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function countPendingCaptures(): Promise<number> {
  const { count, error } = await supabase
    .from('pending_captures')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
  if (error) throw error
  return count ?? 0
}

export async function confirmPendingCapture(args: {
  id: string
  embedding: number[]
  name: string
  image_data: string
}) {
  // employees에 추가 + 해당 pending row를 confirmed로 마킹
  const ins = await supabase.from('employees').insert({
    name: args.name,
    embedding: args.embedding,
    image_data: args.image_data,
    notes: `auto-${new Date().toISOString()}`,
  })
  if (ins.error) throw ins.error
  const upd = await supabase
    .from('pending_captures')
    .update({ status: 'confirmed', resolved_name: args.name })
    .eq('id', args.id)
  if (upd.error) throw upd.error
}

export async function rejectPendingCapture(id: string) {
  const { error } = await supabase.from('pending_captures').delete().eq('id', id)
  if (error) throw error
}

// pending capture의 embedding 가져오기 (insert에 필요)
export async function getPendingCaptureEmbedding(id: string): Promise<number[]> {
  const { data, error } = await supabase.from('pending_captures').select('embedding').eq('id', id).single()
  if (error) throw error
  // pgvector는 fetch 시 string 또는 array — 정규화
  const raw = (data as { embedding: unknown }).embedding
  if (Array.isArray(raw)) return raw as number[]
  if (typeof raw === 'string') return JSON.parse(raw)
  throw new Error('unexpected embedding format')
}

export async function listEmployeeNames(): Promise<string[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('name')
  if (error) throw error
  const set = new Set<string>()
  for (const row of data ?? []) set.add((row as { name: string }).name)
  return Array.from(set).sort()
}

export async function insertEmployee(name: string, embedding: number[], notes?: string, image_data?: string) {
  const { error } = await supabase
    .from('employees')
    .insert({ name, embedding, notes: notes ?? null, image_data: image_data ?? null })
  if (error) throw error
}

// 인물별 사진 cap. 새 사진 들어올 때 max 초과면 새 임베딩과 "가장 비슷한" 기존 row 삭제 → 다양성 유지.
const MAX_PHOTOS_PER_PERSON = 50
export async function insertEmployeeWithDiversityCap(args: {
  name: string
  embedding: number[]
  notes?: string
  image_data?: string
}) {
  const { name, embedding, notes, image_data } = args
  const { data: existing, error: e1 } = await supabase
    .from('employees').select('id,embedding').eq('name', name)
  if (e1) throw e1
  const rows = (existing ?? []) as Array<{ id: string; embedding: unknown }>
  if (rows.length >= MAX_PHOTOS_PER_PERSON) {
    let worstId: string | null = null
    let worstDist = Infinity
    for (const r of rows) {
      const emb = parseEmbedding(r.embedding)
      if (!emb) continue
      let s = 0
      for (let i = 0; i < emb.length; i++) { const d = emb[i] - embedding[i]; s += d * d }
      const dist = Math.sqrt(s)
      if (dist < worstDist) { worstDist = dist; worstId = r.id }
    }
    if (worstId) await supabase.from('employees').delete().eq('id', worstId)
  }
  await insertEmployee(name, embedding, notes, image_data)
}

function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw as number[]
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return null } }
  return null
}

// 자동 캡쳐: 신뢰도 높음 → 인물 풀에 직접 추가
// (낮음/없음은 기존 pending_captures로 적재 → admin에서 클러스터로 노출)
export async function autoCapture(args: {
  embedding: number[]
  image_data: string
  topMatch: { name: string; similarity: number } | null
  highConfThreshold: number
}) {
  const { embedding, image_data, topMatch, highConfThreshold } = args
  if (topMatch && topMatch.similarity >= highConfThreshold) {
    await insertEmployeeWithDiversityCap({
      name: topMatch.name, embedding, image_data,
      notes: `auto-${new Date().toISOString()}`,
    })
    return 'matched' as const
  }
  await insertPendingCapture({
    image_data, embedding,
    auto_top_name: topMatch?.name ?? null,
    auto_top_similarity: topMatch?.similarity ?? null,
  })
  return 'pending' as const
}

// 클러스터링용 — embedding 포함하여 pending 가져옴
export type PendingCaptureWithEmbedding = PendingCapture & { embedding: number[] }
export async function listPendingCapturesWithEmbedding(limit = 300): Promise<PendingCaptureWithEmbedding[]> {
  const { data, error } = await supabase
    .from('pending_captures')
    .select('id,image_data,embedding,auto_top_name,auto_top_similarity,status,resolved_name,created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((r) => {
      const emb = parseEmbedding(r.embedding)
      if (!emb) return null
      return { ...(r as unknown as PendingCapture), embedding: emb }
    })
    .filter((r): r is PendingCaptureWithEmbedding => r !== null)
}

// Storage 업로드 — 셔터 캡쳐 이미지를 public URL로
export async function uploadShot(blob: Blob): Promise<string> {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const { error } = await supabase.storage.from('shots').upload(filename, blob, {
    contentType: 'image/jpeg', cacheControl: '31536000',
  })
  if (error) throw error
  const { data } = supabase.storage.from('shots').getPublicUrl(filename)
  return data.publicUrl
}

// 클러스터에 이름 부여 — pending → employees 일괄 confirm (cap 적용)
export async function assignPendingClusterToName(args: {
  ids: string[]
  embeddings: number[][]
  image_datas: string[]
  name: string
}) {
  const { ids, embeddings, image_datas, name } = args
  for (let i = 0; i < ids.length; i++) {
    await insertEmployeeWithDiversityCap({
      name, embedding: embeddings[i], image_data: image_datas[i],
      notes: `cluster-confirmed-${new Date().toISOString()}`,
    })
    await supabase.from('pending_captures').update({ status: 'confirmed', resolved_name: name }).eq('id', ids[i])
  }
}

export async function deletePendingByIds(ids: string[]) {
  if (ids.length === 0) return
  const { error } = await supabase.from('pending_captures').delete().in('id', ids)
  if (error) throw error
}

export async function deleteEmployee(id: string) {
  const { error } = await supabase.from('employees').delete().eq('id', id)
  if (error) throw error
}

export async function matchFace(embedding: number[], matchCount = 3, threshold = 0.3): Promise<MatchResult[]> {
  const { data, error } = await supabase.rpc('match_employees', {
    query_embedding: embedding,
    match_count: matchCount,
    match_threshold: threshold,
  })
  if (error) throw error
  return (data as MatchResult[]) ?? []
}
