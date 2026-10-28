/**
 * Repair a v4 session log whose one tool call answers itself many times.
 *
 * The streaming terminal card (f2d3329) appended a fresh `tool/result` for
 * every output chunk and another one on exit. The session log allows exactly
 * one result per advertised call: the host's v4 validator drops the call from
 * its pending table when the first result arrives, so the second result is
 * rejected with
 *
 *   tool/result <id> has no advertised tool lifecycle
 *
 * and the whole session refuses to load — not the extra card, the session.
 *
 * The log cannot be fixed by deleting lines: every event carries a dense `seq`
 * and every surface node and reference points at it by number, so removing a
 * line renumbers everything after it. The one shape the host itself writes for
 * "same call, newer content" is a surface *replacement*:
 *
 *   surfaceOp: { op: 'replace', startSeq: <node>, endSeq: <node> }
 *   sourceEventSeqs: [<node>]
 *
 * whose payload differs from the node it shadows only in `message.content`
 * (the host enforces exactly that, `surface.ts:assertToolResultRewrite`). A
 * replacement result is exempt from the lifecycle check, so a chain of them
 * produces one current surface node per call while every intermediate chunk
 * stays visible in the raw log.
 *
 * So for each `(turn, toolCallId)` with more than one result, keep the first
 * result as the append and turn each later one into a replacement of the one
 * before it. Chaining to the *previous result in the group* — not to the
 * original append — keeps every target on the current surface even when the
 * log already contains replacements (a final result written that way, or a
 * repaired file run through this script again); rerunning is idempotent.
 *
 * Content is taken from the later result; identity (`message.id`, `source`,
 * `toolCallId`, `isError`, turn, step) is taken from the node being shadowed,
 * because that is what the host compares. The last result in the group wins,
 * which is the accumulated output the card was showing.
 *
 * One more event type refers to the surface by seq: `compaction/prune` (and
 * `compaction/summary`) must name an exact *current* surface span. A log
 * produced by the bug has prune events aimed at the extra chunks, which no
 * longer sit on the surface once those chunks become replacements. The prune
 * is not the thing being repaired — the span is — so it is re-pointed at the
 * surviving node of the same call (the pair's current surface node at that
 * point in the log). Prunes that name more than one node are left alone when
 * they still match and otherwise refused: a multi-node span cannot be mapped
 * without guessing which lineage each node belongs to.
 *
 * Usage:
 *
 *   node scripts/repair-session-log.mjs <session.v4.jsonl.zstd>           # dry run
 *   node scripts/repair-session-log.mjs <session.v4.jsonl.zstd> --write   # back up, then repair
 *   node scripts/repair-session-log.mjs <log.jsonl> --plain --write       # uncompressed input
 *   node scripts/repair-session-log.mjs --scan <sessions-root>…           # check every log
 *   node scripts/repair-session-log.mjs --scan <sessions-root>… --write   # repair every repairable log
 *
 * Scan mode is the pre-load check: it walks one or more sessions directories,
 * decodes every v4 session log (frame-wise zstd or plain JSONL), and reports
 * whether the file is loadable, repairable, or needs a human. Exit code 0 = all
 * loadable, 1 = some are repairable, 2 = some are unreadable or have shapes
 * this script refuses. With `--write` every repairable log is fixed in place
 * (each with its own backup) and refused logs are left untouched.
 * It validates the tool lifecycle and surface spans it knows how to repair; it
 * does not re-implement the host's remaining format rules.
 *
 * The backup is `<file>.bak-<epoch ms>` next to the original. The repaired
 * file is written as one checksummed zstd frame — the same encoding the host
 * writes per batch, and the app's frame scanner reads any number of frames.
 *
 * Verification with the host's own validator is deliberately *not* duplicated
 * here: it lives in the desktop app (`@deepseek-ai/dsh-session-format-v3-to-v4`,
 * `restoreReleasedV4Artifact`), and a second copy of the rules would drift.
 * Run it after a repair; the script prints the decompressed path to hand it.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib'

const ZSTD_MAGIC = 4247762216
const ZSTD_CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }
const RESULT = 'tool/result'
const CALL = 'tool/call'
/** The event types that own a node of the surface (`dsh-session-format-v3-to-v4`). */
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', RESULT])
/** Events whose `shadowedRange` / `shadowedSeqs` must name a current surface span. */
const SPAN_CHECKED = new Set(['compaction/prune', 'compaction/summary'])

