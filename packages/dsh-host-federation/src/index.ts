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
// 主机互通的线上词表（键、路径、self 记录）是纯模块：浏览器侧报到与宿主侧
// 收发同用这一份。行为入口（./federation-sync）拖着 node:http 与网络调用，
// 不能从根入口出。
export {
  FEDERATION_ANNOUNCE_PATH,
  FEDERATION_PUSH_PATH,
  FEDERATION_PREFIX,
  FULL_UI_PAIR_PATH,
  HOST_ACCESS_ORIGIN_KEY,
  HOST_SELF_KEY,
  isLoopbackOrigin,
  normalizeAccessOrigin,
  originOfRequest,
  parseSelfRecord,
} from './federation-keys.ts'
export type { AccessOriginProblem, FederationPush, HostSelfRecord } from './federation-keys.ts'
export { mergeFederationRegistry } from './federation-merge.ts'
export type { FederationMergeResult } from './federation-merge.ts'
// 远端读数的线上形状是纯类型与纯解析：面板状态推导与登记簿的 remote 字段
// 都用这一份词表，从根入口出（先例同 tailscale-keys.ts 的纯模块）。
export { parseRemoteReport } from './remote-report.ts'
export type { RemoteDeployment, RemoteLiveness, RemoteReport } from './remote-report.ts'
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
  SshConfigHostEntry,
  SshLocalAssets,
} from './ssh/types.ts'
export type { PeerListen, PeerStatus } from './ssh/peer-status.ts'
export type { PeerReport } from './ssh/liveness.ts'
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
export { GATEWAY_PREFIX, gatewayPagePath } from './host-gateway-path.ts'
