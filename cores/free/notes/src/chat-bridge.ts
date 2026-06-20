/**
 * @neutronai/notes — chat-bridge wiring.
 *
 * Factory that adapts the Notes Core's pure `parseNoteCommand` +
 * `executeNoteCommand` into the gateway's `ChatCommandFilter`
 * contract (see `gateway/http/app-ws-surface.ts`). The gateway holds
 * exactly one filter instance per instance boot; the filter resolves
 * the per-project NotesStore lazily on first `/note` for each
 * (instance, project) pair.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 3.2.
 */

import {
  createInMemoryActiveDrawerStore,
  executeNoteCommand,
  parseNoteCommand,
  type ActiveDrawerStore,
  type NoteCommandResponse,
} from './chat-commands.ts'
import type { NotesStoreResolver } from './store-resolver.ts'

/** What the gateway's app-ws filter passes to `match`. Mirrors the
 *  `ChatCommandFilter` shape in `gateway/http/app-ws-surface.ts`. */
export interface NotesChatCommandFilterInput {
  user_id: string
  project_slug: string
  channel_topic_id: string
  project_id?: string
  body: string
}

/** What the filter returns when the inbound matches `/note`. */
export type NotesChatCommandFilterResult = {
  text: string
  data?: unknown
  deep_link?: string
  error?: { code: string; message: string }
}

export interface NotesChatCommandFilter {
  match(
    input: NotesChatCommandFilterInput,
  ): Promise<NotesChatCommandFilterResult | null>
}

export interface CreateNotesChatCommandFilterOptions {
  resolver: NotesStoreResolver
  /**
   * Project_id used when the inbound's envelope didn't carry one.
   * Defaults to `'default'` — the same constant the legacy 4 MCP tools
   * use when project scope is implicit.
   */
  default_project_id?: string
  /**
   * Override the active-drawer session store (testing seam). When
   * omitted, the factory builds a single in-memory store shared across
   * every `(instance, project, user)` for this gateway process.
   */
  active_drawer_store?: ActiveDrawerStore
}

/**
 * Build the `/note` chat-command filter. Routes inbound bodies whose
 * trimmed text starts with `/note` through `parseNoteCommand` +
 * `executeNoteCommand`; returns `null` for any other inbound so the
 * gateway's chat surface falls through to the LLM dispatch path.
 */
export function createNotesChatCommandFilter(
  opts: CreateNotesChatCommandFilterOptions,
): NotesChatCommandFilter {
  const default_project_id = opts.default_project_id ?? 'default'
  const activeDrawerStore = opts.active_drawer_store ?? createInMemoryActiveDrawerStore()
  return {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.toLowerCase().startsWith('/note')) return null
      const cmd = parseNoteCommand(trimmed)
      // `parseNoteCommand` will only return `unrecognized` here for an
      // inbound that started with `/note` but had a malformed
      // remainder (e.g. `/notefoo`). Surface that as a help-style
      // response so the user sees what shape we expected; don't fall
      // through to the LLM (the inbound STARTED with `/note`, so the
      // user clearly intended a command).
      const project_id = input.project_id ?? default_project_id
      const store = await opts.resolver.resolve(project_id)
      const response: NoteCommandResponse = await executeNoteCommand(cmd, {
        store,
        project_id,
        user_id: input.user_id,
        project_slug: input.project_slug,
        activeDrawerStore,
        source: { kind: 'chat', ref: input.channel_topic_id },
      })
      const out: NotesChatCommandFilterResult = { text: response.text }
      if (response.data !== undefined) out.data = response.data
      if (response.deep_link !== undefined) out.deep_link = response.deep_link
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }
}
