export { HostFederation } from './federation.ts'
export type {
  Announcement,
  FederationBus,
  FederationOptions,
  HostRoll,
  HostSession,
  HostSnapshot,
  ProjectGroup,
  RollUp,
} from './federation.ts'
export { browserChannel } from './channel.ts'
export { hostScopedSettings } from './settings.ts'
export type { ScopedSettings, SettingStorage } from './settings.ts'
export { resolveHostIdentity } from './identity.ts'
export type { HostIdentity, IdentitySources } from './identity.ts'
export { applyHostFederation, SETTINGS_PREFIX } from './plugin.ts'
export type { HostFederationConfig, HostFederationContext, HostFederationHandle } from './plugin.ts'

export type { HostView, IdentityForm, SettingsSource } from './view.ts'
export { sessionsFromWorkspaces, UNGROUPED } from './workspace-map.ts'
export type { SessionLike, WorkspaceLike, WorkspaceSession } from './workspace-map.ts'
