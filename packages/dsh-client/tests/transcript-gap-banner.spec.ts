/** Tests for the gap banner that appears when the gateway has rotated out
 *  older transcript entries. The component is a pure presentational
 *  function: it returns `null` when there is no gap, or a single sticky
 *  status div. We test it by calling it directly (no react-test-renderer
 *  or testing-library in the workspace) and walking the returned element
 *  tree to assert the visible copy. JSX is avoided in the test file so
 *  vitest's `.spec.ts` include glob picks it up without a config tweak. */

import { describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { RemoteSessionId, type RemoteSessionView } from '@threadharbor/protocol'
import { TranscriptGapBanner } from '../src/client/transcript-gap-banner.tsx'

function makeSession(overrides: Partial<RemoteSessionView> = {}): RemoteSessionView {
  return {
    sessionId: RemoteSessionId('sess-1'),
    projectId: 'proj-1' as never,
    title: 'work',
    backend: 'codex',
    channelState: 'open',
    turnState: 'idle',
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  } as RemoteSessionView
}

/** Walk a React element tree and return the first string child we find.
 *  Used to read the visible copy out of the banner without a renderer. */
function readTextChild(node: unknown): string | undefined {
  if (node === null || node === undefined || typeof node === 'boolean') return undefined
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = readTextChild(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    return readTextChild((node as { props: { children?: ReactNode } }).props.children)
  }
  return undefined
}

describe('TranscriptGapBanner', () => {
  it('renders nothing when the session has never been trimmed', () => {
    const element = TranscriptGapBanner({ session: makeSession() })
    expect(element).toBeNull()
  })

  it('renders nothing when droppedThrough is explicitly negative', () => {
    const element = TranscriptGapBanner({ session: makeSession({ droppedThrough: -1 }) })
    expect(element).toBeNull()
  })

  it('renders the banner with a single-entry message when droppedThrough is 0', () => {
    const element = TranscriptGapBanner({ session: makeSession({ droppedThrough: 0 }) })
    expect(element).not.toBeNull()
    const text = readTextChild(element as ReactElement)
    expect(text).toBe('Earlier history was rotated. 1 older message is no longer available.')
  })

  it('renders the banner with a plural message for larger gaps', () => {
    const element = TranscriptGapBanner({ session: makeSession({ droppedThrough: 41 }) })
    expect(element).not.toBeNull()
    const text = readTextChild(element as ReactElement)
    expect(text).toBe('Earlier history was rotated. 42 older messages are no longer available.')
  })

  it('exposes the testid, role, and aria-live so the gateway-rendered banner is observable in e2e tests', () => {
    const element = TranscriptGapBanner({ session: makeSession({ droppedThrough: 0 }) })
    const node = element as ReactElement & { props: { 'data-testid'?: string; role?: string; 'aria-live'?: string } }
    expect(node.props['data-testid']).toBe('transcript-gap-banner')
    expect(node.props.role).toBe('status')
    expect(node.props['aria-live']).toBe('polite')
  })
})
