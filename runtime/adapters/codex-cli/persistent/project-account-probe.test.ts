import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as transport from './project-control-broker-transport.ts'
import * as census from './project-owner-crash-recovery.ts'
import { attestCodexAccountViability, probeCodexAccountViability } from './project-account-probe.ts'

const identity = createHash('sha256').update(JSON.stringify(['chatgpt-account', 'target'])).digest('hex')
const account = { account: { type: 'chatgpt', email: null, planType: 'pro' } }
const quota = { accountId: 'target', ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10080 }, secondary: null } }
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

test('account viability requires backend identity and explicit permission, not an absent short window or reset credit', () => {
  expect(attestCodexAccountViability(account, quota, identity)).toBe(identity)
  for (const changed of [{ ...quota, accountId: 'foreign' }, { ...quota, accountId: null },
    { ...quota, ordinaryUsageAllowed: null }, { ...quota, ordinaryUsageAllowed: false },
    { rateLimits: { primary: { usedPercent: 0 } }, rateLimitResetCredits: { availableCount: 3 } }]) {
    expect(() => attestCodexAccountViability(account, changed, identity)).toThrow()
  }
  expect(() => attestCodexAccountViability({ account: { type: 'apiKey' } }, quota, identity)).toThrow()
})

for (const fault of ['none', 'foreign', 'refused', 'callback', 'unknown-exit', 'owned-home']) test(`bounded account preflight sends only metadata, refuses ${fault}, and closes only its transport`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'account-probe-')); cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const methods: string[] = []
  let receive!: (value: unknown) => void, closed = 0
  const owner = spyOn(census, 'assertNoOtherCodexOwner').mockImplementation(() => { if (fault === 'owned-home') throw new Error('Existing owner') })
  cleanup.push(() => owner.mockRestore())
  const factory = spyOn(transport, 'createProjectControlStdioTransport').mockImplementation(options => {
    expect(options.env.OPENAI_API_KEY).toBeUndefined()
    expect(options.codexHome).toBe(home)
    return {
      processIdentity: { pid: 1, boot: 'fixture', start: '1' },
      exited: fault === 'unknown-exit' ? new Promise(() => {}) : Promise.resolve({ pid: 1, boot: 'fixture', start: '1', code: 0, signal: null }),
      listen(listener) { receive = listener }, close() { closed++ },
      send(message) {
        if (!message.method) return
        methods.push(String(message.method))
        if (message.method === 'initialized') return
        queueMicrotask(() => {
          if (message.method === 'account/read' && fault === 'callback') {
            receive({ id: 'refresh', method: 'account/chatgptAuthTokens/refresh', params: {} }); return
          }
          if (message.method === 'account/rateLimits/read' && fault === 'refused') {
            receive({ id: message.id, error: { code: -1, message: 'Not authorized' } }); return
          }
          receive({ id: message.id, result: message.method === 'account/read' ? account
            : message.method === 'account/rateLimits/read' ? { ...quota, accountId: fault === 'foreign' ? 'other' : 'target' } : {} })
        })
      },
    }
  }); cleanup.push(() => factory.mockRestore())
  const operation = probeCodexAccountViability({ binary: 'must-not-run', cwd: home, codexHome: home,
    env: { OPENAI_API_KEY: 'must-not-leak' }, credentialIdentity: identity, timeoutMs: 25 })
  if (fault === 'none') await operation
  else await expect(operation).rejects.toThrow()
  if (fault === 'owned-home') { expect(factory).not.toHaveBeenCalled(); expect(closed).toBe(0) }
  else expect(closed).toBeGreaterThan(0)
  expect(methods.every(method => ['initialize', 'initialized', 'account/read', 'account/rateLimits/read'].includes(method))).toBe(true)
  if (fault === 'none') expect(methods).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read'])
})
