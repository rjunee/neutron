/**
 * @neutronai/channels — Telegram access list: who may talk to this instance's
 * bot, and which chats are connected to which project.
 *
 * ONE FILE, OPERATOR-EDITABLE. The state lives in `<NEUTRON_HOME>/telegram/access.json`
 * so an operator can seed it before the first message (the first allowed user
 * has to come from somewhere other than the bot, or whoever finds the bot first
 * would own it) and can read or repair it with a text editor. Every write is a
 * whole-file atomic replace through a unique temp file.
 *
 * THE RULES, which the receiver enforces and this module makes checkable:
 *   - A message reaches an agent only when its SENDER is an allowed user AND its
 *     CHAT is a connected chat. Anything else is dropped without a reply, except
 *     the pairing commands below.
 *   - `/start` in a private chat from someone not yet allowed issues a short
 *     pairing code (one live code per person, expiring after an hour).
 *   - `/pair <code>` from an allowed user, in a connected chat or a private chat,
 *     admits the person who holds the code. This is how a second member of a
 *     group (a second parent, a co-owner) is added without the operator.
 *   - `/connect` from an allowed user inside a group connects that group to the
 *     default project. A group is never connected by a stranger.
 *
 * Nothing here talks to Telegram; the receiver does. This module is pure state.
 */

import { randomBytes, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Pairing codes live this long. */
export const PAIRING_CODE_TTL_MS = 60 * 60 * 1000
/** At most this many codes are outstanding at once; the oldest is evicted. */
export const MAX_PENDING_CODES = 5
/** Unambiguous alphabet: no 0/O, 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6

export interface TelegramAccessUser {
  name: string
  added_at: number
  /** `operator` when seeded by hand, else the Telegram user id who paired them. */
  added_by: string
}

export interface TelegramAccessChat {
  project_id: string
  title?: string
  connected_at: number
  connected_by: string
}

export interface TelegramPendingCode {
  user_id: string
  name: string
  expires_at: number
}

export interface TelegramAccessState {
  version: 1
  /** Project a newly connected group is bound to. Null until the operator sets it. */
  default_project_id: string | null
  users: Record<string, TelegramAccessUser>
  chats: Record<string, TelegramAccessChat>
  pending: Record<string, TelegramPendingCode>
}

export function emptyAccessState(): TelegramAccessState {
  return { version: 1, default_project_id: null, users: {}, chats: {}, pending: {} }
}

/** `<NEUTRON_HOME>/telegram/access.json` */
export function telegramAccessPath(neutron_home: string): string {
  return join(neutron_home, 'telegram', 'access.json')
}

/**
 * Parse a stored state, keeping only well-formed entries. A malformed file is an
 * EMPTY state (nobody allowed), never a crash and never "allow everyone".
 */
export function parseAccessState(raw: string): TelegramAccessState {
  return parseAccessStateStrict(raw) ?? emptyAccessState()
}

/** Thrown by a change to the access list while its file cannot be parsed. */
export class TelegramAccessUnreadableError extends Error {
  override readonly name = 'TelegramAccessUnreadableError'
  constructor(path: string) {
    super(`${path} is not valid access JSON; refusing to overwrite it`)
  }
}

/** Like {@link parseAccessState}, but null when the text is not a JSON object at all. */
function parseAccessStateStrict(raw: string): TelegramAccessState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  const state = emptyAccessState()
  if (typeof o['default_project_id'] === 'string' && o['default_project_id'].length > 0) {
    state.default_project_id = o['default_project_id']
  }
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
  if (isRecord(o['users'])) {
    for (const [id, u] of Object.entries(o['users'])) {
      if (!/^\d+$/.test(id) || !isRecord(u)) continue
      state.users[id] = {
        name: typeof u['name'] === 'string' ? u['name'] : id,
        added_at: typeof u['added_at'] === 'number' ? u['added_at'] : 0,
        added_by: typeof u['added_by'] === 'string' ? u['added_by'] : 'operator',
      }
    }
  }
  if (isRecord(o['chats'])) {
    for (const [id, c] of Object.entries(o['chats'])) {
      if (!/^-?\d+$/.test(id) || !isRecord(c)) continue
      if (typeof c['project_id'] !== 'string' || c['project_id'].length === 0) continue
      state.chats[id] = {
        project_id: c['project_id'],
        ...(typeof c['title'] === 'string' ? { title: c['title'] } : {}),
        connected_at: typeof c['connected_at'] === 'number' ? c['connected_at'] : 0,
        connected_by: typeof c['connected_by'] === 'string' ? c['connected_by'] : 'operator',
      }
    }
  }
  if (isRecord(o['pending'])) {
    for (const [code, p] of Object.entries(o['pending'])) {
      if (!isRecord(p) || typeof p['user_id'] !== 'string' || typeof p['expires_at'] !== 'number') continue
      state.pending[code] = {
        user_id: p['user_id'],
        name: typeof p['name'] === 'string' ? p['name'] : p['user_id'],
        expires_at: p['expires_at'],
      }
    }
  }
  return state
}

export type PairResult =
  | { ok: true; user_id: string; name: string }
  | { ok: false; reason: 'not_allowed' | 'unknown_code' }

