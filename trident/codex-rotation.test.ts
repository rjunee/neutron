/**
 * `trident/codex-rotation*.ts` — seat selection, the exhaustion signal, and the
 * multi-seat credential service.
 *
 * The rollout fixture below is shaped like the real thing, not like the design
 * document: the field layout, the `primary`-carries-the-weekly-window quirk, the
 * always-null `secondary`, and `resets_at` in SECONDS were all read off real
 * `token_count` events written by codex-cli 0.147.0. Every credential blob here
 * is fabricated — no test in this file contains or prints token material.
 */

import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { asOwnerHandle, ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { codexAuthPath, readMaterializedAuth } from './codex-auth.ts'
import {
  CODEX_CREDENTIAL_SERVICE,
  CodexCredentialService,
  codexServiceSlot,
  codexSlotService,
} from './codex-credential.ts'
import { SqliteCodexRotationStore } from './codex-rotation-store.ts'
import {
  reachedWindowClass,
  classifyResetsAt,
  coolPercentFor,
  fallbackCooldownMs,
  FAILURE_SHORT_COOLDOWN_MS,
  isCooling,
  MAX_FALLBACK_COOLDOWN_MS,
  parseRolloutRateLimits,
  RESET_JITTER_MS,
  selectNextSlot,
  shouldHarvestBack,
  signalToCooldown,
  type SlotState,
} from './codex-rotation.ts'
import { harvestNewestRollout, MAX_ROLLOUT_TAIL_BYTES } from './codex-rotation-io.ts'

const OWNER = asOwnerHandle('owner')
const NOW = Date.parse('2026-08-17T12:00:00.000Z')

let tmp: string
let db: ProjectDb
let store: ProjectCredentialStore
let codexHome: string

/** A fabricated subscription bundle. `last_refresh` is the harvest-back key. */
function subscriptionAuth(lastRefresh = '2026-06-30T00:00:00.000Z'): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: 'id', access_token: 'acc', refresh_token: 'ref', account_id: 'a' },
    last_refresh: lastRefresh,
  })
}

/**
 * One `token_count` event in the real shape. `primary` carries `window_minutes`
 * because the window's LENGTH — not the field's name — is what picks the
 * threshold; every measured sample had 10080 here and a null `secondary`.
 */
function tokenCountLine(opts: {
  used_percent: number
  window_minutes: number
  resets_at?: number | null
  plan_type?: string
}): string {
  return JSON.stringify({
    timestamp: '2026-08-17T11:59:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary: {
          used_percent: opts.used_percent,
          window_minutes: opts.window_minutes,
          resets_at: opts.resets_at === undefined ? Math.floor(NOW / 1000) + 3600 : opts.resets_at,
        },
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: opts.plan_type ?? 'pro',
        rate_limit_reached_type: null,
      },
    },
  })
}

/** Write a rollout file under a CODEX_HOME, with a controllable mtime. */
function writeRollout(home: string, name: string, lines: string[], mtimeSec: number): string {
  const dir = join(home, 'sessions', '2026', '08', '17')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `${lines.join('\n')}\n`)
  utimesSync(path, mtimeSec, mtimeSec)
  return path
}

function slot(over: Partial<SlotState> & { slot: string }): SlotState {
  return { position: 0, cooling_until: null, cooling_reason: null, ...over }
}

