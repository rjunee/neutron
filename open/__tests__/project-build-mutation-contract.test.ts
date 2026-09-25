import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { createMutationProver, spawnGuardCommand, type MutationClaim } from '@neutronai/trident/mutation-prover.ts'
import { validateTrailer } from '@neutronai/trident/gates/result-contract.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { prepareProjectBuild } from '../wiring/project-build.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-worker-contract-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const repo = join(dir, 'code')
  await mkdir(repo)
  const git = async (...args: string[]) => {
    const result = await spawnCapture(['git', '-C', repo, ...args], repo)
    if (!result.ok) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await mkdir(join(repo, 'src'))
  await mkdir(join(repo, 'tests'))
  // Behaviour, not a source-text assertion: the example mutation breaks clamping.
  await writeFile(join(repo, 'src/limit.ts'), 'export const limit = (n: number, max: number) => n > max ? max : n\n')
  await writeFile(join(repo, 'tests/limit.test.ts'),
    "import { test, expect } from 'bun:test'\nimport { limit } from '../src/limit.ts'\ntest('clamps above the maximum', () => expect(limit(7, 3)).toBe(3))\n")
  await writeFile(join(repo, 'tests/other-control.test.ts'),
    "import { test, expect } from 'bun:test'\nimport { limit } from '../src/limit.ts'\ntest('preserves below the maximum', () => expect(limit(2, 3)).toBe(2))\n")
  await git('add', '.')
  await git('commit', '-m', 'test: seed behavioural fixture')
  const head = await git('rev-parse', 'HEAD')
  seedMigratedDb(join(dir, 'db'))
  const db = ProjectDb.open(join(dir, 'db'))
  cleanups.push(() => db.close())
  const store = new TridentRunStore(db)
  const row = await store.create({ slug: 'contract', project_slug: 'project', repo_path: repo, task: 'Implement a bounded limit' })
  await store.update(row.id, { base_sha: head })
  const options = await prepareProjectBuild({ run: store.get(row.id)!, base_branch: 'main', db_path: join(dir, 'db'), max_rounds: 3 }, {
    store, attempts: new TridentAttemptLedger(db), projectDir: dir, projectId: 'contract-project',
    stateRoot: join(dir, 'state'), provider: 'anthropic', providerSource: 'application', env: {}, runHost: spawnCapture,
    spawnProjectSession: async () => { throw new Error('brief preparation must not dispatch a worker') },
    nativeChildAdmission: { complete: async () => 0, admit: async () => { throw new Error('brief preparation must not admit a native child') } },
  }, new AbortController().signal)
  return { options, run: store.get(row.id)!, head }
}

for (const role of ['build', 'fix'] as const) {
  test(`${role} emitted mutation argv example proves behaviour and bare filenames are refused`, async () => {
    const f = await fixture()
    // Consume what the worker receives on disk, not the source schema constant.
    const brief = await readFile(f.options.workers[role].request.brief.path, 'utf8')
    const schemas = brief.split('\n')
      .filter(line => line.startsWith('{"type":"object"'))
      .map(line => JSON.parse(line))
    // The brief also carries the outer snapshot schema; consume the Forge
    // payload schema that actually supplies the mutation-claim example.
    const payloadSchemas = schemas.filter(schema => Object.hasOwn(schema.properties ?? {}, 'mutationClaim'))
    expect(payloadSchemas).toHaveLength(1)
    const schema = payloadSchemas[0]!
    const claim: MutationClaim = schema.properties.mutationClaim.examples[0]
    const payload = { mutationClaim: claim, worktreePath: f.options.production.worktree,
      branch: f.run.branch!, commitSha: f.head, prNumber: null, diffFile: '', testsPassed: true }
    expect(validateTrailer('forge', payload).ok).toBe(true)
    const executed: string[][] = []
    const prover = createMutationProver({ run_host: spawnCapture, run_guard: async (argv, cwd, signal) => {
      executed.push([...argv])
      return spawnGuardCommand(argv, cwd, signal)
    } })
    const evidence = await prover.prove({ run: f.run, head_sha: f.head, claim })
    expect(evidence.proved, evidence.reason).toBe(true)
    expect(evidence.observed!.guard_mutated.exit_code).not.toBe(0)
    expect(evidence.observed!.control_mutated.exit_code).toBe(0)
    expect(evidence.observed!.guard_restored.exit_code).toBe(0)
    expect(executed).toEqual([claim.guard, claim.control, claim.guard])

    for (const field of ['guard', 'control'] as const) {
      executed.length = 0
      const malformed = { ...claim, [field]: [claim[field].at(-1)!] }
      const refused = await prover.prove({ run: f.run, head_sha: f.head, claim: malformed })
      expect(refused.proved).toBe(false)
      expect(executed).toEqual([])
      expect(refused.observed).toBeNull()
      expect(refused.reason).toContain(`claim.${field} program`)
      expect(refused.reason).toContain('not a test runner on the prover allowlist')
    }
  }, 120_000)
}
