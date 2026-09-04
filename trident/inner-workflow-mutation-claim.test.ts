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
 * Markdown the gate does NOT exempt (`isProseOnlyChange` returns false for each),
 * so a branch whose whole diff is one of these still owes a nomination — and has
 * no legal target unless the brief says these paths are themselves nominable.
 */
const EXECUTABLE_PROSE = ['SPEC.md', 'IMPLEMENTATION_PLAN.md', 'CLAUDE.md', 'AGENTS.md', 'SKILL.md']

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
async function runWorkflow(opts: { fixRoundClaim: unknown; codex?: boolean }): Promise<{
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
    // The codex BRIDGE fills CODEX_FORGE_SCHEMA from the wrapper's trailer; it
    // reports mutationClaim null, which is the whole reason the committed
    // artifact exists.
    const codexBridge = opts.codex === true
      ? { codexStatus: 'connected', trailerComplete: true, wrapperExitCode: 0, preservedWork: false, wrapperErrTail: '' }
      : {}
    if (label === 'forge:build') {
      return opts.codex === true
        ? { ...forgeResult, ...codexBridge, mutationClaim: null }
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
      // The ask sits ABOVE the numbered CONTRACT, with the other standing blocks.
      expect(brief.indexOf('\nCONTRACT\n')).toBeGreaterThan(-1)
      expect(brief.indexOf(artifactPath)).toBeLessThan(brief.indexOf('\nCONTRACT\n'))
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

  test('a codex-routed build reports a NULL nomination — the gap the artifact closes', async () => {
    const { result } = await runWorkflow({ fixRoundClaim: undefined, codex: true })
    expect(parseMutationClaim(result.mutationClaim)).toBeNull()
    // Control: the same workflow on the Claude route DOES carry one, so the null
    // above is the route's doing and not an inert harness.
    const claude = await runWorkflow({ fixRoundClaim: undefined })
    expect(parseMutationClaim(claude.result.mutationClaim)).toEqual(BUILD_CLAIM)
  })
})