function newService(now: () => number = () => NOW): CodexCredentialService {
  return new CodexCredentialService({
    store,
    codexHome,
    rotation: new SqliteCodexRotationStore(db),
    now,
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codex-rot-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const crypto = new SecretsStore({ data_dir: tmp, db })
  store = new ProjectCredentialStore(db, { crypto })
  codexHome = join(tmp, '.codex')
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('selectNextSlot', () => {
  // MUTATION: delete the `!isCooling(cand, now)` guard in the ring walk.
  test('round-robin skips a cooling slot and lands on the next eligible one', () => {
    const slots = [
      slot({ slot: 'a', position: 0 }),
      slot({ slot: 'b', position: 1, cooling_until: NOW + 60_000, cooling_reason: 'short-window' }),
      slot({ slot: 'c', position: 2 }),
    ]
    const picked = selectNextSlot(slots, 'a', NOW)
    expect(picked).not.toBeNull()
    // 'a' is eligible, so it stays.
    expect(picked?.slot).toBe('a')

    const fromCooling = selectNextSlot(
      [
        slot({ slot: 'a', position: 0, cooling_until: NOW + 60_000, cooling_reason: 'short-window' }),
        slot({ slot: 'b', position: 1, cooling_until: NOW + 60_000, cooling_reason: 'short-window' }),
        slot({ slot: 'c', position: 2 }),
      ],
      'a',
      NOW,
    )
    expect(fromCooling?.slot).toBe('c')
    expect(fromCooling?.rotated).toBe(true)
    expect(fromCooling?.exhausted).toBe(false)
  })

  // MUTATION: return null (or ring[0]) when every slot is cooling.
  test('when every slot is cooling it KEEPS the current slot and reports exhausted', () => {
    const slots = [
      slot({ slot: 'a', position: 0, cooling_until: NOW + 60_000, cooling_reason: 'long-window' }),
      slot({ slot: 'b', position: 1, cooling_until: NOW + 60_000, cooling_reason: 'long-window' }),
    ]
    const picked = selectNextSlot(slots, 'b', NOW)
    // Never null: a capped seat returns a retryable error, no seat returns nothing.
    expect(picked).not.toBeNull()
    expect(picked?.slot).toBe('b')
    expect(picked?.exhausted).toBe(true)
    expect(picked?.rotated).toBe(false)
  })

  test('an expired cooldown makes a slot eligible again', () => {
    const slots = [slot({ slot: 'a', position: 0, cooling_until: NOW - 1, cooling_reason: 'short-window' })]
    expect(selectNextSlot(slots, 'a', NOW)?.exhausted).toBe(false)
  })

  // MUTATION: let `isCooling` fall through to the `cooling_until` compare for
  // `unauthorized` (i.e. drop the early `return true`).
  test('an unauthorized slot stays ineligible even with a past cooling_until', () => {
    const revoked = slot({ slot: 'a', cooling_until: NOW - 10_000, cooling_reason: 'unauthorized' })
    expect(isCooling(revoked, NOW)).toBe(true)
    // Nothing rotates back onto a revoked seat on a timer — only a reconnect clears it.
    expect(selectNextSlot([revoked], 'a', NOW)?.exhausted).toBe(true)
  })
})

describe('threshold policy', () => {
  // MUTATION: change `>=` to `>` in `signalToCooldown`'s percentage compare.
  test('the short-window threshold cools at exactly 98 and holds at 97.9', () => {
    const holds = signalToCooldown(
      { kind: 'snapshot', snapshot: { windows: [{ used_percent: 97.9, window_minutes: 300, resets_at_ms: null, expired: false }], plan_type: 'pro', reached_type: null } },
      NOW,
    )
    expect(holds).toBeNull()
    const cools = signalToCooldown(
      { kind: 'snapshot', snapshot: { windows: [{ used_percent: 98, window_minutes: 300, resets_at_ms: null, expired: false }], plan_type: 'pro', reached_type: null } },
      NOW,
    )
    expect(cools?.cooling_reason).toBe('short-window')
  })

  // MUTATION: pick the threshold from the field NAME (primary/secondary) instead
  // of from `window_minutes`. Measured reality: `primary.window_minutes` was 10080
  // in all 12,582 sampled events, so a name-keyed policy would apply 98 here.
  test('the threshold is keyed on the window LENGTH, so a weekly window needs 99', () => {
    expect(coolPercentFor(300)).toBe(98)
    expect(coolPercentFor(10080)).toBe(99)
    const weeklyAt98 = signalToCooldown(
      { kind: 'snapshot', snapshot: { windows: [{ used_percent: 98.5, window_minutes: 10080, resets_at_ms: null, expired: false }], plan_type: 'pro', reached_type: null } },
      NOW,
    )
    expect(weeklyAt98).toBeNull()
    const weeklyAt99 = signalToCooldown(
      { kind: 'snapshot', snapshot: { windows: [{ used_percent: 99, window_minutes: 10080, resets_at_ms: null, expired: false }], plan_type: 'pro', reached_type: null } },
      NOW,
    )
    expect(weeklyAt99?.cooling_reason).toBe('long-window')
    // And the fallback is the window's own length, not a hardcoded 5 hours.
    expect(weeklyAt99?.cooling_until).toBe(NOW + 10080 * 60_000)
  })

  test('when two windows are both over, the LATER reset wins', () => {
    const cooled = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          windows: [
            { used_percent: 99.5, window_minutes: 300, resets_at_ms: NOW + 60_000, expired: false },
            { used_percent: 99.5, window_minutes: 10080, resets_at_ms: NOW + 7 * 86_400_000, expired: false },
          ],
          plan_type: 'pro',
          reached_type: null,
        },
      },
      NOW,
    )
    // Cooling only until the session reset would rotate straight back into the weekly wall.
    expect(cooled?.cooling_until).toBe(NOW + 7 * 86_400_000 + RESET_JITTER_MS)
    expect(cooled?.cooling_reason).toBe('long-window')
  })

  // MUTATION: add an arm that returns a cooldown for `kind: 'error'`.
  test('a harvest error or an absent rollout cools NOTHING', () => {
    expect(signalToCooldown({ kind: 'error', error: 'EACCES' }, NOW)).toBeNull()
    expect(signalToCooldown({ kind: 'absent' }, NOW)).toBeNull()
  })

  // MUTATION: drop the `* 1000` in `classifyResetsAt`.
  test('resets_at is converted from seconds to ms, and an implausible value is refused', () => {
    const secs = Math.floor(NOW / 1000) + 3600
    expect(classifyResetsAt(secs, NOW)).toEqual({ kind: 'future', ms: secs * 1000 })
    // Without the x1000 the reset lands in 1970 — in the PAST — which would read as
    // "already expired" and un-cool a capped seat immediately.
    expect(secs).toBeLessThan(NOW)
    expect(classifyResetsAt(Math.floor(NOW / 1000) - 3600, NOW).kind).toBe('expired')
    expect(classifyResetsAt(NOW, NOW).kind).toBe('absent') // ms passed in where secs belong
    expect(classifyResetsAt('soon', NOW).kind).toBe('absent')
  })
})

