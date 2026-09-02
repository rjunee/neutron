import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkpointRound } from './checkpoint-round.ts'

const SCRIPT = fileURLToPath(new URL('./checkpoint.sh', import.meta.url))

const OID = 'a'.repeat(40)

describe('checkpointRound', () => {
  test.each([
    ['fix-round-2', 2],
    ['fix-round-7', 7],
    ['fix-round-12', 12],
  ])('parses %s', (checkpoint, round) => {
    expect(checkpointRound(checkpoint)).toBe(round)
  })

  test('reads the last numeric outer-published field, not remaining tasks', () => {
    expect(checkpointRound(`outer-published:${OID}:3:1`)).toBe(1)
    expect(checkpointRound(`outer-published:${OID}:0:4`)).toBe(4)
    expect(checkpointRound(`outer-published:${OID}:2:6:deviated`)).toBe(6)
  })

  test.each([
    null,
    '',
    'forge-done',
    'argus-approved',
    'argus-request-changes',
    'argus-request-changes-round-7',
    'pr-merged',
    'inner-error',
    'ralph-task-built',
    'fix-round-',
    'fix-round-x',
    'outer-published:nothex:3:1',
    `outer-published:${OID}:3`,
    // OUT OF DOMAIN (>9 digits). Not a shape any writer produces, and the clamp is
    // what makes the bash mirror's `10#` arithmetic unable to wrap negative — see
    // the equivalence corpus below.
    'fix-round-9223372036854775808',
    'fix-round-9007199254740993',
    'fix-round-1000000000',
    `outer-published:${OID}:2:9223372036854775808`,
  ])('does not guess a round for %p', (checkpoint) => {
    expect(checkpointRound(checkpoint)).toBeNull()
  })

  test('the largest in-domain round still parses — the clamp is a bound, not a ban', () => {
    // Positive control for the case above: without this, deleting the parser
    // entirely would leave every out-of-domain assertion passing.
    expect(checkpointRound('fix-round-999999999')).toBe(999_999_999)
    expect(checkpointRound(`outer-published:${OID}:2:999999999`)).toBe(999_999_999)
  })
})

