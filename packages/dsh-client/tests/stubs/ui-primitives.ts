/**
 * A stand-in for `@deepseek-ai/dsh-client-ui-primitives` for specs that never
 * render it.
 *
 * The composer model seat is upstream's component, so it reaches for that
 * package's styled components — which import CSS modules Node cannot execute.
 * Specs that pull the client entry in only to check this repo's own surfaces
 * would otherwise fail on a stylesheet they never touch, so they mock the
 * package away through this file. Specs that DO render the seat mock it with
 * the same stub and assert on the seat's own text.
 *
 * Every export here is a component returning null: the mocked module exists so
 * imports resolve, not so anything renders. A Proxy would be shorter and wrong
 * — it would answer `then` with a function, turning the module namespace into a
 * thenable that never settles.
 */

/** A styled primitive standing in for any of the package's components. */
const nothing = (): null => null

export const MenuGroup = nothing
export const MenuSurface = nothing
export const Input = nothing
export const StateDot = nothing
export const Toast = nothing
export const IconCheckOutlineRegular = nothing
export const IconChevronDownOutlineRegular = nothing
export const IconChevronRightOutlineRegular = nothing
export const IconCloseFillRegular = nothing
export const IconDataOutlineRegular = nothing
export const IconWarningOutlineRegular = nothing

/** No menu is open in these specs, so this never gets to observe anything. */
export const observeStickyMenuGroups = (): (() => void) => () => {}

/** Pass-through: these specs never type a query, so ranking is the identity. */
export const rankByName = <T>(items: readonly T[]): T[] => [...items]
