/**
 * MUTATION ACCEPTANCE for the publisher-auth classifier.
 *
 * WHY THIS FILE EXISTS AT ALL. Every round of this PR has claimed "mutation
 * tested" in prose, and prose is not evidence — a reviewer cannot re-run a
 * sentence. Worse, the failure mode a mutation test guards against is precisely
 * the one that leaves a suite GREEN: a fixture that hardcodes `stdout: ''`
 * cannot notice a classifier that stops reading stdout, and a guard typed
 * `readonly Cause[]` cannot notice a cause that was never added to it. Both of
 * those were real in this branch and both were found by a REVIEWER, not by the
 * suite. So the proof is mechanised here: each mutation below re-introduces one
 * specific misclassification into a COPY of `git-mode.ts`, runs the real suite
 * against the copy, and asserts the suite goes RED and names the right test.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL. `unmutated → green` runs first. Without
 * it, a harness whose copy step is broken reports every mutation as "caught"
 * while proving nothing at all — a tool returning a negative it cannot back up,
 * which is the exact trap this repo has been burned by. If the control is red,
 * every other assertion in this file is meaningless and the run fails there.
 *
 * MECHANICS. The copy lives in a DOT-DIRECTORY, which `scripts/lib/
 * discover-test-files.sh` and bun's own discovery both exclude, so the mutants
 * can never join the real suite. It is removed on the way out and is gitignored
 * so a killed run cannot leave a committable stray.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TRIDENT_DIR = import.meta.dir
const REPO_ROOT = join(TRIDENT_DIR, '..')
const MUTANT_DIR = join(REPO_ROOT, '.trident-mutants')
const MUTANT_SOURCE = join(MUTANT_DIR, 'git-mode.ts')
/**
 * The `./` is load-bearing. Bun's own discovery skips dot-directories — which is
 * WHY the mutants live in one — so a bare `.trident-mutants/…` filter matches no
 * files and bun exits 1 with "did not match any test files". That exit is
 * indistinguishable from a red suite, so without the explicit path form the
 * harness would report every mutation as caught while never running a single
 * test. The positive control is what surfaced it.
 */
const MUTANT_SUITE = './.trident-mutants/git-mode.test.ts'

const ORIGINAL = readFileSync(join(TRIDENT_DIR, 'git-mode.ts'), 'utf8')

/**
 * One re-introduced defect: a list of exact substring replacements, plus the
 * test whose name must appear in the failure output.
 *
 * `expectFailing` is a SUBSTRING OF A TEST NAME, not a count. Asserting "the
 * suite went red" alone would be satisfied by a mutation that broke something
 * unrelated — e.g. a syntax error — so each entry names the specific guard that
 * has to be the one to catch it.
 */
interface Mutation {
  readonly name: string
  readonly why: string
  readonly edits: readonly (readonly [find: string, replace: string])[]
  readonly expectFailing: string
}

