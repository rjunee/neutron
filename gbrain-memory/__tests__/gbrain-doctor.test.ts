/**
 * gbrain-doctor — the host-level auto-upgrade + doctor engine.
 *
 * Covers the two contract guarantees with pure, injected probes/runner (no live
 * gbrain, no network):
 *   1. DOCTOR detects WORKING vs BROKEN gbrain, short-circuiting downstream
 *      checks when a prerequisite fails.
 *   2. AUTO-UPGRADE is IDEMPOTENT (recorded ref == latest → no re-install) and
 *      rolls a broken upgrade BACK to the previously-recorded ref.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runDoctor,
  decideUpgrade,
  runUpgrade,
  shortRef,
  resolveStatePath,
  readDoctorState,
  writeDoctorState,
  resolveLatestUpstreamRef,
  buildInstallCommand,
  type DoctorProbes,
  type ProbeResult,
  type CommandRunner,
  type CommandResult,
} from '../gbrain-doctor.ts'

// ── test doubles ──────────────────────────────────────────────────────────

const okProbe = (detail = 'ok'): (() => Promise<ProbeResult>) => async () => ({ ok: true, detail })
const failProbe = (detail = 'fail'): (() => Promise<ProbeResult>) => async () => ({ ok: false, detail })

function probes(over: Partial<DoctorProbes>): DoctorProbes {
  return {
    binaryOnPath: over.binaryOnPath ?? okProbe('on PATH'),
    binaryResponds: over.binaryResponds ?? okProbe('responds'),
    memoryRoundtrip: over.memoryRoundtrip ?? okProbe('round-trip OK'),
  }
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/** A runner that records calls and returns scripted results per command. */
function scriptedRunner(script: {
  lsRemote?: CommandResult
  install?: (args: string[]) => CommandResult
}): CommandRunner & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = []
  return {
    calls,
    async run(cmd, args) {
      calls.push({ cmd, args })
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return script.lsRemote ?? { code: 0, stdout: `${SHA_B}\tHEAD\n`, stderr: '' }
      }
      // install command (bun install -g … or sh -c …)
      return script.install?.(args) ?? { code: 0, stdout: '', stderr: '' }
    },
  }
}

// ── DOCTOR: working vs broken ───────────────────────────────────────────────

describe('runDoctor — detects working vs broken gbrain', () => {
  test('all probes pass → HEALTHY, every check ran', async () => {
    const report = await runDoctor(probes({}))
    expect(report.ok).toBe(true)
    expect(report.checks.map((c) => c.name)).toEqual([
      'binary_on_path',
      'binary_responds',
      'memory_roundtrip',
    ])
    expect(report.checks.every((c) => c.ok && !c.skipped)).toBe(true)
  })

  test('missing binary → DEGRADED, downstream checks SKIPPED (not run)', async () => {
    let respondsRan = false
    let roundtripRan = false
    const report = await runDoctor(
      probes({
        binaryOnPath: failProbe('not on PATH'),
        binaryResponds: async () => {
          respondsRan = true
          return { ok: true, detail: 'x' }
        },
        memoryRoundtrip: async () => {
          roundtripRan = true
          return { ok: true, detail: 'x' }
        },
      }),
    )
    expect(report.ok).toBe(false)
    expect(respondsRan).toBe(false)
    expect(roundtripRan).toBe(false)
    expect(report.checks.find((c) => c.name === 'binary_responds')?.skipped).toBe(true)
    expect(report.checks.find((c) => c.name === 'memory_roundtrip')?.skipped).toBe(true)
  })

  test('binary present but does not respond → round-trip skipped', async () => {
    const report = await runDoctor(probes({ binaryResponds: failProbe('exited 1') }))
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === 'binary_responds')?.ok).toBe(false)
    expect(report.checks.find((c) => c.name === 'memory_roundtrip')?.skipped).toBe(true)
  })

  test('binary works but round-trip fails (present-but-broken) → DEGRADED', async () => {
    const report = await runDoctor(probes({ memoryRoundtrip: failProbe('read-back empty') }))
    expect(report.ok).toBe(false)
    // The crux: this is the case "binary exists" alone would have missed.
    expect(report.checks.find((c) => c.name === 'memory_roundtrip')?.ok).toBe(false)
    expect(report.checks.find((c) => c.name === 'memory_roundtrip')?.skipped).toBe(false)
  })
})

