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

import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeCodeSubstrateAuto } from '../index.ts'
import { shutdownAllPersistentRepls } from '../persistent/persistent-repl-substrate.ts'

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
