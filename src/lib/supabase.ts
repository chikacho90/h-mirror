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
