/**
 * unconditional-persistent.test.ts — S3 rip-replace acceptance (2026-06-07).
 *
 * `createClaudeCodeSubstrateAuto` UNCONDITIONALLY builds the persistent
 * interactive-REPL substrate. There is NO `NEUTRON_PERSISTENT_REPL` flag and NO
 * `claude -p` fallback — the legacy per-turn transport was HARD-DELETED. The
 * selector ignores the env entirely: unset / '0' / '1' all yield the persistent
 * substrate.
 *
 * Asserted by a distinguishing side effect: the persistent substrate's
 * `respondToTool` rejects with a `persistent-repl:` message (the deleted cli
 * path said `cc-adapter:`), and it never spawns a `claude -p` subprocess.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeCodeSubstrateAuto } from '../index.ts'
import { shutdownAllPersistentRepls } from '../persistent/persistent-repl-substrate.ts'

// HERMETIC: these tests assert substrate SELECTION and wiring, not spawning — but
// `start()` reaches the real `HerdrHost`, which now works. Pointing the socket at a
// path that does not exist makes the spawn fail immediately instead of creating REAL
// PANES on the developer's herdr server and waiting out the pid timeout. Before the
// transport was fixed these tests were fast by accident: the client could not get past
// its own protocol ping, so nothing was ever spawned.
//
// SAVED AND RESTORED, not written at module scope. `HERDR_SOCKET_PATH` is the switch
// that decides whether the LIVE herdr proofs can reach a server at all, and those are
// the only tests in this repo that can see the real one — a module-scope write with no
// teardown turns "make my own case hermetic" into "silently disable the instrument for
// everything that runs after me in this process". A test may not be able to disable the
// only thing capable of catching a whole defect class, and no coverage number would
// ever show it.
const PRIOR_HERDR_SOCKET = process.env['HERDR_SOCKET_PATH']
beforeAll(() => {
  process.env['HERDR_SOCKET_PATH'] = '/nonexistent/herdr-test-must-not-connect.sock'
})
afterAll(() => {
  if (PRIOR_HERDR_SOCKET === undefined) delete process.env['HERDR_SOCKET_PATH']
  else process.env['HERDR_SOCKET_PATH'] = PRIOR_HERDR_SOCKET
})

const PRIOR_FLAG = process.env['NEUTRON_PERSISTENT_REPL']
const PRIOR_SUP = process.env['NEUTRON_PERSISTENT_REPL_SUPERVISION']

afterEach(async () => {
  if (PRIOR_FLAG === undefined) delete process.env['NEUTRON_PERSISTENT_REPL']
  else process.env['NEUTRON_PERSISTENT_REPL'] = PRIOR_FLAG
  if (PRIOR_SUP === undefined) delete process.env['NEUTRON_PERSISTENT_REPL_SUPERVISION']
  else process.env['NEUTRON_PERSISTENT_REPL_SUPERVISION'] = PRIOR_SUP
  await shutdownAllPersistentRepls()
})

const SPEC = { prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] }

async function buildAndAssertPersistent(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'neutron-uncond-'))
  const handle = createClaudeCodeSubstrateAuto({
    substrate_instance_id: 't',
    cwd,
    claude_bin: '/usr/bin/false', // harmless fast-exit; persistent owns its own PTY host
  }).start(SPEC)
  // The persistent substrate's handle identifies itself.
  await expect(handle.respondToTool('x', {})).rejects.toThrow(/persistent-repl/)
  await handle.cancel()
}

describe('createClaudeCodeSubstrateAuto — unconditionally persistent (no flag)', () => {
  test('UNSET → persistent', async () => {
    delete process.env['NEUTRON_PERSISTENT_REPL']
    await buildAndAssertPersistent()
  })

  test('NEUTRON_PERSISTENT_REPL=0 → STILL persistent (no rollback path exists)', async () => {
    process.env['NEUTRON_PERSISTENT_REPL'] = '0'
    await buildAndAssertPersistent()
  })

  test('NEUTRON_PERSISTENT_REPL=1 → persistent', async () => {
    process.env['NEUTRON_PERSISTENT_REPL'] = '1'
    await buildAndAssertPersistent()
  })

  test('NEUTRON_PERSISTENT_REPL_SUPERVISION=0 does NOT change substrate selection', async () => {
    // Supervision is now unconditional too — the sub-gate is gone. Setting the old
    // var has no effect on substrate selection (it still builds persistent).
    process.env['NEUTRON_PERSISTENT_REPL_SUPERVISION'] = '0'
    await buildAndAssertPersistent()
  })
})
