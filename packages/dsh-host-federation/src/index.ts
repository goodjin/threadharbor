export { HostFederation } from './federation.ts'
export type { Announcement, FederationBus, FederationOptions, HostSnapshot } from './federation.ts'
export { browserChannel } from './channel.ts'
export { hostScopedSettings } from './settings.ts'
export type { ScopedSettings, SettingStorage } from './settings.ts'
export { resolveHostIdentity, isValidHostId } from './identity.ts'
export type { HostIdentity, IdentitySources } from './identity.ts'
export { hostRegistry, normalizeAddress, HOST_REGISTRY_KEY } from './registry.ts'
export type { HostRegistration, RegistrationError, RegistrationResult, RegistryStorage } from './registry.ts'
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
