/** Sticky banner shown above the transcript when the gateway has rotated out
 *  older entries for the current session. Tells the user honestly that some
 *  history is gone, without offering a recovery path (stage 1 of the
 *  transcript retention plan; the archive-backed "click to load" UX is
 *  tracked in `docs/research/2026-09-04-transcript-retention-decision.md`).
 *
 *  Pure presentational component: `null` when there is no gap, so the
 *  parent's DOM tree is unchanged for the common case. */

import type { ReactElement } from 'react'
import type { RemoteSessionView } from '@threadharbor/protocol'

/** Visible copy. The count is `droppedThrough + 1` because the projected
 *  transcript starts at seq 0; a `droppedThrough` of 4 means entries 0..4
 *  (five rows) are no longer available. */
function buildMessage(droppedThrough: number): string {
  const lost = droppedThrough + 1
  return `Earlier history was rotated. ${lost} older ${lost === 1 ? 'message is' : 'messages are'} no longer available.`
}

/** Show the gap banner when the session has a `droppedThrough` marker. The
 *  projection layer only attaches the field once a trim has actually
 *  happened, so `undefined` / `0` both mean "no gap" and render nothing. */
export function TranscriptGapBanner({ session }: { readonly session: RemoteSessionView }): ReactElement | null {
  if (session.droppedThrough === undefined || session.droppedThrough < 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="transcript-gap-banner"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1,
        padding: '8px 12px',
        margin: '0 0 8px 0',
        borderRadius: 6,
        background: 'var(--dsw-alias-fill-l2, rgba(255, 196, 0, 0.12))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        border: '1px solid var(--dsw-alias-stroke-warn, rgba(255, 196, 0, 0.4))',
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      {buildMessage(session.droppedThrough)}
    </div>
  )
}
