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

import { parseMutationClaim } from './mutation-prover.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

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