// ── decideUpgrade: idempotency ──────────────────────────────────────────────

describe('decideUpgrade — idempotent', () => {
  test('recorded ref == latest → no-op (idempotent)', () => {
    const d = decideUpgrade({ installedRef: SHA_A, latestRef: SHA_A })
    expect(d.shouldUpgrade).toBe(false)
    expect(d.reason).toContain('already at latest')
  })

  test('no recorded ref → install latest', () => {
    const d = decideUpgrade({ installedRef: null, latestRef: SHA_A })
    expect(d.shouldUpgrade).toBe(true)
    expect(d.from).toBeNull()
    expect(d.to).toBe(SHA_A)
  })

  test('upstream advanced → upgrade', () => {
    const d = decideUpgrade({ installedRef: SHA_A, latestRef: SHA_B })
    expect(d.shouldUpgrade).toBe(true)
    expect(d.reason).toContain('advanced')
  })

  test('force re-installs even when already latest', () => {
    const d = decideUpgrade({ installedRef: SHA_A, latestRef: SHA_A, force: true })
    expect(d.shouldUpgrade).toBe(true)
    expect(d.reason).toContain('forced')
  })
})

describe('shortRef', () => {
  test('truncates a 40-hex sha to 9 chars', () => {
    expect(shortRef(SHA_A)).toBe('aaaaaaaaa')
  })
  test('leaves non-sha values verbatim', () => {
    expect(shortRef('v1.2.3')).toBe('v1.2.3')
  })
})

// ── resolveLatestUpstreamRef ────────────────────────────────────────────────

describe('resolveLatestUpstreamRef', () => {
  test('parses the sha from git ls-remote HEAD', async () => {
    const r = scriptedRunner({ lsRemote: { code: 0, stdout: `${SHA_B}\tHEAD\n`, stderr: '' } })
    expect(await resolveLatestUpstreamRef(r)).toBe(SHA_B)
  })

  test('throws on non-zero exit (upstream unreachable)', async () => {
    const r = scriptedRunner({ lsRemote: { code: 128, stdout: '', stderr: 'fatal: unable to access' } })
    await expect(resolveLatestUpstreamRef(r)).rejects.toThrow(/ls-remote/)
  })

  test('throws on unparseable output', async () => {
    const r = scriptedRunner({ lsRemote: { code: 0, stdout: 'not-a-sha\n', stderr: '' } })
    await expect(resolveLatestUpstreamRef(r)).rejects.toThrow(/unexpected/)
  })
})

describe('buildInstallCommand', () => {
  test('pins to the resolved commit by default', () => {
    const { cmd, args } = buildInstallCommand(SHA_A, {})
    expect(cmd).toBe('bun')
    expect(args).toEqual(['install', '-g', `github:garrytan/gbrain#${SHA_A}`])
  })

  test('honors the NEUTRON_GBRAIN_INSTALL_CMD test seam', () => {
    const { cmd, args } = buildInstallCommand(SHA_A, { NEUTRON_GBRAIN_INSTALL_CMD: 'echo install' })
    expect(cmd).toBe('sh')
    expect(args).toEqual(['-c', 'echo install'])
  })
})

// ── state file ──────────────────────────────────────────────────────────────

describe('doctor state', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neutron-doctor-state-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('resolveStatePath uses NEUTRON_HOME when set', () => {
    expect(resolveStatePath({ NEUTRON_HOME: '/srv/neutron' })).toBe('/srv/neutron/gbrain-doctor.json')
  })

  test('resolveStatePath falls back to $HOME/neutron/data', () => {
    expect(resolveStatePath({ HOME: '/home/me' })).toBe('/home/me/neutron/data/gbrain-doctor.json')
  })

  test('missing/unreadable state → null', async () => {
    expect(await readDoctorState(join(dir, 'nope.json'))).toBeNull()
  })

  test('write then read round-trips', async () => {
    const p = join(dir, 'gbrain-doctor.json')
    await writeDoctorState(p, { installed_ref: SHA_A, verified_ok: true, last_check_iso: '2026-06-25T00:00:00Z' })
    const got = await readDoctorState(p)
    expect(got).toEqual({ installed_ref: SHA_A, verified_ok: true, last_check_iso: '2026-06-25T00:00:00Z' })
  })
})

// ── runUpgrade: end-to-end orchestration ────────────────────────────────────

