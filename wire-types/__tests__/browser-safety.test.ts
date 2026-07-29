/**
 * @neutronai/wire-types — browser-boundary safety (Codex L6 review regression).
 *
 * The landing `chat-react` client is built as a BROWSER bundle with NO
 * `process` shim (`landing/server.ts` `Bun.build({ target: 'browser' })`), and
 * `landing/chat-react/config.ts` reaches into this leaf for topic-id helpers.
 * Before the fix the leaf BARREL re-exported `./doc-links.ts`, which read
 * `process.env` at MODULE-INIT — so importing the barrel in a browser threw
 * `ReferenceError: process is not defined`.
 *
 * These tests pin the fix by running the exact repro in a SUBPROCESS (a fresh
 * module registry each time, so the assertion isn't defeated by this test
 * process having already evaluated the leaf WITH `process` present):
 *   1. barrel import with `process` deleted → no throw; `webAppBase()` = ''.
 *   2. `./topic-id.ts` subpath import with `process` deleted → no throw.
 *   3. server env (`NEUTRON_WEB_APP_BASE`) still resolves.
 *   4. Expo env (`EXPO_PUBLIC_NEUTRON_WEB_APP_BASE`) still resolves as the
 *      fallback when the server var is unset.
 */

import { describe, expect, test } from 'bun:test'

const LEAF_DIR = new URL('..', import.meta.url).pathname

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function runBun(script: string, env?: Record<string, string>): RunResult {
  const proc = Bun.spawnSync({
    cmd: ['bun', '-e', script],
    cwd: LEAF_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    // Start from a CLEAN env (only what we pass) so a stray
    // NEUTRON_WEB_APP_BASE in the outer shell can't skew the assertions.
    env: { PATH: process.env.PATH ?? '', ...(env ?? {}) },
  })
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  }
}

describe('wire-types browser boundary', () => {
  test('barrel import does NOT throw when process is absent (browser repro)', () => {
    const r = runBun(
      "delete globalThis.process;" +
        " const m = await import('./index.ts');" +
        " if (m.webAppBase() !== '') throw new Error('expected empty webAppBase, got ' + m.webAppBase());" +
        " if (m.WEB_APP_BASE !== '') throw new Error('expected empty WEB_APP_BASE');" +
        " if (typeof m.appWsTopicId !== 'function') throw new Error('missing appWsTopicId');" +
        " console.log('BARREL_OK');",
    )
    expect(r.stderr).not.toContain('process is not defined')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('BARREL_OK')
  })

  test('topic-id subpath import does NOT throw when process is absent', () => {
    const r = runBun(
      "delete globalThis.process;" +
        " const m = await import('./topic-id.ts');" +
        " if (m.appWsProjectTopicId('u','p') !== 'app:u:p') throw new Error('bad topic id');" +
        " console.log('TOPIC_OK');",
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('TOPIC_OK')
  })

  test('server env (NEUTRON_WEB_APP_BASE) still resolves', () => {
    const r = runBun(
      "const m = await import('./doc-links.ts');" +
        " console.log('BASE=' + m.webAppBase());",
      { NEUTRON_WEB_APP_BASE: 'https://srv.example.test/' },
    )
    expect(r.code).toBe(0)
    // Trailing slash stripped.
    expect(r.stdout).toContain('BASE=https://srv.example.test')
  })

  test('Expo env (EXPO_PUBLIC_NEUTRON_WEB_APP_BASE) resolves when the server var is unset', () => {
    const r = runBun(
      "const m = await import('./doc-links.ts');" +
        " console.log('BASE=' + m.webAppBase());",
      { EXPO_PUBLIC_NEUTRON_WEB_APP_BASE: 'https://expo.example.test' },
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('BASE=https://expo.example.test')
  })
})
