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
export { sessionsFromWorkspaces, UNGROUPED } from './workspace-map.ts'
export type { SessionLike, WorkspaceLike, WorkspaceSession } from './workspace-map.ts'
export { browserChannel } from './channel.ts'
export { hostScopedSettings } from './settings.ts'
export type { ScopedSettings, SettingStorage } from './settings.ts'
export { resolveHostIdentity, isValidHostId } from './identity.ts'
export type { HostIdentity, IdentitySources } from './identity.ts'
export { hostRegistry, normalizeAddress, HOST_REGISTRY_KEY } from './registry.ts'
export type { HostRegistration, RegistrationError, RegistrationResult, RegistryStorage } from './registry.ts'
export { HOST_STORE_ENTRY_ID } from './host-store-id.ts'
export { SSH_DEPLOY_ENTRY_ID } from './ssh-deploy.ts'
export type {
  SshAccessMode,
  SshConnectionInput,
  SshDeployOperationView,
  SshDeployProgress,
  SshDeployRequest,
  SshDeployResult,
  SshHostKeyCandidate,
} from './ssh/types.ts'
