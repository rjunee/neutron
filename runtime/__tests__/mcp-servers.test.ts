/**
 * THE APPROVAL PROMPT AND THE APPROVED GRANT MUST DESCRIBE THE SAME THING.
 *
 * An installed MCP server is a subprocess started with the owner's permissions, and
 * the owner is the only gate. Two properties carry that:
 *
 *   1. THE HASH covers everything that decides what runs — so a command, an arg or an
 *      env-var NAME cannot change under an approval the owner already gave.
 *   2. THE PROMPT names everything the hash covers, and never a secret VALUE.
 *
 * The pairing is what the tests below assert, rather than the wording: a prompt that
 * overstates or understates what it grants is worse than no gate, and this repo has
 * already shipped that failure once (an egress approval for a capability the code
 * could not exercise — `docs/as-built/2026-08-09-live-agent-web-tools.md`).
 *
 * The fingerprint gets its own describe block because the two ways to get it wrong
 * have opposite symptoms and both are silent: too sensitive and the warm REPL is
 * evicted on every turn (the owner pays a cold spawn per message); too coarse and a
 * server he installed never appears until a restart.
 */

import { describe, expect, test } from 'bun:test'

import {
  MCP_SERVER_ARGS_MAX,
  MCP_SERVER_ENV_VALUE_MAX,
  computeMcpServerGrantHash,
  isReservedMcpServerName,
  mcpSurfaceFingerprint,
  parseOwnerMcpServerInput,
  renderMcpServerGrant,
  type ResolvedOwnerMcpServer,
} from '../mcp-servers.ts'

const GOOD = {
  name: 'example-server',
  command: '/usr/local/bin/example-mcp',
  args: ['--stdio', '--region', 'eu'],
  env: { EXAMPLE_API_KEY: 'sk-not-a-real-key', EXAMPLE_REGION: 'eu' },
}

describe('parseOwnerMcpServerInput — the one validator', () => {
  test('accepts a well-formed server and keeps env NAMES only', () => {
    const { spec, env, errors } = parseOwnerMcpServerInput(GOOD)
    expect(errors).toEqual([])
    expect(spec).not.toBeNull()
    expect(spec!.name).toBe('example-server')
    expect(spec!.args).toEqual(['--stdio', '--region', 'eu'])
    // Sorted, so a re-save in a different key order is the SAME grant.
    expect(spec!.env_names).toEqual(['EXAMPLE_API_KEY', 'EXAMPLE_REGION'])
    // The values come back separately, never on the spec.
    expect(env['EXAMPLE_API_KEY']).toBe('sk-not-a-real-key')
    expect(JSON.stringify(spec)).not.toContain('sk-not-a-real-key')
  })

  test('reports EVERY problem, not the first', () => {
    // The owner is the only one who can fix a bad value, and a form that reports one
    // fault per round trip is a form nobody finishes.
    const { spec, errors } = parseOwnerMcpServerInput({ name: 'Bad Name', command: '' })
    expect(spec).toBeNull()
    expect(errors.length).toBeGreaterThan(1)
    expect(errors.join(' ')).toContain('name')
    expect(errors.join(' ')).toContain('command')
  })

  test('refuses the names Neutron\'s own plumbing occupies', () => {
    // A collision would either shadow the agent's only way to reply or be silently
    // dropped, decided by merge order.
    expect(parseOwnerMcpServerInput({ ...GOOD, name: 'neutron' }).spec).toBeNull()
    expect(parseOwnerMcpServerInput({ ...GOOD, name: 'neutron-abcdef' }).spec).toBeNull()
    expect(isReservedMcpServerName('neutron')).toBe(true)
    expect(isReservedMcpServerName('neutron-deadbeef')).toBe(true)
    expect(isReservedMcpServerName('example-server')).toBe(false)
  })

  test('refuses a command carrying a newline or a bidi override', () => {
    // Both would let the rendered prompt show one thing while the exec\'d argv carried
    // another — the prompt lying is the failure this whole gate exists to prevent.
    expect(parseOwnerMcpServerInput({ ...GOOD, command: '/bin/a\n/bin/b' }).spec).toBeNull()
    expect(parseOwnerMcpServerInput({ ...GOOD, command: '/bin/a‮b' }).spec).toBeNull()
    expect(parseOwnerMcpServerInput({ ...GOOD, args: ['--flag​'] }).spec).toBeNull()
  })

  test('refuses an env name that is not a POSIX variable, and an empty value', () => {
    expect(parseOwnerMcpServerInput({ ...GOOD, env: { 'not-a-var': 'x' } }).spec).toBeNull()
    expect(parseOwnerMcpServerInput({ ...GOOD, env: { GOOD_NAME: '' } }).spec).toBeNull()
  })

  test('never echoes a VALUE in an error message', () => {
    // An error body is a log line waiting to happen.
    const { errors } = parseOwnerMcpServerInput({
      ...GOOD,
      env: { EXAMPLE_API_KEY: 'z'.repeat(MCP_SERVER_ENV_VALUE_MAX + 1) },
    })
    expect(errors.join(' ')).toContain('EXAMPLE_API_KEY')
    expect(errors.join(' ')).not.toContain('zzzz')
  })

  test('caps the arg list rather than truncating it silently', () => {
    const args = Array.from({ length: MCP_SERVER_ARGS_MAX + 1 }, (_, i) => `--a${i}`)
    expect(parseOwnerMcpServerInput({ ...GOOD, args }).spec).toBeNull()
  })

  test('a missing args/env is legal — a bare command is a real MCP server', () => {
    const { spec, errors } = parseOwnerMcpServerInput({ name: 'bare', command: 'example-mcp' })
    expect(errors).toEqual([])
    expect(spec!.args).toEqual([])
    expect(spec!.env_names).toEqual([])
  })
})

