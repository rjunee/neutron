/**
 * ISSUES #49 (2026-05-28) — env-overlay leak regression suite.
 *
 * The per-spawn env overlay must EXPLICITLY unset the three Anthropic auth vars
 * and set ONLY the selected credential's var, so a host-leaked auth var
 * (managed-tier fallback, dev shim, forgotten export) can't survive into the CC
 * subprocess and out-rank the pool credential (cross-credential billing leak).
 *
 * S3 rip-replace (2026-06-07): responsibility is split across two layers, both
 * pinned here:
 *   1. The COMPOSER produces the scrubbing overlay — the three auth vars present
 *      with the unused ones set to `undefined`, the selected one set to the
 *      secret. Asserted via the `substrateFactory` seam (the composed
 *      `opts.env`).
 *   2. The persistent substrate's `mergeEnv` applies `undefined` as
 *      DELETE-from-inherited-env (so the host var is gone from the child). Pinned
 *      by the persistent substrate's own suite; a focused unit assertion lives at
 *      the bottom of this file too.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildImportSubstrate } from '../build-import-substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-issues-49-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

/** Captures the composed `opts.env` (the scrubbing overlay) per spawn. */
function captureFactory(): {
  substrateFactory: (opts: ClaudeCodeSubstrateOptions) => Substrate
  seen: Array<{ env: Record<string, string | undefined> | undefined }>
} {
  const seen: Array<{ env: Record<string, string | undefined> | undefined }> = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start(_spec: AgentSpec): SessionHandle {
      seen.push({ env: opts.env })
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          substrate_instance_id: opts.substrate_instance_id,
          session: { id: 'sess', last_active_at: Date.now() },
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      })()
      return {
        events,
        respondToTool: async () => undefined,
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  })
  return { substrateFactory, seen }
}

function runSpec(): AgentSpec {
  return {
    prompt: 'hi',
    tools: [],
    model_preference: ['claude-haiku-4-5-20251001'],
  }
}

test('ISSUES #49 — max_oauth path: overlay scrubs ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN (set to undefined)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'm1', kind: 'oauth', secret: 'pool-credential-token' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  const h = sub!.start(runSpec())
  for await (const _ev of h.events) {
    // drain
  }
  expect(seen.length).toBe(1)
  const env = seen[0]!.env
  expect(env).toBeDefined()
  // The selected pool credential is set.
  expect(env!['CLAUDE_CODE_OAUTH_TOKEN']).toBe('pool-credential-token')
  // The unused auth vars are EXPLICITLY scrubbed (present in the overlay as
  // undefined → mergeEnv deletes them from the inherited env).
  expect('ANTHROPIC_API_KEY' in env!).toBe(true)
  expect(env!['ANTHROPIC_API_KEY']).toBeUndefined()
  expect('ANTHROPIC_AUTH_TOKEN' in env!).toBe(true)
  expect(env!['ANTHROPIC_AUTH_TOKEN']).toBeUndefined()
})

test('ISSUES #49 — api_key path: overlay scrubs CLAUDE_CODE_OAUTH_TOKEN + ANTHROPIC_AUTH_TOKEN (set to undefined)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'pool-credential-key' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  const h = sub!.start(runSpec())
  for await (const _ev of h.events) {
    // drain
  }
  const env = seen[0]!.env
  expect(env).toBeDefined()
  // The selected pool credential is set.
  expect(env!['ANTHROPIC_API_KEY']).toBe('pool-credential-key')
  // The unused auth vars are explicitly scrubbed.
  expect(env!['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
  expect('CLAUDE_CODE_OAUTH_TOKEN' in env!).toBe(true)
  expect(env!['ANTHROPIC_AUTH_TOKEN']).toBeUndefined()
  expect('ANTHROPIC_AUTH_TOKEN' in env!).toBe(true)
})

// The merge-applies-undefined-as-DELETE contract (the half that actually
// removes the host var from the child) is pinned against the real persistent
// substrate spawn path in
// `runtime/adapters/claude-code/persistent/__tests__/credential-rotation-rekey.test.ts`
// ("ISSUES #49 — an overlay var set to `undefined` is DELETED from the spawned
// child env").