export type ConnectResult =
  | { ok: true; project_id: string; already: boolean }
  | { ok: false; reason: 'not_allowed' | 'not_a_group' | 'no_default_project' }

/**
 * The access list over its file. Reads the file on every call so an operator's
 * hand edit takes effect without a restart; the file is tiny.
 */
export class TelegramAccess {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The current list. An unreadable file reads as empty: nobody is allowed. */
  read(): TelegramAccessState {
    if (!existsSync(this.path)) return emptyAccessState()
    try {
      return parseAccessState(readFileSync(this.path, 'utf8'))
    } catch {
      return emptyAccessState()
    }
  }

  /**
   * The list as the base for a change. A file that exists but is not a JSON
   * object (an operator's half-saved edit) is never replaced: the change is
   * refused with {@link TelegramAccessUnreadableError}, so the operator's users
   * and chats survive for them to repair.
   */
  private readForChange(): TelegramAccessState {
    if (!existsSync(this.path)) return emptyAccessState()
    const state = parseAccessStateStrict(readFileSync(this.path, 'utf8'))
    if (state === null) throw new TelegramAccessUnreadableError(this.path)
    return state
  }

  private write(state: TelegramAccessState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* nothing to clean */
      }
      throw err
    }
  }

  isAllowedUser(user_id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.read().users, user_id)
  }

  /** The project a chat is connected to, or null when the chat is not connected. */
  chatProject(chat_id: string): string | null {
    const chat = this.read().chats[chat_id]
    return chat !== undefined ? chat.project_id : null
  }

  /**
   * A message is delivered only from an allowed sender in a connected chat.
   * Returns the project to deliver to, or null to drop.
   */
  deliveryProject(input: { chat_id: string; user_id: string }): string | null {
    const state = this.read()
    if (!Object.prototype.hasOwnProperty.call(state.users, input.user_id)) return null
    const chat = state.chats[input.chat_id]
    return chat !== undefined ? chat.project_id : null
  }

  /**
   * Issue (or re-show) a pairing code for a person who is not yet allowed.
   * Expired codes are swept; one live code per person; at most
   * {@link MAX_PENDING_CODES} outstanding.
   */
  issueCode(input: { user_id: string; name: string }): string {
    const state = this.readForChange()
    const t = this.now()
    for (const [code, p] of Object.entries(state.pending)) {
      if (p.expires_at <= t) delete state.pending[code]
    }
    for (const [code, p] of Object.entries(state.pending)) {
      if (p.user_id === input.user_id) return code
    }
    const codes = Object.entries(state.pending).sort((a, b) => a[1].expires_at - b[1].expires_at)
    while (codes.length >= MAX_PENDING_CODES) {
      const oldest = codes.shift()
      if (oldest !== undefined) delete state.pending[oldest[0]]
    }
    let code = generateCode()
    while (state.pending[code] !== undefined) code = generateCode()
    state.pending[code] = { user_id: input.user_id, name: input.name, expires_at: t + PAIRING_CODE_TTL_MS }
    this.write(state)
    return code
  }

  /** `/pair <code>` by `by_user_id`. Only an allowed user can admit anyone. */
  pair(input: { code: string; by_user_id: string }): PairResult {
    const state = this.readForChange()
    if (!Object.prototype.hasOwnProperty.call(state.users, input.by_user_id)) {
      return { ok: false, reason: 'not_allowed' }
    }
    const code = input.code.trim().toUpperCase()
    const pending = state.pending[code]
    if (pending === undefined || pending.expires_at <= this.now()) {
      if (pending !== undefined) {
        delete state.pending[code]
        this.write(state)
      }
      return { ok: false, reason: 'unknown_code' }
    }
    delete state.pending[code]
    state.users[pending.user_id] = { name: pending.name, added_at: this.now(), added_by: input.by_user_id }
    this.write(state)
    return { ok: true, user_id: pending.user_id, name: pending.name }
  }

  /** `/connect` inside a group by `by_user_id`: bind the group to the default project. */
  connect(input: { chat_id: string; chat_type: string; title?: string; by_user_id: string }): ConnectResult {
    const state = this.readForChange()
    if (!Object.prototype.hasOwnProperty.call(state.users, input.by_user_id)) {
      return { ok: false, reason: 'not_allowed' }
    }
    if (input.chat_type !== 'group' && input.chat_type !== 'supergroup') {
      return { ok: false, reason: 'not_a_group' }
    }
    const existing = state.chats[input.chat_id]
    if (existing !== undefined) return { ok: true, project_id: existing.project_id, already: true }
    if (state.default_project_id === null) return { ok: false, reason: 'no_default_project' }
    state.chats[input.chat_id] = {
      project_id: state.default_project_id,
      ...(input.title !== undefined ? { title: input.title } : {}),
      connected_at: this.now(),
      connected_by: input.by_user_id,
    }
    this.write(state)
    return { ok: true, project_id: state.default_project_id, already: false }
  }
}

function generateCode(): string {
  let out = ''
  // `randomInt` is uniform over the alphabet (no modulo bias).
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}
