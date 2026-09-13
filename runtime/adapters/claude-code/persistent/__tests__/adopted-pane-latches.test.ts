/**
 * adopted-pane-latches.test.ts — #539's LIVE-FIRE hazard, in both directions.
 *
 * THE DEFECT THIS EXISTS FOR IS THE ONE THAT ACTS. Every detector latch is in-memory
 * (`repl-session.ts`), so a gateway that restarts and re-adopts a running REPL meets
 * that pane with no history at all — while the pane's screen still holds whatever was
 * on it when the old gateway died. If the first scan treats "present now" as "just
 * appeared", the tool-use auto-approver sees a rising edge on a prompt the OWNER was
 * reading and answers it: `1` + Enter, on a question nobody asked us. That is not a
 * failed feature; it is an action taken on the owner's session.
 *
 * SO THE CASES ARE BIDIRECTIONAL, and the second half matters as much as the first:
 *
 *   1. a pane whose screen ALREADY holds an approval prompt at adoption time must have
 *      NOTHING submitted to it — not on the first screen, and not on any later screen
 *      that still shows the same prompt;
 *   2. and the detectors must still be ARMED: a prompt that appears AFTER adoption is
 *      answered exactly as it would be on a freshly spawned REPL. Without this second
 *      half, deleting every detector registration would pass case 1 perfectly.
 *
 * THE MUTATION THAT MUST REDDEN THIS: remove the `primeLatches` call in
 * `boot-adoption.ts`. Case 1's "still on screen a tick later" assertion then fails,
 * because the second delivery is a rising edge for a detector with no history.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcileOwnRepl, resetBootAdoptionForTests } from '../boot-adoption.ts'
import { childByKey, pool, sink } from '../pool-state.ts'
import type { ReplRegistry, ReplRegistryRecord } from '../repl-registry.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import { FakeAdoptableHost, type FakeAttachedChild } from './boot-adoption-host.ts'

const KEY = 'inst user proj cred'
const SESSION_ID = 'bbbbbbbb-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-fedcba9876543210fedcba9876543210'
const GENERATION = 'gen-latch-1'
const HANDLE = 'w9:p9'

/**
 * The real approval prompt, in the shape the substrate's own detector matches: the
 * question and the `1. Yes` selector, both required (a single cue is scrollback).
 * Taken from the registered detector's own regexes so this fixture cannot drift into
 * matching something the production detector would not.
 */
const APPROVAL_SCREEN = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'
const QUIET_SCREEN = 'the agent is thinking...'

const dirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'neutron-539-latch-'))
  dirs.push(d)
  return d
}

function fixtureWithScreens(screens: string[]): {
  options: PersistentReplSubstrateOptions
  host: FakeAdoptableHost
} {
  const registryPath = join(scratch(), 'repl-registry.json')
  const row: ReplRegistryRecord = {
    sessionKey: KEY,
    sessionId: SESSION_ID,
    cwd: '/tmp',
    channelName: CHANNEL,
    has_session: true,
    pid: 5150,
    devchannel_port: 45999,
    child_generation: GENERATION,
    pane_handle: HANDLE,
    reuse: { tool_surface: '', tool_bridge: false, auth_fingerprint: '' },
  }
  const registry: ReplRegistry = { [KEY]: row }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2))
  const host = new FakeAdoptableHost()
  host.addPane(HANDLE, {
    argv: [
      'claude',
      '--resume',
      SESSION_ID,
      '--dangerously-load-development-channels',
      `server:${CHANNEL}`,
    ],
    screens,
    pid: 5150,
  })
  const options = {
    substrate_instance_id: 'inst',
    model_preference: ['claude-opus-5'],
    replRegistryPath: registryPath,
    cwd: '/tmp',
    ptyHost: host,
  } as unknown as PersistentReplSubstrateOptions
  return { options, host }
}

async function adopt(screens: string[]): Promise<FakeAttachedChild> {
  const { options, host } = fixtureWithScreens(screens)
  const outcome = await reconcileOwnRepl(options, KEY, {
    host,
    health: async () => true,
    log: () => {},
  })
  expect(outcome.kind).toBe('adopted')
  const child = host.attached[0]
  if (child === undefined) throw new Error('the fixture attached nothing')
  return child
}

beforeAll(async () => {
  await sink.ensureStarted({ tokenPath: join(scratch(), 'sink-token') })
})


// CLEARED BEFORE EACH CASE, NOT ONLY AFTER IT. The shutdown latch and the pass map are
// module-global, and bun runs many test FILES in one process — so a suite that shuts a
// gateway down leaves adoption latched off for whatever file runs next. Clearing after
// each case protects this file's own cases from each other; clearing before each one also
// protects them from every other file. The failure mode is silent and green-looking: the
// first case passes and the rest adopt nothing.
beforeEach(() => resetBootAdoptionForTests())

afterEach(() => {
  resetBootAdoptionForTests()
  pool.clear()
  childByKey.clear()
  sink.unregister(SESSION_ID)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('a pane that already holds a prompt when we adopt it', () => {
  it('submits NOTHING — not on the baseline screen, and not while the same prompt stays up', async () => {
    const child = await adopt([APPROVAL_SCREEN])
    // The baseline screen is delivered by `beginOutput()` during the adoption above.
    expect(child.keysSent).toEqual([])

    // The pane repaints with the SAME prompt still up — a spinner tick, a cursor
    // move, anything. A detector with no history reads this as absent -> present.
    child.push(`${APPROVAL_SCREEN}\nstill waiting`)
    expect(child.keysSent).toEqual([])

    // And again, because "did not fire on the first two" is not "will never fire".
    child.push(`${APPROVAL_SCREEN}\nstill waiting.`)
    expect(child.keysSent).toEqual([])
  })

  it('answers a prompt that appears AFTER the pane falls quiet — the detectors are armed, not disabled', async () => {
    const child = await adopt([APPROVAL_SCREEN])
    expect(child.keysSent).toEqual([])

    // The stale prompt goes away (the owner answered it, or the agent moved on).
    // That falling edge is what re-arms the latch.
    child.push(QUIET_SCREEN)
    expect(child.keysSent).toEqual([])

    // A genuinely NEW prompt, produced after we arrived: ours to answer.
    child.push(APPROVAL_SCREEN)
    expect(child.keysSent).toEqual([['1', 'enter']])
  })
})

describe('a pane that is quiet when we adopt it', () => {
  it('answers the first prompt it produces — the positive control for the whole mechanism', async () => {
    // If this case failed, case 1 above would pass for the wrong reason: a session
    // with no detectors registered submits nothing to anything, forever.
    const child = await adopt([QUIET_SCREEN])
    expect(child.keysSent).toEqual([])
    child.push(APPROVAL_SCREEN)
    expect(child.keysSent).toEqual([['1', 'enter']])
  })

  it('answers it exactly ONCE while it stays on screen', async () => {
    const child = await adopt([QUIET_SCREEN])
    child.push(APPROVAL_SCREEN)
    child.push(`${APPROVAL_SCREEN}\n(still up)`)
    expect(child.keysSent).toEqual([['1', 'enter']])
  })
})
