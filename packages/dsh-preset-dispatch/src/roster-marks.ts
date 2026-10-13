/**
 * Preset ids that asked to stay out of the picker.
 *
 * The mark is set by the binding that owns the preset (`hideFromRoster`), not
 * by a name list on the filter. New agents only need the same flag.
 */

const marked = new Set<string>()

export function markRosterHidden(presetId: string): void {
  const id = presetId.trim()
  if (id !== '') marked.add(id)
}

export function markedRosterIds(): readonly string[] {
  return [...marked]
}

export function clearRosterMarks(): void {
  marked.clear()
}
