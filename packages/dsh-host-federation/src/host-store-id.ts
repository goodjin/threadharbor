/**
 * The composition id of the host-side settings slot, shared by the host entry
 * and the browser storage so the two can never drift apart.
 *
 * Kept in its own module because the browser bundle imports the package root:
 * re-exporting this from the entry file itself would drag the schema library
 * into the browser for one string.
 */

/** The composition id, which is also the settings namespace the browser addresses. */
export const HOST_STORE_ENTRY_ID = 'threadharbor-host-store'
