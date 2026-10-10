/**
 * The settings source the roll-up has been missing.
 *
 * The federation reads this tab's host identity from a settings form; what did
 * not exist was the form. This is it: the host id and title, as the operator
 * configured them, kept in the page's own storage under one key. Nothing here
 * is a placeholder — an empty configuration reads as empty, and the federation
 * derives a fallback identity from the page origin on its own.
 */

/** The identity fields an operator can configure for this host. */
export type ConfiguredIdentity = {
  readonly hostId?: string
  readonly hostTitle?: string
}

/** What the panel and the federation both read identity through. */
export type IdentitySettings = {
  read(): ConfiguredIdentity
  write(value: ConfiguredIdentity): void
}

/** The one storage key identity lives under. */
export const IDENTITY_STORAGE_KEY = 'dsh.host.identity'

/** The slice of Web Storage these settings use, so tests can stand it in. */
export type IdentityStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Identity settings over a Web Storage.
 * @param storage - localStorage or a stand-in with the same two methods.
 * @returns read/write access to this host's configured identity.
 */
export function storageIdentitySettings(storage: IdentityStorage): IdentitySettings {
  return {
    read: () => {
      const raw = storage.getItem(IDENTITY_STORAGE_KEY)
      if (raw === null) return {}
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Unreadable storage is an ordinary empty configuration, not a reason
        // for the panel to fail.
        return {}
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const record = parsed as Record<string, unknown>
      return {
        ...(typeof record['hostId'] === 'string' ? { hostId: record['hostId'] } : {}),
        ...(typeof record['hostTitle'] === 'string' ? { hostTitle: record['hostTitle'] } : {}),
      }
    },
    write: value => {
      storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(value))
    },
  }
}
