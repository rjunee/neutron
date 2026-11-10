import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  TelegramAccessUnreadableError,
  MAX_PENDING_CODES,
  PAIRING_CODE_TTL_MS,
  TelegramAccess,
  parseAccessState,
  telegramAccessPath,
} from '../access.ts'

let home: string
let path: string
let clock: number

function seed(state: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-access-'))
  path = telegramAccessPath(home)
  clock = 1_000_000
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('parseAccessState', () => {
  test('malformed input is an empty state, never allow-all', () => {
    for (const raw of ['', 'not json', 'null', '[]', '3', '{"users": "everyone"}']) {
      const s = parseAccessState(raw)
      expect(Object.keys(s.users)).toEqual([])
      expect(Object.keys(s.chats)).toEqual([])
    }
  })

  test('keeps well-formed entries and drops the rest', () => {
    const s = parseAccessState(
      JSON.stringify({
        default_project_id: 'family',
        users: { '111': { name: 'Parent One' }, 'abc': { name: 'bad id' }, '222': 'not an object' },
        chats: { '-100500': { project_id: 'family' }, '-7': { project_id: '' } },
      }),
    )
    expect(Object.keys(s.users)).toEqual(['111'])
    expect(Object.keys(s.chats)).toEqual(['-100500'])
    expect(s.default_project_id).toBe('family')
  })
})

describe('TelegramAccess', () => {
  const access = (): TelegramAccess => new TelegramAccess(path, () => clock)

  test('no file: nobody is allowed and nothing is delivered', () => {
    const a = access()
    expect(a.isAllowedUser('111')).toBe(false)
    expect(a.deliveryProject({ chat_id: '-100500', user_id: '111' })).toBeNull()
  })

  test('delivery needs BOTH an allowed sender and a connected chat', () => {
    seed({ users: { '111': { name: 'Parent One' } }, chats: { '-100500': { project_id: 'family' } } })
    const a = access()
    expect(a.deliveryProject({ chat_id: '-100500', user_id: '111' })).toBe('family')
    expect(a.deliveryProject({ chat_id: '-100500', user_id: '999' })).toBeNull()
    expect(a.deliveryProject({ chat_id: '-100600', user_id: '111' })).toBeNull()
  })

  test('a second person is admitted by code from an allowed user', () => {
    seed({ users: { '111': { name: 'Parent One' } }, chats: {} })
    const a = access()
    const code = a.issueCode({ user_id: '222', name: 'Parent Two' })
    expect(code).toMatch(/^[A-Z2-9]{6}$/)
    // Asking again returns the same live code.
    expect(a.issueCode({ user_id: '222', name: 'Parent Two' })).toBe(code)
    // A stranger cannot use it.
    expect(a.pair({ code, by_user_id: '333' })).toEqual({ ok: false, reason: 'not_allowed' })
    const r = a.pair({ code: code.toLowerCase(), by_user_id: '111' })
    expect(r).toEqual({ ok: true, user_id: '222', name: 'Parent Two' })
    expect(a.isAllowedUser('222')).toBe(true)
    expect(a.read().users['222']?.added_by).toBe('111')
    // Single use.
    expect(a.pair({ code, by_user_id: '111' })).toEqual({ ok: false, reason: 'unknown_code' })
  })

  test('codes expire', () => {
    seed({ users: { '111': { name: 'Parent One' } } })
    const a = access()
    const code = a.issueCode({ user_id: '222', name: 'Parent Two' })
    clock += PAIRING_CODE_TTL_MS + 1
    expect(a.pair({ code, by_user_id: '111' })).toEqual({ ok: false, reason: 'unknown_code' })
    expect(a.isAllowedUser('222')).toBe(false)
  })

  test('outstanding codes are capped', () => {
    const a = access()
    for (let i = 0; i < MAX_PENDING_CODES + 3; i++) {
      clock += 1
      a.issueCode({ user_id: String(500 + i), name: `p${i}` })
    }
    expect(Object.keys(a.read().pending).length).toBe(MAX_PENDING_CODES)
  })

  test('connect binds a group to the default project, only for an allowed user', () => {
    seed({ default_project_id: 'family', users: { '111': { name: 'Parent One' } } })
    const a = access()
    expect(a.connect({ chat_id: '-100500', chat_type: 'group', by_user_id: '999' })).toEqual({ ok: false, reason: 'not_allowed' })
    expect(a.connect({ chat_id: '111', chat_type: 'private', by_user_id: '111' })).toEqual({ ok: false, reason: 'not_a_group' })
    expect(a.connect({ chat_id: '-100500', chat_type: 'group', title: 'Home', by_user_id: '111' })).toEqual({
      ok: true,
      project_id: 'family',
      already: false,
    })
    expect(a.chatProject('-100500')).toBe('family')
    expect(a.connect({ chat_id: '-100500', chat_type: 'group', by_user_id: '111' })).toEqual({
      ok: true,
      project_id: 'family',
      already: true,
    })
  })

  test('connect without a default project is refused', () => {
    seed({ users: { '111': { name: 'Parent One' } } })
    expect(access().connect({ chat_id: '-1', chat_type: 'supergroup', by_user_id: '111' })).toEqual({
      ok: false,
      reason: 'no_default_project',
    })
  })

  test('the file is written owner-only and stays valid JSON', () => {
    const a = access()
    a.issueCode({ user_id: '222', name: 'Parent Two' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
  })

  test('an unreadable file is never overwritten by a change', () => {
    mkdirSync(dirname(path), { recursive: true })
    const halfSaved = '{"users": {"111": {"name": "Parent One"}}, "chats": {'
    writeFileSync(path, halfSaved)
    const a = access()
    expect(a.isAllowedUser('111')).toBe(false)
    expect(() => a.issueCode({ user_id: '222', name: 'Stranger' })).toThrow(TelegramAccessUnreadableError)
    expect(() => a.pair({ code: 'ABCDEF', by_user_id: '111' })).toThrow(TelegramAccessUnreadableError)
    expect(() => a.connect({ chat_id: '-1', chat_type: 'group', by_user_id: '111' })).toThrow(TelegramAccessUnreadableError)
    expect(readFileSync(path, 'utf8')).toBe(halfSaved)
  })
})
