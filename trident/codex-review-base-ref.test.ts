/**
 * `codex-review.sh`'s BASE-REF PROMOTION, against real git (#546).
 *
 * The wrapper prefers `origin/<x>` over a stale local branch `<x>`. The first version of
 * that block promoted whenever `origin/${BASE_REF}` resolved — by STRING SHAPE — and its
 * own comment claimed a tag would be "kept verbatim". It would not have been: with a tag
 * `release` at one commit and a remote branch `origin/release` at another,
 * `codex-review.sh release` reviewed the wrong commit, silently.
 *
 * That is the shape these tests exist for, and it is the second time on this branch that
 * a correct-looking generalisation over-reached by substituting an available signal for
 * the one that matters — the merge-mode fallback inferred "no remote" from "merges
 * locally", and this inferred "branch" from "resolves". So the cases below are written as
 * KINDS OF ARGUMENT, and every one of them names the commit it must end up at.
 *
 * THE SHIPPED BLOCK IS WHAT RUNS. It is extracted from `codex-review.sh` by text rather
 * than retyped, so a test cannot pass against a promotion the wrapper does not have.
 * Running the whole wrapper would need codex auth and a review round; the promotion is
 * self-contained and the extraction below is checked to have found it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'

const SCRIPT = join(import.meta.dir, 'codex-review.sh')
const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout.trim()
}

/**
 * The base-ref block PLUS the resolvability guard, lifted out of the shipped wrapper — the
 * qualification `if/elif` chain, then the guard that refuses a base naming no commit. The
 * guard lives beside the diff rather than beside the chain (putting it next to the chain made
 * it preempt the documented GRACEFUL exit 10/11), so it is spliced on here.
 *
 * THE EXTRACTION USED TO STOP AT THE FIRST `fi`, which is why `'no-such-branch'` could be
 * asserted as "kept verbatim" for a whole round: whatever refuses an unresolvable base is not
 * in that slice, so the tests never ran it. **An extraction boundary is a claim about what is
 * under test**, and this one was quietly narrower than the behaviour it was named for.
 */
function promotionBlock(): string {
  const src = readFileSync(SCRIPT, 'utf8')
  const start = src.indexOf('BASE_REF="${1:-main}"')
  expect(start).toBeGreaterThan(-1)
  const chainEnd = src.indexOf(': "${CODEX_HOME:=}"', start)
  expect(chainEnd).toBeGreaterThan(start)
  // FROM THE CLASSIFIER'S REFUSAL EMITTER, not from the shape `case` that follows it. The
  // classifier RECORDS its refusals in `BASE_REF_REFUSAL` (emitting them up there would
  // preempt the graceful exit 10/11), so a slice that began at the shape assertion would drop
  // every refusal the classifier decided — which is what this extraction did for one run, and
  // the tests said so immediately. **An extraction boundary is a claim about what is under
  // test**, and it has to move whenever the code it names does.
  const guardStart = src.indexOf("if [ -n \"${BASE_REF_REFUSAL:-}\" ]", chainEnd)
  expect(guardStart).toBeGreaterThan(chainEnd)
  const guardEnd = src.indexOf('\n  fi\n', src.indexOf('does not name a commit in this repository', guardStart))
  expect(guardEnd).toBeGreaterThan(guardStart)
  const block = src.slice(start, chainEnd) + src.slice(guardStart, guardEnd + 6)
  // It must actually contain the promotion, or these tests prove nothing about it.
  expect(block).toContain('refs/remotes/origin/${BASE_REF}')
  // The FULLY QUALIFIED form, which is what the block verifies one line above. It stored the
  // shorthand `origin/${BASE_REF}` until round seventeen, and a tag named `origin/main` wins
  // that name in git's disambiguation order — so the promotion resolved to the tag.
  expect(block).toContain('BASE_REF="refs/remotes/origin/${BASE_REF}"')
  // …and the guard that makes an unresolvable base a REFUSAL rather than an empty review.
  expect(block).toContain('does not name a commit in this repository')
  // …and the SHAPE assertion, the property this file's last test is about.
  expect(block).toContain('is a SHORTHAND, not a ref')
  return block
}

