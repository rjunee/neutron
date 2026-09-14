/**
 * O3 — producer-side spawn/channel error classification.
 *
 * Pins that the persistent-REPL adapter stamps the correct `SubstrateErrorClass`
 * for its own spawn/channel failure shapes, so the composer classifies on `code`
 * first. Mirrors the composer's `detectBinaryNotFound` / `detectChannelWedged`
 * negative-space guarantees at the producer.
 */

import { describe, expect, test } from 'bun:test'

import { SUBSTRATE_ERROR_CODES } from '../../../../errors.ts'
import { classifySpawnError, classifyThrownSpawnError } from '../classify-spawn-error.ts'

describe('classifySpawnError', () => {
  test('#539 — the boot-adoption refusal is STAMPED, so it never cools a credential', () => {
    // The producer-side stamp is what keeps this out of the credential ladder. An
    // UNSTAMPED retryable error maps to a 429-shaped pool cooldown
    // (`mapStatusForPoolCooldown(null, true)` in the composer), so a refusal that has
    // nothing to do with the credential would park a healthy one after five turns.
    const message =
      'persistent-repl: refusing to resume session inst user proj cred — a previous REPL for it may ' +
      'still be running and could not be accounted for (the herdr socket did not answer). Starting a ' +
      'second process on one transcript corrupts it, so this turn fails instead. It retries on the next turn.'
    expect(classifySpawnError(message)).toBe('repl_unreconciled')
    // Retryable, because the next turn re-probes: a transient failure to see the pane
    // costs one turn rather than the session.
    expect(SUBSTRATE_ERROR_CODES.repl_unreconciled.retryable).toBe(true)
  })

  test('a refusal is NOT confused with the channel classes that share its prefix', () => {
    expect(classifySpawnError('persistent-repl: channel not ready')).toBe('channel_wedged')
    expect(classifySpawnError('persistent-repl: spawn failed (dead-child; )')).toBe('channel_wedged')
  })

  test('missing `claude` binary shapes → binary_not_found', () => {
    expect(classifySpawnError('Executable not found in $PATH: "claude"')).toBe('binary_not_found')
    expect(classifySpawnError('Error: spawn claude ENOENT')).toBe('binary_not_found')
    expect(classifySpawnError('sh: claude: command not found')).toBe('binary_not_found')
    expect(classifySpawnError('spawn claude: no such file or directory')).toBe('binary_not_found')
  })

  test('an unrelated file ENOENT is NOT binary_not_found (requires a `claude` mention)', () => {
    expect(classifySpawnError('Error: spawn ENOENT')).toBeUndefined()
    expect(classifySpawnError('ENOENT: no such file or directory, open /tmp/settings.json')).toBeUndefined()
  })

  test('a missing OTHER executable is NOT binary_not_found — the executable-not-found branch also requires a `claude` mention', () => {
    // A spawn failure for some other binary (e.g. a helper the child shells out
    // to) must not be mislabelled as "Claude not on PATH".
    expect(classifySpawnError('Executable not found in $PATH: "bun"')).toBeUndefined()
    expect(classifySpawnError('Executable not found in $PATH: "ripgrep"')).toBeUndefined()
  })

  test('post-spawn-assertion / channel failures → channel_wedged', () => {
    for (const reason of ['channel-wedged', 'no-channel-ready', 'no-http-health', 'dead-child']) {
      expect(classifySpawnError(`persistent-repl: spawn failed (${reason}; pid=1)`)).toBe('channel_wedged')
    }
    expect(classifySpawnError('[channel-wedged] REPL sess still unwired')).toBe('channel_wedged')
    expect(classifySpawnError('persistent-repl: channel not ready')).toBe('channel_wedged')
  })

  test('a reply-sink bind failure → channel_wedged, which is FATAL (ISSUES #537)', () => {
    // The real producer message, verbatim in shape: a held port is a CONFIGURATION
    // failure. Unclassified, `pool.ts` stamps the default `retryable: true` with no
    // code and the credential ladder re-attempts a condition that will never clear —
    // paying a bind budget per attempt, forever.
    const message =
      'repl-sink: could not bind the reply sink on 127.0.0.1:19004 after 5 attempt(s): ' +
      'Failed to start server. Is port 19004 in use?. The sink port is DERIVED from this ' +
      "instance's state dir …"
    expect(classifySpawnError(message)).toBe('channel_wedged')
    expect(SUBSTRATE_ERROR_CODES.channel_wedged.retryable).toBe(false)
  })

  test('a message that merely MENTIONS the sink is not classified — the producer prefix is required', () => {
    // Negative space, same discipline as the `claude`-mention requirement above: a
    // turn error that happens to name the sink must still reach the composer's own
    // ladder rather than being declared fatal here.
    expect(classifySpawnError('posted to repl-sink and got a 500')).toBeUndefined()
    expect(classifySpawnError('could not bind something else entirely')).toBeUndefined()
  })

  test('an ordinary retryable turn error is unclassified (undefined → composer ladder decides)', () => {
    expect(classifySpawnError('persistent-repl: REPL process exited')).toBeUndefined()
    expect(classifySpawnError('some transient inner hiccup')).toBeUndefined()
  })
})

describe('#539 r42 — BOTH refusal verbs join the same class', () => {
  test('classifies the boot-adoption gate\'s refusal', () => {
    expect(classifySpawnError('persistent-repl: refusing to resume session abc — a previous REPL')).toBe(
      'repl_unreconciled',
    )
  })

  test('classifies the ownership-unrecorded refusal, which shipped unmatched', () => {
    // THE PROSE FALLBACK, kept even though the thrower now stamps its own class: a
    // consumer that only ever sees the message (the composer's regex ladder) would
    // otherwise map this to a synthetic 429 and cool a healthy credential.
    expect(
      classifySpawnError(
        'persistent-repl: refusing to serve session abc — its pane w9:p7 could not be RECORDED as owned',
      ),
    ).toBe('repl_unreconciled')
  })

  test('prefers what a thrower STAMPED over what it wrote', () => {
    const stamped = Object.assign(new Error('something the regexes have never seen'), {
      substrateErrorClass: 'repl_unreconciled' as const,
    })
    expect(classifyThrownSpawnError(stamped)).toBe('repl_unreconciled')
    // ...and still falls back to prose for the many failures that arrive as bare strings.
    expect(classifyThrownSpawnError(new Error('Executable not found in $PATH: "claude"'))).toBe(
      'binary_not_found',
    )
    expect(classifyThrownSpawnError('an ordinary crash')).toBeUndefined()
  })

  test('a stamp that is not a taxonomy member is ignored, not trusted', () => {
    // The consumer does `SUBSTRATE_ERROR_CODES[code].retryable`, so trusting an arbitrary
    // string would throw INSIDE the catch handling a spawn failure — turning a handled
    // refusal into an unhandled crash on the turn path. An unrecognised stamp falls back to
    // the message, which is the same disposition as never having been stamped at all.
    const bogus = Object.assign(new Error('Executable not found in $PATH: "claude"'), {
      substrateErrorClass: 'not_a_real_class',
    })
    expect(classifyThrownSpawnError(bogus)).toBe('binary_not_found')
    const bogusAndUnmatched = Object.assign(new Error('nothing recognisable'), {
      substrateErrorClass: 'not_a_real_class',
    })
    expect(classifyThrownSpawnError(bogusAndUnmatched)).toBeUndefined()
  })
})