class RepairError extends Error {}

/**
 * Locate complete zstd frames without decompressing them.
 *
 * Node's one-shot `zstdDecompressSync` returns only the first frame of a
 * concatenation, which silently truncates a session log to its first write
 * batch — exactly the shape that once made a corrupt log look valid. The app
 * scans frame boundaries itself (`scanZstdFrames` in
 * `dsh-session-persistence-jsonl`), so this mirrors that scan.
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new RepairError(`torn zstd frame header at byte ${offset}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new RepairError(`invalid zstd frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) throw new RepairError(`torn zstd frame header at byte ${start}`)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new RepairError(`reserved zstd frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new RepairError(`torn zstd frame header at byte ${start}`)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new RepairError(`torn zstd block header in frame at byte ${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new RepairError(`reserved zstd block type in frame at byte ${start}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new RepairError(`torn zstd block payload in frame at byte ${start}`)
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new RepairError(`torn zstd checksum in frame at byte ${start}`)
      offset += 4
    }
    frames.push([start, offset])
  }
  return frames
}

function decodeLog(buffer, plain) {
  if (plain) return buffer.toString('utf8')
  const frames = scanFrames(buffer)
  const chunks = frames.map(([start, end]) => {
    try {
      return zstdDecompressSync(buffer.subarray(start, end))
    } catch (error) {
      throw new RepairError(`zstd frame at byte ${start} failed to decode: ${error.message}`)
    }
  })
  return Buffer.concat(chunks).toString('utf8')
}

function parseLog(text) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length < 2) throw new RepairError('log has no events')
  const header = JSON.parse(lines[0])
  const events = lines.slice(1).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new RepairError(`event line ${index + 2} is not JSON: ${error.message}`)
    }
  })
  events.forEach((event, index) => {
    if (event.seq !== index) throw new RepairError(`event at line ${index + 2} has seq ${event.seq}; expected ${index} (not a dense full log)`)
  })
  return { header, events }
}

/** The pair a result answers; step is deliberately absent — results settle across steps. */
function pairOf(event) {
  if (event.type !== RESULT) return undefined
  const id = event.data?.message?.toolCallId
  if (typeof id !== 'string') return undefined
  return `${event.data?.turn}:${id}`
}

function contentOf(event) {
  const content = event.data?.message?.content
  return Array.isArray(content) ? content : undefined
}

/**
 * Rewrite every result after the first of each pair into a replacement of its
 * predecessor. Returns the changed events and the groups it refused to touch.
 */
