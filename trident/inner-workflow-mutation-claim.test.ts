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

import { mutationClaimArtifactPath } from './mutation-claim-artifact.ts'
import { isProseOnlyChange, parseMutationClaim } from './mutation-prover.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

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
/**
 * What a codex BRIDGE would report if it ignored its instruction and invented the
 * field it cannot measure. Structurally valid on purpose — `parseMutationClaim`
 * accepts it (asserted as a control below), so any null the codex route produces
 * for it is the ROUTE discarding it, not the decoder refusing it.
 */
const BRIDGE_FABRICATION = {
  file: 'trident/fabricated.ts',
  find: 'invented by the bridge',
  replace: 'still invented',
  guard: ['bun', 'test', 'trident/fabricated.test.ts'],
  control: ['bun', 'test', 'trident/other.test.ts'],
}

/**
 * Markdown the gate does NOT exempt (`isProseOnlyChange` returns false for each),
 * so a branch whose whole diff is one of these still owes a nomination — and has
 * no legal target unless the brief says these paths are themselves nominable.
 */
const EXECUTABLE_PROSE = ['SPEC.md', 'IMPLEMENTATION_PLAN.md', 'CLAUDE.md', 'AGENTS.md', 'SKILL.md']

/**
 * THE GATE'S OWN RUNNER ALLOWLIST, read out of the production source.
 *
 * `TEST_COMMAND_SHAPES` is module-private, so the alternative is transcribing it
 * here — and a transcription drifts silently. A runner the gate accepts but the
 * contract never names costs a build a whole round (it learns the rule from a
 * post-APPROVE refusal), which is the one-round-per-lesson loop this card exists
 * to end; a runner REMOVED from the gate while the contract still advertises it
 * is worse. Extracting the programs makes either drift red here.
 */
const ALLOWLISTED_RUNNERS = ((): string[] => {
  const src = readFileSync(fileURLToPath(new URL('./mutation-prover.ts', import.meta.url)), 'utf8')
  const from = src.indexOf('const TEST_COMMAND_SHAPES')
  const to = src.indexOf('function isPackageScriptTest(argv')
  return [...src.slice(from, to).matchAll(/program: '([^']+)'/g)].map((m) => String(m[1]))
})()

/**
 * How the contract must SPELL each allowlisted runner: the program NEXT TO its
 * test verb. A bare program name would be satisfied by prose — the brief already
 * contains the words "go" and "make" — so the spelling is what is asserted, and a
 * runner added to the gate has no entry here and reddens rather than passing.
 */
const RUNNER_SPELLING: Record<string, string> = {
  bun: 'bun test',
  node: 'node --test',
  npm: 'npm|pnpm|yarn test',
  pnpm: 'npm|pnpm|yarn test',
  yarn: 'npm|pnpm|yarn test',
  make: 'make test',
  python3: 'python3 -m pytest',
  go: 'go test',
  cargo: 'cargo test',
}

/**
 * The READER'S OWN path derivation, narrowed to a string.
 *
 * The production helper returns null for a branch name it will not hand to git,
 * and `string | null` is not a needle. Throwing rather than defaulting is the
 * point: an empty-string default would make every `toContain` below pass
 * vacuously, which is the exact silent-pass this suite is written against.
 */
function artifactPathFor(branch: string): string {
  const path = mutationClaimArtifactPath(branch)
  if (path === null) throw new Error(`mutationClaimArtifactPath(${branch}) derived no path`)
  return path
}