describe('runUpgrade', () => {
  let dir: string
  let statePath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neutron-doctor-up-'))
    statePath = join(dir, 'gbrain-doctor.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('idempotent: recorded ref already latest → no install, just verifies', async () => {
    await writeDoctorState(statePath, { installed_ref: SHA_B, verified_ok: true, last_check_iso: null })
    const runner = scriptedRunner({ lsRemote: { code: 0, stdout: `${SHA_B}\tHEAD\n`, stderr: '' } })
    const res = await runUpgrade({
      runner,
      probes: probes({}),
      statePath,
      nowIso: '2026-06-25T01:00:00Z',
    })
    expect(res.decision.shouldUpgrade).toBe(false)
    expect(res.installed).toBe(false)
    expect(res.ok).toBe(true)
    // Only the ls-remote call ran — no install.
    expect(runner.calls.filter((c) => c.cmd !== 'git')).toHaveLength(0)
    const state = await readDoctorState(statePath)
    expect(state?.last_check_iso).toBe('2026-06-25T01:00:00Z')
  })

  test('upstream advanced → installs + verifies + records new ref', async () => {
    await writeDoctorState(statePath, { installed_ref: SHA_A, verified_ok: true, last_check_iso: null })
    const runner = scriptedRunner({
      lsRemote: { code: 0, stdout: `${SHA_B}\tHEAD\n`, stderr: '' },
      install: () => ({ code: 0, stdout: 'installed', stderr: '' }),
    })
    const res = await runUpgrade({ runner, probes: probes({}), statePath })
    expect(res.installed).toBe(true)
    expect(res.installOk).toBe(true)
    expect(res.ok).toBe(true)
    const installCall = runner.calls.find((c) => c.cmd === 'bun')
    expect(installCall?.args).toEqual(['install', '-g', `github:garrytan/gbrain#${SHA_B}`])
    expect((await readDoctorState(statePath))?.installed_ref).toBe(SHA_B)
  })

  test('install failure → keeps old ref, ok=false', async () => {
    await writeDoctorState(statePath, { installed_ref: SHA_A, verified_ok: true, last_check_iso: null })
    const runner = scriptedRunner({
      install: () => ({ code: 1, stdout: '', stderr: 'network error' }),
    })
    const res = await runUpgrade({ runner, probes: probes({}), statePath })
    expect(res.ok).toBe(false)
    expect(res.installOk).toBe(false)
    // Old ref preserved — a failed install must not corrupt the record.
    expect((await readDoctorState(statePath))?.installed_ref).toBe(SHA_A)
  })

  test('broken upgrade → rolls back to previous ref', async () => {
    await writeDoctorState(statePath, { installed_ref: SHA_A, verified_ok: true, last_check_iso: null })
    const installArgsSeen: string[][] = []
    const runner = scriptedRunner({
      install: (args) => {
        installArgsSeen.push(args)
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    // First doctor run (post-upgrade) fails; rollback's doctor run passes.
    let doctorCall = 0
    const flakyProbes = probes({
      memoryRoundtrip: async () => {
        doctorCall += 1
        return doctorCall === 1
          ? { ok: false, detail: 'broken by upgrade' }
          : { ok: true, detail: 'healthy after rollback' }
      },
    })
    const res = await runUpgrade({ runner, probes: flakyProbes, statePath })
    expect(res.rolledBack).toBe(true)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('rolled back')
    // Installed the new ref, then re-installed the old one.
    expect(installArgsSeen[0]).toEqual(['install', '-g', `github:garrytan/gbrain#${SHA_B}`])
    expect(installArgsSeen[1]).toEqual(['install', '-g', `github:garrytan/gbrain#${SHA_A}`])
    // State restored to the known-good ref.
    expect((await readDoctorState(statePath))?.installed_ref).toBe(SHA_A)
  })

  test('first install broken with no prior ref → records failure, no rollback', async () => {
    // No state file → installedRef null → from is null → nothing to roll back to.
    const runner = scriptedRunner({ install: () => ({ code: 0, stdout: '', stderr: '' }) })
    const res = await runUpgrade({
      runner,
      probes: probes({ memoryRoundtrip: failProbe('broken') }),
      statePath,
    })
    expect(res.rolledBack).toBe(false)
    expect(res.ok).toBe(false)
    expect((await readDoctorState(statePath))?.verified_ok).toBe(false)
  })
})
