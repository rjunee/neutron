import { expect, test } from 'bun:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-shared-host.sh', import.meta.url))

function fixture(gitRepo = true) {
  const scratch = mkdtempSync(join(tmpdir(), 'shared-host-check-test-'))
  const root = join(scratch, 'repo')
  const peer = join(scratch, 'peer')
  mkdirSync(join(root, 'scripts/ci'), { recursive: true })
  copyFileSync(script, join(root, 'scripts/check-shared-host.sh'))
  const assertHeld = 'exec 8<"$FIXTURE_COMMON_DIR"\nif flock -n 8; then exit 98; fi\n'
  writeFileSync(join(root, 'scripts/ci/typecheck-all.sh'), assertHeld + 'echo typecheck >> calls\nif [ "${FIXTURE_HOLD:-0}" = 1 ]; then echo ready; read -r release; fi\nexit "${FIXTURE_TYPECHECK_EXIT:-0}"\n')
  writeFileSync(join(root, 'scripts/run-tests.sh'), assertHeld + 'echo suite >> calls\nprintf "%s\\n" "$NEUTRON_TEST_JOBS/${NEUTRON_TEST_CONCURRENCY:-default}/$NEUTRON_TEST_CHUNK_SIZE" >> calls\n[ -z "${NEUTRON_TEST_SHARD:-}${NEUTRON_TEST_PLAN_ONLY:-}${NEUTRON_TEST_ROOT:-}${NEUTRON_TEST_DISCOVER_OVERRIDE:-}${NEUTRON_BUN_BIN:-}" ] || exit 99\nexit "${FIXTURE_SUITE_EXIT:-0}"\n')
  if (gitRepo) {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    git('init', '--quiet')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
    git('worktree', 'add', '--quiet', '--detach', peer)
  }
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, FIXTURE_COMMON_DIR: join(root, '.git'), ...extra })
  const run = (extra: Record<string, string> = {}, checkout = root) => spawnSync('bash', [join(checkout, 'scripts/check-shared-host.sh')], { encoding: 'utf8', env: env(extra) })
  return { scratch, root, peer, env, run, calls: (checkout = root) => readFileSync(join(checkout, 'calls'), 'utf8') }
}

test('executable runs both unchanged gates with the directory lock held and no subset selectors', () => {
  const f = fixture()
  try {
    const result = f.run({ NEUTRON_TEST_SHARD: '1/8', NEUTRON_TEST_PLAN_ONLY: '1', NEUTRON_TEST_ROOT: '/unused-fixture', NEUTRON_TEST_DISCOVER_OVERRIDE: 'subset', NEUTRON_BUN_BIN: 'fake', NEUTRON_TEST_JOBS: '18' })
    expect(result.status).toBe(0)
    expect(f.calls()).toBe('typecheck\nsuite\n4/default/100\n')
  } finally { rmSync(f.scratch, { recursive: true, force: true }) }
})

test('two real Git worktrees contend through the executable; release admits the second', async () => {
  const f = fixture()
  const holder = spawn('bash', [join(f.root, 'scripts/check-shared-host.sh')], { env: f.env({ FIXTURE_HOLD: '1' }), stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      holder.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) resolve() })
      holder.once('error', reject)
      holder.once('exit', () => reject(new Error('lock holder exited before ready')))
    })
    const refused = f.run({}, f.peer)
    expect(refused.status).toBe(75)
    expect(refused.stderr).toContain('BUSY')
    expect(() => f.calls(f.peer)).toThrow()
    const released = new Promise(resolve => holder.once('exit', resolve))
    holder.stdin.end('release\n')
    expect(await released).toBe(0)
    expect(f.calls()).toBe('typecheck\nsuite\n4/default/100\n')
    expect(f.run({}, f.peer).status).toBe(0)
    expect(f.calls(f.peer)).toBe('typecheck\nsuite\n4/default/100\n')
  } finally {
    holder.kill()
    rmSync(f.scratch, { recursive: true, force: true })
  }
})

test.each(['typecheck', 'suite'])('%s failure remains a failure and releases admission to another worktree', (gate) => {
  const f = fixture()
  try {
    const failed = f.run({ [gate === 'typecheck' ? 'FIXTURE_TYPECHECK_EXIT' : 'FIXTURE_SUITE_EXIT']: '17' })
    expect(failed.status).toBe(17)
    expect(f.calls()).toBe(gate === 'typecheck' ? 'typecheck\n' : 'typecheck\nsuite\n4/default/100\n')
    expect(f.run({}, f.peer).status).toBe(0)
  } finally { rmSync(f.scratch, { recursive: true, force: true }) }
})

test('non-Git executable root is refused before either gate', () => {
  const f = fixture(false)
  try {
    const result = f.run()
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('checks require a Git repository')
    expect(() => f.calls()).toThrow()
  } finally { rmSync(f.scratch, { recursive: true, force: true }) }
})