/** Run the real workflow body; return every captured agent call + its result. */
async function runWorkflow(opts: {
  fixRoundClaim: unknown
  codex?: boolean
  bridgeClaim?: unknown
  /** Drives MEMBER MODE, which the production launcher supplies and this harness never did. */
  member?: { taskId: string; memberBranch: string }
}): Promise<{
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
    // MEMBER MODE REFUSES TO RUN FORGE WITHOUT AN EXECUTION SPEC, so the pinned
    // task has to come back from the planner — and `pinnedUncheckedTaskLine`
    // matches lines of the form "- [ ] <taskId>: ...". Answered BEFORE the
    // head-probe and catch-all branches, which would otherwise return '' and
    // throw before forge:build is ever reached.
    if (label === 'plan:fable' && opts.member !== undefined) {
      const line = `- [ ] ${opts.member.taskId}: pinned member task`
      return {
        implementationPlan: line,
        topTask: line,
        executionSpec: 'do the pinned task',
        complexity: 'mechanical',
        remainingTasks: 0,
      }
    }
    // THE BUILD-COMPLETION HEAD. Without it the run stops `infra-only` at
    // "could not read the head of refs/heads/… after forge:build", returns
    // `verdict: null`, and every assertion below reads a run that never reviewed
    // anything. (`typeof null === 'object'` is why this surfaced as a type error.)
    if (String(label).startsWith('head-probe-round-')) return { head: 'a'.repeat(40) }
    // The codex BRIDGE fills CODEX_FORGE_SCHEMA from the wrapper's trailer; it
    // reports mutationClaim null, which is the whole reason the committed
    // artifact exists. `bridgeClaim` is the ADVERSARIAL case: a bridge that
    // ignores its instruction and fabricates the field anyway.
    const codexBridge = opts.codex === true
      ? { codexStatus: 'connected', trailerComplete: true, wrapperExitCode: 0, preservedWork: false, wrapperErrTail: '' }
      : {}
    if (label === 'forge:build') {
      return opts.codex === true
        ? { ...forgeResult, ...codexBridge, mutationClaim: opts.bridgeClaim === undefined ? null : opts.bridgeClaim }
        : { ...forgeResult, mutationClaim: BUILD_CLAIM }
    }
    if (String(label).startsWith('forge:fix-round-')) {
      return opts.fixRoundClaim === undefined
        ? { ...forgeResult, ...codexBridge }
        : { ...forgeResult, ...codexBridge, mutationClaim: opts.fixRoundClaim }
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
    ...(opts.member === undefined
      ? {}
      : { pinnedTaskId: opts.member.taskId, memberBranch: opts.member.memberBranch }),
    codexHome: null,
    checkpointScript: null,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
    // Pinning the BUILD phase to a cli-transport tier is what routes `forge:*`
    // through `codexBuildPrompt` instead of straight to `agent()` — the route
    // this card is about, and the one the brief has to survive intact.
    ...(opts.codex === true
      ? {
          codexBuildScript: '/harness/trident/codex-build.sh',
          phaseModels: { build: { model: 'gpt' } },
          modelTiers: {
            gpt: { model_id: 'gpt-5-codex', transport: 'cli', env_var: 'CODEX_BUILD_MODEL', group: 'codex' },
          },
        }
      : {}),
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

  test('the BUILD CONTRACT asks for the committed nomination — per-branch path, commit, exactly-once, prose opt-out', async () => {
    const { captured } = await runWorkflow({ fixRoundClaim: undefined })
    const forge = captured.filter((c) => String(c.label).startsWith('forge:'))
    // POSITIVE CONTROLS: build + at least one fix round, so the loop below can
    // never pass on an empty filter or an empty brief.
    expect(forge.length).toBeGreaterThan(1)
    expect(forge.map((c) => c.label)).toContain('forge:build')
    expect(forge.some((c) => String(c.label).startsWith('forge:fix-round-'))).toBe(true)
    // The path the READER derives, from the branch this workflow builds. Computed
    // by the production helper rather than written out, so the two halves of the
    // channel cannot drift apart: change the layout on one side and this reddens.
    const artifactPath = artifactPathFor('trident/test-run')
    expect(artifactPath).toBe('.trident/mutation-claims/trident/test-run.json')
    for (const call of forge) {
      const brief = call.prompt
      expect(brief.length).toBeGreaterThan(0)
      expect(brief).toContain(artifactPath)
      // EVERY clause the gate actually depends on. Deleting any one of them
      // reintroduces a real, observed failure: an uncommitted file is invisible
      // to `git show`; a `find` occurring twice is refused by `validateClaim`;
      // and without the opt-out a docs-only branch nominates a target the gate
      // must reject.
      expect(brief).toContain('COMMIT it with your work')
      expect(brief).toContain('EXACTLY ONCE')
      expect(brief).toContain('do NOT write the file at all')
      // The prose opt-out leads the block: a build that reads the first
      // imperative and stops must not write a .json onto a documentation-only
      // diff, which would destroy its own prose-only exemption. `indexOf`
      // returns -1 for an absent needle and -1 is less than everything, so the
      // ordering assertion is worthless without this presence control.
      expect(brief).toContain('ENTIRE diff is INERT documentation')
      expect(brief.indexOf('ENTIRE diff is INERT documentation')).toBeLessThan(brief.indexOf(artifactPath))
      // ...and the opt-out says INERT for a reason: `isProseOnlyChange` refuses
      // the exemption for harness-driving markdown, so a branch that only edits
      // IMPLEMENTATION_PLAN.md is proof-required and must know those paths are
      // legal targets rather than "documentation" it was told never to nominate.
      for (const executableProse of EXECUTABLE_PROSE) {
        // The production classifier, not a literal: these really are proof-required.
        expect(isProseOnlyChange([executableProse])).toBe(false)
        expect(brief).toContain(executableProse)
      }
      // ...against an inert one, which really does earn the exemption (control).
      expect(isProseOnlyChange(['docs/notes.md'])).toBe(true)
      expect(brief).toContain('they are themselves LEGAL targets')
      // ...and the ONE intersection where that promise would be false is named
      // rather than left to be discovered by a refusal: a path with a `tests/`
      // segment reads as a test file to the gate, so `skills/tests/SKILL.md`
      // has neither an exemption nor a nominable target. Pinned as behaviour in
      // trident/mutation-claim-artifact.test.ts against the real gate.
      expect(brief).toContain('reads as a test file to the gate and is refused')
      // ...and the denylist warning next to it says WHICH names actually forfeit
      // the exemption. It read "a branch NAME carrying a `skills` … path
      // segment", which no ordinary lane name can trip: the artifact path's LAST
      // segment is the branch name plus `.json`, so only a MID-path segment
      // reaches the denylist. Pinned against the production predicate in
      // trident/mutation-claim-artifact.test.ts.
      expect(brief).toContain('ANYWHERE BUT LAST')
      // The ask sits ABOVE the numbered CONTRACT, with the other standing blocks.
      expect(brief.indexOf('\nCONTRACT\n')).toBeGreaterThan(-1)
      expect(brief.indexOf(artifactPath)).toBeLessThan(brief.indexOf('\nCONTRACT\n'))
    }
  })

  test('the contract NAMES the runner shapes the gate allows, the ones it refuses, and the blob cap', async () => {
    const { captured } = await runWorkflow({ fixRoundClaim: undefined })
    const forge = captured.filter((c) => String(c.label).startsWith('forge:'))
    // POSITIVE CONTROLS on both extractions: briefs really were captured, and
    // the allowlist really was read out of the gate. An empty match set would
    // make the loop below pass against any brief at all.
    expect(forge.length).toBeGreaterThan(1)
    expect(ALLOWLISTED_RUNNERS).toContain('bun')
    expect(ALLOWLISTED_RUNNERS.length).toBeGreaterThan(5)
    // ...and a runner the gate does NOT allow, so "named" is not something every
    // word in the brief satisfies.
    expect(ALLOWLISTED_RUNNERS).not.toContain('npx')
    // Every allowlisted program has a documented spelling — a runner added to
    // the gate reddens HERE rather than being discovered by a refused build.
    expect(ALLOWLISTED_RUNNERS.filter((r) => RUNNER_SPELLING[r] === undefined)).toEqual([])

    for (const call of forge) {
      const brief = call.prompt
      for (const runner of ALLOWLISTED_RUNNERS) {
        const spelling = RUNNER_SPELLING[runner] ?? runner
        expect({ label: call.label, runner, named: brief.includes(spelling) }).toEqual({
          label: call.label,
          runner,
          named: true,
        })
      }
      // The rule itself, and one refused shape named BEFORE it costs a round.
      expect(brief).toContain('ALLOWLISTED')
      expect(brief).toContain('npx vitest')
      // The cap that silently nulls an oversized nomination is a number the
      // build can see rather than discover.
      expect(brief).toContain('32 KiB')
    }
  })
})