function repairEvents(events) {
  const groups = new Map()
  for (const event of events) {
    const pair = pairOf(event)
    if (pair === undefined) continue
    if (!groups.has(pair)) groups.set(pair, [])
    groups.get(pair).push(event)
  }

  const rewritten = []
  const refused = []
  for (const [pair, group] of groups) {
    if (group.length < 2) continue
    const [first, ...rest] = group
    if (first.surfaceOp !== 'append') {
      refused.push({ pair, reason: `first result (seq ${first.seq}) is not an append` })
      continue
    }
    if (contentOf(first) === undefined) {
      refused.push({ pair, reason: `first result (seq ${first.seq}) has no message content array` })
      continue
    }
    const missing = contentOf(group.at(-1)) === undefined ? group.find(event => contentOf(event) === undefined) : undefined
    if (missing !== undefined) {
      refused.push({ pair, reason: `result (seq ${missing.seq}) has no message content array` })
      continue
    }

    let shadowed = first
    for (const event of rest) {
      const before = {
        surfaceOp: event.surfaceOp,
        sourceEventSeqs: event.sourceEventSeqs,
        messageId: event.data?.message?.id,
        contentLength: JSON.stringify(contentOf(event)).length,
      }
      const data = { ...shadowed.data, message: { ...shadowed.data.message, content: contentOf(event) } }
      const surfaceOp = { op: 'replace', startSeq: shadowed.seq, endSeq: shadowed.seq }
      // Already a replacement of this predecessor: leave it alone so a rerun
      // reports "ok" instead of making another backup.
      const done = event.surfaceOp?.op === 'replace'
        && event.surfaceOp.startSeq === shadowed.seq
        && event.surfaceOp.endSeq === shadowed.seq
        && Array.isArray(event.sourceEventSeqs)
        && event.sourceEventSeqs.length === 1
        && event.sourceEventSeqs[0] === shadowed.seq
        && JSON.stringify(event.data) === JSON.stringify(data)
      if (!done) {
        event.data = data
        event.surfaceOp = surfaceOp
        event.sourceEventSeqs = [shadowed.seq]
        rewritten.push({ pair, seq: event.seq, before })
      }
      shadowed = event
    }
  }
  return { rewritten, refused }
}

/**
 * Re-point span-checked events at a node the repaired surface actually holds.
 *
 * Folding the rewritten log is the only way to know which seqs are current:
 * a prune names its span by seq, and the host compares that span against the
 * live surface literally. Follows the same fold the host does for surface
 * events (`foldSurface`): append pushes, replace splices the named range.
 *
 * A prune whose span still matches is left untouched — most do, since the
 * compaction mostly targeted first results. A stale single-node span is moved
 * to the current node of the same `(turn, toolCallId)` lineage, which is the
 * node the prune would have named had the duplicates never existed.
 */
function remapSpans(events) {
  const surface = []
  const pairBySeq = new Map()
  const currentByPair = new Map()
  const remapped = []
  const refused = []

  for (const event of events) {
    if (SURFACE_TYPES.has(event.type)) {
      if (event.surfaceOp === 'append') {
        surface.push(event.seq)
      } else if (typeof event.surfaceOp === 'object' && event.surfaceOp?.op === 'replace') {
        const first = surface.indexOf(event.surfaceOp.startSeq)
        const last = surface.indexOf(event.surfaceOp.endSeq)
        if (first < 0 || last < first) {
          refused.push({
            seq: event.seq,
            reason: `surface replacement target is not on the current surface (${event.surfaceOp.startSeq}..${event.surfaceOp.endSeq})`,
          })
          continue
        }
        surface.splice(first, last - first + 1, event.seq)
      } else {
        refused.push({ seq: event.seq, reason: `surface event has an unrecognised surfaceOp ${JSON.stringify(event.surfaceOp)}` })
        continue
      }
      if (event.type === RESULT) {
        const pair = pairOf(event)
        if (pair !== undefined) {
          pairBySeq.set(event.seq, pair)
          currentByPair.set(pair, event.seq)
        }
      }
      continue
    }

    if (!SPAN_CHECKED.has(event.type)) continue
    const range = event.data?.shadowedRange
    const seqs = event.data?.shadowedSeqs
    if (range === undefined || !Array.isArray(seqs)) {
      refused.push({ seq: event.seq, reason: `${event.type} has no shadowedRange / shadowedSeqs` })
      continue
    }
    const first = surface.indexOf(range.start)
    const last = surface.indexOf(range.end)
    const current = first >= 0 && last >= first ? surface.slice(first, last + 1) : undefined
    if (current !== undefined && current.length === seqs.length && current.every((seq, index) => seq === seqs[index])) continue
    if (seqs.length !== 1) {
      refused.push({ seq: event.seq, reason: `${event.type} names ${String(seqs.length)} nodes that are no longer one current span` })
      continue
    }
    const pair = pairBySeq.get(seqs[0])
    const survivor = pair === undefined ? undefined : currentByPair.get(pair)
    if (survivor === undefined) {
      refused.push({ seq: event.seq, reason: `${event.type} names seq ${seqs[0]}, which has no surviving surface node` })
      continue
    }
    event.data = { ...event.data, shadowedRange: { start: survivor, end: survivor }, shadowedSeqs: [survivor] }
    remapped.push({ seq: event.seq, from: seqs[0], to: survivor })
  }

  return { remapped, refused }
}