describe('rollout harvest', () => {
  // MUTATION: return the FIRST matching snapshot instead of the last.
  test('parses the LAST rate_limits snapshot in the file', () => {
    const text = [
      tokenCountLine({ used_percent: 12, window_minutes: 10080 }),
      '{"type":"response_item","payload":{"role":"user"}}',
      tokenCountLine({ used_percent: 99.4, window_minutes: 10080 }),
    ].join('\n')
    const outcome = parseRolloutRateLimits(text, NOW)
    expect(outcome.kind).toBe('snapshot')
    if (outcome.kind !== 'snapshot') throw new Error('expected a snapshot')
    // The first snapshot describes usage BEFORE this session spent anything.
    expect(outcome.snapshot.windows[0]?.used_percent).toBe(99.4)
    expect(outcome.snapshot.windows[0]?.window_minutes).toBe(10080)
    expect(outcome.snapshot.plan_type).toBe('pro')
  })

  test('a truncated trailing line does not discard the complete records before it', () => {
    const text = `${tokenCountLine({ used_percent: 55, window_minutes: 10080 })}\n{"type":"event_msg","payl`
    const outcome = parseRolloutRateLimits(text, NOW)
    expect(outcome.kind).toBe('snapshot')
  })

  test('a file with no rate_limits event is absent, not an error', () => {
    expect(parseRolloutRateLimits('{"type":"response_item"}', NOW).kind).toBe('absent')
  })

  // MUTATION: sort rollouts oldest-first (or drop the mtime sort entirely).
  test('harvest reads the NEWEST rollout file', () => {
    writeRollout(codexHome, 'rollout-old.jsonl', [tokenCountLine({ used_percent: 10, window_minutes: 10080 })], 1_700_000_000)
    writeRollout(codexHome, 'rollout-new.jsonl', [tokenCountLine({ used_percent: 99.9, window_minutes: 10080 })], 1_800_000_000)
    const outcome = harvestNewestRollout(codexHome, NOW)
    expect(outcome.kind).toBe('snapshot')
    if (outcome.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(outcome.snapshot.windows[0]?.used_percent).toBe(99.9)
  })

  test('a CODEX_HOME with no sessions dir harvests as absent, never as an error', () => {
    mkdirSync(codexHome, { recursive: true })
    expect(harvestNewestRollout(codexHome, NOW).kind).toBe('absent')
  })

  test('falls back to an older rollout when the newest carries no usage event', () => {
    writeRollout(codexHome, 'rollout-old.jsonl', [tokenCountLine({ used_percent: 42, window_minutes: 10080 })], 1_700_000_000)
    writeRollout(codexHome, 'rollout-new.jsonl', ['{"type":"response_item"}'], 1_800_000_000)
    const outcome = harvestNewestRollout(codexHome, NOW)
    expect(outcome.kind).toBe('snapshot')
    if (outcome.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(outcome.snapshot.windows[0]?.used_percent).toBe(42)
  })
})

describe('the harvest stays cheap on a big rollout', () => {
  // MUTATION: remove the cap — `if (true) return readFileSync(path, 'utf8')`.
  // Verified RED.
  //
  // NOT a guard on the positioned read, and saying so matters. Replacing the
  // positioned read with `readFileSync(path).subarray(size - maxBytes)` was
  // measured to leave this suite GREEN, because both produce the SAME STRING —
  // the difference is that one allocates the whole file first, and that is a
  // resource property no output assertion can see. The positioned read is
  // still the right implementation (a multi-hundred-megabyte transcript would
  // otherwise be loaded in full on the synchronous path that resolves a run's
  // credential); it is simply not what this test proves. What this test proves
  // is that the CAP is honoured at all: a padded file whose only usage event
  // sits in the head must not be found.
  test('only the TAIL is read, so a head-only snapshot is not found', () => {
    const filler = `{"type":"response_item","pad":"${'x'.repeat(4096)}"}`
    const lines = [tokenCountLine({ used_percent: 99.9, window_minutes: 10080 })]
    // Push the head event well past the tail window.
    const fillerCount = Math.ceil((MAX_ROLLOUT_TAIL_BYTES * 2) / filler.length)
    for (let i = 0; i < fillerCount; i++) lines.push(filler)
    writeRollout(codexHome, 'rollout-huge.jsonl', lines, 1_800_000_000)

    const outcome = harvestNewestRollout(codexHome, NOW)
    expect(outcome.kind).toBe('absent')
  })

  // The positive control: the same oversized file, with the usage event at the
  // END, must still be found. Without this the test above would also pass
  // against a reader that returned nothing at all.
  test('a snapshot in the tail of the same oversized file IS found', () => {
    const filler = `{"type":"response_item","pad":"${'x'.repeat(4096)}"}`
    const lines: string[] = []
    const fillerCount = Math.ceil((MAX_ROLLOUT_TAIL_BYTES * 2) / filler.length)
    for (let i = 0; i < fillerCount; i++) lines.push(filler)
    lines.push(tokenCountLine({ used_percent: 77, window_minutes: 10080 }))
    writeRollout(codexHome, 'rollout-huge-tail.jsonl', lines, 1_800_000_000)

    const outcome = harvestNewestRollout(codexHome, NOW)
    if (outcome.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(outcome.snapshot.windows[0]?.used_percent).toBe(77)
  })
})

describe('a reading whose window has already reset', () => {
  // MUTATION: delete `if (w.expired) continue` from `signalToCooldown`.
  //
  // The window then falls through to the no-reset branch and is cooled for a
  // FRESH FULL WINDOW from now, on the strength of a reading that expired days
  // ago — benching a healthy, paid-for seat. It is self-perpetuating too: the
  // benched seat may not run again to produce a newer reading.
  test('a spent window whose reset has PASSED cools nothing', () => {
    const stale = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          windows: [{ used_percent: 99.6, window_minutes: 10080, resets_at_ms: null, expired: true }],
          plan_type: 'pro',
          reached_type: null,
        },
      },
      NOW,
    )
    expect(stale).toBeNull()
  })

  // MUTATION: collapse `expired` back into `absent` in `classifyResetsAt`.
  test('expired, absent and future are three different answers', () => {
    expect(classifyResetsAt((NOW + 3_600_000) / 1000, NOW).kind).toBe('future')
    expect(classifyResetsAt((NOW - 7 * 86_400_000) / 1000, NOW).kind).toBe('expired')
    expect(classifyResetsAt(null, NOW).kind).toBe('absent')
    // The unit guard still holds: a forgotten ×1000 lands in 1970, which reads
    // as expired — and an expired window is IGNORED, never trusted.
    expect(classifyResetsAt(1, NOW).kind).toBe('expired')
    expect(classifyResetsAt((NOW - 1000) / 1000, NOW).kind).toBe('expired')
  })

  // Parsed end-to-end, so the flag cannot be lost between parser and policy.
  test('the parser marks an elapsed reset as expired', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 99.9, window_minutes: 10080, resets_at: (NOW - 86_400_000) / 1000 },
          secondary: null,
        },
      },
    })
    const out = parseRolloutRateLimits(line, NOW)
    if (out.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(out.snapshot.windows[0]?.expired).toBe(true)
    expect(signalToCooldown(out, NOW)).toBeNull()
  })
})

describe('the fallback cooldown is bounded', () => {
  // MUTATION: drop the `Math.min` in `fallbackCooldownMs`.
  //
  // The shipped CLI declares monthly and annual limits, so an unclamped window
  // length benches a seat for 30 or 365 days off one reading; a corrupt value
  // multiplies through to Infinity, which SQLite round-trips as a REAL that no
  // clock comparison can ever clear — a permanent retirement that looks exactly
  // like a working cooldown.
  test('an annual or absurd window clamps; anything inside the horizon passes through', () => {
    expect(fallbackCooldownMs(300)).toBe(300 * 60_000)
    expect(fallbackCooldownMs(10080)).toBe(10080 * 60_000)
    // A month (30 d) is INSIDE the 32-day horizon and is honoured as declared —
    // the clamp is a sanity bound, not a second opinion on the CLI's windows.
    expect(fallbackCooldownMs(43_200)).toBe(43_200 * 60_000)
    // A year, and a value that would otherwise reach Infinity, do not survive.
    expect(fallbackCooldownMs(525_600)).toBe(MAX_FALLBACK_COOLDOWN_MS)
    expect(fallbackCooldownMs(1e308)).toBe(MAX_FALLBACK_COOLDOWN_MS)
    expect(Number.isFinite(fallbackCooldownMs(1e308))).toBe(true)
  })

  test('an annual window over its limit does not retire the seat for a year', () => {
    const cooled = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          windows: [{ used_percent: 99.9, window_minutes: 525_600, resets_at_ms: null, expired: false }],
          plan_type: 'pro',
          reached_type: null,
        },
      },
      NOW,
    )
    expect(cooled?.cooling_until).toBe(NOW + MAX_FALLBACK_COOLDOWN_MS)
  })
})