const MUTATIONS: readonly Mutation[] = [
  {
    name: 'a transport failure is classified as a rejected credential',
    why:
      'The original defect. `gh auth status` renders a DNS/proxy failure with the words ' +
      '"The token in GH_TOKEN is invalid.", so matching "is invalid" tells an owner whose ' +
      'network is down that his token is bad.',
    edits: [["    t.includes('bad credentials') ||", "    t.includes('is invalid') ||"]],
    expectFailing: 'the MEASURED dead-network output is NOT classified as a rejection',
  },
  {
    name: 'the rejection classifier goes back to a blanket `HTTP 40[13]`',
    why:
      'GitHub returns 403 — not 429 — for both rate limits, for SAML/SSO and for resource ' +
      'restrictions, and `gh auth status` makes a live API round-trip. The blanket test ' +
      'read all of them as "expired, revoked, or missing a scope". Note WHICH guard catches ' +
      'it: the probe path is ALSO defended by ordering (the rate limit is subtracted before ' +
      'any 4xx reading), so the classifier-level assertion is the one that has to be there ' +
      'for a caller that skips that ordering — which is exactly why it exists.',
    edits: [
      [
        '  if (looksLikeGithubRateLimited(t)) return false',
        '  if (false as boolean) return false',
      ],
      ['    /\\bhttp 401\\b/.test(t)', '    /\\bhttp 40[13]\\b/.test(t)'],
    ],
    expectFailing: 'the 403 in a rate limit is subtracted from the rejection classifier itself',
  },
  {
    name: 'a rate limit is no longer subtracted BEFORE the credential verdict',
    why:
      'The ordering half of the same defect, mutated at the probe and at the reachability ' +
      'classifier so the rate-limited 403 reaches a rejection reading. A rate-limited owner ' +
      'is then told to rotate a token GitHub never refused.',
    edits: [
      [
        "      if (looksLikeGithubRateLimited(output)) {\n        return { authenticated: false, cause: 'github_rate_limited', detail: res.stderr }",
        "      if (false as boolean) {\n        return { authenticated: false, cause: 'github_rate_limited', detail: res.stderr }",
      ],
      [
        "  if (looksLikeGithubRateLimited(output)) return 'rate_limited'",
        "  if (false as boolean) return 'rate_limited'",
      ],
      [
        '  if (looksLikeGithubRateLimited(t)) return false',
        '  if (false as boolean) return false',
      ],
    ],
    expectFailing: 'the primary rate limit is `github_rate_limited`, not a bad token',
  },
  {
    name: 'the cause is keyed on the CONFIGURED SOURCE instead of on what happened',
    why:
      'Control reaches that branch only on positive evidence that a credential was ' +
      'presented and refused, so "no credential available" denies the observation that ' +
      'selected the branch. Real case: a stale ambient account with an empty in-app store.',
    edits: [
      [
        "          cause: 'credential_rejected',\n          detail: describeWhichCredential(token, res.stderr),",
        "          cause: token.length === 0 ? ('no_credential_available' as const) : ('credential_rejected' as const),\n          detail: describeWhichCredential(token, res.stderr),",
      ],
    ],
    expectFailing: 'an empty store whose AMBIENT credential is refused reads as a rejection',
  },
  {
    name: "multi-line `gh` stderr is truncated to its first line",
    why:
      "gh 2.97.0's rejected-token stderr is four lines and the FIRST is the bare hostname, " +
      "so `split('\\n')[0]` kept the only line carrying no diagnosis and ended the refusal " +
      "'…missing a scope: github.com'.",
    edits: [
      [
        '  const lines = detail\n    .split(\'\\n\')',
        "  const lines = [detail.split('\\n')[0] ?? '']\n    .slice(0)",
      ],
    ],
    expectFailing: 'EVERY diagnostic line reaches the owner, not just the bare hostname',
  },
  {
    name: 'the rate-limit refusal claims the credential is good',
    why:
      'A 403 rate limit is also returned to UNAUTHENTICATED requests, against the source ' +
      'IP, so it is not evidence of acceptance. The overclaim would tell an owner whose ' +
      'credential was silently dropped that it had been verified.',
    edits: [
      [
        '`accepted nor rejected. A rate limit is NOT evidence of rejection and NOT evidence ` +',
        '`accepted nor rejected — GitHub returns a rate limit WITH a working credential, so ` +',
      ],
      [
        '`the credential is good either — GitHub 403-rate-limits unauthenticated requests too, ` +\n        `against the source IP. Wait for the limit to reset, then re-run. ` +',
        '`this is evidence the token is fine. Wait for the limit to reset, then re-run. ` +',
      ],
    ],
    expectFailing: 'the primary refusal does NOT claim the credential is good',
  },
  {
    name: 'the evidence sentence reads STDERR only, while the classifier reads both streams',
    why:
      'Measured: `gh api` writes its SUCCESS body and its 401 JSON body to STDOUT. Reading ' +
      'stderr alone reported a call that plainly answered as "exited 0 without printing ' +
      'anything" — a message contradicting the classification standing next to it.',
    edits: [['  const said = [reach.stderr, reach.stdout]', '  const said = [reach.stderr]']],
    expectFailing: 'a successful reachability call is QUOTED',
  },
  {
    name: 'the reachability CLASSIFIER stops reading stdout',
    why:
      'The regression every `stdout: \'\'` fixture was blind to. GitHub puts the fuller ' +
      'diagnostic in the response body, which `gh` prints on stdout.',
    edits: [
      [
        "  if (res.ok) return 'reachable'\n  const output = `${res.stderr}\\n${res.stdout}`",
        "  if (res.ok) return 'reachable'\n  const output = `${res.stderr}`",
      ],
    ],
    expectFailing: 'the classifier reads STDOUT too',
  },
  {
    name: 'an x509/TLS interception falls through to the unclassified tail',
    why:
      'A handshake that never completed carried no credential to GitHub, so it is a ' +
      'transport fact. Round 4 rendered it as "the probe itself failed" — unactionable, ' +
      'and about the wrong subsystem.',
    edits: [
      [
        "    t.includes('x509:') ||\n" +
          "    t.includes('certificate signed by unknown authority') ||\n" +
          "    t.includes('certificate is not trusted') ||\n" +
          "    t.includes('certificate has expired or is not yet valid') ||\n" +
          "    t.includes('self-signed certificate') ||\n" +
          "    t.includes('tls: failed to verify') ||\n" +
          "    t.includes('tls: handshake failure') ||\n" +
          "    t.includes('unable to verify the first certificate') ||\n",
        '',
      ],
    ],
    expectFailing: 'is a TRANSPORT failure, not a rejected credential',
  },
  {
    name: 'a SUCCESSFUL reachability call is folded back into `inconclusive`',
    why:
      'A `gh api /zen` that exits 0 proves GitHub answered AND accepted this credential. ' +
      'Calling that inconclusive sent the owner to "Check network/DNS/proxy FIRST" — to ' +
      'debug the one thing just measured as working.',
    edits: [["  if (res.ok) return 'reachable'", "  if (res.ok) return 'inconclusive'"]],
    expectFailing: 'a reachability call that SUCCEEDS rules out both the token and the network',
  },
  {
    name: 'a SAML/SSO 403 is reported as a rejected credential',
    why:
      'GitHub accepted WHO the credential is and refused WHAT it asked for. Rotating just ' +
      'produces another unauthorized token; the fix is to authorize the existing one.',
    edits: [
      ['  if (looksLikeSamlSsoUnauthorized(t)) return false', '  if (false as boolean) return false'],
      [
        "      if (looksLikeSamlSsoUnauthorized(output)) {\n        return {\n          authenticated: false,\n          cause: 'credential_needs_sso_authorization',",
        "      if (false as boolean) {\n        return {\n          authenticated: false,\n          cause: 'credential_needs_sso_authorization',",
      ],
      [
        "  if (looksLikeSamlSsoUnauthorized(output)) return 'sso_unauthorized'",
        "  if (false as boolean) return 'sso_unauthorized'",
      ],
    ],
    expectFailing: 'a SAML/SSO refusal names the ORG problem',
  },
]

