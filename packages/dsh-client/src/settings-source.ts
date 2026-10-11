/**
 * The settings source the roll-up has been missing.
 *
 * The federation reads this tab's host identity from a settings form; what did
 * not exist was the form. This is it: the host id and title, as the operator
 * configured them, kept in the page's own storage under one key. Nothing here
 * is a placeholder — an empty configuration reads as empty, and the federation
 * derives a fallback identity from the page origin on its own.
 *
 * Identity has two layers, because §8.4's form is one tab per host: a tab that
 * claimed an identity keeps it for that tab (session storage), while the origin
 * keeps a default that a fresh tab inherits (local storage). One shared key
 * alone would make two tabs of the same origin collapse into one host the next
 * time either reloads.
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

/** The storage key of the origin-wide default identity. */
export const IDENTITY_STORAGE_KEY = 'dsh.host.identity'
/** The storage key of this tab's own claim, which outranks the default. */
export const IDENTITY_TAB_STORAGE_KEY = 'dsh.host.identity.tab'

/** The slice of Web Storage these settings use, so tests can stand it in. */
export type IdentityStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Identity settings over a Web Storage: the origin-wide default.
 * @param storage - localStorage or a stand-in with the same two methods.
 * @returns read/write access to this origin's default identity.
 */
export function storageIdentitySettings(storage: IdentityStorage): IdentitySettings {
  return recordIdentitySettings(storage, IDENTITY_STORAGE_KEY)
}

/**
 * Layered identity settings: the tab's own claim first, then the origin's
 * default. A write records both, so this tab keeps its claim across reloads and
 * a fresh tab on the same origin starts from the last identity saved here.
 * @param tab - sessionStorage or a stand-in: this tab's override.
 * @param local - localStorage or a stand-in: the origin-wide default.
 * @returns read/write access to this tab's identity.
 */
export function layeredIdentitySettings(tab: IdentityStorage, local: IdentityStorage): IdentitySettings {
  const tabSettings = recordIdentitySettings(tab, IDENTITY_TAB_STORAGE_KEY)
  const localSettings = recordIdentitySettings(local, IDENTITY_STORAGE_KEY)
  return {
    read: () => {
      const own = tabSettings.read()
      if (own.hostId !== undefined || own.hostTitle !== undefined) return own
      return localSettings.read()
    },
    write: value => {
      tabSettings.write(value)
      localSettings.write(value)
    },
  }
}

/** One storage key's identity record, with unreadable content read as empty. */
function recordIdentitySettings(storage: IdentityStorage, key: string): IdentitySettings {
  return {
    read: () => {
      const raw = storage.getItem(key)
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
      storage.setItem(key, JSON.stringify(value))
    },
  }
}
