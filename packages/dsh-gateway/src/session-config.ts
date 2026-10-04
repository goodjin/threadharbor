/** Backend session settings (permission mode / model / effort …) as advertised
 *  over ACP, projected into `RemoteSessionView.configOptions`.
 *
 *  Claude and Codex ACP adapters return `configOptions` on `session/new`
 *  (`{id, name, category, currentValue, options:[{value,name}]}`) and switch
 *  them with `session/set_config_option`. Older adapters only return the
 *  ACP `modes` / `models` blocks, switched with `session/set_mode` /
 *  `session/set_model`; those are synthesized into the same shape so the
 *  composer renders one uniform control strip.
 */

import type { JsonValue, RemoteSessionConfigChoice, RemoteSessionConfigOption } from '@threadharbor/protocol'

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function choice(value: JsonValue, idKey: string): RemoteSessionConfigChoice | undefined {
  const row = record(value)
  const id = text(row?.[idKey])
  if (id === undefined) return undefined
  const description = text(row?.['description'])
  return { value: id, name: text(row?.['name']) ?? id, ...(description === undefined ? {} : { description }) }
}

/** ACP `configOptions` may nest its selectable entries in provider groups
 *  (`{group, name, options:[…]}`) instead of listing them flat. The Harness ACP
 *  profile groups every model under its provider route, so a flat read would
 *  find no choices at all and drop the whole option — the selector would then
 *  silently disappear from the composer. */
function flatConfigChoices(entries: JsonValue | undefined): RemoteSessionConfigChoice[] {
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry): RemoteSessionConfigChoice[] => {
    const parsed = choice(entry, 'value')
    if (parsed !== undefined) return [parsed]
    const row = record(entry)
    const groupName = text(row?.['name'])
    const nested = row?.['options']
    if (nested === undefined) return []
    return flatConfigChoices(nested).map(candidate => (groupName === undefined
      ? candidate
      : { ...candidate, name: `${groupName} · ${candidate.name}` }))
  })
}

function nativeConfigOptions(value: JsonValue | undefined): RemoteSessionConfigOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value.flatMap((entry): RemoteSessionConfigOption[] => {
    const row = record(entry)
    const id = text(row?.['id'])
    const currentValue = text(row?.['currentValue'])
    const choices = flatConfigChoices(row?.['options'])
    if (id === undefined || currentValue === undefined) return []
    if (choices.length === 0) return []
    const description = text(row?.['description'])
    const category = text(row?.['category'])
    return [{
      id,
      name: text(row?.['name']) ?? id,
      ...(description === undefined ? {} : { description }),
      ...(category === undefined ? {} : { category }),
      currentValue,
      options: choices,
      setter: 'config',
    }]
  })
  return options.length === 0 ? undefined : options
}

function synthesizedOptions(result: Record<string, JsonValue>): RemoteSessionConfigOption[] | undefined {
  const options: RemoteSessionConfigOption[] = []
  const modes = record(result['modes'])
  const availableModes = Array.isArray(modes?.['availableModes']) ? modes['availableModes'] : []
  const currentModeId = text(modes?.['currentModeId'])
  const modeChoices = availableModes.flatMap(candidate => {
    const parsed = choice(candidate, 'id')
    return parsed === undefined ? [] : [parsed]
  })
  if (currentModeId !== undefined && modeChoices.length > 0) {
    options.push({ id: 'mode', name: 'Mode', category: 'mode', currentValue: currentModeId, options: modeChoices, setter: 'mode' })
  }
  const models = record(result['models'])
  const availableModels = Array.isArray(models?.['availableModels']) ? models['availableModels'] : []
  const currentModelId = text(models?.['currentModelId'])
  const modelChoices = availableModels.flatMap(candidate => {
    const parsed = choice(candidate, 'modelId')
    return parsed === undefined ? [] : [parsed]
  })
  if (currentModelId !== undefined && modelChoices.length > 0) {
    options.push({ id: 'model', name: 'Model', category: 'model', currentValue: currentModelId, options: modelChoices, setter: 'model' })
  }
  return options.length === 0 ? undefined : options
}

/** Read the advertised settings from a JSON-RPC *result* object
 *  (`session/new`, `session/load`, `session/set_config_option`). */
export function configOptionsFromResult(result: JsonValue | undefined): RemoteSessionConfigOption[] | undefined {
  const row = record(result)
  if (row === undefined) return undefined
  return nativeConfigOptions(row['configOptions']) ?? synthesizedOptions(row)
}

function withCurrentValue(
  current: readonly RemoteSessionConfigOption[] | undefined,
  id: string,
  value: string,
): readonly RemoteSessionConfigOption[] | undefined {
  if (current === undefined) return undefined
  let changed = false
  const next = current.map((option) => {
    if (option.id !== id || option.currentValue === value) return option
    changed = true
    return { ...option, currentValue: value }
  })
  return changed ? next : current
}

/** Fold one journaled native frame into the session's advertised settings.
 *  Returns the same reference when the frame carries nothing relevant so the
 *  caller can skip a catalog write + broadcast. */
export function applyConfigFrame(
  current: readonly RemoteSessionConfigOption[] | undefined,
  frame: JsonValue,
): readonly RemoteSessionConfigOption[] | undefined {
  const row = record(frame)
  if (row === undefined) return current
  if (row['method'] === undefined && row['result'] !== undefined) {
    return configOptionsFromResult(row['result']) ?? current
  }
  if (row['method'] !== 'session/update') return current
  const update = record(record(row['params'])?.['update'])
  const kind = update?.['sessionUpdate']
  if (kind === 'config_option_update') {
    return nativeConfigOptions(update?.['configOptions']) ?? current
  }
  if (kind === 'current_mode_update') {
    const modeId = text(update?.['currentModeId'])
    return modeId === undefined ? current : withCurrentValue(current, 'mode', modeId)
  }
  return current
}

/** Build the native request that switches one advertised option. */
export function configSwitchRequest(
  option: RemoteSessionConfigOption,
  nativeSessionId: string,
  value: string,
  rpcId: string,
): JsonValue {
  const params: Record<string, JsonValue> = option.setter === 'config'
    ? { sessionId: nativeSessionId, configId: option.id, value }
    : option.setter === 'mode'
      ? { sessionId: nativeSessionId, modeId: value }
      : { sessionId: nativeSessionId, modelId: value }
  const method = option.setter === 'config' ? 'session/set_config_option'
    : option.setter === 'mode' ? 'session/set_mode' : 'session/set_model'
  return { jsonrpc: '2.0', id: rpcId, method, params }
}

/** Optimistically reflect a switch the backend acknowledged without echoing
 *  the full option list (`session/set_mode` / `session/set_model` return `{}`). */
export function withSwitchedValue(
  current: readonly RemoteSessionConfigOption[],
  id: string,
  value: string,
): readonly RemoteSessionConfigOption[] {
  return withCurrentValue(current, id, value) ?? current
}