describe('computeMcpServerGrantHash — what an approval is bound to', () => {
  const base = parseOwnerMcpServerInput(GOOD).spec!

  test('is stable for the same spec', () => {
    expect(computeMcpServerGrantHash(base)).toBe(
      computeMcpServerGrantHash(parseOwnerMcpServerInput(GOOD).spec!),
    )
  })

  test('CHANGES on a new command, a changed arg, or a new env NAME', () => {
    // Each of these changes what runs, so each must drop the old approval.
    const changed = [
      { ...GOOD, command: '/usr/local/bin/other-mcp' },
      { ...GOOD, args: ['--stdio', '--region', 'us'] },
      { ...GOOD, args: ['--stdio'] },
      { ...GOOD, env: { ...GOOD.env, EXTRA_TOKEN: 'x' } },
    ]
    for (const c of changed) {
      const spec = parseOwnerMcpServerInput(c).spec!
      expect(computeMcpServerGrantHash(spec)).not.toBe(computeMcpServerGrantHash(base))
    }
  })

  test('does NOT change when only a VALUE is rotated', () => {
    // Rotating a token must not silently revoke the approval and stop the assistant
    // working — what was granted is which program runs with which variables set.
    const rotated = parseOwnerMcpServerInput({
      ...GOOD,
      env: { EXAMPLE_API_KEY: 'sk-a-different-value', EXAMPLE_REGION: 'eu' },
    }).spec!
    expect(computeMcpServerGrantHash(rotated)).toBe(computeMcpServerGrantHash(base))
  })

  test('is order-insensitive for env names and order-SENSITIVE for args', () => {
    const reordered = parseOwnerMcpServerInput({
      ...GOOD,
      env: { EXAMPLE_REGION: 'eu', EXAMPLE_API_KEY: 'sk-not-a-real-key' },
    }).spec!
    expect(computeMcpServerGrantHash(reordered)).toBe(computeMcpServerGrantHash(base))
    const swapped = parseOwnerMcpServerInput({ ...GOOD, args: ['--region', '--stdio', 'eu'] }).spec!
    expect(computeMcpServerGrantHash(swapped)).not.toBe(computeMcpServerGrantHash(base))
  })

  test('cannot be forged by moving text across a field boundary', () => {
    // A delimiter-joined hash would collide these two. A canonical JSON array cannot.
    const a = parseOwnerMcpServerInput({ name: 'x', command: 'a', args: ['b'] }).spec!
    const b = parseOwnerMcpServerInput({ name: 'x', command: 'a b', args: [] }).spec!
    expect(computeMcpServerGrantHash(a)).not.toBe(computeMcpServerGrantHash(b))
  })
})

