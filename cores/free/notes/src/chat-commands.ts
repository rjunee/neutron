/**
 * @neutronai/notes — `/note ...` chat-command parser + dispatcher.
 *
 * Pure parser (`parseNoteCommand`) splits a raw chat-send body into a
 * typed command shape; the dispatcher (`executeNoteCommand`) calls the
 * matching NotesStore method and returns a chat-render-ready envelope.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 3.2.
 *
 * Commands:
 *   /note <body>                    — capture into the active or inbox drawer
 *   /note find <query>              — hybrid lex+vec search
 *   /note drawer <name>             — create-or-switch the active drawer
 *   /note tunnel <from_id> <to_id>  — directed KG edge between two notes
 *   /note help | (bare /note)       — surface a tiny cheatsheet
 *
 * The active drawer is per-`(instance, project, user)` and stored in
 * memory by the dispatcher's caller (the chat-bridge wiring point).
 * S1 ships in-memory; S2 may persist to a `notes_session_state` table
 * inside the per-project sidecar.
 */

import { search, type SearchHit } from './search.ts'
import {
  KG_EDGE_KIND_USER_TUNNEL,
  NotesStore,
  NotesStoreError,
} from './notes-store.ts'

export type NoteCommand =
  | { kind: 'capture'; body: string; drawer_name?: string }
  | { kind: 'search'; query: string }
  | { kind: 'drawer'; name: string }
  | { kind: 'tunnel'; from: string; to: string }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

/**
 * Pure parser. The first whitespace-separated token after `/note`
 * (lowercased) selects the subcommand. Everything after that token
 * (and a single space) is the body. Bare `/note` returns help.
 */
export function parseNoteCommand(raw: string): NoteCommand {
  const trimmed = raw.trimStart()
  if (!trimmed.toLowerCase().startsWith('/note')) {
    return { kind: 'unrecognized', reason: 'not a /note command' }
  }
  const afterVerb = trimmed.slice('/note'.length)
  if (afterVerb.length === 0) return { kind: 'help' }
  if (!/^\s/.test(afterVerb)) {
    // /noteFOO is not a /note command — needs a separator after the
    // verb.
    return { kind: 'unrecognized', reason: 'missing space after /note' }
  }
  const rest = afterVerb.trim()
  if (rest.length === 0) return { kind: 'help' }
  if (rest === 'help' || rest.toLowerCase() === 'help') return { kind: 'help' }

  // Inspect the first token; if it's a known subcommand, dispatch.
  // Otherwise treat the entire rest as a capture body.
  const firstSpace = rest.indexOf(' ')
  const head = (firstSpace === -1 ? rest : rest.slice(0, firstSpace)).toLowerCase()
  const tail = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim()

  if (head === 'find') {
    if (tail.length === 0) {
      return { kind: 'unrecognized', reason: 'usage: /note find <query>' }
    }
    return { kind: 'search', query: tail }
  }
  if (head === 'drawer') {
    if (tail.length === 0) {
      return { kind: 'unrecognized', reason: 'usage: /note drawer <name>' }
    }
    return { kind: 'drawer', name: tail }
  }
  if (head === 'tunnel') {
    if (tail.length === 0) {
      return { kind: 'unrecognized', reason: 'usage: /note tunnel <from_id> <to_id>' }
    }
    const parts = tail.split(/\s+/).filter((s) => s.length > 0)
    if (parts.length !== 2) {
      return { kind: 'unrecognized', reason: 'usage: /note tunnel <from_id> <to_id>' }
    }
    const from = parts[0]
    const to = parts[1]
    if (from === undefined || to === undefined) {
      return { kind: 'unrecognized', reason: 'usage: /note tunnel <from_id> <to_id>' }
    }
    return { kind: 'tunnel', from, to }
  }

  // Otherwise capture the entire remainder.
  return { kind: 'capture', body: rest }
}

export interface NoteCommandResponse {
  /** A short confirmation / result one-liner for the chat reply. */
  text: string
  /** Optional structured payload (search hits, drawer list, etc.). */
  data?: unknown
  /** Optional deep-link the channel may surface as a tap target. */
  deep_link?: string
  /** Populated only when the command was malformed or denied. */
  error?: {
    code:
      | 'malformed'
      | 'unknown_drawer'
      | 'unknown_note'
      | 'tunnel_self_loop'
      | 'capability_denied'
      | 'store_error'
    message: string
  }
}

export interface NoteCommandContext {
  store: NotesStore
  project_id: string
  user_id: string
  /** Session-scoped active drawer id; reads + writes via the
   *  caller-supplied {@link activeDrawerStore}. */
  activeDrawerStore?: ActiveDrawerStore
  /** Source identifier stamped on captured notes (default `chat`). */
  source?: { kind: 'chat' | 'launcher' | 'mcp_tool' | 'import'; ref?: string }
}

export interface ActiveDrawerStore {
  get(key: ActiveDrawerKey): string | undefined
  set(key: ActiveDrawerKey, drawer_id: string): void
}

