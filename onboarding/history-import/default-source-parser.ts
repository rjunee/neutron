/**
 * @neutronai/onboarding/history-import — default SourceParser dispatcher.
 *
 * Wires every supported source to its parser. The runner injects this
 * via `ImportJobRunnerDeps.parse`; tests substitute their own.
 */

import { parseChatgptExport } from './chatgpt-export.ts'
import { parseClaudeExport } from './claude-export.ts'
import {
  ImportError,
  type ChunkerInput,
  type ConversationRecord,
  type ImportSource,
} from './types.ts'

/**
 * Build a `SourceParser` that dispatches on source. The live onboarding
 * import path is zip-only (`chatgpt-zip` / `claude-zip`); production
 * injects this via gateway/composition.ts.
 */
export function buildDefaultSourceParser(): (
  source: ImportSource,
  payload: ChunkerInput,
) => AsyncIterable<ConversationRecord> {
  return (source, payload) => {
    switch (source) {
      case 'chatgpt-zip':
        return parseChatgptExport(asBuffer(source, payload))
      case 'claude-zip':
        return parseClaudeExport(asBuffer(source, payload))
    }
  }
}

function asBuffer(source: ImportSource, payload: ChunkerInput): Buffer {
  if (Buffer.isBuffer(payload)) return payload
  throw new ImportError(
    'parse_failed',
    source,
    `expected Buffer payload for source=${source}, got ${typeof payload}`,
  )
}
