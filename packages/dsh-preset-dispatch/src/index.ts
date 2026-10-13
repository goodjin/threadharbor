export { installAcpDispatch, resolvePreset } from './dispatch.ts'
export type {
  AcpDispatchOptions,
  AcpPresetBinding,
  AgentLike,
  ContentEvent,
  SessionHeaderLike,
  StepDecisionLike,
  StepEndReason,
  PresetResolver,
} from './dispatch.ts'
export { AcpTurnRunner } from './runner.ts'
export type { AcpClientPort, RunnerOptions, TurnStreamPort } from './runner.ts'
export { AcpAssistantStream } from './stream.ts'
export type { StreamOptions, StreamRecord } from './stream.ts'
export { buildPresetTable, openSessionsOf, sessionsRegistry } from './registry.ts'
export type {
  AcpPresetConfig,
  AcpSession,
  AcpSessionFactory,
  PresetConfig,
  PresetTableOptions,
  SessionDropEvent,
  SessionRegistry,
} from './registry.ts'
export { adaptClient, makeSessionFactory } from './factory.ts'
export type { FactoryDeps } from './factory.ts'
export { makeContentWriter } from './content-writer.ts'
export type { ContentWriter, SessionAppend } from './content-writer.ts'
export { ALLOWED_ONCE, makeApprovalBridge } from './approval-bridge.ts'
export type { ApprovalBridge, ApprovalPort } from './approval-bridge.ts'
export { makeQuestionBridge } from './question-bridge.ts'
export type { QuestionBridge, QuestionPort } from './question-bridge.ts'

export type { AcpPluginContext, AcpPluginDeps } from './plugin.ts'

export type { AttachOptions } from './service.ts'
export { catalogAdapter, presetForModel, presetOfRoute, providerRoute } from './catalog.ts'
export type { CatalogAdapterLike, CatalogDeps, CatalogModel } from './catalog.ts'
export { decideOnSelection } from './switch.ts'
export type { SelectionDecision, SelectionState } from './switch.ts'
export { presetsForHost } from './host-filter.ts'
export { assembleHandover, decideHandover, messagesOf } from './handover.ts'
export type { HandoverDecision, HandoverInput, HandoverMessage, HandoverOptions } from './handover.ts'
export { planSwitch } from './switch-plan.ts'
export type { SwitchOptions, SwitchPlan, SwitchSessionState } from './switch-plan.ts'
export { applySwitchPlan } from './apply-plan.ts'
export type { ApplyResult, ForkRequest, SwitchCarry, SwitchPorts } from './apply-plan.ts'
export {
  estimateTokens,
  mountSwitchOnForeignModelRequest,
  servicesOf,
  splitQuestion,
  startedOf,
  switchDrivenSession,
  switchPortsOf,
} from './switch-mount.ts'
export type { HostServices } from './switch-mount.ts'
export { makeSwitchShared, switchShared } from './switch-shared.ts'
export type { MountedModel, SwitchRecord, SwitchShared } from './switch-shared.ts'
export { catalogRoutes, registerCatalog } from './catalog-registration.ts'
