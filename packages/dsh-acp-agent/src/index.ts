export { AcpClient } from './client.ts'
export type { PermissionRequest, PermissionDecision, AskQuestionRequest, AskQuestionItem, AskQuestionAnswer, AskQuestionOutcome } from './client.ts'
export { ActivityBeacon, StdioAcpTransport, WebSocketAcpTransport, GrokServeTransport } from './transport.ts'
export type { AcpTransport, StdioTransportOptions, GrokServeOptions, GrokServeChild, GrokServeSpawn } from './transport.ts'
export { projectTurn, projectUserMessage, projectStepContent, projectTurnIncremental, projectToolCall, projectToolCallFrame, projectToolCallAnnouncement, projectToolCallAnnouncementCall, projectToolResultFrame, mapToolName, readSpawnedFrame, projectSpawnedResult, stillRunningText } from './projection.ts'
export type { ProjectionEvent, StreamRecord, SpawnedFrameReading } from './projection.ts'
export { AcpSegmenter } from './segmentation.ts'
export { claudeDialect } from './dialects/claude.ts'
export { codexDialect } from './dialects/codex.ts'
export { cursorDialect } from './dialects/cursor.ts'
export { grokDialect } from './dialects/grok.ts'
export { qoderDialect } from './dialects/qoder.ts'
export type { AcpDialect, ToolCall } from './dialects/types.ts'
export { TerminalService } from './terminals.ts'
export { stdioArgsFor, stdioArgsForDialect, stdioEnvFor } from './spawn-args.ts'
export { bridgePermissions, connectPermissions, toDecision } from './approval.ts'
export type { ApprovalRequester, DshApprovalOutcome } from './approval.ts'
export type { AcpFrame, AcpModel } from './acp-client.ts'
export { RawOutputAggregator, classifyRawOutput } from './raw-output.ts'
export type { RawOutputBlock, RawOutputClassification } from './raw-output.ts'
export { readSessionStatus } from './session-status.ts'
export type { SessionStatusReading, SessionStatusSnapshot } from './session-status.ts'
export {
  assistantMessageEvent, systemNoteEvent, toolCallAnnouncementEvent, toolCallEvent, toolResultMessageEvent, userMessageEvent,
} from './message-events.ts'
export type { MessageEvent, ReasoningBlock, TextBlock, ToolCallBlock } from './message-events.ts'

// ─── GLM (ZCode) model client ────────────────────────────────────────────────
export {
  decryptCredential,
  deriveKey,
  loadApiKey,
} from './zcode/credential.ts'
export {
  BIGMODEL_CODING_PLAN_BASE,
  ZAI_CODING_PLAN_BASE,
  buildAnthropicBody,
  messagesUrl,
  reasoningFields,
} from './zcode/anthropic.ts'
export type { AnthropicBody, PromptInput, PromptTool } from './zcode/anthropic.ts'
export { streamGlm, scrub } from './zcode/glm.ts'
export type { GlmRequest } from './zcode/glm.ts'
export { fetchCodingPlanQuota, parseQuotaLimits, quotaUrl } from './zcode/quota.ts'
export type { GlmCodingPlanQuota, GlmQuotaRequest, GlmQuotaWindow } from './zcode/quota.ts'
export type { GlmBlock, GlmFinish, GlmStreamChunk, GlmUsage } from './zcode/sse.ts'

// ─── MiniMax model client ────────────────────────────────────────────────────
export {
  detectNamespace,
  resolveCredential,
  resolveDataDir,
} from './minimaxi/credential.ts'
export type { CredentialOverrides, DataDirOptions, MiniMaxCredential, AuthBuildEnv, AuthRegion } from './minimaxi/credential.ts'
// Disambiguate: these names collide with zcode exports above.
export {
  buildAnthropicBody as miniMaxBuildAnthropicBody,
  defaultMaxTokens,
  reasoningFields as miniMaxReasoningFields,
} from './minimaxi/anthropic.ts'
export type { AnthropicBody as MiniMaxAnthropicBody, Effort, PromptInput as MiniMaxPromptInput, PromptTool as miniMaxPromptTool } from './minimaxi/anthropic.ts'
export { messagesUrl as miniMaxMessagesUrl } from './minimaxi/credential.ts'
export { streamMiniMax, scrub as miniMaxScrub } from './minimaxi/minimax.ts'
export type { MiniMaxRequest } from './minimaxi/minimax.ts'
export { fetchMiniMaxQuota } from './minimaxi/quota.ts'
export type { MiniMaxCodingPlanQuota, MiniMaxCredit, MiniMaxQuotaRequest, MiniMaxQuotaWindow } from './minimaxi/quota.ts'
export type { MiniMaxBlock, MiniMaxFinish, MiniMaxStreamChunk, MiniMaxUsage } from './minimaxi/sse.ts'
export { canDisableThinking, MINIMAX_MODELS } from './minimaxi/vendor/mcode-runtime/model-catalog.ts'

// ─── DSH preset dispatch runtime ─────────────────────────────────────────────
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
export type { StreamOptions } from './stream.ts'
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
  servicesOf,
  splitQuestion,
  startedOf,
  switchDrivenSession,
} from './switch-mount.ts'
export type { HostServices } from './switch-mount.ts'
export { GatewayConversations, GatewayChunkQueue, GatewayChunkStream } from './gateway.ts'
export type { GatewayChunk, GatewaySink, GatewayStepEnd } from './gateway.ts'
export { makeSwitchShared, switchShared } from './switch-shared.ts'
export type { MountedModel, SwitchRecord, SwitchShared } from './switch-shared.ts'
export { catalogRoutes, registerCatalog } from './catalog-registration.ts'
