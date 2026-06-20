/**
 * ISSUES #67 (2026-05-28) — Codex-CLI env-overlay leak regression suite.
 *
 * Mirrors PR #332's ISSUES #49 fix at the Codex-CLI adapter spawn site
 * (`runtime/adapters/gpt-5-5-codex-cli/exec.ts`). Before this fix the
 * `node:child_process.spawn` env arg was `{ ...process.env, ...spawn_env }`,
 * so every host env var inherited into the subprocess — including a
 * leftover `OPENAI_API_KEY` from the gateway box. On a `codex_oauth`
 * instance the `codex` binary's documented auth precedence would prefer
 * the host's `OPENAI_API_KEY` over the persisted OAuth file, billing the
 * host's quota instead of the instance's credential. Same shape as the
 * Anthropic-adapter leak ISSUES #49 closed.
 *
 * Fix (this PR):
 *   1. `auth.ts` widens `CodexResolvedAuth.spawn_env` to
 *      `Record<string, string | undefined>` and pre-seeds the per-path
 *      spawn_env with every var in `CODEX_CLI_AUTH_ENV_VARS` set to
 *      `undefined`, then sets the selected variant.
 *   2. `exec.ts` widens `CodexExecOptions.spawn_env` to the same type
 *      and rewrites the merge as a manual loop that treats `undefined`
 *      as "delete from parentEnv". A new `spawnImpl` injection point on
 *      `CodexExecOptions` lets tests capture the merged env without
 *      depending on a real `codex` binary.
 *   3. `index.ts` propagates `spawnImpl` from `CodexCliSubstrateOptions`
 *      into `startCodexExec` so the end-to-end seam through
 *      `createCodexCliSubstrate → resolveCodexAuth → startCodexExec`
 *      is testable.
 *
 * This file pins the merged-env shape end-to-end through that seam so
 * future overlay changes can't silently re-leak. The four cases mirror
 * the GAP items in ISSUES #67's closing condition (and the
 * structurally-identical four cases in PR #332's
 * `gateway/realmode-composer/__tests__/env-overlay-unset-unused.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import type { Event } from '../../../events.ts'
import type { AgentSpec } from '../../../substrate.ts'
import { createCodexCliSubstrate } from '../index.ts'
import type { CodexSpawnLike } from '../exec.ts'

let codex_home: string

beforeEach(() => {
  codex_home = mkdtempSync(join(tmpdir(), 'neutron-issues-67-'))
})

afterEach(() => {
  rmSync(codex_home, { recursive: true, force: true })
})

const SUCCESS_LINE =
  '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n'

/**
 * Minimal `ChildProcessByStdio<null, Readable, Readable>` stub that emits
 * one successful JSONL line on stdout and exits 0. Implements only the
 * surface exec.ts touches (on / once / removeListener / emit / kill /
 * exitCode / stdout / stderr).
 */
function buildSuccessChild(): {
  child: {
    stdout: Readable
    stderr: Readable
    kill: () => void
    exitCode: number | null
    on: EventEmitter['on']
    once: EventEmitter['once']
    removeListener: EventEmitter['removeListener']
    emit: EventEmitter['emit']
  }
  scheduleExit: () => void
} {
  const emitter = new EventEmitter()
  const stdout = Readable.from([Buffer.from(SUCCESS_LINE)])
  const stderr = Readable.from([])
  let exitCode: number | null = null
  // exec.ts reads child.exitCode synchronously after the for-await loop
  // ends. We schedule the exit transition just after stdout naturally
  // closes so the subsequent exitCode read sees 0.
  const scheduleExit = (): void => {
    setImmediate(() => {
      exitCode = 0
      emitter.emit('exit', 0, null)
    })
  }
  stdout.once('end', scheduleExit)
  // Surface `exitCode` as a getter so mutations from inside scheduleExit
  // are visible to consumers that read it after the exit event.
  const child = {
    stdout,
    stderr,
    kill(): void {
      // no-op
    },
    get exitCode(): number | null {
      return exitCode
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    emit: emitter.emit.bind(emitter),
  }
  return { child, scheduleExit }
}

interface CapturedSpawn {
  cmd: string
  args: ReadonlyArray<string>
  env: Record<string, string>
}

function captureSpawn(): {
  spawnImpl: CodexSpawnLike
  seen: CapturedSpawn[]
} {
  const seen: CapturedSpawn[] = []
  const spawnImpl: CodexSpawnLike = ((cmd, args, opts) => {
    seen.push({ cmd, args, env: opts.env })
    return buildSuccessChild().child as unknown as ReturnType<CodexSpawnLike>
  }) as CodexSpawnLike
  return { spawnImpl, seen }
}

function specWithModel(): AgentSpec {
  return {
    prompt: 'hi',
    tools: [],
    model_preference: ['gpt-5.5-codex'],
  }
}

async function drain(events: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of events) out.push(e)
  return out
}

