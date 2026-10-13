/**
 * The SSH auto-deploy entry id, shared by the profile patch that mounts the
 * plugin and any code that needs to name it.
 *
 * In its own module for the same reason {@link ./tailscale-keys.ts} is: the
 * browser bundle imports the package root, and the behavioral entry this id
 * belongs to runs `node:os`/`node:path` — importing that into a browser would
 * put node builtins into the module table's require path, which the client
 * module loader cannot resolve. Only this plain string is re-exported from
 * the root.
 */

/** The cordis entry id the SSH auto-deploy plugin registers under. */
export const SSH_DEPLOY_ENTRY_ID = 'threadharbor-ssh-deploy'