describe('only a real usage event is evidence', () => {
  // MUTATION: drop the `rec['type'] === 'token_count'` condition from
  // `findRateLimits`, i.e. accept any nested object called `rate_limits`.
  //
  // A model's own message quoting this schema would then be read as a quota
  // snapshot and could cool a seat on the strength of transcript content.
  test('a response_item carrying a look-alike rate_limits is NOT a snapshot', () => {
    const impostor = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        content: [{ rate_limits: { primary: { used_percent: 99.9, window_minutes: 10080 } } }],
      },
    })
    expect(parseRolloutRateLimits(impostor, NOW).kind).toBe('absent')
  })

  // THE POSITIVE CONTROL for the test above: the same parser, given the shape a
  // REAL rollout line has, must still return a snapshot. Without this the test
  // above would pass just as well against a parser that accepted nothing at all.
  test('the real event_msg → token_count shape still parses', () => {
    const real = JSON.stringify({
      timestamp: '2026-08-15T23:47:16.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 1 } },
        rate_limits: {
          limit_id: 'codex',
          limit_name: null,
          primary: { used_percent: 14, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) + 3600 },
          secondary: null,
          credits: { has_credits: false, unlimited: false, balance: '0' },
          individual_limit: null,
          spend_control_reached: null,
          plan_type: 'pro',
          rate_limit_reached_type: null,
        },
      },
    })
    const out = parseRolloutRateLimits(real, NOW)
    if (out.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(out.snapshot.windows[0]?.used_percent).toBe(14)
    expect(out.snapshot.windows[0]?.window_minutes).toBe(10080)
    expect(out.snapshot.plan_type).toBe('pro')
  })

  // MUTATION: read only `window_minutes` in `readWindowMinutes`.
  //
  // Both names ship in the same binary. A miss defaults to 0, and 0 classes as a
  // LONG window — so the weekly threshold and a week-long fallback would be
  // applied to a five-hour limit.
  test('window_duration_mins is read as the window length too', () => {
    const alt = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 98.5, window_duration_mins: 300, resets_at: null },
          secondary: null,
        },
      },
    })
    const out = parseRolloutRateLimits(alt, NOW)
    if (out.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(out.snapshot.windows[0]?.window_minutes).toBe(300)
    // 98.5% of a SHORT window is over its threshold; misread as a long window it
    // would sit under 99 and cool nothing.
    expect(signalToCooldown(out, NOW)?.cooling_reason).toBe('short-window')
  })
})

describe('the CLI reporting that it HIT a limit', () => {
  // MUTATION: delete the `reachedWindowClass` arm from `signalToCooldown`, i.e.
  // parse `rate_limit_reached_type` and never read it (which is what the module
  // did before). The seat then stays eligible while the CLI is telling us
  // outright that it is capped.
  test('a reached weekly limit cools even when the percentage is under threshold', () => {
    const cooled = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          windows: [{ used_percent: 12, window_minutes: 10080, resets_at_ms: NOW + 86_400_000, expired: false }],
          plan_type: 'pro',
          reached_type: 'weekly-limit',
        },
      },
      NOW,
    )
    expect(cooled?.cooling_reason).toBe('long-window')
    expect(cooled?.cooling_until).toBe(NOW + 86_400_000 + RESET_JITTER_MS)
  })

  // MUTATION: map every reached_type to the short class. A weekly cap would then
  // be cooled for five hours and the seat would rotate back into the same wall.
  test('the window class comes from the reached_type name, across the ids the CLI declares', () => {
    expect(reachedWindowClass('five-hour-limit')).toBe('short')
    expect(reachedWindowClass('daily-limit')).toBe('short')
    expect(reachedWindowClass('weekly-limit')).toBe('long')
    expect(reachedWindowClass('monthly-limit')).toBe('long')
    expect(reachedWindowClass('annual-limit')).toBe('long')
    expect(reachedWindowClass('secondary-usage-limit')).toBe('long')
  })

  // MUTATION: return 'short' instead of null for an unknown name. An id we cannot
  // place is not evidence, and guessing would cool healthy seats.
  test('an unrecognised or absent reached_type cools nothing', () => {
    expect(reachedWindowClass('some-future-limit')).toBeNull()
    expect(reachedWindowClass(null)).toBeNull()
    const untouched = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          windows: [{ used_percent: 12, window_minutes: 10080, resets_at_ms: NOW + 86_400_000, expired: false }],
          plan_type: 'pro',
          reached_type: 'some-future-limit',
        },
      },
      NOW,
    )
    expect(untouched).toBeNull()
  })

  // MUTATION: delete the `staleSnapshot` early return from `signalToCooldown`,
  // so the reached_type arm runs against a snapshot whose every window has
  // already reset.
  //
  // This is the bug that made the percentage guard useless. A rollout is a file:
  // the harvest re-reads the same bytes on every resolve, and a seat that hit its
  // weekly cap last week still has `weekly-limit` sitting in its last event next
  // to the elapsed reset that proves the quota came back. Without the guard, no
  // window matched (all expired), so the arm fell through to a BLIND seven days
  // measured from now — and the cooled seat never ran, never wrote a newer
  // rollout, and re-derived the same seven days on the next resolve. Permanent,
  // self-renewing, and indistinguishable from a working cooldown.
  test('a reached limit on a snapshot whose windows have ALL reset cools nothing', () => {
    const stale = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          windows: [{ used_percent: 99.6, window_minutes: 10080, resets_at_ms: null, expired: true }],
          plan_type: 'pro',
          reached_type: 'weekly-limit',
        },
      },
      NOW,
    )
    expect(stale).toBeNull()
  })

  // MUTATION: require the class match again — `windows.find(w => !w.expired &&
  // isShortWindow(w.window_minutes) === (hit === 'short'))` with no anchor
  // fallback — so a short-class hit falls through to `FAILURE_SHORT_COOLDOWN_MS`.
  //
  // The class match is not merely unreliable, it NEVER succeeds for a short hit:
  // every window the CLI has been observed to report declares 10080 minutes, so
  // `five-hour-limit` matches nothing. The blind five-hour constant then
  // over-cooled a seat whose own snapshot named a reset three hours out, and
  // never converged on it — five hours later the same file produced the same
  // five hours again.
  test('a five-hour hit uses the snapshot’s own reset, not a blind five hours', () => {
    const cooled = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          // The measured shape: one weekly-length window, well under threshold,
          // carrying the reset — and the CLI naming a SHORT limit as the one hit.
          windows: [{ used_percent: 41, window_minutes: 10080, resets_at_ms: NOW + 3 * 3_600_000, expired: false }],
          plan_type: 'pro',
          reached_type: 'five-hour-limit',
        },
      },
      NOW,
    )
    expect(cooled?.cooling_reason).toBe('short-window')
    expect(cooled?.cooling_until).toBe(NOW + 3 * 3_600_000 + RESET_JITTER_MS)
    // The point of the fix: NOT the five-hour constant, which is both longer than
    // the seat's real cap and unable to ever converge on it.
    expect(cooled?.cooling_until).not.toBe(NOW + FAILURE_SHORT_COOLDOWN_MS)
  })

  // MUTATION: drop the anchor entirely and keep only the class constant. With no
  // window carrying a reset there is nothing better than the constant — and the
  // constant must still be chosen by CLASS, or a weekly cap gets five hours.
  test('with no reset anywhere in the snapshot the class constant still applies', () => {
    const cooled = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          windows: [{ used_percent: 3, window_minutes: 10080, resets_at_ms: null, expired: false }],
          plan_type: 'pro',
          reached_type: 'weekly-limit',
        },
      },
      NOW,
    )
    // Class-matched, so the window's own LENGTH is the fallback — a week.
    expect(cooled?.cooling_until).toBe(NOW + 10080 * 60_000)
    expect(cooled?.cooling_reason).toBe('long-window')
  })
})