/**
 * Stub `process.env[key] = value` and restore the prior value (or delete
 * if previously unset) via the returned cleanup fn. Lets the test drive
 * the dual-env-host failure mode without polluting other tests.
 */
function stubEnv(overrides: Record<string, string>): () => void {
  const restores: Array<() => void> = []
  for (const [k, v] of Object.entries(overrides)) {
    const had = Object.prototype.hasOwnProperty.call(process.env, k)
    const prior = process.env[k]
    process.env[k] = v
    if (had) {
      restores.push(() => {
        process.env[k] = prior!
      })
    } else {
      restores.push(() => {
        delete process.env[k]
      })
    }
  }
  return (): void => {
    for (const r of restores) r()
  }
}

/**
 * Belt-and-suspenders: clear a key from `process.env` for the duration
 * of a test so a stray outer-shell export can't mask an "is undefined?"
 * assertion. Restores the prior value on cleanup.
 */
function ensureUnset(key: string): () => void {
  const had = Object.prototype.hasOwnProperty.call(process.env, key)
  const prior = process.env[key]
  delete process.env[key]
  return (): void => {
    if (had) process.env[key] = prior!
  }
}

describe('ISSUES #67 — codex-cli env-overlay unset unused auth vars', () => {
  test('codex_oauth path: host OPENAI_API_KEY + OPENAI_AUTH_TOKEN + OPENAI_API_TOKEN do NOT leak into the spawn env', async () => {
    // Seed CODEX_HOME with an auth.json so the OAuth path resolves.
    writeFileSync(join(codex_home, 'auth.json'), '{"access_token":"test-oauth"}')
    const restoreEnv = stubEnv({
      OPENAI_API_KEY: 'host-api-key-DO-NOT-USE',
      OPENAI_AUTH_TOKEN: 'host-auth-token-DO-NOT-USE',
      OPENAI_API_TOKEN: 'host-api-token-DO-NOT-USE',
    })
    try {
      const { spawnImpl, seen } = captureSpawn()
      const sub = createCodexCliSubstrate({
        env: {}, // empty resolver env -> falls through to OAuth path
        codex_home,
        bin: 'codex',
        spawnImpl,
      })
      const handle = sub.start(specWithModel())
      await drain(handle.events)
      expect(seen.length).toBe(1)
      const env = seen[0]!.env
      // CODEX_HOME survives — it's the per-spawn intent, not an auth credential.
      expect(env['CODEX_HOME']).toBe(codex_home)
      // All three OPENAI_* host vars are gone — they would otherwise inherit
      // via the parentEnv merge and the codex binary would prefer
      // OPENAI_API_KEY over the persisted OAuth file.
      expect(env['OPENAI_API_KEY']).toBeUndefined()
      expect(env['OPENAI_AUTH_TOKEN']).toBeUndefined()
      expect(env['OPENAI_API_TOKEN']).toBeUndefined()
    } finally {
      restoreEnv()
    }
  })

  test('api_key path: host OPENAI_AUTH_TOKEN + OPENAI_API_TOKEN do NOT leak; only pool OPENAI_API_KEY survives', async () => {
    const restoreEnv = stubEnv({
      OPENAI_AUTH_TOKEN: 'host-auth-token-DO-NOT-USE',
      OPENAI_API_TOKEN: 'host-api-token-DO-NOT-USE',
    })
    try {
      const { spawnImpl, seen } = captureSpawn()
      const sub = createCodexCliSubstrate({
        // api_key path requires the resolver env to carry the BYO key.
        env: { OPENAI_API_KEY: 'pool-byo-key' },
        codex_home,
        bin: 'codex',
        spawnImpl,
      })
      const handle = sub.start(specWithModel())
      await drain(handle.events)
      expect(seen.length).toBe(1)
      const env = seen[0]!.env
      // Pool's OPENAI_API_KEY wins.
      expect(env['OPENAI_API_KEY']).toBe('pool-byo-key')
      expect(env['CODEX_HOME']).toBe(codex_home)
      // Defensive variants are dropped even though the host had them set.
      expect(env['OPENAI_AUTH_TOKEN']).toBeUndefined()
      expect(env['OPENAI_API_TOKEN']).toBeUndefined()
    } finally {
      restoreEnv()
    }
  })

  test('codex_oauth path is robust when only ONE host auth var is set (no crash on absent vars)', async () => {
    writeFileSync(join(codex_home, 'auth.json'), '{"access_token":"test-oauth"}')
    const restoreEnv = stubEnv({
      OPENAI_API_KEY: 'host-api-key-DO-NOT-USE',
      // OPENAI_AUTH_TOKEN and OPENAI_API_TOKEN intentionally absent — the
      // delete-side-effect must be a no-op when the var is unset rather
      // than throwing.
    })
    // Belt-and-suspenders: clear the other two so a stray outer-shell
    // export can't mask the "is undefined?" assertion.
    const restoreUnset1 = ensureUnset('OPENAI_AUTH_TOKEN')
    const restoreUnset2 = ensureUnset('OPENAI_API_TOKEN')
    try {
      const { spawnImpl, seen } = captureSpawn()
      const sub = createCodexCliSubstrate({
        env: {}, // falls through to OAuth path
        codex_home,
        bin: 'codex',
        spawnImpl,
      })
      const handle = sub.start(specWithModel())
      await drain(handle.events)
      expect(seen.length).toBe(1)
      const env = seen[0]!.env
      expect(env['CODEX_HOME']).toBe(codex_home)
      expect(env['OPENAI_API_KEY']).toBeUndefined()
      expect(env['OPENAI_AUTH_TOKEN']).toBeUndefined()
      expect(env['OPENAI_API_TOKEN']).toBeUndefined()
    } finally {
      restoreUnset2()
      restoreUnset1()
      restoreEnv()
    }
  })

  test('the per-spawn env delete does NOT mutate process.env', async () => {
    writeFileSync(join(codex_home, 'auth.json'), '{"access_token":"test-oauth"}')
    const restoreEnv = stubEnv({
      OPENAI_API_KEY: 'host-api-key-preserved',
      OPENAI_AUTH_TOKEN: 'host-auth-token-preserved',
      OPENAI_API_TOKEN: 'host-api-token-preserved',
    })
    try {
      const { spawnImpl } = captureSpawn()
      const sub = createCodexCliSubstrate({
        env: {},
        codex_home,
        bin: 'codex',
        spawnImpl,
      })
      const handle = sub.start(specWithModel())
      await drain(handle.events)
      // process.env unchanged — the delete fires on the per-spawn copy
      // inside exec.ts's merge step, never on the global.
      expect(process.env['OPENAI_API_KEY']).toBe('host-api-key-preserved')
      expect(process.env['OPENAI_AUTH_TOKEN']).toBe('host-auth-token-preserved')
      expect(process.env['OPENAI_API_TOKEN']).toBe('host-api-token-preserved')
    } finally {
      restoreEnv()
    }
  })

  test('ISSUES #67 (Codex r1 P2) — host OPENAI_API_KEY does NOT flip a codex_oauth instance onto the api_key path (resolver default env is empty, not process.env)', async () => {
    // The exec-time env-overlay delete only protects against UNSELECTED
    // variants — it cannot rescue an instance whose SELECTED credential
    // was wrong-sourced at resolve time. Without an empty default,
    // `createCodexCliSubstrate()` with no `env` override (the documented
    // production-composer call shape) would inherit `process.env`, see
    // the host's `OPENAI_API_KEY`, and the resolver would pick the
    // `api_key` path — billing the host's quota for the OAuth instance's
    // calls. This test pins the default behaviour by setting host
    // `OPENAI_API_KEY` AND seeding `auth.json` for a codex_oauth instance,
    // then asserting the spawn carries CODEX_HOME alone (no leak of the
    // host key as the "selected" credential).
    writeFileSync(join(codex_home, 'auth.json'), '{"access_token":"test-oauth"}')
    const restoreEnv = stubEnv({
      OPENAI_API_KEY: 'host-api-key-WOULD-LEAK-WITHOUT-FIX',
    })
    try {
      const { spawnImpl, seen } = captureSpawn()
      // Note: NO `env:` override. Pre-fix this would default to
      // `process.env` and the resolver would short-circuit on the host
      // key. Post-fix it defaults to `{}` so the OAuth path resolves.
      const sub = createCodexCliSubstrate({
        codex_home,
        bin: 'codex',
        spawnImpl,
      })
      const handle = sub.start(specWithModel())
      await drain(handle.events)
      expect(seen.length).toBe(1)
      const env = seen[0]!.env
      expect(env['CODEX_HOME']).toBe(codex_home)
      // The host's OPENAI_API_KEY did NOT become the selected credential.
      expect(env['OPENAI_API_KEY']).toBeUndefined()
    } finally {
      restoreEnv()
    }
  })
})
