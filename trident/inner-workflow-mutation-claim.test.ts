/**
 * THE PRODUCER HALF of the mutation-proof pipeline, executed.
 *
 * `mutation-prover.test.ts` covers the consumer: given a nomination, the prover
 * runs it. Nothing covered the other end — the `mutationClaim` field on
 * `FORGE_SCHEMA` and the fix-round re-nomination in `inner-workflow.mjs` — and
 * that gap is not cosmetic: DELETE the schema field and every non-prose merge is
 * blocked ("the build nominated no mutation") with the whole suite still green.
 * Trident would stop merging anything and no test would say why.
 *
 * The script is not importable (top-level `return`, Workflow-runtime globals), so
 * this uses the same harness as `inner-workflow-assembly.test.ts`: read the
 * source, strip the single `export`, run the body as an AsyncFunction with mocked
 * runtime globals. That gives us the REAL schema object as it is handed to
 * `agent()`, and the REAL terminal result the outer loop harvests.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { classifyMutationTarget, parseMutationClaim } from './mutation-prover.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')
const PROVER_SRC = readFileSync(fileURLToPath(new URL('./mutation-prover.ts', import.meta.url)), 'utf8')

interface Captured {
  label: string | undefined
  schema: Record<string, unknown> | undefined
  prompt: string
}

const BUILD_CLAIM = {
  file: 'trident/limit.ts',
  find: 'n < LIMIT',
  replace: 'true',
  guard: ['bun', 'test', 'trident/limit.test.ts'],
  control: ['bun', 'test', 'trident/other.test.ts'],
}
const FIX_CLAIM = { ...BUILD_CLAIM, find: 'n <= LIMIT', rationale: 'round 2 moved the line' }

/** Run the real workflow body; return every captured agent call + its result. */
async function runWorkflow(opts: { fixRoundClaim: unknown }): Promise<{
  captured: Captured[]
  result: Record<string, unknown>
}> {
  const captured: Captured[] = []
  let synthCount = 0

  const agent = async (
    prompt: string,
    o?: { label?: string; schema?: Record<string, unknown> },
  ): Promise<unknown> => {
    const label = o?.label
    captured.push({ label, schema: o?.schema, prompt })
    const forgeResult = {
      prNumber: null,
      branch: 'trident/test-run',
      diffFile: '/tmp/x.diff',
      worktreePath: '/wt',
      commitSha: 'abc',
      testsPassed: true,
    }
    // THE BUILD-COMPLETION HEAD. Without it the run stops `infra-only` at
    // "could not read the head of refs/heads/… after forge:build", returns
    // `verdict: null`, and every assertion below reads a run that never reviewed
    // anything. (`typeof null === 'object'` is why this surfaced as a type error.)
    if (String(label).startsWith('head-probe-round-')) return { head: 'a'.repeat(40) }
    if (label === 'forge:build') return { ...forgeResult, mutationClaim: BUILD_CLAIM }
    if (String(label).startsWith('forge:fix-round-')) {
      return opts.fixRoundClaim === undefined
        ? forgeResult
        : { ...forgeResult, mutationClaim: opts.fixRoundClaim }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') return { verdict: 'REQUEST_CHANGES', findings: [] }
    if (label === 'argus:synthesis') {
      synthCount += 1
      return { verdict: synthCount === 1 ? 'REQUEST_CHANGES' : 'APPROVE', findings: [] }
    }
    // THE HEAD PROBE MUST ANSWER WITH A REAL OID. The catch-all below returns '',
    // which the workflow reads as "could not read the head of refs/heads/… after
    // forge:build" and stops `infra-only` BEFORE review - so `verdict` comes back
    // null (typeof null === 'object', which is what the string assertion was
    // actually tripping on) and the terminal result this suite exists to inspect is
    // never produced.
    if (String(label).startsWith('head-probe-round-')) return { head: 'a'.repeat(40) }
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> => Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (): void => {}
  const budget = { total: 0, spent: (): number => 0 }
  const args = {
    repoPath: '/repo',
    task: 'build the feature',
    baseBranch: 'main',
    slug: 'test-run',
    maxRounds: 3,
    ralph: false,
    mergeMode: 'local',
    prNumber: null,
    branch: null,
    dbPath: null,
    runId: null,
    resumeCheckpoint: null,
    codexHome: null,
    checkpointScript: null,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
  }

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  const result = (await fn(agent, parallel, phase, log, budget, args)) as Record<string, unknown>
  return { captured, result }
}

describe('inner-workflow.mjs NOMINATES the mutation (and can never report one)', () => {
  test('every BUILD prompt ASKS for the nomination — required-for-merge, legality, and when null is legal', async () => {
    // MEASURED CAUSE of every null claim on this card: the schema had a
    // mutationClaim field and no prompt ever told the build to fill it, so
    // `null` was a schema-valid answer to a question nothing asked. The ask
    // lives in the contract text, so it is the contract text that is pinned.
    const { captured } = await runWorkflow({ fixRoundClaim: undefined })
    const prompts = captured
      .filter((c) => c.label === 'forge:build' || String(c.label).startsWith('forge:fix-round-'))
      .map((c) => c.prompt)
    // POSITIVE CONTROL: the harness drives a build pass AND a fix pass, so an
    // empty extraction must fail here rather than pass the loop vacuously.
    expect(prompts.length).toBeGreaterThan(1)
    for (const p of prompts) {
      expect(p).toContain('MUTATION NOMINATION — REQUIRED, NOT A FORMALITY')
      expect(p).toContain('CANNOT MERGE')
      expect(p).toContain('null ONLY when NO legal target exists')
      expect(p).toContain('mutationClaim (see MUTATION NOMINATION below)')
      expect(p).toContain('a truthy claim from a fix round replaces the standing one')
    }
  })

  test('FORGE_SCHEMA requires a mutationClaim, with every field the prover needs', async () => {
    const { captured } = await runWorkflow({ fixRoundClaim: undefined })
    const forge = captured.filter((c) => String(c.label).startsWith('forge:'))
    expect(forge.length).toBeGreaterThan(1)
    for (const call of forge) {
      const schema = call.schema as
        | { required?: string[]; properties?: Record<string, { required?: string[]; properties?: object }> }
        | undefined
      expect(schema?.required).toContain('mutationClaim')
      const claim = schema?.properties?.mutationClaim
      expect(claim).toBeDefined()
      // Exactly the fields `parseMutationClaim` insists on — if the schema stops
      // asking for one, Forge stops emitting it and every merge blocks.
      for (const field of ['file', 'find', 'replace', 'guard', 'control']) {
        expect(claim?.required).toContain(field)
        expect(Object.keys(claim?.properties ?? {})).toContain(field)
      }
    }
  })

  test('the schema\'s DECLARED-test list is the classifier\'s, suffix for suffix', async () => {
    // THE CONTRADICTION THIS PINS, measured. The schema told Forge never to
    // nominate `a *_test.go/py/rs basename`; `TEST_BASENAME` in the prover
    // deliberately dropped `rs` (cargo has no `_test.rs` convention, and
    // keeping it let a build buy the no-production-file exemption by SUFFIX).
    // So `classifyMutationTarget('src/pricing_test.rs') === 'production'` while
    // the schema forbade naming it — and a Rust diff whose only code file is
    // `src/pricing_test.rs` refuses with "no legal target" while telling Forge
    // the one file it could have named is off limits. An unresolvable refusal
    // loop, from two lists that drifted apart in two files.
    const { captured } = await runWorkflow({ fixRoundClaim: undefined })
    const described = captured
      .filter((c) => String(c.label).startsWith('forge:'))
      .map(
        (c) =>
          (
            c.schema as { properties?: { mutationClaim?: { properties?: { file?: { description?: string } } } } }
          )?.properties?.mutationClaim?.properties?.file?.description ?? '',
      )
    // POSITIVE CONTROL on the extraction itself: the descriptions were really
    // read, and every one of them really does enumerate the suffixes. Without
    // this, a renamed field makes `described` a list of empty strings and every
    // set comparison below passes on nothing.
    expect(described.length).toBeGreaterThan(1)
    for (const d of described) expect(d).toContain('_test.')
    for (const d of described) expect(d).toContain('<ext> is one of')

    // The suffixes the SCHEMA names, in either spelling it has used
    // (`*_test.go/py` and `*_test.go or *_test.py`).
    const schemaSuffixes = new Set(
      described.flatMap((d) => [...d.matchAll(/\*_test\.([a-z]+(?:\/[a-z]+)*)/g)].flatMap((m) => m[1]!.split('/'))),
    )
    // …and the suffixes the CLASSIFIER names, read out of its own regex literal
    // rather than re-typed here, so the two lists can only agree by being the
    // same list.
    const pinned = PROVER_SRC.match(/const TEST_BASENAME = \/.*_test\\\.\(([a-z|]+)\)/)
    expect(pinned).not.toBeNull()
    const proverSuffixes = new Set((pinned![1] as string).split('|'))
    expect([...proverSuffixes].sort()).toEqual(['go', 'py'])
    expect([...schemaSuffixes].sort()).toEqual([...proverSuffixes].sort())

    // AND THE BEHAVIOUR, not just the spelling: every suffix the schema tells
    // Forge not to nominate really is refused by the gate, and no suffix it
    // names is one the gate would have accepted.
    for (const ext of schemaSuffixes) expect([ext, classifyMutationTarget(`src/pricing_test.${ext}`)]).toEqual([ext, 'test'])
    // The suffix that started this: named by NEITHER side now, so a Rust module
    // with a test-shaped name is an ordinary production file the build may
    // nominate — which is the only outcome that leaves such a diff provable.
    expect(classifyMutationTarget('src/pricing_test.rs')).toBe('production')
    expect([...schemaSuffixes]).not.toContain('rs')

    // AND THE DOTTED FAMILY, which had drifted the same way and WIDER. The
    // schema said `*.test.*` / `*.spec.*` — any extension at all — while
    // `TEST_BASENAME` spells out eight and deliberately excludes the hybrids
    // `.cjsx`, `.mjsx`, `.ctsx`, `.mtsx` (no runner collects them, so declaring
    // them a test would sell a diff the no-production-file exemption for a file
    // nothing would ever run). So `classifyMutationTarget('src/payments.test.cjsx')`
    // is `production` — the file a build MUST nominate for such a diff to be
    // provable — while the schema forbade naming it: the identical unresolvable
    // refusal loop as `_test.rs`, one wildcard wide.
    const dotSuffixes = new Set(
      described.flatMap((d) => [...d.matchAll(/<ext> is one of ([a-z/]+)/g)].flatMap((m) => m[1]!.split('/'))),
    )
    // The CLASSIFIER's list, probed off the real function rather than re-typed
    // here, over every extension the two JS/TS families can spell.
    const universe: string[] = []
    for (const prefix of ['', 'c', 'm']) {
      for (const letter of ['j', 't']) for (const x of ['', 'x']) universe.push(`${prefix}${letter}s${x}`)
    }
    universe.push('go', 'py', 'rs', 'coffee', 'vue')
    const declared = universe.filter((ext) => classifyMutationTarget(`src/payments.test.${ext}`) === 'test')
    // POSITIVE CONTROL on the probe: the universe really SPLITS — some
    // extensions declare a test and some do not — so the comparison below can
    // pass neither on an empty answer nor on an all-inclusive one.
    expect(declared.length).toBeGreaterThan(0)
    expect(declared.length).toBeLessThan(universe.length)
    expect([...dotSuffixes].sort()).toEqual([...declared].sort())

    // AND THE BEHAVIOUR, in both spellings the regex covers: every extension the
    // schema forbids really is refused as `.test.` AND as `.spec.`.
    for (const ext of dotSuffixes) {
      expect([ext, classifyMutationTarget(`src/payments.test.${ext}`)]).toEqual([ext, 'test'])
      expect([ext, classifyMutationTarget(`src/payments.spec.${ext}`)]).toEqual([ext, 'test'])
    }
    // The hybrids that started this: named by NEITHER side now, so a diff whose
    // only code file is `src/payments.test.cjsx` has a legal nomination.
    for (const hybrid of ['cjsx', 'mjsx', 'ctsx', 'mtsx']) {
      expect([hybrid, classifyMutationTarget(`src/payments.test.${hybrid}`)]).toEqual([hybrid, 'production'])
      expect([...dotSuffixes]).not.toContain(hybrid)
    }
  })

  test("the schema's GUARD description names both OPAQUE shapes the gate refuses", async () => {
    // THE CONTRADICTION THIS PINS. The gate refuses two guard shapes for EVERY
    // target because the command they really run lives in a file the branch
    // wrote and the argv does not show it: a WRAPPER (`npm run …`, `make …`,
    // whose script body may itself preload the mutated file) and a LOAD HOOK
    // (`--preload=…` and its family, whose file may import it). The schema said
    // neither — it mentioned `npm run test-all` only as an example of
    // whole-suite DISCOVERY — so a build following it literally on a wrapper
    // repo earned a refusal after the entire review had already run, with
    // nothing anywhere telling it what to write instead. Same class of drift as
    // the declared-test list above: two lists in two files that must agree.
    const { captured } = await runWorkflow({ fixRoundClaim: undefined })
    const described = captured
      .filter((c) => String(c.label).startsWith('forge:'))
      .map(
        (c) =>
          (
            c.schema as { properties?: { mutationClaim?: { properties?: { guard?: { description?: string } } } } }
          )?.properties?.mutationClaim?.properties?.guard?.description ?? '',
      )
    // POSITIVE CONTROL on the extraction: the GUARD descriptions were really
    // read. Without it a renamed field makes every assertion below pass on ''.
    expect(described.length).toBeGreaterThan(1)
    for (const d of described) expect(d).toContain('MUST go RED')

    // THE WRAPPERS, read out of the prover's own predicate rather than re-typed,
    // so adding a fifth wrapper there reddens this line until the schema says it.
    const wrappers = PROVER_SRC.match(/function forwardsPositionalsToAScript[^}]*}/)
    expect(wrappers).not.toBeNull()
    const names = [...(wrappers![0] as string).matchAll(/argv\[0\] === '([a-z]+)'/g)].map((m) => m[1] as string)
    expect(names.length).toBeGreaterThan(1)
    for (const d of described) for (const name of names) expect([name, d.includes(name)]).toEqual([name, true])

    // AND THE LOAD HOOKS, read out of the prover's regex the same way, so the
    // schema cannot name three of them and leave the fourth to be discovered by
    // a build that gets refused for writing it.
    const hooks = PROVER_SRC.match(/const LOAD_HOOK_OPTION = \/\^--\(\?:([a-z|-]+)\)\$\//)
    expect(hooks).not.toBeNull()
    const hookNames = (hooks![1] as string).split('|')
    expect(hookNames.length).toBeGreaterThan(1)
    for (const d of described) for (const h of hookNames) expect([h, d.includes(`--${h}`)]).toEqual([h, true])

    // CONTAINMENT, pinned by name: the agreement loop above compares two lists and
    // goes green again if an entry is deleted from BOTH sides, so a two-sided
    // deletion would reopen a closed escape silently. These fifteen must be there.
    for (const name of [
      'preload',
      'require',
      'import',
      'loader',
      'experimental-loader',
      'test-reporter',
      'reporter',
      'reporters',
      'config',
      'experimental-config-file',
      'experimental-default-config-file',
      'env-file',
      'env-file-if-exists',
      'tsconfig-override',
      'conditions',
    ])
      expect([name, hookNames.includes(name)]).toEqual([name, true])

    // THE SPELLINGS THE NAME-LOOPS ABOVE CANNOT SEE, pinned literally. The
    // wrapper loop reads EXECUTABLE names out of the prover, so a description
    // saying only `npm run …` passes it while the prover refuses the bare `npm
    // test` alias too — an unannounced refusal is how this whole family started.
    // The short `-c`/`-r`/`-C` spellings are invisible to the hook loop for the
    // same reason: they are not `--<name>` and only this line requires them —
    // and `-C` is node's alias for `--conditions`, whose value is a NAME, so the
    // prover cannot narrow it the way it narrows the two path-valued letters.
    for (const d of described)
      for (const spelling of ['npm test', '-c…', '-r…', '-C…'])
        expect([spelling, d.includes(spelling)]).toEqual([spelling, true])

    // GO'S ONE-DASH HOOKS, read out of the prover's SECOND regex the same way.
    // The `--`-anchored loop above is blind to them by construction, so without
    // this loop the schema could name every long option and still send a build
    // to write `go test -exec ./wrap.sh ./pkg` and be refused for it.
    const goHooks = PROVER_SRC.match(/const GO_TOOLCHAIN_HOOK_OPTION = \/\^-\(\?:([a-z|]+)\)\$\//)
    expect(goHooks).not.toBeNull()
    const goNames = (goHooks![1] as string).split('|')
    expect(goNames.length).toBeGreaterThan(1)
    for (const d of described) for (const g of goNames) expect([g, d.includes(`-${g}`)]).toEqual([g, true])
    // CONTAINMENT for those three, by name, for the same two-sided-deletion
    // reason the thirteen above are pinned.
    for (const name of ['exec', 'toolexec', 'overlay'])
      expect([name, goNames.includes(name)]).toEqual([name, true])

    // `node --run` IS A WRAPPER AND NO LOOP ABOVE CAN SEE IT: it is refused at
    // the node SHAPE rather than by the wrapper predicate (whose `argv[0]` is
    // `node` under the legal spelling too), so only a literal pin requires the
    // schema to say so — and only a literal pin keeps the prover from quietly
    // re-admitting it.
    for (const d of described) expect(['node --run', d.includes('node --run')]).toEqual(['node --run', true])
    expect(PROVER_SRC).toContain('never --run')

    // …AND PYTHON'S `-m` IS SHADOWABLE BY THE TREE, which no name loop above can
    // ever see: the refusal is not about a name in the argv at all, it is about
    // an ENTRY IN THE REPOSITORY, so only a two-sided literal pin can require
    // the schema to foresee it and the prover to enforce it.
    for (const d of described) {
      expect(['python -m shadow', d.includes('-m resolves the module from the working directory first')]).toEqual([
        'python -m shadow',
        true,
      ])
      expect(['python -m shadow', d.includes('BRANCH-SUPPLIED')]).toEqual(['python -m shadow', true])
    }
    expect(PROVER_SRC).toContain('pythonModuleShadow')
    expect(PROVER_SRC).toContain('-m resolves the module from the working directory first')

    // …AND THE TWO SIBLINGS OF THAT ESCAPE, which are about an entry in the
    // repository for the same reason and are equally unreachable by any name
    // loop: the DEPENDENCY a top-level module file shadows, and the pytest
    // config the tree changes the run with NO FLAG AT ALL. A build that read
    // only the module sentence would nominate a guard that is refused after the
    // whole review had run, so the schema has to foresee both.
    for (const d of described) {
      expect(['python dependency shadow', d.includes('ANY top-level .py/.pyc/.so file is refused')]).toEqual([
        'python dependency shadow',
        true,
      ])
      expect(['pytest config shadow', d.includes('conftest.py')]).toEqual(['pytest config shadow', true])
      expect(['pytest config shadow', d.includes('nothing on the argv')]).toEqual(['pytest config shadow', true])
    }
    expect(PROVER_SRC).toContain('pythonImportShadow')
    expect(PROVER_SRC).toContain('pytestConfigShadow')

    // …AND THE DIRECTORY HALF OF THE SAME ESCAPE, which the branch enforced and
    // then forgot to tell anyone about: `pythonPackageShadow` refuses a top-level
    // directory holding an `__init__`/`__main__` module, and the schema said
    // nothing about it — so the very escape hatch the config sentence offers
    // ("nominate python3 -m unittest, which reads neither") walks a build into a
    // refusal, after the whole review has run, in any repo with a
    // `tests/__init__.py`. Two-sided for the same reason as its siblings: an
    // entry in the REPOSITORY is invisible to every name loop above.
    for (const d of described) {
      expect(['python package shadow', d.includes('REGULAR PACKAGE')]).toEqual(['python package shadow', true])
      expect(['python package shadow', d.includes('tests/__init__.py')]).toEqual(['python package shadow', true])
    }
    expect(PROVER_SRC).toContain('pythonPackageShadow')
    // THE COMPILED SPELLINGS ARE THE ESCAPE ITSELF — a seat forged a full
    // `proved: true` through an `argparse/__init__.pyc` while the marker matched
    // source only, so the suffix class is pinned as a literal here: narrowing it
    // back to `.py` reopens that hole and reddens this line.
    // The ABI-TAGGED spellings are in the class for the same reason: python's
    // own `EXTENSION_SUFFIXES` carries `.abi3.so` and `.cpython-<ver>-<platform>.so`, and
    // the file-half sibling already matched them.
    expect(PROVER_SRC).toContain(
      'const TOP_LEVEL_PACKAGE_MARKER = /^[^/]+\\/(?:__init__|__main__)\\.(?:py|pyc|so|[^/]*\\.so)$/',
    )

    // …AND THE SAME QUESTION ASKED OF BUN, the runner this repository actually
    // uses: a `bunfig.toml` `preload` or a `tsconfig.json` `paths` the BRANCH
    // wrote decides which code every `bun test` loads with nothing on the argv
    // to show for it. The schema must say so, and must say the narrowing too —
    // a build that read only "bunfig is refused" would think a repo shipping one
    // has no bun nomination at all, which is the opposite of what is enforced.
    for (const d of described) {
      expect(['bun config shadow', d.includes('bunfig.toml')]).toEqual(['bun config shadow', true])
      expect(['bun config shadow', d.includes('tsconfig.json')]).toEqual(['bun config shadow', true])
      // THE NARROWING, IN THE WORDS THE GATE NOW ENFORCES. It was "only what
      // your diff writes is refused", and that over-promised in the direction
      // that costs a build its nomination: the arm fired on the FILE being in
      // the diff and the KEY being present at the head, so a dependency bump
      // beside an inherited `exports` map lost `bun test` — the "no legal
      // nomination" defect this card exists to fix. What is compared is the
      // key's VALUE against the merge base, and the schema must say so, because
      // the escape hatch it used to name (land the manifest change on its own
      // COMMIT) does not exist: the diff is the whole range.
      expect(['bun config shadow', d.includes('a map main already carried is fine')]).toEqual([
        'bun config shadow',
        true,
      ])
      expect(['bun config shadow', d.includes('compared against the merge base')]).toEqual([
        'bun config shadow',
        true,
      ])
      // …AND NODE READS THE SAME MAP. Two seats forged `proved: true` under
      // `node --test` with the package.json forgery `bun test` was refusing,
      // because the arm was gated on `argv[0] === 'bun'`.
      expect(['node manifest arm', d.includes('refuses `node --test` too')]).toEqual(['node manifest arm', true])
      // …ALL THREE KEYS ON THAT SIDE. `MANIFEST_HOOK_KEY` is asked of a node
      // nomination too, `main` included, while the sentence named only
      // `imports`/`exports` — enforcement stricter than the contract, which
      // reads to a build as an unexplained refusal. Both existing `main` tests
      // used bun guards, so nothing red when the wording and the list diverged.
      expect(['node manifest arm names main', d.includes('`imports`/`exports`/`main` map refuses `node --test`')]).toEqual([
        'node manifest arm names main',
        true,
      ])
      // THE SPELLINGS AND THE SECOND MAP, pinned literally because two seats
      // forged a full `proved: true` past the first wording of this arm: the
      // defence matched ONE spelling of `preload` while the parser accepts four,
      // and it did not consider package.json at all, though its `imports` map
      // redirects a bare specifier inside a guard file main already carried.
      // A build told only about a bare `preload =` would read the quoted and
      // dotted spellings as permitted, which they are not.
      expect(['bun config spellings', d.includes('test.preload')]).toEqual(['bun config spellings', true])
      expect(['bun config spellings', d.includes('inline table')]).toEqual(['bun config spellings', true])
      expect(['bun package map', d.includes('package.json `imports`/`exports`')]).toEqual(['bun package map', true])
      // …AND THE KEY WITH ITS NAME LEFT IMPLICIT. A seat forged `proved: true`
      // on node v22 through `main`: with no `exports` map present the CJS
      // resolver falls back to it, so a branch-authored `"main"` redirects
      // `require('..')` inside an unrelated guard at the mutated file. A build
      // told only about `imports`/`exports` would write the third one.
      expect(['bun package main key', d.includes('`imports`/`exports`/`main`')]).toEqual([
        'bun package main key',
        true,
      ])
      // …AND WHERE AN INHERITED PRELOAD POINTS. The thirteenth escape of the
      // family walks between both authorship arms: leave main's bunfig alone and
      // rewrite THE FILE ITS PRELOAD NAMES. Nothing on the argv, nothing in the
      // config diff — and the branch's code runs in every bun test process. A
      // build told only "a config YOUR DIFF writes is refused" would read this
      // as permitted, which is exactly how it was forged.
      expect(['inherited preload target', d.includes('when the root bunfig.toml')]).toEqual([
        'inherited preload target',
        true,
      ])
      expect(['inherited preload target', d.includes('names a file THIS BRANCH CHANGES')]).toEqual([
        'inherited preload target',
        true,
      ])
    }
    // Two-sided: the prover must really read the root bunfig whether or not the
    // branch touched it, and really compare the preload's target against the
    // diff, or the two sentences above are promises nothing keeps.
    expect(PROVER_SRC).toContain('export function bunConfigInspected(')
    expect(PROVER_SRC).toContain('export function hookTargetChangedByBranch(')
    expect(PROVER_SRC).toContain("const MANIFEST_HOOK_KEY = ['imports', 'exports', 'main'] as const")
    expect(PROVER_SRC).toContain('bunConfigCandidates')
    expect(PROVER_SRC).toContain('bunConfigLoadHook')
    // Two-sided, like every other entry in this test: the prover must really
    // read the key unanchored and really consider the manifest, or the sentence
    // above is a promise nothing keeps.
    expect(PROVER_SRC).toContain('const TOML_PRELOAD_KEY = ')
    expect(PROVER_SRC).toContain("base === 'package.json'")
    // …and the two halves of the round-22 sentence really exist on the prover
    // side: node is a candidate runner for the manifest, and the refusal is
    // decided by comparing the key's value with the merge base.
    expect(PROVER_SRC).toContain("argv[0] === 'node' ? NODE_LOAD_CONFIG_BASENAME")
    expect(PROVER_SRC).toContain('bunConfigHookSlice')
    expect(PROVER_SRC).toContain("'merge-base', baseRef, headSha")

    // …AND `node <script> --test <unrelated>` IS THE SAME WRAPPER WITHOUT THE
    // OPTION, invisible to every loop above for the same reason. Node forwards a
    // `--test` written after an entry script straight to that BRANCH-AUTHORED
    // script, so the shape requires the LEADING spelling — and a build told only
    // "not --run" would write the other one and be refused after the whole review
    // had run. The schema must say where `--test` goes, and the prover must
    // really require it.
    for (const d of described)
      expect(['--test first', d.includes('`--test` must be the FIRST argument after `node`')]).toEqual([
        '--test first',
        true,
      ])
    expect(PROVER_SRC).toContain("ok: (a) => a[1] === '--test' && !a.some(isNodeRunOption)")

    // …and both refusals really exist on the prover side, in the words its
    // reasons use, so this test fails if either shape is quietly re-allowed.
    expect(PROVER_SRC).toContain('whose script body the branch wrote')
    expect(PROVER_SRC).toContain('whose body the branch wrote')
  })

  test("the schema's CONTROL description says what the prover really enforces of it", async () => {
    // THE ASYMMETRY THIS CLOSES. The schema described `control` as nothing but
    // "argv that MUST stay GREEN under the mutation", while `validateClaim`
    // holds it to the guard's whole rulebook — a test-invocation shape, no
    // general shell, worktree-relative arguments, and DISTINCT from the guard.
    // So a schema-compliant `["sh","-c","echo ok"]` earned a refusal after the
    // entire review had run, with nothing anywhere saying what to write instead.
    const { captured } = await runWorkflow({ fixRoundClaim: undefined })
    const described = captured
      .filter((c) => String(c.label).startsWith('forge:'))
      .map(
        (c) =>
          (
            c.schema as { properties?: { mutationClaim?: { properties?: { control?: { description?: string } } } } }
          )?.properties?.mutationClaim?.properties?.control?.description ?? '',
      )
    // POSITIVE CONTROL on the extraction: a renamed field would otherwise make
    // every assertion below pass on ''.
    expect(described.length).toBeGreaterThan(1)
    for (const d of described) expect(d).toContain('MUST stay GREEN')

    for (const d of described) {
      expect(['a real test invocation', d.includes('REAL test invocation')]).toEqual(['a real test invocation', true])
      expect(['distinct from the guard', d.includes('DISTINCT from the guard')]).toEqual([
        'distinct from the guard',
        true,
      ])
      expect(['no general shell', d.includes('sh -c')]).toEqual(['no general shell', true])
      // A WRAPPER IS A LEGAL CONTROL, and the schema said the opposite ("no
      // wrapper"), which over-constrained the build against an enforcement that
      // deliberately keeps `npm run …`/`make …` runnable as the GREEN half. A
      // schema stricter than the gate costs nominations for nothing.
      expect(['a wrapper is a legal control', d.includes('LEGAL CONTROL')]).toEqual([
        'a wrapper is a legal control',
        true,
      ])
      expect(['a wrapper is not a legal guard', d.includes('refused as a GUARD')]).toEqual([
        'a wrapper is not a legal guard',
        true,
      ])
      // …AND THE LIMIT ON THAT PERMISSION. The sentence above used to end "a
      // control merely has to stay green", which a seat read as licence and
      // then forged a full `proved: true` out of: a control is branch-authored
      // code running BETWEEN the guard's red and its green, and one whose module
      // body rewrote the guard's own test file made the restored guard green
      // with nothing having tested the target. A build told only "a wrapper is
      // a legal control" would write exactly that shape.
      expect(['the control is not unobserved', d.includes('status --porcelain --ignored')]).toEqual([
        'the control is not unobserved',
        true,
      ])
      expect(d).not.toContain('merely has to stay green')
    }
    // Two-sided: the fence really exists on the prover side, in the argv it
    // spends and the words its refusal uses, so the sentence cannot drift into
    // a promise the gate does not keep.
    expect(PROVER_SRC).toContain("'status', '--porcelain', '--ignored'")
    expect(PROVER_SRC).toContain('no longer matches')
    // Two-sided: the prover really refuses the wrapper for the GUARD only, so
    // the sentence above cannot drift into a permission the gate does not give.
    expect(PROVER_SRC).toContain('function guardRunsTheMutatedFile(')
    expect(PROVER_SRC).toContain('whose script body the branch wrote')
    // …and each of those is really enforced on the prover side, so a two-sided
    // deletion cannot quietly re-admit the shape.
    expect(PROVER_SRC).toContain("validateArgv(claim.control, 'control')")
    expect(PROVER_SRC).toContain('one command cannot be both the RED and the GREEN')
  })

  test('NO Forge schema has a field for a mutation RESULT — only for a nomination', async () => {
    // The structural invariant: an agent that could report "mutation verified" is
    // an agent that can fabricate it. There must be nowhere on the wire to say it.
    const { captured, result } = await runWorkflow({ fixRoundClaim: undefined })
    const banned = /^(mutationProof|mutationEvidence|mutationVerified|mutationResult|proved|proofToken)$/
    for (const call of captured) {
      const props = Object.keys((call.schema?.properties as Record<string, unknown>) ?? {})
      expect(props.filter((p) => banned.test(p))).toEqual([])
    }
    expect(Object.keys(result).filter((k) => banned.test(k))).toEqual([])
  })

  test("the terminal result carries the nomination, and the prover's decoder accepts it", async () => {
    const { result } = await runWorkflow({ fixRoundClaim: undefined })
    expect(typeof result.verdict).toBe('string')
    // END TO END across the seam: the producer's field name and shape are the
    // ones the outer loop's decoder reads. A rename on either side reddens here.
    expect(parseMutationClaim(result.mutationClaim)).toEqual(BUILD_CLAIM)
  })

  test('the LAST round that edited the code owns the nomination', async () => {
    // A fix round can move or delete the line round 1 nominated, and proving a
    // mutation against a line that no longer exists is not a proof.
    const { result } = await runWorkflow({ fixRoundClaim: FIX_CLAIM })
    expect(parseMutationClaim(result.mutationClaim)).toEqual(FIX_CLAIM)
  })

  test('a fix round that nominates nothing leaves the previous nomination standing', async () => {
    const { result } = await runWorkflow({ fixRoundClaim: undefined })
    expect(parseMutationClaim(result.mutationClaim)).toEqual(BUILD_CLAIM)
  })
})