describe('the reset boundary is approached with tolerance, never equality', () => {
  // MUTATION: return `resets_at_ms` unchanged from `coolUntil` (drop the
  // `+ RESET_JITTER_MS`), which is an equality compare against the boundary.
  //
  // `isCooling` is a strict `cooling_until > now`, so a cooldown that ends at the
  // reported instant makes the seat eligible at exactly that millisecond. The
  // reported instant and the instant the quota is actually refunded are different
  // clocks, so the run lands early, hits the same cap, and is spent for nothing.
  test('a cooldown derived from a reset ends AFTER it, and the seat is still cooling at the boundary', () => {
    const resets = NOW + 3_600_000
    const cooled = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          windows: [{ used_percent: 99.9, window_minutes: 300, resets_at_ms: resets, expired: false }],
          plan_type: 'pro',
          reached_type: null,
        },
      },
      NOW,
    )
    expect(cooled?.cooling_until).toBeGreaterThan(resets)
    const state = slot({ slot: 'a', cooling_until: cooled?.cooling_until ?? 0, cooling_reason: 'short-window' })
    expect(isCooling(state, resets)).toBe(true)
    // …and it does clear, shortly after.
    expect(isCooling(state, resets + RESET_JITTER_MS + 1)).toBe(false)
  })

  // MUTATION: pad the DURATION fallback too. A duration is already our own
  // conservative guess; padding it compounds a guess instead of stepping over a
  // real boundary, and it would make the window-length fallback assertions drift.
  test('the tolerance rides the reset path only, not the duration fallback', () => {
    const cooled = signalToCooldown(
      {
        kind: 'snapshot',
        snapshot: {
          windows: [{ used_percent: 99.5, window_minutes: 300, resets_at_ms: null, expired: false }],
          plan_type: 'pro',
          reached_type: null,
        },
      },
      NOW,
    )
    expect(cooled?.cooling_until).toBe(NOW + 300 * 60_000)
  })
})

describe('harvest-back', () => {
  // MUTATION: reverse the comparison to `disk < stored`.
  test('only a NEWER on-disk bundle replaces the stored one', () => {
    expect(shouldHarvestBack('2026-08-17T00:00:00Z', '2026-06-30T00:00:00Z')).toBe(true)
    expect(shouldHarvestBack('2026-06-01T00:00:00Z', '2026-06-30T00:00:00Z')).toBe(false)
    expect(shouldHarvestBack('2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z')).toBe(false)
    // No defensible ordering ⇒ leave both copies alone.
    expect(shouldHarvestBack(undefined, '2026-06-30T00:00:00Z')).toBe(false)
    expect(shouldHarvestBack('not-a-date', '2026-06-30T00:00:00Z')).toBe(false)
  })

  test('a CLI-refreshed auth.json is re-encrypted back into the store', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth('2026-06-30T00:00:00.000Z'))
    // Simulate the CLI refreshing in place — a NEWER last_refresh on disk.
    writeFileSync(codexAuthPath(codexHome), subscriptionAuth('2026-08-17T09:00:00.000Z'))
    svc.resolveActiveCodexHome(OWNER, 'proj')
    await Bun.sleep(20)
    const stored = store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)
    const parsed = JSON.parse(stored?.plaintext ?? '{}') as { last_refresh?: string }
    // Without this, the store keeps a refresh token the server has already rotated
    // away, and the self-heal path eventually restores it over a live login.
    expect(parsed.last_refresh).toBe('2026-08-17T09:00:00.000Z')
  })

  test('an older on-disk bundle leaves the store untouched', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth('2026-08-01T00:00:00.000Z'))
    writeFileSync(codexAuthPath(codexHome), subscriptionAuth('2026-01-01T00:00:00.000Z'))
    svc.resolveActiveCodexHome(OWNER, 'proj')
    await Bun.sleep(20)
    const stored = store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)
    const parsed = JSON.parse(stored?.plaintext ?? '{}') as { last_refresh?: string }
    expect(parsed.last_refresh).toBe('2026-08-01T00:00:00.000Z')
  })
})

