/**
 * Settings that belong to one host.
 *
 * With one tab per host, a single shared key means whichever host the user
 * visits last overwrites the others. Each host gets its own slot, and reading
 * one host's settings never shows another's.
 */

/** The slice of Web Storage this uses, so it can be stood in for. */
export type SettingStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type ScopedSettings<T extends object> = {
  read(): T
  write(value: T): void
  reset(): void
  subscribe(listener: (value: T) => void): () => void
}

const PREFIX = 'dsh.host-settings.'

/**
 * Settings scoped to one host.
 *
 * The host id goes into the key with a separator, so `alpha` cannot read
 * `alpha-2`'s slot — which a bare concatenation would let it do.
 */
export function hostScopedSettings<T extends object>(
  hostId: string,
  storage: SettingStorage,
  defaults: T,
): ScopedSettings<T> {
  const key = `${PREFIX}${hostId}`
  const listeners = new Set<(value: T) => void>()

  const read = (): T => {
    const raw = storage.getItem(key)
    if (raw === null) return { ...defaults }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Unreadable storage must not leave a host permanently broken.
      return { ...defaults }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...defaults }
    // Fill in per-key defaults, so a value stored before a setting existed
    // does not leave it undefined.
    return { ...defaults, ...(parsed as Partial<T>) }
  }

  return {
    read,
    write: value => {
      storage.setItem(key, JSON.stringify(value))
      for (const listener of listeners) listener(value)
    },
    reset: () => {
      storage.removeItem(key)
      for (const listener of listeners) listeners.forEach(l => l({ ...defaults }))
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
