/** Session stats strip shown under the composer in the active conversation,
 *  mirroring the official DSH "StatsLine" dock form: pipe-separated groups of
 *  small tertiary text on one centered row that elides when it outgrows the
 *  composer column. Only groups the transcript can back are rendered (counts,
 *  and tool duration when it was actually measurable); everything else is
 *  omitted whole so the row never shows fabricated numbers.
 *
 *  Pure presentational component: `null` when no group has data, so the
 *  parent's DOM tree is unchanged for a new or empty conversation. */

import { Fragment, useMemo } from 'react'
import type { ReactElement } from 'react'
import type { RemoteTranscriptEntry } from '@threadharbor/protocol'
import {
  conversationStatsGroups,
  deriveConversationStats,
} from './conversation-model.ts'
import css from './RemoteSurface.module.css'

/** Props: the current session's projected transcript entries (session-scoped). */
export interface ConversationStatsLineProps {
  readonly entries: readonly RemoteTranscriptEntry[]
}

/** Render one non-empty statistics line under the composer. */
export function ConversationStatsLine({ entries }: ConversationStatsLineProps): ReactElement | null {
  const stats = useMemo(() => deriveConversationStats(entries), [entries])
  const groups = useMemo(() => conversationStatsGroups(stats), [stats])
  if (groups.length === 0) return null
  const line = groups.join(' | ')
  return (
    <div className={css.conversationStats} data-testid="conversation-stats-line" title={line} aria-label={line}>
      {groups.map((group, index) => (
        <Fragment key={group}>
          {index > 0 && <span className={css.conversationStatsSep} aria-hidden="true">|</span>}
          <span>{group}</span>
        </Fragment>
      ))}
    </div>
  )
}
