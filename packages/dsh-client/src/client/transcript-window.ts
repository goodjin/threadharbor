/**
 * Dynamic-window virtualization for the remote transcript list.
 *
 * Mirrors the mechanism DSH's own conversation view uses
 * (`@tanstack/virtual-core`): only the rows near the viewport mount, row
 * heights are measured lazily, and the scroll container gets a spacer that
 * reports the full list height. `anchorTo: 'end'` + `followOnAppend`
 * reproduces the old "stick to the newest message" behavior natively — a
 * follow-bottom reader stays pinned while new rows append, and manual
 * scrolling never yanks the viewport.
 *
 * The virtualizer instance is created once per scroll container and pushed
 * fresh options every render, so it always sees the current row count.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Virtualizer,
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
} from '@tanstack/virtual-core'

/** Below this row count every row renders directly: virtualization only pays
 * off once the list is long enough for DOM work to dominate. */
export const VIRTUALIZE_TRANSCRIPT_THRESHOLD = 40
/** Rows rendered above and below the viewport so fast scrolling stays smooth. */
const TRANSCRIPT_OVERSCAN = 12
/** First-paint viewport guess before the real container measures. */
const INITIAL_VIEWPORT_HEIGHT_PX = 600

export interface TranscriptWindowRow {
  readonly index: number
  readonly start: number
  readonly size: number
  readonly key: number | string | bigint
}

export interface TranscriptWindowOptions {
  /** The scrollable container element. */
  readonly getScrollElement: () => HTMLDivElement | null
  /** Row count. */
  readonly count: number
  /** Stable key per row so recycled DOM keeps its measurement. */
  readonly getItemKey: (index: number) => number | string | bigint
  /** Rough row height used until the real measurement lands. */
  readonly estimateSize: (index: number) => number
}

export interface TranscriptWindow {
  /** True when the dynamic window is active (list long enough to virtualize). */
  readonly virtualized: boolean
  /** Rows to mount right now. */
  readonly rows: readonly TranscriptWindowRow[]
  /** Full list height for the spacer. */
  readonly totalSize: number
  /** Ref callback: attach to each mounted row so its height gets measured. */
  readonly measureRef: (element: HTMLDivElement | null) => void
  /** Scroll the list so the last row is visible (composer send). */
  readonly scrollToBottom: () => void
  /** Row index at a scroll offset, for restoring a remembered position. */
  readonly indexAtOffset: (offset: number) => number | undefined
  /** Scroll so one row is visible (restoring a remembered position). */
  readonly scrollToIndex: (index: number) => void
  /** Bump when the window changes so the component re-renders. */
  readonly bump: () => void
}

export function useTranscriptWindow({
  getScrollElement,
  count,
  getItemKey,
  estimateSize,
}: TranscriptWindowOptions): TranscriptWindow {
  const enabled = count >= VIRTUALIZE_TRANSCRIPT_THRESHOLD
  const [, forceRender] = useState(0)
  // The virtualizer instance is created once per scroll container; options are
  // pushed on every render via `setOptions`.
  const instanceRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | undefined>(undefined)
  if (instanceRef.current === undefined && enabled) {
    instanceRef.current = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      scrollMargin: 0,
      get scrollToFn() {
        return elementScroll
      },
      get observeElementRect() {
        return observeElementRect
      },
      get observeElementOffset() {
        return observeElementOffset
      },
      get measureElement() {
        return measureElement
      },
      count,
      getScrollElement,
      estimateSize,
      getItemKey,
      overscan: TRANSCRIPT_OVERSCAN,
      paddingStart: 0,
      paddingEnd: 0,
      initialRect: { width: 0, height: INITIAL_VIEWPORT_HEIGHT_PX },
      initialOffset: 0,
      // New rows arrive at the end: a follow-bottom reader stays pinned
      // without a manual scroll-to-bottom on every append.
      anchorTo: 'end',
      followOnAppend: 'auto',
      onChange: () => { forceRender(value => value + 1) },
    })
  }
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === undefined) return
    // Push fresh options every render: count/estimateSize/getItemKey are
    // inline closures that change identity each render, and the virtualizer
    // reads them at notify time.
    instance.setOptions({
      scrollMargin: 0,
      get scrollToFn() {
        return elementScroll
      },
      get observeElementRect() {
        return observeElementRect
      },
      get observeElementOffset() {
        return observeElementOffset
      },
      get measureElement() {
        return measureElement
      },
      count,
      getScrollElement,
      estimateSize,
      getItemKey,
      overscan: TRANSCRIPT_OVERSCAN,
      paddingStart: 0,
      paddingEnd: 0,
      initialRect: { width: 0, height: INITIAL_VIEWPORT_HEIGHT_PX },
      initialOffset: 0,
      anchorTo: 'end',
      followOnAppend: 'auto',
      onChange: () => { forceRender(value => value + 1) },
    })
  })
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === undefined) return
    const cleanupRect = instance._didMount()
    return () => {
      cleanupRect()
      // A disabled list (session switched to a short one) drops the instance
      // so a later long session builds a fresh one.
      if (!enabled) instanceRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, getScrollElement])
  useEffect(() => () => {
    const instance = instanceRef.current
    if (instance !== undefined) instance._didMount()()
    instanceRef.current = undefined
  }, [])

  const rows = useMemo<readonly TranscriptWindowRow[]>(() => {
    if (!enabled) {
      return plainWindowRows(count, estimateSize, getItemKey)
    }
    return instanceRef.current?.getVirtualItems().map(item => ({
      index: item.index,
      start: item.start,
      size: item.size,
      key: item.key,
    })) ?? []
    // The window changes on scroll/append via the virtualizer's onChange bump;
    // count/estimateSize/getItemKey are inline closures that change identity
    // every render, so they are read fresh rather than listed as deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, count])

  const totalSize = enabled
    ? (instanceRef.current?.getTotalSize() ?? 0)
    : plainWindowHeight(count, estimateSize)

  return {
    virtualized: enabled,
    rows,
    totalSize,
    measureRef: (element) => { instanceRef.current?.measureElement(element) },
    scrollToBottom: () => { instanceRef.current?.scrollToEnd() },
    indexAtOffset: (offset: number) => instanceRef.current?.getVirtualItemForOffset(offset)?.index,
    scrollToIndex: (index: number) => { instanceRef.current?.scrollToIndex(index, { align: 'start' }) },
    bump: () => { forceRender(value => value + 1) },
  }
}

/** One-off window math for the non-virtualized (short) list. */
function plainWindowRows(
  count: number,
  estimateSize: (index: number) => number,
  getItemKey: (index: number) => number | string | bigint,
): TranscriptWindowRow[] {
  const rows: TranscriptWindowRow[] = []
  let start = 0
  for (let index = 0; index < count; index += 1) {
    const size = estimateSize(index)
    rows.push({ index, start, size, key: getItemKey(index) })
    start += size
  }
  return rows
}

function plainWindowHeight(count: number, estimateSize: (index: number) => number): number {
  let total = 0
  for (let index = 0; index < count; index += 1) total += estimateSize(index)
  return total
}
