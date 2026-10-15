export { HostFederation } from './federation.ts'
export type {
  Announcement,
  FederationBus,
  FederationOptions,
  HostSnapshot,
} from './federation.ts'
export { browserChannel } from './channel.ts'
export { hostScopedSettings } from './settings.ts'
export type { ScopedSettings, SettingStorage } from './settings.ts'
export { resolveHostIdentity, isValidHostId } from './identity.ts'
export type { HostIdentity, IdentitySources } from './identity.ts'
export { hostRegistry, normalizeAddress, HOST_REGISTRY_KEY } from './registry.ts'
export type { HostRegistration, RegistrationError, RegistrationResult, RegistryStorage, HostSshInfo } from './registry.ts'
export { HOST_STORE_ENTRY_ID } from './host-store-id.ts'
// Tailscale 桥的线上的键与类型只从这里出：行为入口（./tailscale）拖着
// node:child_process，浏览器侧绝不能顺着根入口把它拖进 bundle。
export {
  TAILSCALE_ERROR_KEY,
  TAILSCALE_PEERS_KEY,
  TAILSCALE_REFRESHED_KEY,
  TAILSCALE_REFRESH_KEY,
} from './tailscale-keys.ts'
export type { TailscalePeer } from './tailscale-keys.ts'
// SSH 部署的入口 id 只从这里出：行为入口（./ssh-deploy）拖着 node:os 与
// node:path，浏览器侧绝不能顺着根入口把它拖进 bundle（同上 tailscale 的
// 先例；`ssh-deploy-id.ts` 是纯字符串模块）。
export { SSH_DEPLOY_ENTRY_ID } from './ssh-deploy-id.ts'
export type {
  RemoteAgentDeploySelection,
  SshAccessMode,
  SshConnectionInput,
  SshConnectResult,
  SshDeployOperationView,
  SshDeployProgress,
  SshDeployRequest,
  SshDeployResult,
  SshHostKeyCandidate,
} from './ssh/types.ts'
export type { PeerListen, PeerStatus } from './ssh/peer-status.ts'
export type {
  PeerCheckAction,
  PeerCheckFacts,
  PeerCheckReport,
  PeerCheckState,
  PeerCheckStep,
  PeerCheckStepId,
  PeerHttpsProbe,
} from './ssh/peer-check.ts'
export { REMOTE_DEPLOY_AGENT_SPECS } from './ssh/remote-agents.ts'
export type { HostSession, HostRoll, ProjectGroup, RollUp } from './federation.ts'
export { rollUpView } from './rollup-view.ts'
export type { RollUpView, HostViewRow, ProjectView, SessionView } from './rollup-view.ts'
export { sessionsFromWorkspaces, UNGROUPED } from './workspace-map.ts'
export type { WorkspaceLike, SessionLike, WorkspaceSession } from './workspace-map.ts'
export { fetchRemoteSessions, mergeRemoteSessions } from './host-remote-sessions.ts'
