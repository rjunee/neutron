import { expect, test } from 'bun:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-shared-host.sh', import.meta.url))
const staleProseGuard = fileURLToPath(new URL('./ci/stale-prose-guard.ts', import.meta.url))

function fixture(gitRepo = true) {
  const scratch = mkdtempSync(join(tmpdir(), 'shared-host-check-test-'))
  const root = join(scratch, 'repo')
  const peer = join(scratch, 'peer')
  const remote = join(scratch, 'remote.git')
  mkdirSync(join(root, 'scripts/ci'), { recursive: true })
  copyFileSync(script, join(root, 'scripts/check-shared-host.sh'))
  copyFileSync(staleProseGuard, join(root, 'scripts/ci/stale-prose-guard.ts'))
  const assertHeld = 'exec 8<"$FIXTURE_COMMON_DIR"\nif flock -n 8; then exit 98; fi\n'
  writeFileSync(join(root, 'scripts/ci/typecheck-all.sh'), assertHeld + 'echo typecheck >> calls\nif [ "${FIXTURE_HOLD:-0}" = 1 ]; then echo ready; read -r release; fi\nexit "${FIXTURE_TYPECHECK_EXIT:-0}"\n')
  writeFileSync(join(root, 'scripts/run-tests.sh'), assertHeld + 'echo suite >> calls\nprintf "%s\\n" "$NEUTRON_TEST_JOBS/${NEUTRON_TEST_CONCURRENCY:-default}/$NEUTRON_TEST_CHUNK_SIZE" >> calls\n[ -z "${NEUTRON_TEST_SHARD:-}${NEUTRON_TEST_PLAN_ONLY:-}${NEUTRON_TEST_ROOT:-}${NEUTRON_TEST_DISCOVER_OVERRIDE:-}${NEUTRON_BUN_BIN:-}" ] || exit 99\nif [ "${FIXTURE_RUN_STALE_PROSE_GUARD:-0}" = 1 ]; then bun scripts/ci/stale-prose-guard.ts || exit "$?"; fi\nexit "${FIXTURE_SUITE_EXIT:-0}"\n')
  if (gitRepo) {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    git('init', '--quiet')
    git('branch', '-M', 'main')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
    execFileSync('git', ['init', '--quiet', '--bare', remote])
    git('remote', 'add', 'origin', remote)
    git('push', '--quiet', '-u', 'origin', 'main')
    execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    git('worktree', 'add', '--quiet', '--detach', peer)
  }
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, FIXTURE_COMMON_DIR: join(root, '.git'), ...extra })
  const run = (extra: Record<string, string> = {}, checkout = root) => spawnSync('bash', [join(checkout, 'scripts/check-shared-host.sh')], { encoding: 'utf8', env: env(extra) })
  return { scratch, root, peer, remote, env, run, calls: (checkout = root) => readFileSync(join(checkout, 'calls'), 'utf8') }
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

test('a missing tracking ref refuses before typecheck and suite', () => {
  const f = fixture()
  try {
    execFileSync('git', ['-C', f.root, 'update-ref', '-d', 'refs/remotes/origin/main'])
    const result = f.run()
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('origin/main is missing')
    expect(() => f.calls()).toThrow()
  } finally { rmSync(f.scratch, { recursive: true, force: true }) }
})

test('a stale tracking ref refuses before typecheck and suite; fetching admits both', () => {
  const f = fixture()
  try {
    const writer = join(f.scratch, 'writer')
    execFileSync('git', ['clone', '--quiet', f.remote, writer])
    writeFileSync(join(writer, 'new.txt'), 'new remote commit\n')
    execFileSync('git', ['-C', writer, 'add', 'new.txt'])
    execFileSync('git', ['-C', writer, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'advance main'])
    execFileSync('git', ['-C', writer, 'push', '--quiet', 'origin', 'main'])
    const refused = f.run()
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('origin/main is stale')
    expect(() => f.calls()).toThrow()
    execFileSync('git', ['-C', f.root, 'fetch', '--quiet', 'origin', 'main'])
    expect(f.run().status).toBe(0)
    expect(f.calls()).toBe('typecheck\nsuite\n4/default/100\n')
  } finally { rmSync(f.scratch, { recursive: true, force: true }) }
})