/**
 * THE CODEX ROUTE — the one the card is about.
 *
 * On this route `forge:*` does NOT go to `agent()` with the brief; it goes to the
 * codex BRIDGE prompt, which carries the brief base64-chunked into a file the
 * wrapper runs. The bridge fills the schema from the wrapper's six-line trailer
 * and reports `mutationClaim: null` — so the ask has to survive INTO the wrapper
 * brief, and the bridge has to be told not to invent the field it cannot measure.
 */
describe('the codex route carries the nomination ask, and never fabricates the field', () => {
  /** The brief travels base64 (a model once deleted a phrase out of a prose
   *  heredoc), so a `toContain` on the raw prompt cannot see it. Decode first. */
  function decodeTransport(prompt: string): string {
    const re = /base64 -d >>? '[^']*' <<'(NEUTRON_CODEX_B64_EOF_P\d+)'\n([\s\S]*?)\n\1/g
    let m: RegExpExecArray | null
    let out = ''
    while ((m = re.exec(prompt)) !== null) {
      out += Buffer.from(String(m[2]).replace(/\n/g, ''), 'base64').toString('utf8')
    }
    return out
  }

  test('the wrapper brief a codex build actually executes contains the nomination block — build AND fix rounds', async () => {
    const { captured } = await runWorkflow({ fixRoundClaim: undefined, codex: true })
    const forge = captured.filter((c) => String(c.label).startsWith('forge:'))
    // POSITIVE CONTROLS: a build AND at least one fix round, so the loop cannot
    // pass on an empty filter — fix rounds go through the same bridge seam
    // (`codexBuildPrompt`) and a round that dropped the ask would leave the gate
    // reading whatever the FIRST round committed.
    expect(forge.map((c) => c.label)).toContain('forge:build')
    expect(forge.some((c) => String(c.label).startsWith('forge:fix-round-'))).toBe(true)

    const artifactPath = artifactPathFor('trident/test-run')
    for (const call of forge) {
      // POSITIVE CONTROL that this really is the codex route and not the Claude
      // one: only the bridge prompt names the wrapper script and its schema.
      expect(call.prompt).toContain('codex-build.sh')
      expect(call.schema?.required).toContain('codexStatus')

      const brief = decodeTransport(call.prompt)
      // POSITIVE CONTROL against an empty decode passing every assertion below.
      expect(brief.length).toBeGreaterThan(0)
      expect(brief).toContain('CONTRACT')

      expect(brief).toContain(artifactPath)
      expect(brief).toContain('COMMIT it with your work')
      expect(brief).toContain('EXACTLY ONCE')
    }
  })

  test('the BRIDGE is told to report mutationClaim null and never to invent one — on every round', async () => {
    const { captured } = await runWorkflow({ fixRoundClaim: undefined, codex: true })
    const forge = captured.filter((c) => String(c.label).startsWith('forge:'))
    expect(forge.some((c) => String(c.label).startsWith('forge:fix-round-'))).toBe(true)
    for (const call of forge) {
      // The bridge cannot see the build's reasoning, and the schema REQUIRES the
      // field — so without this instruction a fabricated object would short-circuit
      // the committed-artifact read at the gate and shadow the real nomination.
      expect(call.prompt).toContain('mutationClaim is ALWAYS null on this route')
      expect(call.prompt).toContain('NEVER fabricate one')
      // ...and the field really is required on this route (positive control).
      expect(call.schema?.required).toContain('mutationClaim')
    }
  })

  test('an ADVERSARIAL bridge that fabricates a nomination is overruled IN CODE — build round', async () => {
    // The instruction the test above asserts is prose aimed at an LLM, and prose
    // is not a guard: `mutationClaim` rides in the `FORGE_SCHEMA` spread as type
    // ['object','null'], so this object is SCHEMA-VALID on the codex route. If it
    // survived, the gate would prefer it over the nomination the build actually
    // COMMITTED and would prove a mutation nobody measured.
    const { result } = await runWorkflow({ fixRoundClaim: undefined, codex: true, bridgeClaim: BRIDGE_FABRICATION })
    expect(parseMutationClaim(result.mutationClaim)).toBeNull()
    // POSITIVE CONTROL — the fabricated object is a perfectly decodable claim, so
    // the null above is the ROUTE discarding it and not a claim the decoder
    // rejected on its own shape.
    expect(parseMutationClaim(BRIDGE_FABRICATION)).toEqual(BRIDGE_FABRICATION)
    // ...and a SECOND control: the very same object handed to the CLAUDE route is
    // carried all the way to the terminal result. The discard is route-specific.
    const claude = await runWorkflow({ fixRoundClaim: BRIDGE_FABRICATION })
    expect(parseMutationClaim(claude.result.mutationClaim)).toEqual(BRIDGE_FABRICATION)
  })

  test('an ADVERSARIAL bridge that fabricates a nomination is overruled IN CODE — fix rounds too', async () => {
    // Fix rounds go through the same `forgeAgent`, and the fix-round assignment
    // (`if (fix && fix.mutationClaim) mutationClaim = fix.mutationClaim`) is a
    // SECOND door onto the same value — a normalisation that covered only round 1
    // would leave it open.
    const { captured, result } = await runWorkflow({ fixRoundClaim: BRIDGE_FABRICATION, codex: true })
    // POSITIVE CONTROL: a fix round really ran, so the null is not an unrun loop.
    expect(captured.some((c) => String(c.label).startsWith('forge:fix-round-'))).toBe(true)
    expect(parseMutationClaim(result.mutationClaim)).toBeNull()
  })

  test('a codex-routed build reports a NULL nomination — the gap the artifact closes', async () => {
    const { result } = await runWorkflow({ fixRoundClaim: undefined, codex: true })
    expect(parseMutationClaim(result.mutationClaim)).toBeNull()
    // Control: the same workflow on the Claude route DOES carry one, so the null
    // above is the route's doing and not an inert harness.
    const claude = await runWorkflow({ fixRoundClaim: undefined })
    expect(parseMutationClaim(claude.result.mutationClaim)).toEqual(BUILD_CLAIM)
  })
})