/**
 * Every result's pair must have been announced and started.
 *
 * The validator's own lifecycle table is authoritative; this only catches the
 * shape the rewrite cannot fix (a result whose call never existed at all), so
 * the script does not claim success on a log that will fail for another
 * reason.
 */
function findOrphans(events) {
  const advertised = new Map()
  const started = new Map()
  const orphans = []
  const unannounced = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type === 'tool-call' && typeof block.id === 'string') {
          const key = `${event.data?.turn}:${block.id}`
          advertised.set(key, (advertised.get(key) ?? 0) + 1)
        }
      }
    } else if (event.type === CALL) {
      const key = `${event.data?.turn}:${event.data?.callId}`
      // The loader admits a tool/call only after an assistant message
      // advertised the same id. The undelivered-attachment card once skipped
      // that message, which made the whole log unloadable.
      if (!advertised.has(key)) unannounced.push({ pair: key, seq: event.seq })
      started.set(key, (started.get(key) ?? 0) + 1)
    } else if (event.type === RESULT && event.surfaceOp === 'append') {
      const pair = pairOf(event)
      if (pair === undefined || !advertised.has(pair) || !started.has(pair)) orphans.push({ pair, seq: event.seq })
    }
  }
  return { orphans, unannounced }
}

/** Decode, parse, and run every repair pass over one log without writing it. */
function inspect(file, plain) {
  const { header, events } = parseLog(decodeLog(readFileSync(file), plain))
  const { rewritten, refused: resultRefusals } = repairEvents(events)
  const { remapped, refused: spanRefusals } = remapSpans(events)
  const { orphans, unannounced } = findOrphans(events)
  return {
    header,
    events,
    rewritten,
    remapped,
    refused: [...resultRefusals, ...spanRefusals],
    orphans,
    unannounced,
  }
}

/** Only v4 logs: they are what the host loads, and the only ones these rules describe. */
const SESSION_LOG = /^session\.v4\.jsonl(\.zstd)?$/
const BACKUP = /\.bak-\d+$/

/** Every session log under a root, skipping backups and lock files. */
function collectLogs(root) {
  if (statSync(root).isFile()) return [root]
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (SESSION_LOG.test(entry.name) && !BACKUP.test(entry.name)) files.push(path)
    }
  }
  walk(root)
  return files.sort()
}

/**
 * One line per log plus a tally; the exit code is the machine-readable half.
 *
 * With `write` a repairable log is fixed in place (same backups as the
 * single-file path). Logs this script refuses are never touched — `--write`
 * repairs what it understands and leaves the rest for a human.
 */
