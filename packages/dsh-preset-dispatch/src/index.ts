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
export { buildPresetTable } from './registry.ts'
export type { AcpPresetConfig, AcpSession, AcpSessionFactory, PresetConfig } from './registry.ts'
export { adaptClient, makeSessionFactory } from './factory.ts'
export type { FactoryDeps } from './factory.ts'
export { attachAcpDispatch } from './service.ts'
export type { AttachOptions } from './service.ts'
export { catalogAdapter, presetForModel, presetOfRoute, providerRoute } from './catalog.ts'
export type { CatalogAdapterLike, CatalogDeps, CatalogModel } from './catalog.ts'
export { decideOnSelection } from './switch.ts'
export type { SelectionDecision, SelectionState } from './switch.ts'