/** The shipped block's raw outcome for `arg` in `repo` — exit code and streams. */
async function runBlock(repo: string, arg: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const script = `set -uo pipefail\nset -- ${JSON.stringify(arg)}\n${promotionBlock()}\nprintf %s "$BASE_REF"\n`
  const res = await spawnCapture(['bash', '-c', script], repo)
  return { ok: res.ok, stdout: res.stdout.trim(), stderr: res.stderr }
}

/** What the shipped block leaves `BASE_REF` as, for `arg`, in `repo`. */
async function promote(repo: string, arg: string): Promise<string> {
  const res = await runBlock(repo, arg)
  if (!res.ok) throw new Error(`promotion block failed: ${res.stderr}`)
  return res.stdout
}

interface World {
  repo: string
  /** Where the local branch `main` and the tag `release` point. */
  local: string
  /** Where `origin/main` and `origin/release` point — a DIFFERENT commit. */
  remote: string
}

/**
 * One repository holding, deliberately, every collision at once: a local branch and a
 * remote-tracking branch of the same name at different commits (the case the promotion is
 * FOR), and a TAG whose name also exists as a remote-tracking branch (the case it must
 * not touch).
 */
async function seedWorld(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'codex-review-base-ref-'))
  created.push(root)
  const repo = join(root, 'repo')
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', repo], root)
  await spawnCapture(['bash', '-c', `cd ${JSON.stringify(repo)} && echo a > a.txt`], root)
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'A')
  const local = await git(repo, 'rev-parse', 'HEAD')

  // The tag sits at A, with the SAME NAME as a remote-tracking branch created below.
  await git(repo, 'tag', 'release', local)

  await spawnCapture(['bash', '-c', `cd ${JSON.stringify(repo)} && echo b > b.txt`], root)
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'B')
  const remote = await git(repo, 'rev-parse', 'HEAD')

  // Remote-tracking refs at B; local `main` moved back to A so the promotion has a real
  // staleness to correct.
  await git(repo, 'update-ref', 'refs/remotes/origin/main', remote)
  await git(repo, 'update-ref', 'refs/remotes/origin/release', remote)
  await git(repo, 'update-ref', 'refs/heads/main', local)

  expect(local).not.toBe(remote)
  return { repo, local, remote }
}