describe('the Bash mirror in checkpoint.sh agrees with the TypeScript parser', () => {
  // `checkpoint.sh` is the ONLY writer the live inner workflow checkpoints
  // through, so it carries its own copy of this parser (same reason
  // `phase_for_checkpoint` exists — see checkpoint-phase.test.ts). Two copies of
  // one rule need a proof that they answer identically, or they drift.

  /**
   * Run the script's own `round_for_checkpoint` by sourcing it out of the file.
   *
   * `set -euo pipefail` matches the script's own header, because the defect this
   * guards (see the locale test below) is an ABORT: without `-e` the arithmetic
   * error prints and the function limps on, and the test would report the failure
   * as a wrong answer rather than as the lost write it really is.
   */
  function bashRoundFor(checkpoint: string, locale?: string): string {
    const src = readFileSync(SCRIPT, 'utf8')
    const start = src.indexOf('round_for_checkpoint() {')
    expect(start).toBeGreaterThan(-1) // the function must still be findable
    const end = src.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    const fn = src.slice(start, end + 3)
    const p = Bun.spawnSync(
      ['bash', '-c', `set -euo pipefail\n${fn}\nround_for_checkpoint "$1"`, '_', checkpoint],
      locale === undefined ? {} : { env: { ...process.env, LC_ALL: locale } },
    )
    expect(p.exitCode).toBe(0)
    return p.stdout.toString()
  }

  test('the extracted function is real bash, not an empty slice', () => {
    // Guards the extraction itself: an empty or malformed slice would make every
    // comparison below pass by both sides answering ''.
    expect(bashRoundFor('fix-round-2')).toBe('2')
  })

  const CORPUS = [
    'fix-round-1',
    'fix-round-2',
    'fix-round-12',
    // Leading zeros: `Number('007')` is 7, and bash's `10#` prefix is what stops
    // the shell reading it as octal.
    'fix-round-007',
    'fix-round-',
    'fix-round-x',
    `outer-published:${OID}:3:1`,
    `outer-published:${OID}:0:4`,
    `outer-published:${OID}:2:6:deviated`,
    // An UPPERCASE oid is not the pinned shape — both copies must decline it.
    `outer-published:${OID.toUpperCase()}:2:6`,
    // THE WRAP CASE, and the reason the domain is clamped to nine digits in BOTH
    // copies. `$(( 10#9223372036854775808 ))` wraps NEGATIVE in bash and that minus
    // sign would be interpolated into `round=MAX(round, -N)`, while `Number()`
    // returns the mathematical value — the two copies disagreed, and the earlier
    // corpus had no case above 2^53 to notice. Nine digits max means neither copy
    // matches these at all, so both answer "no round" and agree by construction.
    'fix-round-9223372036854775808',
    'fix-round-9007199254740993',
    'fix-round-1000000000',
    `outer-published:${OID}:2:9223372036854775808`,
    // …and the largest round that IS in the domain still parses.
    'fix-round-999999999',
    'argus-request-changes-round-7',
    // WHITESPACE-PADDED. The TS copy trims before matching; the bash copy matched
    // the raw argument, so ' fix-round-3 ' answered 3 there and '' here — a total
    // equivalence claim that was true only over unpadded names. No writer emits
    // these today, which is exactly why nothing caught it.
    ' fix-round-3 ',
    '\tfix-round-4',
    'fix-round-5\n',
    `  outer-published:${OID}:2:6:deviated  `,
    '   ',
    // …and padding does NOT rescue a name that is out of the domain either way.
    ' fix-round-1x ',
    // NON-ASCII padding, the half the corpus was missing (Argus r4). `[[:space:]]`
    // does not strip NBSP / U+2003 / the BOM, and `String.prototype.trim` does — so
    // the TS copy answered 3 for a name bash called unparseable. Both copies now
    // trim the same six ASCII characters and both decline these.
    '\u00a0fix-round-3',
    'fix-round-3\u00a0',
    '\u2003fix-round-3',
    '\ufefffix-round-3',
    `\u00a0outer-published:${OID}:2:6`,
    'forge-done',
    'argus-approved',
    'ralph-task-built',
    'inner-error',
    '',
    'who-knows',
  ]

  for (const name of CORPUS) {
    test(`both copies agree for ${JSON.stringify(name)}`, () => {
      expect(bashRoundFor(name)).toBe(String(checkpointRound(name) ?? ''))
    })
  }

  // AND THE ANSWER DOES NOT DEPEND ON THE AMBIENT LOCALE (Argus r23, two
  // independent repros). `[0-9]` inside `[[ =~ ]]` is COLLATED under glibc, so in
  // `en_US.UTF-8` it also matches U+0663 ARABIC-INDIC DIGIT THREE: `fix-round-٣`
  // matched, `$(( 10#٣ ))` threw "invalid integer constant", and under the
  // script's own `set -euo pipefail` that aborts the whole invocation — the entire
  // checkpoint UPDATE lost, which is the blind row the script's docblock forbids.
  // The trim above was narrowed for the same reason (`[[:space:]]` is locale-
  // dependent too); this is the digit class, the other half of the same bug.
  const ARABIC_INDIC_THREE = '٣'
  for (const locale of ['en_US.UTF-8', 'C']) {
    test(`a non-ASCII digit is DECLINED, not thrown on, under ${locale}`, () => {
      const name = `fix-round-${ARABIC_INDIC_THREE}`
      // `bashRoundFor` asserts exit 0, which is the whole point: the failure mode
      // was an abort, not a wrong number.
      expect(bashRoundFor(name, locale)).toBe('')
      expect(checkpointRound(name)).toBeNull()
    })

    test(`an ASCII round still parses under ${locale} — the locale pin is not a ban`, () => {
      // Positive control: without it, a `round_for_checkpoint` that answered ''
      // for everything would satisfy the assertion above.
      expect(bashRoundFor('fix-round-3', locale)).toBe('3')
      expect(bashRoundFor(`outer-published:${OID}:2:6:deviated`, locale)).toBe('6')
    })
  }
})
