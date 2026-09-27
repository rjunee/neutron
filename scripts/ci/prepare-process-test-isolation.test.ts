import { describe, expect, test } from 'bun:test'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('./prepare-process-test-isolation.sh', import.meta.url))
const profileSource = fileURLToPath(new URL('./process-test-bwrap.apparmor', import.meta.url))
const expectedProfile = `abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
userns,
}`

function fixture(run: (f: {
  dir: string; helper: string; profile: string; log: string
  invoke: (env?: Record<string, string>) => SpawnSyncReturns<string>
}) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-namespace-admission-'))
  const bin = join(dir, 'bin'), log = join(dir, 'calls'), helper = join(dir, 'setup.sh')
  const profile = join(dir, 'process-test-bwrap.apparmor')
  mkdirSync(bin)
  copyFileSync(source, helper)
  copyFileSync(profileSource, profile)
  writeFileSync(log, '')
  // Every privileged/probe command is intercepted. The probe refuses without
  // successful profile admission, so a removed setup cannot report green.
  const executable = (name: string, body: string) => writeFileSync(join(bin, name), '#!/bin/sh\nset -eu\n' + body, { mode: 0o755 })
  executable('dirname', '/usr/bin/dirname "$@"\n')
  executable('sudo', `printf '%s\\n' "$*" >> "$SETUP_LOG"
case "$*" in
  'apt-get update') exit "\${UPDATE_EXIT:-0}" ;;
  'apt-get install --yes bubblewrap apparmor')
    [ "\${INSTALL_EXIT:-0}" = 0 ] || exit "$INSTALL_EXIT"
    /bin/cp "$SETUP_DIR/bwrap" "$SETUP_BIN/bwrap"
    /bin/cp "$SETUP_DIR/parser" "$SETUP_BIN/apparmor_parser" ;;
  *) [ "$1" = apparmor_parser ] || exit 97; shift; exec "$SETUP_BIN/apparmor_parser" "$@" ;;
esac
`)
  writeFileSync(join(dir, 'bwrap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(dir, 'parser'), `#!/bin/sh
set -eu
[ "$1" = --replace ] && [ "$2" = --skip-cache ] || exit 98
[ "\${PARSER_EXIT:-0}" = 0 ] || exit "$PARSER_EXIT"
/usr/bin/cmp "$3" "$EXPECTED_PROFILE" || exit 99
printf admitted > "$SETUP_DIR/admitted"
`, { mode: 0o755 })
  executable('python3', `printf 'probe %s\\n' "$*" >> "$SETUP_LOG"
[ -f "$SETUP_DIR/admitted" ] || exit 3
exit "\${PROBE_EXIT:-0}"
`)
  const env = {
    PATH: bin, SETUP_LOG: log, SETUP_DIR: dir, SETUP_BIN: bin,
    EXPECTED_PROFILE: profileSource, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  }
  try { run({ dir, helper, profile, log, invoke: (extra = {}) => spawnSync('/bin/bash', [helper], { env: { ...env, ...extra }, encoding: 'utf8' }) }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('ephemeral CI namespace admission', () => {
  test('profile admits only the exact bwrap executable', () => {
    const rules = readFileSync(profileSource, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n')
    expect(rules).toBe(expectedProfile)
  })

  test('installs dependencies, loads admission, and probes unchanged isolation without sudo', () => fixture(f => {
    expect(f.invoke().status).toBe(0)
    const provision = `apparmor_parser --replace --skip-cache ${f.profile}\n`
    const probe = `probe -B ${f.dir}/../../trident/process-test-isolation.py -- python3 -B -c pass\n`
    expect(readFileSync(f.log, 'utf8')).toBe(`apt-get update\napt-get install --yes bubblewrap apparmor\n${provision}${probe}`)
    writeFileSync(f.log, '')
    expect(f.invoke().status).toBe(0)
    expect(readFileSync(f.log, 'utf8')).toBe(provision + probe)
  }))

  const rejectedContexts: Record<string, Record<string, string>> = {
    local: { GITHUB_ACTIONS: '' }, selfHosted: { RUNNER_ENVIRONMENT: 'self-hosted' }, otherOS: { RUNNER_OS: 'macOS' },
  }
  for (const [name, env] of Object.entries(rejectedContexts)) test(`refuses ${name} before provisioning`, () => fixture(f => {
    const result = f.invoke(env)
    expect(result.status).toBe(3)
    expect(String(result.stderr)).toContain('requires a GitHub-hosted Linux runner')
    expect(readFileSync(f.log, 'utf8')).toBe('')
  }))

  for (const phase of ['UPDATE', 'INSTALL', 'PARSER', 'PROBE']) test(`${phase} failure remains red`, () => fixture(f => {
    expect(f.invoke({ [`${phase}_EXIT`]: '42' }).status).toBe(42)
    expect(readFileSync(f.log, 'utf8').includes('probe ')).toBe(phase === 'PROBE')
  }))

  test('removing admission fails the dependent probe; the restored helper passes', () => fixture(f => {
    const original = readFileSync(f.helper, 'utf8')
    const line = 'sudo apparmor_parser --replace --skip-cache "$script_dir/process-test-bwrap.apparmor"'
    expect(original).toContain(line)
    writeFileSync(f.helper, original.replace(line, ':'))
    expect(f.invoke().status).toBe(3)
    expect(existsSync(join(f.dir, 'admitted'))).toBe(false)
    writeFileSync(f.helper, original)
    expect(f.invoke().status).toBe(0)
  }))

  test('a changed profile cannot count as successful admission', () => fixture(f => {
    writeFileSync(f.profile, readFileSync(f.profile, 'utf8').replace('  userns,', ''))
    expect(f.invoke().status).toBe(99)
    expect(readFileSync(f.log, 'utf8')).not.toContain('probe ')
  }))
})