describe('codex-review.sh promotes a base ref BY KIND, not by string shape', () => {
  test('a LOCAL BRANCH with a remote counterpart is promoted — the case this is for', async () => {
    const w = await seedWorld()
    expect(await promote(w.repo, 'main')).toBe('refs/remotes/origin/main')
    // Pinned as the COMMIT, not just the name: promotion is only worth anything if the
    // ref it picks resolves somewhere different from the one it refused.
    expect(await git(w.repo, 'rev-parse', await promote(w.repo, 'main'))).toBe(w.remote)
    expect(await git(w.repo, 'rev-parse', 'main')).toBe(w.local)
  })

  test('A TAG NAMED `origin/main` DOES NOT CAPTURE THE PROMOTED REF — the return form', async () => {
    // THE COLLISION AGAINST THE RETURNED FORM, not against the argument. The block verifies
    // `refs/remotes/origin/main^{commit}` and used to STORE the shorthand `origin/main` —
    // and git prefers `refs/tags/` over `refs/remotes/` when disambiguating, so a tag by that
    // name silently captured the base the wrapper had just proved. Measured on git 2.43: the
    // shorthand resolves to the tag with only a `warning: refname … is ambiguous` on stderr
    // and exit 0, and this wrapper sends its diff's stderr to /dev/null.
    //
    // The sibling test above covers a tag named `release` — a collision against the ARGUMENT.
    // This is the other end: same mechanism, the value the check hands back.
    const w = await seedWorld()
    await git(w.repo, 'tag', 'origin/main', w.local)
    // The collision is real here, and the two names disagree — or this proves nothing.
    expect(await git(w.repo, 'rev-parse', 'refs/tags/origin/main')).toBe(w.local)
    expect(await git(w.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(w.remote)

    const promoted = await promote(w.repo, 'main')
    expect(promoted).toBe('refs/remotes/origin/main')
    // THE COMMIT, which is the claim: the promoted ref resolves to the REMOTE tip even with
    // the tag present. The shorthand would resolve to `w.local` — asserted here so the
    // difference is a measured value, not an argument about git's precedence rules.
    expect(await git(w.repo, 'rev-parse', promoted)).toBe(w.remote)
    expect(await git(w.repo, 'rev-parse', 'origin/main')).toBe(w.local)
  })

  test('A TAG IS NOT PROMOTED to origin/<same-name> — and a BARE tag-only name is now REFUSED', async () => {
    // THE ORIGINAL REGRESSION: `origin/release` resolves, so the string-shaped promotion
    // rewrote this and the review ran against B — a different commit, silently. That must
    // still not happen.
    //
    // AND THE NEW HALF: the old answer was to keep `release` VERBATIM, which is a bare word
    // that resolves only as a tag. This repository has a live instance of exactly that shape
    // (`archive/agent-replies-prior-iter-3b35767`), and a tag is not a base branch — so the
    // bare form is refused, with the explicit `refs/tags/release` still accepted below.
    const w = await seedWorld()
    const res = await runBlock(w.repo, 'release')
    expect({ ok: res.ok, stdout: res.stdout }).toEqual({ ok: false, stdout: '' })
    expect(res.stderr).toContain('refs/tags/release')
    expect(res.stderr).toContain('a tag is not a base branch')
    // NOT promoted to the remote-tracking ref — the refusal must not be the promotion in
    // disguise, so the commit the name would have reached is named here too.
    expect(res.stderr).not.toContain('refs/remotes/origin/release')
    expect(await git(w.repo, 'rev-parse', 'refs/tags/release')).toBe(w.local)
    expect(await git(w.repo, 'rev-parse', 'refs/remotes/origin/release')).toBe(w.remote)
    // THE WAY OUT, kept working: an operator who means the tag says so explicitly.
    expect(await promote(w.repo, 'refs/tags/release')).toBe('refs/tags/release')
    expect(await git(w.repo, 'rev-parse', await promote(w.repo, 'refs/tags/release'))).toBe(w.local)
  })

  test('an AMBIGUOUS name — both a branch and a tag — is REFUSED, not passed through', async () => {
    // THIS USED TO BE "left alone", on the reasoning that promoting would be a guess.
    // Leaving it alone is also a guess — GIT's — and git prefers `refs/tags/` over
    // `refs/heads/`, so the review would have run against the TAG with only a
    // `warning: refname … is ambiguous` on a stderr this wrapper sends to /dev/null.
    const w = await seedWorld()
    // THE BRANCH AND THE TAG AT DIFFERENT COMMITS. Both were seeded at `w.local` until this
    // round, so the two assertions below compared a value with itself: the fixture could not
    // show that git's choice CHANGES the reviewed commit, which is the only reason the
    // refusal exists. A test whose two arms are the same value cannot fail for the reason it
    // exists.
    await git(w.repo, 'update-ref', 'refs/heads/release', w.remote)
    expect(await git(w.repo, 'rev-parse', 'refs/tags/release')).toBe(w.local)
    expect(await git(w.repo, 'rev-parse', 'refs/heads/release')).toBe(w.remote)
    expect(w.local).not.toBe(w.remote)
    // AND THE STAKES, measured: the bare word resolves to the TAG, so a review that accepted
    // it would have run against `w.local` while the branch the operator named is at
    // `w.remote`. That is the commit the refusal is protecting.
    expect(await git(w.repo, 'rev-parse', 'release')).toBe(w.local)
    const res = await runBlock(w.repo, 'release')
    expect({ ok: res.ok, stdout: res.stdout }).toEqual({ ok: false, stdout: '' })
    // The message has to name BOTH refs and the way out, or the operator is left with an
    // exit code and a guess of their own.
    expect(res.stderr).toContain('refs/heads/release')
    expect(res.stderr).toContain('refs/tags/release')
    expect(res.stderr).toContain('AMBIGUOUS')
    // …and the unambiguous sibling still passes, so the refusal is not "refuse everything".
    expect(await promote(w.repo, 'main')).toBe('refs/remotes/origin/main')
  })

  test('every other kind of argument that RESOLVES is kept VERBATIM', async () => {
    const w = await seedWorld()
    // HEAD NEEDS A PARENT for `HEAD~1` to be a resolvable argument, and the fixture leaves
    // HEAD at the root commit. Found by the new guard REFUSING `HEAD~1` here — the fixture
    // was supplying an unresolvable value and the old "kept verbatim" assertion could not
    // tell that from a resolvable one, which is the same fixture-supplies-the-claim shape
    // this round is about.
    await git(w.repo, 'switch', '-q', '-c', 'head-probe', w.remote)
    for (const arg of [
      w.remote, // a 40-hex sha — a full object name
      'refs/tags/release', // an explicitly qualified tag: the caller's own choice
    ]) {
      expect({ arg, got: await promote(w.repo, arg) }).toEqual({ arg, got: arg })
    }
    // `HEAD~1` is RESOLVED to an object name rather than kept as text: it is unambiguous (no
    // namespace lookup), so it needs no refusal — but the value that reaches git must still
    // be an object name or a `refs/` path.
    expect(await promote(w.repo, 'HEAD~1')).toBe(await git(w.repo, 'rev-parse', 'HEAD~1'))
  })

  test('`origin/main` IS NOT QUALIFIED — it is a shorthand a tag outranks', async () => {
    // THE FOURTH POSITION OF ONE DEFECT, and the one that hid behind a classifier: this
    // argument was in the "kept VERBATIM" list as "already qualified". It is not — a slash
    // is not a namespace. Measured on git 2.43 with both refs present, `origin/main` resolves
    // to the TAG, so the review would have run against the wrong commit and exited 0.
    const w = await seedWorld()
    await git(w.repo, 'tag', 'origin/main', w.local)
    expect(await git(w.repo, 'rev-parse', 'refs/tags/origin/main')).toBe(w.local)
    expect(await git(w.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(w.remote)
    // The bare shorthand resolves to the tag — the wrong commit…
    expect(await git(w.repo, 'rev-parse', 'origin/main')).toBe(w.local)
    // …and the wrapper hands git the remote-tracking ref instead, which resolves to the right
    // one. Asserted as the COMMIT, because the two names differ only in what they resolve to.
    const got = await promote(w.repo, 'origin/main')
    expect(got).toBe('refs/remotes/origin/main')
    expect(await git(w.repo, 'rev-parse', got)).toBe(w.remote)
  })

  test('THE PRECEDENCE TABLE: every competing ref present, at DIFFERENT commits', async () => {
    // THE THING THAT MAKES A FOURTH ROUND UNNECESSARY. Three consecutive findings on this
    // chain were the same defect — an arm probing a CONSTRUCTED ref name ran before the arm
    // that would have recognised what the input already was — and each fix moved one arm and
    // exposed the one behind it. A test per collision only fails on the collision someone
    // thought of; **this table fails on any future reordering.**
    //
    // Every competing ref exists here, at a DIFFERENT commit, so no row can pass by accident:
    // the input form alone decides which commit the review would run against.
    const w = await seedWorld()
    const c = {
      heads: w.local, // refs/heads/main
      remote: w.remote, // refs/remotes/origin/main
      // `commit-tree` needs an identity like any other commit; GIT_ID is what the rest of
      // this fixture uses.
      nested: await git(w.repo, ...GIT_ID, 'commit-tree', `${w.remote}^{tree}`, '-p', w.remote, '-m', 'nested'),
      tag: await git(w.repo, ...GIT_ID, 'commit-tree', `${w.local}^{tree}`, '-p', w.local, '-m', 'tagged'),
    }
    await git(w.repo, 'update-ref', 'refs/heads/main', c.heads)
    await git(w.repo, 'update-ref', 'refs/remotes/origin/main', c.remote)
    await git(w.repo, 'update-ref', 'refs/remotes/origin/origin/main', c.nested)
    await git(w.repo, 'update-ref', 'refs/tags/origin/main', c.tag)
    // The four are distinct, or a row could pass while naming the wrong ref.
    expect(new Set(Object.values(c)).size).toBe(4)

    // input form → the COMMIT the wrapper's answer resolves to, and WHY that kind wins.
    const table: Array<{ input: string; ref: string; commit: string }> = [
      // A BARE name is never probed as `origin/<x>`: it takes the remote-tracking ref for
      // ITS OWN name, not one nested under it.
      { input: 'main', ref: 'refs/remotes/origin/main', commit: c.remote },
      // An `origin/`-prefixed name is never probed as a bare name: exactly one promotion,
      // `refs/remotes/<it>`. The generic arm used to win here and select the NESTED ref.
      { input: 'origin/main', ref: 'refs/remotes/origin/main', commit: c.remote },
      // …and the nested ref is reachable only by asking for it.
      { input: 'origin/origin/main', ref: 'refs/remotes/origin/origin/main', commit: c.nested },
      // ALREADY SHAPED — kept verbatim, whatever else could have been constructed from it.
      { input: 'refs/heads/main', ref: 'refs/heads/main', commit: c.heads },
      { input: 'refs/tags/origin/main', ref: 'refs/tags/origin/main', commit: c.tag },
      { input: 'refs/remotes/origin/origin/main', ref: 'refs/remotes/origin/origin/main', commit: c.nested },
      { input: c.remote, ref: c.remote, commit: c.remote },
    ]
    // RUN TWICE — with the `refs/tags/origin/main` collision present and ABSENT. Found by
    // mutation: reinstating the discovery-ordered chain (the generic remote arm ahead of the
    // `origin/` kind) passed the first run, because that tag makes the generic arm's
    // `! refs/tags/<x>` condition false and it skips to the right arm by luck. **A fixture
    // that carries an extra ref can mask the very precedence it is testing**; without the tag,
    // the generic arm probes `refs/remotes/origin/origin/main` and wins.
    for (const withTag of [true, false]) {
      if (!withTag) await git(w.repo, 'update-ref', '-d', 'refs/tags/origin/main')
      for (const row of table) {
        if (!withTag && row.input === 'refs/tags/origin/main') continue
        const got = await promote(w.repo, row.input)
        const resolved = await git(w.repo, 'rev-parse', got)
        expect({ withTag, input: row.input, got, resolved }).toEqual({
          withTag,
          input: row.input,
          got: row.ref,
          resolved: row.commit,
        })
      }
    }
  })

  test('A VALUE THAT IS ALREADY THE RIGHT SHAPE IS KEPT — even when a promotable ref shadows it', async () => {
    // THE PROMOTION ARMS RAN BEFORE THE INPUT WAS CLASSIFIED, so they could capture a value the
    // contract says is kept verbatim. They are rev-parse probes on `refs/*/${BASE_REF}`, and
    // those names are LEGAL for an already-qualified value: `git check-ref-format
    // refs/remotes/origin/<40-hex>` exits 0.
    //
    // The launch-pinned SHA is the PRIMARY caller in this item, so its silent rewrite is
    // exactly the Argus r4 shape the item exists for — a review against the wrong base, exit 0.
    // The competing refs point at DIFFERENT commits here, or the assertion could not tell
    // "kept verbatim" from "promoted to something that happens to match".
    const w = await seedWorld()
    const pin = w.remote // a real 40-hex object name…
    await git(w.repo, 'update-ref', `refs/remotes/origin/${pin}`, w.local) // …shadowed, at ANOTHER commit
    expect(await git(w.repo, 'rev-parse', `refs/remotes/origin/${pin}`)).toBe(w.local)
    expect(pin).not.toBe(w.local)
    expect(await promote(w.repo, pin)).toBe(pin)
    // Asserted as the COMMIT too: the value still names what the caller pinned.
    expect(await git(w.repo, 'rev-parse', await promote(w.repo, pin))).toBe(w.remote)

    // The same capture reaches an explicit ref path.
    await git(w.repo, 'update-ref', 'refs/remotes/origin/refs/tags/release', w.local)
    expect(await promote(w.repo, 'refs/tags/release')).toBe('refs/tags/release')
    expect(await git(w.repo, 'rev-parse', await promote(w.repo, 'refs/tags/release'))).toBe(w.local)
  })

  test('AN UPPERCASE OBJECT NAME IS A VALID ONE — the over-refusal direction, in the guard', async () => {
    // Measured: `git rev-parse --verify "${UPPER}^{commit}"` succeeds and `${UPPER}..HEAD` is a
    // valid range, so refusing it was an over-refusal — exit 3, DEFERRED, no review — of a
    // legitimate full object name. `diffBaseRef` already lowercases before matching; the
    // wrapper now accepts both cases, which is the same acceptance.
    //
    // The lowercase fixture is why the sweep could not see this: a boundary that only ever
    // supplies one case cannot fail on a case-sensitivity bug.
    const w = await seedWorld()
    const upper = (w.remote as string).toUpperCase()
    expect(upper).not.toBe(w.remote)
    expect(await promote(w.repo, upper)).toBe(upper)
    expect(await git(w.repo, 'rev-parse', upper)).toBe(w.remote)
    // …and the lowercase sibling still passes, so this is not "accept any hex-looking word":
    expect(await promote(w.repo, w.remote)).toBe(w.remote)
    // A 39-hex and a 41-hex string are still SHORTHANDS, refused for their shape.
    for (const bad of [(w.remote as string).slice(0, 39), `${w.remote}a`]) {
      const res = await runBlock(w.repo, bad)
      expect({ bad, ok: res.ok }).toEqual({ bad, ok: false })
    }
  })

  test('THE OTHER FAILURE DIRECTION, audited: what each arm turns away, and its remedy', async () => {
    // Prompted by the remote-only bug: a classifier has two failure directions, and five
    // rounds of sweeping only ever exercised the permissive one. So each refusing arm is
    // asked the same question — **is there a legitimate input it now turns away?** — and the
    // answer is recorded as a test rather than as a claim. Three refuse deliberately, and
    // each names the way through in its own message; the fourth (remote-only) was a bug.
    const w = await seedWorld()
    await git(w.repo, 'update-ref', 'refs/heads/release', w.remote) // branch AND tag: ambiguous
    const cases: Array<{ arg: string; remedy: string }> = [
      // An operator who means the BRANCH when a tag shares its name.
      { arg: 'release', remedy: 'refs/heads/release' },
      // An operator who means the TAG. (Seeded below on a name with no branch.)
      { arg: 'solo-tag', remedy: 'refs/tags/solo-tag' },
      // A SHORT sha — refused on purpose: git prefers a REF of that name over the object, so
      // an abbreviation is a namespace lookup like any other bare word.
      { arg: (w.remote as string).slice(0, 8), remedy: w.remote },
    ]
    await git(w.repo, 'tag', 'solo-tag', w.local)
    for (const { arg, remedy } of cases) {
      const refused = await runBlock(w.repo, arg)
      expect({ arg, ok: refused.ok }).toEqual({ arg, ok: false })
      // THE REMEDY WORKS, which is what makes the refusal a redirection rather than a wall.
      const through = await runBlock(w.repo, remedy)
      expect({ arg, remedy, ok: through.ok, base: through.stdout }).toEqual({
        arg,
        remedy,
        ok: true,
        base: remedy,
      })
    }
  })

  test('THE SHAPE PROPERTY: what reaches git is an object name or begins with refs/', async () => {
    // THE TERMINATING CONDITION, asserted as a property of the VALUE rather than as a list of
    // inputs — which is what makes it exhaustive. A classifier mistake upstream can no longer
    // reach the command, because this is about what git receives.
    const w = await seedWorld()
    await git(w.repo, 'branch', 'solo', w.local)
    await git(w.repo, 'switch', '-q', '-c', 'head-probe', w.remote)
    for (const arg of ['main', 'solo', 'origin/main', 'HEAD~1', 'refs/tags/release', w.remote]) {
      const got = await promote(w.repo, arg)
      const shaped = got.startsWith('refs/') || /^[0-9a-f]{40}$/.test(got)
      expect({ arg, got, shaped }).toEqual({ arg, got, shaped: true })
    }
    // …and the inputs that CANNOT be given that shape are refused rather than passed on.
    //
    // THE SAME ADVERSARIAL VECTOR THE CI GATE USES (`scripts/ci/diff-base-check.test.ts`, "a
    // QUALIFIED ref is not a hit"). The two classifiers cannot share a function — one decides
    // about SOURCE TEXT in JavaScript, the other about a runtime VALUE in bash — so they share
    // the vector instead: a new spelling has to be added in both places, and until it is, one
    // of them fails. Six positions of this defect were all deciders disagreeing about what
    // counts as qualified; #658 tracks reducing that to one definition.
    for (const arg of ['no-such-branch', 'release', 'notrefs/main', 'xrefs/main', 'origin/refs/main']) {
      const res = await runBlock(w.repo, arg)
      expect({ arg, ok: res.ok }).toEqual({ arg, ok: false })
    }
  })

  test('AN UNRESOLVABLE BASE IS REFUSED — an empty diff reads as "no findings"', async () => {
    // THE BEHAVIOURAL DEFECT THIS TEST USED TO ENSHRINE. `'no-such-branch'` was in the
    // verbatim list above, and nothing downstream stopped it: the wrapper runs
    // `set -uo pipefail` — NOT `set -e` — and read its diff as
    // `FULL_DIFF=$(git diff … 2>/dev/null)` with no status check, so a fatal left FULL_DIFF
    // EMPTY and execution continued into codex with nothing to review.
    //
    // **A REVIEW THAT CANNOT SEE APPROVES EVERYTHING.** An empty diff is indistinguishable
    // from a diff with no findings, which is the same shape as a gate whose disk filled up
    // returning empty output with no error: a check that could not run reads exactly like a
    // check that passed, and both fail in the safe-looking direction.
    const w = await seedWorld()
    // FOUR REFUSALS IN TWO CLASSES, and which fires is itself the property. The two about the
    // DIFF — a shorthand that cannot be given the required shape, and a well-shaped value that
    // names nothing — carry `CODEX_REVIEW_EMPTY_DIFF`, because the consequence is an empty diff
    // and the marker is what stops that reading as "no findings". The two about the ARGUMENT's
    // KIND — ambiguous, and tag-only — say what is wrong with the argument instead; they are
    // still exit 3 (DEFERRED), which is the contract a caller acts on.
    for (const arg of ['no-such-branch']) {
      const res = await runBlock(w.repo, arg)
      expect({ arg, ok: res.ok, stdout: res.stdout }).toEqual({ arg, ok: false, stdout: '' })
      expect(res.stderr).toContain('CODEX_REVIEW_EMPTY_DIFF')
    }
    for (const arg of ['release']) {
      const res = await runBlock(w.repo, arg)
      expect({ arg, ok: res.ok, stdout: res.stdout }).toEqual({ arg, ok: false, stdout: '' })
      expect(res.stderr).toContain('a tag is not a base branch')
    }
    for (const arg of ['a'.repeat(40), 'refs/tags/no-such-tag', 'refs/heads/no-such-branch']) {
      const res = await runBlock(w.repo, arg)
      expect({ arg, ok: res.ok, stdout: res.stdout }).toEqual({ arg, ok: false, stdout: '' })
      expect(res.stderr).toContain('does not name a commit')
    }
    // THE COMPLEMENT, so this is not "refuse everything": the resolvable siblings still pass.
    expect(await promote(w.repo, 'main')).toBe('refs/remotes/origin/main')
    await git(w.repo, 'switch', '-q', '-c', 'head-probe', w.remote)
    // RESOLVED to an object name, not kept as text: `HEAD~1` is unambiguous but it is neither
    // a `refs/` path nor an object name, and the shape property admits only those two.
    expect(await promote(w.repo, 'HEAD~1')).toBe(await git(w.repo, 'rev-parse', 'HEAD~1'))
  })

  test('a local branch with NO remote counterpart is QUALIFIED — the fallback, same rigour', async () => {
    // It used to be "kept" — the bare word, which is exactly what a tag of that name would
    // capture later. There is nothing to promote TO, but there is still a ref to NAME.
    const w = await seedWorld()
    await git(w.repo, 'branch', 'solo', w.local)
    expect(await promote(w.repo, 'solo')).toBe('refs/heads/solo')
    expect(await git(w.repo, 'rev-parse', await promote(w.repo, 'solo'))).toBe(w.local)
  })

  test('REMOTE-ONLY — the ordinary CI checkout — promotes, with no local branch at all', async () => {
    // THE FIRST FAILURE IN THE OTHER DIRECTION. Every earlier position of this defect accepted
    // too much; this one REFUSED too much: the promotion arm required `refs/heads/<x>` to
    // resolve as well, so a detached or fresh checkout — which carries
    // `refs/remotes/origin/main` and no local `main`, the ordinary state — fell through the
    // chain, kept the bare name, and was refused by the shape guard. The default standalone
    // review was broken in the most common environment it runs in.
    //
    // A classifier has TWO failure directions and the sweep only ever exercised the permissive
    // one, because the defect that prompted it was permissive.
    const w = await seedWorld()
    await git(w.repo, 'switch', '-q', '--detach', w.remote)
    await git(w.repo, 'branch', '-D', 'main')
    expect(await git(w.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/main')).toBe('')
    expect(await git(w.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(w.remote)

    const got = await promote(w.repo, 'main')
    expect(got).toBe('refs/remotes/origin/main')
    expect(await git(w.repo, 'rev-parse', got)).toBe(w.remote)
    // …and the wrapper's own DEFAULT argument is exactly this input, so the default review in
    // a CI checkout resolves rather than refusing.
    const dflt = await runBlock(w.repo, '')
    expect({ ok: dflt.ok, base: dflt.stdout }).toEqual({ ok: true, base: 'refs/remotes/origin/main' })
    // THE COMPLEMENT, so the arm is not "promote whatever resolves": a TAG of that name with a
    // remote branch beside it is still NOT promoted — the by-kind regression stays fixed.
    await git(w.repo, 'update-ref', 'refs/remotes/origin/release', w.remote)
    const tagged = await runBlock(w.repo, 'release')
    expect({ ok: tagged.ok }).toEqual({ ok: false })
    expect(tagged.stderr).toContain('a tag is not a base branch')
  })

  test('a repository with no remote-tracking refs at all still names the local branch in full', async () => {
    const w = await seedWorld()
    for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/release']) {
      await git(w.repo, 'update-ref', '-d', ref)
    }
    expect(await promote(w.repo, 'main')).toBe('refs/heads/main')
  })

  test('A TAG PLANTED LATER CANNOT CAPTURE THE FALLBACK — the degraded world, measured', async () => {
    // The fallback runs when the environment is already unusual, which is where a stray tag
    // is likeliest. With `refs/heads/solo` qualified, a tag `solo` appearing afterwards
    // changes nothing about what the review diffs against — the bare word would have moved.
    const w = await seedWorld()
    await git(w.repo, 'branch', 'solo', w.local)
    await git(w.repo, 'tag', 'solo-tag-target', w.remote)
    const qualified = await promote(w.repo, 'solo')
    expect(qualified).toBe('refs/heads/solo')
    // git resolves the QUALIFIED name to the branch even with a same-named tag present…
    await git(w.repo, 'update-ref', 'refs/tags/solo', w.remote)
    expect(await git(w.repo, 'rev-parse', qualified)).toBe(w.local)
    // …while the bare word it used to hand back now resolves to the TAG: a different commit.
    expect(await git(w.repo, 'rev-parse', 'solo')).toBe(w.remote)
  })
})
