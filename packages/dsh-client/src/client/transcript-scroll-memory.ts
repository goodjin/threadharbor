/** Persisted scroll position for one remote session transcript. */
export interface TranscriptScrollMemory {
  readonly scrollTop: number
  readonly followBottom: boolean
}

const TRANSCRIPT_SCROLL_STORAGE_KEY = 'dsh.remote-agent.transcript-scroll'

function isTranscriptScrollMemory(value: unknown): value is TranscriptScrollMemory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['scrollTop'] === 'number' && Number.isFinite(record['scrollTop'])
    && typeof record['followBottom'] === 'boolean'
}

export function readTranscriptScrollMemory(sessionId: string): TranscriptScrollMemory | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(TRANSCRIPT_SCROLL_STORAGE_KEY)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const value = (parsed as Record<string, unknown>)[sessionId]
    if (!isTranscriptScrollMemory(value)) return undefined
    return { scrollTop: Math.max(0, value.scrollTop), followBottom: value.followBottom }
  } catch {
    return undefined
  }
}

export function writeTranscriptScrollMemory(sessionId: string, memory: TranscriptScrollMemory): void {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(TRANSCRIPT_SCROLL_STORAGE_KEY)
    let base: Record<string, unknown> = {}
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          base = parsed as Record<string, unknown>
        }
      } catch {
        // ignore corrupted entry and overwrite below
      }
    }
    base[sessionId] = memory
    window.localStorage.setItem(TRANSCRIPT_SCROLL_STORAGE_KEY, JSON.stringify(base))
  } catch {
    // ignore quota / disabled storage
  }
}