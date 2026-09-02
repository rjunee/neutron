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
    _prompt: string,
    o?: { label?: string; schema?: Record<string, unknown> },
  ): Promise<unknown> => {
    const label = o?.label
    captured.push({ label, schema: o?.schema })
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
