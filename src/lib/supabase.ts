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
    .select('id,name,photo_url,notes,created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
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

export async function insertEmployee(name: string, embedding: number[], notes?: string) {
  const { error } = await supabase
    .from('employees')
    .insert({ name, embedding, notes: notes ?? null })
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