describe('renderMcpServerGrant — the prompt says exactly what the hash covers', () => {
  const spec = parseOwnerMcpServerInput(GOOD).spec!
  const prompt = renderMcpServerGrant(spec)

  test('names the server, the command, EVERY arg, and every env NAME', () => {
    expect(prompt).toContain('example-server')
    expect(prompt).toContain('/usr/local/bin/example-mcp')
    for (const arg of spec.args) expect(prompt).toContain(arg)
    for (const name of spec.env_names) expect(prompt).toContain(name)
  })

  test('never contains a VALUE — the promise it makes about itself', () => {
    expect(prompt).not.toContain('sk-not-a-real-key')
    expect(prompt).toContain('values never')
  })

  test('says what approving PERMITS, and names the tool namespace', () => {
    // "Approve" with no statement of consequence is the understating failure.
    expect(prompt.toLowerCase()).toContain('start this program')
    expect(prompt).toContain('mcp__example-server')
  })

  test('a server with no variables SAYS SO rather than leaving a blank section', () => {
    const bare = parseOwnerMcpServerInput({ name: 'bare', command: 'example-mcp' }).spec!
    expect(renderMcpServerGrant(bare)).toContain('no environment variables')
  })

  test('every field the hash covers appears in the prompt — the pairing, mechanically', () => {
    // The guard against the two halves drifting: change what is hashed without
    // changing what is shown and this fails, whatever the wording is.
    const fields = [spec.name, spec.command, ...spec.args, ...spec.env_names]
    for (const field of fields) expect(prompt).toContain(field)
  })
})

describe('mcpSurfaceFingerprint — the warm-session identity of the installed set', () => {
  const one: ResolvedOwnerMcpServer = {
    name: 'example-server',
    command: '/usr/local/bin/example-mcp',
    args: ['--stdio'],
    env_names: ['EXAMPLE_API_KEY'],
    env: { EXAMPLE_API_KEY: 'v1' },
  }

  test('an empty set is the empty string, so a box with nothing installed is inert', () => {
    expect(mcpSurfaceFingerprint([])).toBe('')
  })

  test('EQUAL configuration yields an EQUAL fingerprint — or the pool thrashes', () => {
    // The failure this pins is invisible and expensive: a fingerprint that varied
    // per call would evict the warm REPL on every single turn.
    expect(mcpSurfaceFingerprint([one])).toBe(mcpSurfaceFingerprint([{ ...one }]))
  })

  test('order does not matter — the same two servers are the same surface', () => {
    const two: ResolvedOwnerMcpServer = { ...one, name: 'other-server' }
    expect(mcpSurfaceFingerprint([one, two])).toBe(mcpSurfaceFingerprint([two, one]))
  })

  test('a changed command, arg, added server, or ROTATED VALUE all move it', () => {
    // The rotated value is the one worth stating: a running child holds the old
    // value in its process env, so only a respawn can pick up a new one.
    const base = mcpSurfaceFingerprint([one])
    expect(mcpSurfaceFingerprint([{ ...one, command: '/bin/other' }])).not.toBe(base)
    expect(mcpSurfaceFingerprint([{ ...one, args: ['--http'] }])).not.toBe(base)
    expect(mcpSurfaceFingerprint([one, { ...one, name: 'second' }])).not.toBe(base)
    expect(
      mcpSurfaceFingerprint([{ ...one, env: { EXAMPLE_API_KEY: 'v2' } }]),
    ).not.toBe(base)
  })

  test('is a digest, not the values — nothing recoverable, nothing loggable', () => {
    const fp = mcpSurfaceFingerprint([one])
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    expect(fp).not.toContain('v1')
  })
})