export interface ActiveDrawerKey {
  project_slug: string
  project_id: string
  user_id: string
}

/** Build an in-memory active-drawer store. Production wires exactly
 *  one per gateway process; tests inject their own. */
export function createInMemoryActiveDrawerStore(): ActiveDrawerStore {
  const map = new Map<string, string>()
  const keyOf = (k: ActiveDrawerKey): string =>
    `${k.project_slug}::${k.project_id}::${k.user_id}`
  return {
    get(k) {
      return map.get(keyOf(k))
    },
    set(k, drawer_id) {
      map.set(keyOf(k), drawer_id)
    },
  }
}

export async function executeNoteCommand(
  cmd: NoteCommand,
  ctx: NoteCommandContext & { project_slug: string },
): Promise<NoteCommandResponse> {
  try {
    switch (cmd.kind) {
      case 'help':
        return helpResponse()
      case 'unrecognized':
        return {
          text: `Note command not understood: ${cmd.reason}`,
          error: { code: 'malformed', message: cmd.reason },
        }
      case 'capture':
        return await captureNote(cmd.body, ctx)
      case 'search':
        return await searchNotes(cmd.query, ctx)
      case 'drawer':
        return drawerSwitch(cmd.name, ctx)
      case 'tunnel':
        return tunnelNotes(cmd.from, cmd.to, ctx)
    }
  } catch (err) {
    if (err instanceof NotesStoreError) {
      const code =
        err.code === 'unknown_drawer'
          ? 'unknown_drawer'
          : err.code === 'unknown_note'
            ? 'unknown_note'
            : err.code === 'tunnel_self_loop'
              ? 'tunnel_self_loop'
              : 'store_error'
      return {
        text: `Notes Core: ${err.message}`,
        error: { code, message: err.message },
      }
    }
    const message = err instanceof Error ? err.message : 'unknown error'
    return {
      text: `Notes Core: ${message}`,
      error: { code: 'store_error', message },
    }
  }
}

function helpResponse(): NoteCommandResponse {
  return {
    text:
      'Notes Core commands: ' +
      '`/note <body>` capture · ' +
      '`/note find <q>` search · ' +
      '`/note drawer <name>` switch · ' +
      '`/note tunnel <from> <to>` link.',
  }
}

async function captureNote(
  body: string,
  ctx: NoteCommandContext & { project_slug: string },
): Promise<NoteCommandResponse> {
  if (body.trim().length === 0) {
    return {
      text: 'Note command not understood: empty body.',
      error: { code: 'malformed', message: 'empty body' },
    }
  }
  const activeDrawerId = ctx.activeDrawerStore?.get({
    project_slug: ctx.project_slug,
    project_id: ctx.project_id,
    user_id: ctx.user_id,
  })
  const writeInput: Parameters<NotesStore['write']>[0] = {
    content: body,
    source_kind: ctx.source?.kind ?? 'chat',
  }
  if (activeDrawerId !== undefined) writeInput.drawer_id = activeDrawerId
  if (ctx.source?.ref !== undefined) writeInput.source_ref = ctx.source.ref
  const result = ctx.store.write(writeInput)
  return {
    text: `Note captured (${result.id}).`,
    data: { note_id: result.id, drawer_id: result.drawer_id },
    deep_link: `/projects/${ctx.project_id}/notes#${result.id}`,
  }
}

async function searchNotes(
  query: string,
  ctx: NoteCommandContext,
): Promise<NoteCommandResponse> {
  const results = await search({
    store: ctx.store,
    project_id: ctx.project_id,
    query,
    limit: 10,
  })
  if (results.length === 0) {
    return { text: `No notes match "${query}".`, data: { results } }
  }
  const top = results.slice(0, 3)
  const summary = top
    .map((hit: SearchHit) => `• ${hit.snippet.slice(0, 60)}…`)
    .join('\n')
  return {
    text: `${results.length} note${results.length === 1 ? '' : 's'} match "${query}":\n${summary}`,
    data: { results },
  }
}

function drawerSwitch(
  name: string,
  ctx: NoteCommandContext & { project_slug: string },
): NoteCommandResponse {
  const drawer = ctx.store.findDrawerByName(name) ?? ctx.store.createDrawer({ name })
  if (ctx.activeDrawerStore !== undefined) {
    ctx.activeDrawerStore.set(
      {
        project_slug: ctx.project_slug,
        project_id: ctx.project_id,
        user_id: ctx.user_id,
      },
      drawer.id,
    )
  }
  return {
    text: `Active drawer: ${drawer.name}`,
    data: { drawer_id: drawer.id, drawer_name: drawer.name },
  }
}

function tunnelNotes(
  from: string,
  to: string,
  ctx: NoteCommandContext,
): NoteCommandResponse {
  const edge = ctx.store.tunnel(from, to, KG_EDGE_KIND_USER_TUNNEL)
  return {
    text: `Tunneled note ${from} → ${to}.`,
    data: { edge_id: edge.id, source_id: edge.source_id, target_id: edge.target_id },
  }
}