describe('the multi-seat credential service', () => {
  // MUTATION: change the default slot's service name or its directory.
  test('connecting with NO account is byte-identical to the legacy single-seat path', async () => {
    const svc = newService()
    const result = await svc.connectAccount(OWNER, subscriptionAuth())
    expect(result.ok).toBe(true)
    expect(result.slot).toBe('default')
    // Same service row and same directory as before rotation existed.
    expect(codexSlotService('default')).toBe(CODEX_CREDENTIAL_SERVICE)
    expect(store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)).not.toBeNull()
    expect(svc.slotHome('default')).toBe(codexHome)
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
    expect(svc.resolveActiveCodexHome(OWNER, 'proj')).toBe(codexHome)
  })

  test('a second seat gets its OWN directory and service row', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth())
    const second = await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    expect(second.ok).toBe(true)
    expect(svc.slotHome('work')).toBe(join(codexHome, 'accounts', 'work'))
    expect(existsSync(join(codexHome, 'accounts', 'work', 'auth.json'))).toBe(true)
    // The first seat's file is untouched — a seat is never moved or copied.
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
    expect(codexSlotService('work')).toBe('codex-acct-work')
    expect(codexServiceSlot('codex-acct-work')).toBe('work')
    expect(codexServiceSlot('apify')).toBeNull()
    expect(svc.listAccounts(OWNER).map((a) => a.slot).sort()).toEqual(['default', 'work'])
  })

  test('an unknown seat name is refused rather than silently slugged', async () => {
    const svc = newService()
    for (const bad of ['Work Seat', '-lead', 'a'.repeat(33), '../etc']) {
      const r = await svc.connectAccount(OWNER, subscriptionAuth(), { slot: bad })
      expect(r.ok).toBe(false)
      expect(r.code).toBe('invalid_account')
    }
  })

  // MUTATION: stop reporting `replaced`, or compute it AFTER the write (when
  // every seat looks pre-existing and it is always true).
  //
  // `normalizeSlot` trims and lowercases, so `Work`, ` work ` and `work` are ONE
  // seat. Typing any of them over a connected `work` overwrites a live
  // subscription bundle — silently, and the owner cannot get it back without
  // fetching auth.json from the other machine again. The overwrite itself is
  // legitimate (it is how a revoked seat is repaired); what was missing was the
  // instance being able to SAY which of the two it was about to do, so no control
  // could tell him.
  test('a paste that will REPLACE an existing seat says so, through aliased spellings too', async () => {
    const svc = newService()
    const first = await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    expect(first.ok).toBe(true)
    expect(first.replaced).toBe(false)
    for (const alias of ['work', 'Work', ' work ', 'WORK']) {
      const again = await svc.connectAccount(OWNER, subscriptionAuth(), { slot: alias })
      expect(again.ok).toBe(true)
      expect(again.slot).toBe('work')
      expect(again.replaced).toBe(true)
    }
    // One seat throughout — the aliases never created a second directory.
    expect(svc.listAccounts(OWNER).map((a) => a.slot)).toEqual(['work'])
  })

  // MUTATION: drop the `label` argument from the `connect` delegation in
  // `connectAccount`, or restore `syncSlots` passing `record.label` to
  // `upsertSlot`.
  //
  // Two ways one name was lost. The first seat delegates to the legacy `connect`,
  // which hardcoded a generic description — so seat one was the only seat that
  // could not be named. And `syncSlots` copied the credential row's label back
  // over the rotation row on EVERY status poll, so a name that did survive the
  // write reverted the first time the pane refreshed.
  test('a seat keeps the name the owner gave it, across a status poll', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth(), { label: 'Personal' })
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work', label: 'Company' })
    // A poll runs syncSlots; the names must survive it.
    svc.listAccounts(OWNER)
    const byName = new Map(svc.listAccounts(OWNER).map((a) => [a.slot, a.label]))
    expect(byName.get('default')).toBe('Personal')
    expect(byName.get('work')).toBe('Company')
  })

  // MUTATION: make the re-materialize write unconditional.
  test('resolving never overwrites an auth.json the CLI already owns', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth('2026-06-30T00:00:00.000Z'))
    const refreshed = subscriptionAuth('2026-08-17T09:00:00.000Z')
    writeFileSync(codexAuthPath(codexHome), refreshed)
    svc.resolveActiveCodexHome(OWNER, 'proj')
    // Overwriting would install a refresh token the server has already rotated
    // away, which is how two live copies of one account kill each other.
    const onDisk = JSON.parse(readMaterializedAuth(codexHome) ?? '{}') as { last_refresh?: string }
    expect(onDisk.last_refresh).toBe('2026-08-17T09:00:00.000Z')
  })

  test('a wiped auth.json IS re-materialized from the store', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth())
    rmSync(codexAuthPath(codexHome))
    expect(svc.resolveActiveCodexHome(OWNER, 'proj')).toBe(codexHome)
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
  })

  // MUTATION: consult rotation before the project-override branch.
  test('a per-project override bypasses rotation entirely', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth())
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: 'pinned' })
    // Cool BOTH global seats: rotation would have to pick one of them, and an
    // exhausted pool would be visible here if the override consulted rotation.
    const rotation = new SqliteCodexRotationStore(db)
    for (const s of ['default', 'work']) {
      rotation.setCooldown(OWNER, s, { cooling_until: NOW + 86_400_000, cooling_reason: 'long-window' })
    }
    const home = svc.resolveActiveCodexHome(OWNER, 'pinned')
    expect(home).toBe(join(codexHome, 'projects', 'pinned'))
    expect(home).not.toBe(codexHome)
    expect(home).not.toBe(join(codexHome, 'accounts', 'work'))
  })

  test('a spent seat rotates to the other one on the next run', async () => {
    // The clock ADVANCES between the two resolves, because two runs never launch
    // in the same millisecond and the harvest is throttled to one scan a minute.
    let clock = NOW
    const svc = newService(() => clock)
    await svc.connectAccount(OWNER, subscriptionAuth())
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    // Register both slots, then write a spent rollout for the active one.
    expect(svc.resolveActiveCodexHome(OWNER, 'proj')).toBe(codexHome)
    writeRollout(codexHome, 'rollout-spent.jsonl', [tokenCountLine({ used_percent: 99.7, window_minutes: 10080 })], 1_800_000_000)
    clock = NOW + 5 * 60_000
    const home = svc.resolveActiveCodexHome(OWNER, 'proj')
    expect(home).toBe(join(codexHome, 'accounts', 'work'))
    const spent = svc.listAccounts(OWNER).find((a) => a.slot === 'default')
    expect(spent?.cooling).toBe(true)
    expect(spent?.cooling_reason).toBe('long-window')
    expect(spent?.used_percent).toBe(99.7)
  })

  // MUTATION: delete the `setCooldown(..., null)` arm from `harvestSlot`, i.e.
  // go back to doing nothing when `signalToCooldown` returns null.
  //
  // Cooling was one-way. The cooldown is set from a reset the CLI PREDICTED, and
  // the window can reopen before it; the seat's own next snapshot showing it
  // under threshold is the CLI itself withdrawing the prediction. With nothing
  // acting on that, the stale timestamp remained the only thing that could
  // release the seat, so a paid seat sat out the remainder of a cooldown the
  // evidence in hand had already refuted.
  test('a current healthy reading RELEASES a cooling seat', async () => {
    let clock = NOW
    const svc = newService(() => clock)
    await svc.connectAccount(OWNER, subscriptionAuth())
    const rotation = new SqliteCodexRotationStore(db)
    svc.resolveActiveCodexHome(OWNER, 'proj')
    rotation.setCooldown(OWNER, 'default', {
      cooling_until: NOW + 6 * 86_400_000,
      cooling_reason: 'long-window',
    })
    expect(svc.listAccounts(OWNER)[0]?.cooling).toBe(true)
    // The seat runs again and reports itself well under its limit.
    writeRollout(codexHome, 'rollout-healthy.jsonl', [tokenCountLine({ used_percent: 4, window_minutes: 10080 })], 1_800_000_000)
    clock = NOW + 5 * 60_000
    svc.resolveActiveCodexHome(OWNER, 'proj')
    const seat = svc.listAccounts(OWNER)[0]
    expect(seat?.cooling).toBe(false)
    expect(seat?.cooling_until).toBeNull()
  })

  // MUTATION: drop the `fresh` check before clearing, so a stale snapshot's null
  // decision reads as proof of health.
  //
  // The inverse error, and just as wrong: `signalToCooldown` also returns null
  // for a snapshot whose windows have all reset, and treating THAT as evidence
  // would release a genuinely capped seat on the strength of a week-old file.
  test('a wholly stale reading does NOT release a cooling seat', async () => {
    let clock = NOW
    const svc = newService(() => clock)
    await svc.connectAccount(OWNER, subscriptionAuth())
    const rotation = new SqliteCodexRotationStore(db)
    svc.resolveActiveCodexHome(OWNER, 'proj')
    rotation.setCooldown(OWNER, 'default', {
      cooling_until: NOW + 6 * 86_400_000,
      cooling_reason: 'long-window',
    })
    writeRollout(
      codexHome,
      'rollout-stale.jsonl',
      [tokenCountLine({ used_percent: 4, window_minutes: 10080, resets_at: Math.floor((NOW - 86_400_000) / 1000) })],
      1_800_000_000,
    )
    clock = NOW + 5 * 60_000
    svc.resolveActiveCodexHome(OWNER, 'proj')
    expect(svc.listAccounts(OWNER)[0]?.cooling).toBe(true)
  })

  // MUTATION: remove the `harvestSlot` call from `accountsView`, i.e. go back to
  // a status that only reads stored state.
  //
  // The owner opens the pane to find out whether Codex is working. Reading only
  // what the last run happened to persist means a seat that capped itself an hour
  // ago still shows healthy until some future run discovers it — the pane
  // reports the past and looks current.
  test('reading status HARVESTS, so a seat that capped since the last run shows cooling', async () => {
    let clock = NOW
    const svc = newService(() => clock)
    await svc.connectAccount(OWNER, subscriptionAuth())
    svc.resolveActiveCodexHome(OWNER, 'proj')
    expect(svc.listAccounts(OWNER)[0]?.cooling).toBe(false)
    writeRollout(codexHome, 'rollout-capped.jsonl', [tokenCountLine({ used_percent: 99.8, window_minutes: 10080 })], 1_800_000_000)
    clock = NOW + 5 * 60_000
    // No resolve in between — the status view is the only thing that runs.
    const seat = svc.listAccounts(OWNER)[0]
    expect(seat?.cooling).toBe(true)
    expect(seat?.used_percent).toBe(99.8)
  })

  // MUTATION: make `accountsView` call `syncSlots` a second time for `next`, or
  // have `nextSlot` re-select against freshly-read state.
  //
  // Two passes let the two halves answer different questions: the seat listed as
  // `active` was chosen against state the first pass had already changed, so a
  // status reply could name one seat as active and a different one as next.
  test('the seat marked active and the seat reported next are the same seat', async () => {
    let clock = NOW
    const svc = newService(() => clock)
    await svc.connectAccount(OWNER, subscriptionAuth())
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    svc.resolveActiveCodexHome(OWNER, 'proj')
    writeRollout(codexHome, 'rollout-spent2.jsonl', [tokenCountLine({ used_percent: 99.9, window_minutes: 10080 })], 1_800_000_000)
    clock = NOW + 5 * 60_000
    const view = svc.accountsView(OWNER)
    expect(view.next?.slot).toBe('work')
    expect(view.accounts.filter((a) => a.active).map((a) => a.slot)).toEqual(['work'])
  })

  test('with every seat spent it keeps a seat and logs exhaustion rather than returning null', async () => {
    const events: string[] = []
    const svc = new CodexCredentialService({
      store,
      codexHome,
      rotation: new SqliteCodexRotationStore(db),
      now: () => NOW,
      log: (event) => events.push(event),
    })
    await svc.connectAccount(OWNER, subscriptionAuth())
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    svc.resolveActiveCodexHome(OWNER, 'proj')
    const rotation = new SqliteCodexRotationStore(db)
    for (const s of ['default', 'work']) {
      rotation.setCooldown(OWNER, s, { cooling_until: NOW + 86_400_000, cooling_reason: 'long-window' })
    }
    const home = svc.resolveActiveCodexHome(OWNER, 'proj')
    expect(home).not.toBeNull()
    expect(events).toContain('codex_rotation_exhausted')
    expect(svc.nextSlot(OWNER)?.exhausted).toBe(true)
  })

  test('no credential at all still resolves to null — codex simply is not connected', () => {
    expect(newService().resolveActiveCodexHome(OWNER, 'proj')).toBeNull()
  })

  test('removing a seat deletes its row, its dir contents and its rotation state', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth())
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    expect((await svc.removeAccount(OWNER, 'work')).ok).toBe(true)
    expect(existsSync(join(codexHome, 'accounts', 'work', 'auth.json'))).toBe(false)
    expect(svc.listAccounts(OWNER).map((a) => a.slot)).toEqual(['default'])
    // The first seat is untouched.
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
  })

  // MUTATION: drop `markConnected` from the NAMED-seat arm of `connectAccount`.
  test('a reconnect clears an unauthorized cooldown, which nothing else can', async () => {
    const svc = newService()
    const rotation = new SqliteCodexRotationStore(db)
    await svc.connectAccount(OWNER, subscriptionAuth())
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    rotation.setCooldown(OWNER, 'work', { cooling_until: NOW, cooling_reason: 'unauthorized' })
    expect(svc.listAccounts(OWNER).find((a) => a.slot === 'work')?.cooling).toBe(true)
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    expect(svc.listAccounts(OWNER).find((a) => a.slot === 'work')?.cooling).toBe(false)
  })

  // MUTATION: drop `markConnected` from the DEFAULT arm of `connectAccount`.
  //
  // This branch delegates to the legacy `connect`, which knows nothing about
  // rotation — so it is the arm most likely to be forgotten, and the previous
  // revision did forget it while the named-seat arm above passed. The owner
  // pastes a fresh bundle into the first seat and it goes on being skipped by a
  // timer he cannot see.
  test('reconnecting the FIRST seat clears its cooldown too', async () => {
    const svc = newService()
    const rotation = new SqliteCodexRotationStore(db)
    await svc.connectAccount(OWNER, subscriptionAuth())
    rotation.setCooldown(OWNER, 'default', { cooling_until: NOW, cooling_reason: 'unauthorized' })
    expect(svc.listAccounts(OWNER).find((a) => a.slot === 'default')?.cooling).toBe(true)
    await svc.connectAccount(OWNER, subscriptionAuth())
    expect(svc.listAccounts(OWNER).find((a) => a.slot === 'default')?.cooling).toBe(false)
  })

  // MUTATION: drop the `connected_at` floor passed to `harvestNewestRollout`.
  //
  // Disconnecting a seat cannot remove its `sessions/` tree, so a DIFFERENT
  // subscription connected under the same slot name would read its predecessor's
  // rollout and be benched before it had run once.
  test('a seat reconnected under a reused name does not inherit the old usage history', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    // The previous occupant left a spent-weekly rollout behind in the directory,
    // stamped well before the new seat is connected.
    writeRollout(
      join(codexHome, 'accounts', 'work'),
      'rollout-previous-account.jsonl',
      [tokenCountLine({ used_percent: 99.9, window_minutes: 10080 })],
      Math.floor(NOW / 1000) - 86_400,
    )
    await svc.removeAccount(OWNER, 'work')
    expect(existsSync(join(codexHome, 'accounts', 'work', 'auth.json'))).toBe(false)

    // A new subscription takes the same slot name. Its own rollout tree is empty.
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    svc.resolveActiveCodexHome(OWNER, 'proj')
    expect(svc.listAccounts(OWNER).find((a) => a.slot === 'work')?.cooling).toBe(false)
  })

  test('a seat whose credential was deleted out from under it stops winning selections', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth())
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    svc.resolveActiveCodexHome(OWNER, 'proj')
    await store.delete(OWNER, '', 'codex-acct-work')
    // A stale row would hand back a directory with no bundle in it.
    expect(svc.listAccounts(OWNER).map((a) => a.slot)).toEqual(['default'])
    expect(svc.resolveActiveCodexHome(OWNER, 'proj')).toBe(codexHome)
  })

  // MUTATION: `return null` instead of walking on when a selected seat has no
  // usable stored credential.
  //
  // An EXPIRED credential row still appears in the seat listing (only `resolve`
  // filters on expiry), so it keeps its place in the ring and can win a
  // selection — and returning null there drops codex out of the review entirely
  // while a perfectly healthy seat sits next in line. That is the one direction
  // the policy explicitly forbids: a capped or missing seat must never be worse
  // than no seat.
  test('an expired seat is skipped, not fatal — the next healthy seat is used', async () => {
    const svc = newService()
    const rotation = new SqliteCodexRotationStore(db)
    await svc.connectAccount(OWNER, subscriptionAuth())
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    // Aim the pointer at 'work', then expire its credential out from under it.
    rotation.setActiveSlot(OWNER, 'work', NOW)
    await store.set(OWNER, {
      service: codexSlotService('work'),
      plaintext: subscriptionAuth(),
      scope: 'global',
      project_id: '',
      label: null,
      expires_at: new Date(NOW - 86_400_000).toISOString(),
    })

    // It must fall through to the healthy first seat rather than returning null.
    expect(svc.resolveActiveCodexHome(OWNER, 'proj')).toBe(codexHome)
    const work = svc.listAccounts(OWNER).find((a) => a.slot === 'work')
    // …and say WHY, so the owner is told to reconnect rather than left waiting
    // on a timer that would never have fixed it.
    expect(work?.cooling).toBe(true)
    expect(work?.cooling_reason).toBe('unauthorized')
  })

  // MUTATION: drop the `harvestBackOnly(owner_slug, previousActive)` call.
  //
  // THE SEAT THAT JUST RAN IS THE ONE WHOSE BUNDLE WENT STALE. The CLI refreshes
  // `auth.json` during a run and a refresh ROTATES the refresh token, so the
  // store's copy for the PREVIOUS seat is the one now holding a token the server
  // has replaced. Syncing only the seat about to run leaves that copy frozen —
  // and because the previous seat is cooling, it may not be resolved again for a
  // week, so the self-heal path would sit on a dead bundle for exactly as long
  // as it is unable to notice. That is the mutual-revocation failure this whole
  // design exists to avoid.
  test('the seat that just ran is harvested back, even when rotation moves away from it', async () => {
    const svc = newService()
    const rotation = new SqliteCodexRotationStore(db)
    await svc.connectAccount(OWNER, subscriptionAuth())
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    rotation.setActiveSlot(OWNER, 'work', NOW)

    const workHome = join(codexHome, 'accounts', 'work')
    // 'work' ran itself into its weekly cap AND refreshed its bundle on disk.
    writeRollout(workHome, 'rollout-spent.jsonl', [tokenCountLine({ used_percent: 99.8, window_minutes: 10080 })], 1_800_000_000)
    const refreshed = subscriptionAuth('2026-08-17T09:00:00.000Z')
    writeFileSync(codexAuthPath(workHome), refreshed)

    // The run rotates AWAY from 'work' to the healthy first seat…
    expect(svc.resolveActiveCodexHome(OWNER, 'proj')).toBe(codexHome)
    await Bun.sleep(50)

    // …and 'work's stored bundle still tracks what the CLI left on its disk.
    // Compared on `last_refresh` rather than on bytes: the store keeps the
    // NORMALIZED bundle, so a byte comparison would fail for a reason that has
    // nothing to do with whether the harvest-back ran.
    const storedWork = store.resolve(OWNER, undefined, codexSlotService('work'))?.plaintext ?? '{}'
    expect((JSON.parse(storedWork) as { last_refresh?: string }).last_refresh).toBe(
      '2026-08-17T09:00:00.000Z',
    )
    // The control: without the harvest-back it would still hold the connect-time
    // stamp, which is the stale copy that eventually revokes the live login.
    expect((JSON.parse(storedWork) as { last_refresh?: string }).last_refresh).not.toBe(
      '2026-06-30T00:00:00.000Z',
    )
  })

  // MUTATION: pass `label: null` in the harvest-back's store write.
  //
  // The store's upsert OVERWRITES label on conflict, so a null there quietly
  // erases the name the seat was connected under — and it happens on a path that
  // fires on its own schedule, whenever the CLI refreshes, so the seat simply
  // goes anonymous in every credential view with nothing to point at.
  test('harvesting a refreshed bundle back does not erase the seat label', async () => {
    const svc = newService()
    const rotation = new SqliteCodexRotationStore(db)
    await svc.connectAccount(OWNER, subscriptionAuth(), { slot: 'work' })
    const before = store.getMeta(OWNER, '', codexSlotService('work'))?.label ?? null
    expect(before).not.toBeNull()

    // The CLI refreshes the seat's bundle on disk: same account, newer stamp.
    rotation.setActiveSlot(OWNER, 'work', NOW)
    writeFileSync(
      codexAuthPath(join(codexHome, 'accounts', 'work')),
      subscriptionAuth('2026-08-17T09:00:00.000Z'),
    )
    svc.resolveActiveCodexHome(OWNER, 'proj')
    // The write is fire-and-forget by contract (the resolver is synchronous).
    await Bun.sleep(50)

    expect(store.getMeta(OWNER, '', codexSlotService('work'))?.label ?? null).toBe(before)
  })

  test('no account summary ever carries token material', async () => {
    const svc = newService()
    await svc.connectAccount(OWNER, subscriptionAuth())
    const blob = JSON.stringify(svc.listAccounts(OWNER))
    for (const secret of ['acc', 'ref', 'id_token', 'access_token', 'refresh_token']) {
      expect(blob).not.toContain(secret)
    }
  })
})
