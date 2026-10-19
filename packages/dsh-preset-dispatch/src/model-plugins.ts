/**
 * The model plugins, in one place.
 *
 * A preset that is itself a model answers the loop's request instead of opening
 * an ACP session. There is more than one such row — GLM through the local ZCode
 * login, MiniMax through the local MiniMax Code login — and the catalogue takes
 * a single answerer, so this picks the one that owns the preset. Each row is
 * asked in turn and declines by returning nothing.
 */

import type { CatalogTurnRequest } from './catalog.ts'
import { minimaxiModelStream } from './minimaxi-model.ts'
import type { PresetConfig } from './registry.ts'
import { zcodeModelStream } from './zcode-model.ts'
import type { MiniMaxStreamChunk } from '@threadharbor/minimaxi-acp'
import type { GlmStreamChunk } from '@threadharbor/zcode-acp'

/**
 * One answerer for every model row. Returning nothing leaves the request on the
 * gateway path, which is what a preset no plugin claims should get.
 */
export function modelPluginStream(
  config: PresetConfig,
): (presetId: string, request: CatalogTurnRequest) => AsyncIterable<GlmStreamChunk | MiniMaxStreamChunk> | undefined {
  const plugins = [zcodeModelStream(config), minimaxiModelStream(config)]
  return (presetId, request) => {
    for (const plugin of plugins) {
      const stream = plugin(presetId, request)
      if (stream !== undefined) return stream
    }
    return undefined
  }
}