function scan(roots, plain, write) {
  const files = []
  for (const root of roots) {
    if (!existsSync(root)) {
      console.log(`skipped    ${root} — no such directory`)
      continue
    }
    files.push(...collectLogs(root))
  }
  files.sort()
  let repairable = 0
  let repaired = 0
  let broken = 0
  for (const file of files) {
    const isPlain = plain || !file.endsWith('.zstd')
    try {
      const result = inspect(file, isPlain)
      const problems = [
        ...result.refused.map(item => `refused seq ${item.seq}: ${item.reason}`),
        ...result.orphans.map(item => `result at seq ${item.seq} has no announced call (${item.pair})`),
        ...result.unannounced.map(item => `tool/call at seq ${item.seq} has no announcement (${item.pair})`),
      ]
      if (problems.length > 0) {
        broken += 1
        const rest = problems.length > 1 ? ` (+${problems.length - 1} more)` : ''
        console.log(`corrupt    ${file} — ${problems[0]}${rest}`)
      } else if (result.rewritten.length > 0 || result.remapped.length > 0) {
        const detail = `${result.rewritten.length} extra results → replacements, ${result.remapped.length} spans re-pointed`
        if (write) {
          const saved = writeRepaired(file, result.header, result.events, isPlain)
          repaired += 1
          console.log(`repaired   ${file} — ${detail}; backup ${saved.backup}`)
        } else {
          repairable += 1
          console.log(`repairable ${file} — ${detail}; rerun with --scan --write to fix`)
        }
      } else {
        console.log(`ok         ${file} — ${result.events.length} events`)
      }
    } catch (error) {
      broken += 1
      console.log(`unreadable ${file} — ${error.message}`)
    }
  }
  const fixed = repaired > 0 ? `, ${repaired} repaired` : ''
  console.log(`\n${files.length} logs: ${files.length - repairable - repaired - broken} ok, ${repairable} repairable, ${broken} need attention${fixed}`)
  return broken > 0 ? 2 : repairable > 0 ? 1 : 0
}

function serialize(header, events) {
  return `${JSON.stringify(header)}\n${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

/** Back up, then replace one log with its repaired events. */
function writeRepaired(file, header, events, plain) {
  const output = serialize(header, events)
  const encoded = plain ? Buffer.from(output, 'utf8') : zstdCompressSync(Buffer.from(output, 'utf8'), ZSTD_CHECKSUM_OPTIONS)
  const backup = `${file}.bak-${Date.now()}`
  copyFileSync(file, backup)
  writeFileSync(file, encoded)
  return { backup, bytes: encoded.length }
}

function main(argv) {
  const args = argv.slice(2)
  const write = args.includes('--write')
  const plain = args.includes('--plain')
  const scanning = args.includes('--scan')
  const targets = args.filter(arg => !arg.startsWith('--'))
  const file = targets[0]
  if (file === undefined) {
    console.error('usage: node scripts/repair-session-log.mjs <session.v4.jsonl.zstd> [--write] [--plain]')
    console.error('       node scripts/repair-session-log.mjs --scan <sessions-root> [<more-roots>…] [--write]')
    return 2
  }
  if (scanning) {
    return scan(targets, plain, write)
  }

  const { header, events, rewritten, remapped, refused, orphans, unannounced } = inspect(file, plain)

  console.log(JSON.stringify({
    file,
    encoding: plain ? 'plain' : 'zstd-frames',
    events: events.length,
    rewrittenResults: rewritten.length,
    pairs: [...new Set(rewritten.map(item => item.pair))].length,
    remappedSpans: remapped.length,
    remapped,
    refused,
    orphanResultCalls: orphans,
    unannouncedCalls: unannounced,
    written: false,
  }, null, 2))

  if (refused.length > 0 || orphans.length > 0 || unannounced.length > 0) {
    console.error('refusing to write: the log has shapes this repair does not cover')
    return 2
  }
  if (!write) {
    console.log('dry run — pass --write to back up and replace the file')
    return 0
  }
  if (rewritten.length === 0 && remapped.length === 0) {
    console.log('nothing to repair')
    return 0
  }

  const { backup, bytes } = writeRepaired(file, header, events, plain)
  console.log(JSON.stringify({ file, backup, bytes, written: true }, null, 2))
  return 0
}

try {
  process.exitCode = main(process.argv)
} catch (error) {
  if (!(error instanceof RepairError)) throw error
  console.error(`repair-session-log: ${error.message}`)
  process.exitCode = 1
}