/**
 * MEMBER MODE, driven through the same production body: `pinnedTaskId` +
 * `memberBranch` are what the launcher threads for a wave member, and until now
 * no test supplied them, so the nomination path was never exercised on the one
 * route where two builds can share a branch. Member mode returns at the `built`
 * checkpoint right after forge:build — there are no fix rounds and no review
 * calls here, so only `plan:fable` and `forge:build` are asserted on.
 */
describe('THE MEMBER SEAM — the nomination path is scoped per wave member', () => {
  test('the production dispatch shape: a member branch already carrying its suffix is used as-is', async () => {
    const { captured, result } = await runWorkflow({
      fixRoundClaim: undefined,
      member: { taskId: 'T1', memberBranch: 'trident/lane--wT1' },
    })
    // POSITIVE CONTROLS: member mode really ran and really briefed the build.
    expect(result.built).toBe(true)
    expect(captured.map((c) => c.label)).toContain('plan:fable')
    const build = captured.find((c) => c.label === 'forge:build')
    expect(build?.prompt.length ?? 0).toBeGreaterThan(0)

    const brief = String(build?.prompt)
    expect(brief).toContain(artifactPathFor('trident/lane--wT1'))
    // The suffix is appended ONLY when it is missing — the production dispatch
    // must not grow a second one.
    expect(brief).not.toContain('lane--wT1--wT1')
  })

  test('a shared lane branch cannot share one nomination file: the suffix is appended per member', async () => {
    const paths: string[] = []
    for (const taskId of ['T7', 'T8']) {
      const { captured, result } = await runWorkflow({
        fixRoundClaim: undefined,
        member: { taskId, memberBranch: 'trident/lane' },
      })
      expect(result.built).toBe(true)
      const brief = String(captured.find((c) => c.label === 'forge:build')?.prompt)
      const expected = `.trident/mutation-claims/trident/lane--w${taskId}.json`
      expect(brief).toContain(expected)
      // The shared-lane path is what a later member would inherit an earlier
      // member's nomination through.
      expect(brief).not.toContain('.trident/mutation-claims/trident/lane.json')
      paths.push(expected)
    }
    // The per-member point — and a positive control against both assertions
    // above matching one constant.
    expect(paths[0]).not.toBe(paths[1])
  })

  test('WRITER AND READER AGREE on the production dispatch, and fail CLOSED when they cannot', async () => {
    // The suffix is a writer-side rule; the READER derives its path from the
    // branch the run reports (`result.branch`, which the orchestrator passes to
    // `readCommittedMutationClaim`). So the two can only agree when the caller
    // already suffixed the member branch — which `waveChildSlug` does — and the
    // divergent case must be a REFUSAL, never a sibling member's nomination.
    const production = await runWorkflow({
      fixRoundClaim: undefined,
      member: { taskId: 'T1', memberBranch: 'trident/lane--wT1' },
    })
    const writerPath = (brief: string): string => {
      const m = /\.trident\/mutation-claims\/\S+?\.json/.exec(brief)
      if (m === null) throw new Error('the brief named no nomination path')
      return m[0]
    }
    const built = (r: typeof production): string =>
      writerPath(String(r.captured.find((c) => c.label === 'forge:build')?.prompt))
    // AGREEMENT: what the build is told to write is exactly what the reader
    // derives from the branch this run reports out.
    expect(built(production)).toBe(artifactPathFor(String(production.result.branch)))

    // DIVERGENCE, on a caller that threaded an UNSUFFIXED member branch: the
    // writer scopes per member, the reader does not — so the reader looks for a
    // file that is not there and the gate refuses. That is the correct failure;
    // the alternative (one shared path) is a later member's gate satisfied by an
    // earlier member's nomination.
    const divergent = await runWorkflow({
      fixRoundClaim: undefined,
      member: { taskId: 'T9', memberBranch: 'trident/lane' },
    })
    expect(built(divergent)).not.toBe(artifactPathFor(String(divergent.result.branch)))
    // POSITIVE CONTROLS: both runs really built, and both really named a path —
    // otherwise the comparison above is two throws or two empty strings.
    expect([production.result.built, divergent.result.built]).toEqual([true, true])
    expect(built(divergent)).toContain('--wT9')
  })
})
