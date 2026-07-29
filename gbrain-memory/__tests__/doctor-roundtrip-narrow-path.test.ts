/**
 * Real regression guard for the SERVICE-PATH reachability fix (dogfood
 * 2026-06-28): the gbrain doctor's memory round-trip must pass even when the
 * binary is NOT on the (narrow) service PATH — resolved via the absolute-path
 * resolver — AND it must init the ephemeral brain before `serve` (else "No brain
 * configured" → `MCP error -32000: Connection closed`, the exact symptom that
 * made `neutron doctor` falsely report DEGRADED on healthy installs).
 *
 * Drives the REAL `realProbes(env).memoryRoundtrip()` with a deliberately narrow
 * `PATH` (no `~/.bun/bin`), mirroring the launchd/systemd service environment.
 * Gated on the binary being RESOLVABLE (not just `Bun.which` — that's the whole
 * point): a host without gbrain installed skips with a clear reason. Run locally
 * with `bun install -g github:garrytan/gbrain`.
 */

import { describe, test, expect } from 'bun:test'

import { realProbes } from '../gbrain-doctor.ts'
import { resolveGbrainCommand } from '../resolve-gbrain-command.ts'

// A narrow, service-like env: the bun global-bin dir is NOT on PATH, so a bare
// `Bun.which('gbrain')` against THIS PATH would miss — the resolver must probe.
const NARROW_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: process.env['HOME'] ?? '',
  ...(process.env['BUN_INSTALL'] ? { BUN_INSTALL: process.env['BUN_INSTALL'] } : {}),
  ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
}

const RESOLVABLE = resolveGbrainCommand(NARROW_ENV) !== null
const describeReal = RESOLVABLE ? describe : describe.skip

if (!RESOLVABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    '[doctor-roundtrip-narrow-path] SKIPPED — `gbrain` not resolvable in any known ' +
      'install dir. Install with `bun install -g github:garrytan/gbrain` to run this guard.',
  )
}

describeReal('gbrain doctor round-trip — reachable + init`d under a narrow service PATH', () => {
  test('binary_on_path resolves off-PATH and memory_roundtrip passes (no Connection closed)', async () => {
    const probes = realProbes(NARROW_ENV)

    const onPath = await probes.binaryOnPath()
    expect(onPath.ok).toBe(true) // resolved via probe, despite PATH=/usr/bin:/bin

    const responds = await probes.binaryResponds()
    expect(responds.ok).toBe(true) // absolute command + bun-resolvable child PATH

    const round = await probes.memoryRoundtrip()
    // The init guard must make `serve` work; a regression to the un-init'd path
    // surfaces here as `Connection closed`.
    expect(round.detail).not.toContain('Connection closed')
    expect(round.ok).toBe(true)
  }, 90_000)
})
