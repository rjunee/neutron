import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { CODEX_CLI_AUTH_ENV_VARS } from '../auth.ts'
import { assertOwnerScope, object } from './project-owner-helper-protocol.ts'
import { assertNoOtherCodexOwner } from './project-owner-crash-recovery.ts'
import { createProjectControlStdioTransport } from './project-control-broker-transport.ts'
import type { CodexOwnerBindingFacts } from './project-control-bootstrap.ts'

/** Backend identity and permission, not a JWT claim, percentage, reset time or
 * missing window. This predicate also gates the successor's own native read. */
export function attestCodexAccountViability(account: unknown, quota: unknown, expected: string): string {
  if (!object(account) || !object(account.account) || account.account.type !== 'chatgpt'
    || !object(quota) || typeof quota.accountId !== 'string' || !quota.accountId
    || quota.ordinaryUsageAllowed !== true) throw new Error('Target account viability is unproven')
  const identity = createHash('sha256').update(JSON.stringify(['chatgpt-account', quota.accountId])).digest('hex')
  if (identity !== expected) throw new Error('Native target account identity mismatch')
  return identity
}

/** On-demand preflight only, before retiring the existing owner. Uses the
 * target's canonical home: the CLI retains refresh ownership in that one home.
 * No thread, turn, browser login, external-auth callback, or credit redemption.
 * Exact exit is awaited before a successor may use this home. */
export async function probeCodexAccountViability(options: {
  binary: string; cwd: string; codexHome: string; env: Readonly<Record<string, string>>
  credentialIdentity: string; timeoutMs?: number
}): Promise<void> {
  assertOwnerScope(options.codexHome, null)
  const marker = `neutron-account-probe-${randomBytes(16).toString('hex')}`
  // Probe ownership is home-only; the original conversation is deliberately
  // still alive in its other home until this preflight has succeeded.
  assertNoOtherCodexOwner({ codexHome: options.codexHome, threadId: marker,
    rolloutPath: join(options.codexHome, marker) } as CodexOwnerBindingFacts)
  const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !CODEX_CLI_AUTH_ENV_VARS.includes(key)))
  const transport = createProjectControlStdioTransport({ ...options, env })
  const timeoutMs = options.timeoutMs ?? 15_000
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let sequence = 0
  let failure: Error | undefined
  const fail = (error: Error): void => {
    failure ??= error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  const timer = setTimeout(() => { fail(new Error('Target account metadata deadline expired')); transport.close() }, timeoutMs)
  transport.listen(message => {
    if (!object(message)) return fail(new Error('Malformed account metadata envelope'))
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        transport.send({ id: message.id, error: { code: -32601, message: 'Account probe cannot satisfy native callbacks' } })
        fail(new Error('Account probe requires unsupported native interaction'))
      }
      return
    }
    const request = typeof message.id === 'number' ? pending.get(message.id) : undefined
    if (!request) return fail(new Error('Uncorrelated account metadata response'))
    pending.delete(message.id as number)
    if ('error' in message || !('result' in message)) request.reject(new Error('Native account metadata read failed'))
    else request.resolve(message.result)
  }, fail)
  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (failure) return Promise.reject(failure)
    const id = ++sequence
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try { transport.send({ id, method, params }) } catch { fail(new Error('Native account metadata transport failed')) }
    })
  }
  try {
    if (!transport.exited || !transport.processIdentity) throw new Error('Account probe process ownership is unproven')
    await request('initialize', { clientInfo: { name: 'neutron-account-probe', version: '1' }, capabilities: { experimentalApi: true } })
    transport.send({ method: 'initialized' })
    const account = await request('account/read', {})
    const quota = await request('account/rateLimits/read', { excludeResetCreditDetails: true, supportsLunaReserve: false })
    attestCodexAccountViability(account, quota, options.credentialIdentity)
  } finally {
    clearTimeout(timer); transport.close()
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!transport.exited) throw new Error('Account probe exit cannot be confirmed')
      await Promise.race([transport.exited, new Promise<never>((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error('Account probe exit is unknown')), timeoutMs)
      })])
    } finally { clearTimeout(exitTimer) }
  }
}