/** Run the copied suite against whatever `git-mode.ts` currently sits beside it. */
function runMutantSuite(): { exitCode: number; output: string } {
  const proc = Bun.spawnSync(['bun', 'test', MUTANT_SUITE], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: proc.exitCode,
    output: `${proc.stdout.toString()}\n${proc.stderr.toString()}`,
  }
}

function applyMutation(mutation: Mutation): string {
  let mutated = ORIGINAL
  for (const [find, replace] of mutation.edits) {
    // A replacement whose anchor has drifted would leave the source UNCHANGED,
    // the suite GREEN, and the harness would report "the guard did not catch
    // it" — blaming the test for the harness's own miss. Fail on the real cause
    // instead, naming the anchor.
    if (!mutated.includes(find)) {
      throw new Error(
        `mutation "${mutation.name}": anchor not found in trident/git-mode.ts, so nothing ` +
          `was mutated. The source moved; update the anchor:\n${find}`,
      )
    }
    mutated = mutated.replace(find, replace)
  }
  if (mutated === ORIGINAL) {
    throw new Error(`mutation "${mutation.name}" produced an identical file`)
  }
  return mutated
}

describe('mutation acceptance — each re-introduced misclassification is CAUGHT', () => {
  beforeAll(() => {
    rmSync(MUTANT_DIR, { recursive: true, force: true })
    mkdirSync(MUTANT_DIR, { recursive: true })
    // The real suite, run verbatim against a swappable source. `store.ts` comes
    // along because both files import its types; `@neutronai/*` specifiers still
    // resolve, because node walks up to the repo root's `node_modules`.
    cpSync(join(TRIDENT_DIR, 'git-mode.test.ts'), join(MUTANT_DIR, 'git-mode.test.ts'))
    cpSync(join(TRIDENT_DIR, 'store.ts'), join(MUTANT_DIR, 'store.ts'))
  })

  afterAll(() => {
    rmSync(MUTANT_DIR, { recursive: true, force: true })
  })

  test('POSITIVE CONTROL — the UNMUTATED copy is green, so a red below means something', () => {
    writeFileSync(MUTANT_SOURCE, ORIGINAL)
    const { exitCode, output } = runMutantSuite()
    expect([exitCode, output.includes('0 fail')]).toEqual([0, true])
  })

  for (const mutation of MUTATIONS) {
    test(`CAUGHT: ${mutation.name}`, () => {
      writeFileSync(MUTANT_SOURCE, applyMutation(mutation))
      const { exitCode, output } = runMutantSuite()
      // Red, AND red for the right reason: the named guard must be among the
      // failures. `[name, …]` so a failure here reports which mutation escaped.
      expect([mutation.name, exitCode !== 0, output.includes(mutation.expectFailing)]).toEqual([
        mutation.name,
        true,
        true,
      ])
    })
  }
})
