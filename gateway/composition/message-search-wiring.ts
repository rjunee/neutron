/**
 * @neutronai/gateway — server-side wiring for the `message_search` agent tool.
 *
 * The gateway does not keep a `@neutronai/chat-core` message Store; it keeps
 * per-topic conversation history in `ButtonStore` (each "turn" is an agent
 * prompt body plus, when the user replied, their resolution text). This module
 * adapts that history into the {@link MessageHistorySource} the message-search
 * runtime consumes, so the live agent can full-text-search the CURRENT
 * conversation mid-turn without a second persistent server-side index.
 *
 * Per-topic by design (see {@link HistorySourceMessageSearchRuntime}): the
 * agent's dominant need is "where did we land on X in THIS chat". Cross-topic
 * global search is the client store's job (web wasm-sqlite / RN op-sqlite).
 */

import type { ButtonStore, ChatHistoryTurn } from '../../channels/button-store.ts'
import type { ChatMessage } from '../../chat-core/types.ts'
import {
  HistorySourceMessageSearchRuntime,
  type MessageHistorySource,
  type MessageSearchRuntime,
} from '../../message-search/runtime.ts'

/** Page size when walking ButtonStore history (it paginates by cursor). */
const HISTORY_PAGE = 100

/**
 * Lift one ButtonStore turn into chat messages: the agent prompt body, and —
 * when the user replied — their reply as a user message ordered just after it.
 * Synthetic resolution sentinels (`__timeout__` / `__cancel__`) never reach
 * here: `rowToHistoryTurn` already maps them to `resolved:false`.
 */
function turnToMessages(topic_id: string, t: ChatHistoryTurn): ChatMessage[] {
  const msgs: ChatMessage[] = []
  if (t.body.length > 0) {
    msgs.push({
      topic_id,
      client_msg_id: `${t.prompt_id}:a`,
      message_id: t.prompt_id,
      seq: null,
      role: 'agent',
      body: t.body,
      project_id: null,
      attachments: null,
      created_at: t.created_at,
      status: 'acked',
    })
  }
  if (t.resolved && t.resolution_text.length > 0) {
    msgs.push({
      topic_id,
      client_msg_id: `${t.prompt_id}:u`,
      message_id: `${t.prompt_id}:u`,
      seq: null,
      role: 'user',
      body: t.resolution_text,
      project_id: null,
      attachments: null,
      // +1ms so the reply sorts immediately after the prompt it answered.
      created_at: t.created_at + 1,
      status: 'acked',
    })
  }
  return msgs
}

/** A {@link MessageHistorySource} over a topic's ButtonStore history. */
class ButtonStoreMessageSource implements MessageHistorySource {
  private readonly buttonStore: ButtonStore
  constructor(buttonStore: ButtonStore) {
    this.buttonStore = buttonStore
  }

  async loadTopicMessages(topic_id: string, limit: number): Promise<ChatMessage[]> {
    const out: ChatMessage[] = []
    const now = Date.now()
    let before = now
    let before_prompt_id: string | null = null
    try {
      // Walk newest→oldest in cursor pages until we have enough turns or the
      // history is exhausted. The FTS in the ephemeral store re-ranks, so the
      // descending fetch order doesn't matter.
      while (out.length < limit) {
        const { turns, has_more } = await this.buttonStore.listHistoryByTopic({
          topic_id,
          before,
          before_prompt_id,
          limit: HISTORY_PAGE,
          now,
        })
        if (turns.length === 0) break
        for (const t of turns) out.push(...turnToMessages(topic_id, t))
        const last = turns[turns.length - 1]
        if (last === undefined || !has_more) break
        before = last.created_at
        before_prompt_id = last.prompt_id
      }
    } catch {
      // History read failed — degrade to whatever we gathered (often nothing)
      // rather than throwing into the agent turn.
    }
    return out
  }
}

/**
 * Build the server-side {@link MessageSearchRuntime} backing the
 * `message_search` tool, sourced from a topic's ButtonStore history.
 */
export function buildButtonStoreMessageSearchRuntime(
  buttonStore: ButtonStore,
): MessageSearchRuntime {
  return new HistorySourceMessageSearchRuntime(new ButtonStoreMessageSource(buttonStore))
}