test('file://localhost origin admits a current base and refuses a stale one', () => {
  const f = fixture()
  try {
    execFileSync('git', ['-C', f.root, 'remote', 'set-url', 'origin', `file://localhost${f.remote}`])
    expect(f.run().status).toBe(0)
    expect(f.calls()).toBe('typecheck\nsuite\n4/default/100\n')
    const writer = join(f.scratch, 'writer')
    execFileSync('git', ['clone', '--quiet', f.remote, writer])
    writeFileSync(join(writer, 'new.txt'), 'upstream moved\n')
    execFileSync('git', ['-C', writer, 'add', 'new.txt'])
    execFileSync('git', ['-C', writer, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'advance main'])
    execFileSync('git', ['-C', writer, 'push', '--quiet', 'origin', 'main'])
    const refused = f.run()
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('origin/main is stale')
    expect(f.calls()).toBe('typecheck\nsuite\n4/default/100\n')
  } finally { rmSync(f.scratch, { recursive: true, force: true }) }
})

test('inherited prose range overrides are cleared before the consuming guard runs', () => {
  const f = fixture()
  try {
    const result = f.run({ STALE_PROSE_BASE_SHA: 'nonexistent-base', STALE_PROSE_HEAD_SHA: 'nonexistent-head', FIXTURE_RUN_STALE_PROSE_GUARD: '1' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('stale-prose-guard: OK')
    expect(f.calls()).toBe('typecheck\nsuite\n4/default/100\n')
  } finally { rmSync(f.scratch, { recursive: true, force: true }) }
})

test('an authoritative base still refuses a branch whose prose diff exceeds the guard reader', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'large.md'), 'x'.repeat(1_100_000) + '\n')
    execFileSync('git', ['-C', f.root, 'add', 'large.md'])
    execFileSync('git', ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'large branch'])
    const result = f.run()
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('beyond its 1 MiB reader limit')
    expect(() => f.calls()).toThrow()
  } finally { rmSync(f.scratch, { recursive: true, force: true }) }
})

test('a local source clone with stale main follows its upstream, then admits a current base', () => {
  const f = fixture()
  try {
    const source = join(f.scratch, 'source')
    const nested = join(f.scratch, 'nested')
    execFileSync('git', ['clone', '--quiet', f.remote, source])
    execFileSync('git', ['clone', '--quiet', source, nested])
    const writer = join(f.scratch, 'writer')
    execFileSync('git', ['clone', '--quiet', f.remote, writer])
    writeFileSync(join(writer, 'new.txt'), 'upstream moved\n')
    execFileSync('git', ['-C', writer, 'add', 'new.txt'])
    execFileSync('git', ['-C', writer, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'advance main'])
    execFileSync('git', ['-C', writer, 'push', '--quiet', 'origin', 'main'])
    execFileSync('git', ['-C', source, 'fetch', '--quiet', 'origin', 'main'])
    // Source main and nested origin/main remain old while source origin/main is fresh.
    const result = spawnSync('bash', [join(nested, 'scripts/check-shared-host.sh')], { encoding: 'utf8', env: f.env({ FIXTURE_COMMON_DIR: join(nested, '.git') }) })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('origin/main is stale')
    expect(() => readFileSync(join(nested, 'calls'), 'utf8')).toThrow()
    execFileSync('git', ['-C', source, 'merge', '--ff-only', 'origin/main'])
    execFileSync('git', ['-C', nested, 'fetch', '--quiet', 'origin', 'main'])
    const admitted = spawnSync('bash', [join(nested, 'scripts/check-shared-host.sh')], { encoding: 'utf8', env: f.env({ FIXTURE_COMMON_DIR: join(nested, '.git') }) })
    expect(admitted.status).toBe(0)
    expect(readFileSync(join(nested, 'calls'), 'utf8')).toBe('typecheck\nsuite\n4/default/100\n')
  } finally { rmSync(f.scratch, { recursive: true, force: true }) }
})
