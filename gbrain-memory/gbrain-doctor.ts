/**
 * @neutronai/gbrain-memory — GBrain auto-upgrade + doctor (HOST-level).
 *
 * WHY THIS EXISTS
 * ---------------
 * `install.sh` self-installs the `gbrain` memory binary (`bun install -g
 * github:garrytan/gbrain`, parity gap #1 / PR #51) so a fresh self-host has REAL
 * knowledge-graph + semantic memory out of the box. But that install is a
 * point-in-time snapshot of an UNPINNED default branch with NO upgrade path and
 * NO health verification — "the binary exists" is all install.sh ever proved.
 * Two failure modes follow: (a) the install silently rots as upstream advances,
 * and (b) a present-but-broken binary (PATH gap, a busted build, a migration the
 * brain can't apply) degrades memory SILENTLY — the runtime latches one
 * `GBrainUnavailableError` and never spawns again (see `memory-store.ts`).
 *
 * This module mirrors Vajra's `cc-update-doctor` (which keeps Claude Code
 * current + verified): a deterministic, NO-LLM check that (1) detects the
 * installed gbrain ref vs latest upstream, (2) re-installs when upstream
 * advanced — idempotent + safe, pinned to the resolved commit for
 * reproducibility, and (3) VERIFIES gbrain actually WORKS afterward — binary on
 * PATH, the binary responds, AND a real memory round-trip (connect → put → read
 * back), not just "binary exists". An upgrade that breaks the round-trip rolls
 * back to the previously-recorded ref, exactly like the CC doctor.
 *
 * HOST-LEVEL, NEVER IN-PROCESS
 * ----------------------------
 * Neutron runs GBrain in **notify** mode INSIDE a running instance and NEVER
 * silently auto-upgrades there — a memory-substrate schema change mid-session is
 * volatile state the owner must gate (see `version-notice.ts`,
 * `gbrain-stdio-client.ts`). So the auto-upgrade lives OUT of the instance
 * process: a scheduled host job (`neutron doctor --upgrade`, wired by
 * `install.sh` as a launchd/systemd timer) drives this on a cadence, the same
 * boundary `cc-update-doctor` runs at. The in-instance notify path is untouched.
 *
 * Pure decision logic (`runDoctor`, `decideUpgrade`) is separated from the real
 * probes/runner so it is exhaustively unit-testable without a live gbrain.
 */

import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { GBrainStdioMcpClient } from './gbrain-stdio-client.ts'
import { GBrainMemoryStore } from './gbrain-memory-store.ts'
import { isGbrainBinaryMissingError } from './memory-store.ts'
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'
import { resolveGbrainCommand, resolveGbrainChildPath } from './resolve-gbrain-command.ts'

/**
 * Canonical upstream source. Matches `install.sh`'s `GBRAIN_REF` default
 * (`github:garrytan/gbrain`) so the doctor re-installs from the same place the
 * installer did. garrytan/gbrain ships NO semver release tags (only an
 * `eval-run-*-baseline` tag), so the reproducible pin is the resolved commit
 * SHA: we install `github:garrytan/gbrain#<sha>` while still auto-advancing when
 * the upstream default branch moves.
 */
export const GBRAIN_REF = 'github:garrytan/gbrain'
/** Plain git URL for `git ls-remote` (the `bun install` `github:` shorthand is not a git remote). */
export const GBRAIN_GIT_URL = 'https://github.com/garrytan/gbrain'

// ── doctor: structured health report ────────────────────────────────────────

export type DoctorCheckName = 'binary_on_path' | 'binary_responds' | 'memory_roundtrip'

export interface DoctorCheck {
  name: DoctorCheckName
  ok: boolean
  /** True when the check could not run because an earlier prerequisite failed. */
  skipped: boolean
  detail: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
}

export interface ProbeResult {
  ok: boolean
  detail: string
}

/**
 * The three "does gbrain actually work" probes, injectable so the orchestration
 * is unit-testable against working / broken gbrain without a live binary.
 */
export interface DoctorProbes {
  /** Is the `gbrain` binary resolvable on PATH? */
  binaryOnPath(): Promise<ProbeResult>
  /** Does the binary execute (e.g. `gbrain --version` exits cleanly)? */
  binaryResponds(): Promise<ProbeResult>
  /** Does a real memory round-trip succeed (connect → put → read back)? */
  memoryRoundtrip(): Promise<ProbeResult>
}

/**
 * Run the doctor probes IN ORDER, short-circuiting: a missing binary can't
 * respond, and a binary that won't respond can't round-trip — those downstream
 * checks are recorded as `skipped` (and therefore `ok: false`) rather than run.
 * The report is `ok` only when every check ran AND passed.
 */
export async function runDoctor(probes: DoctorProbes): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []

  const onPath = await probes.binaryOnPath()
  checks.push({ name: 'binary_on_path', ok: onPath.ok, skipped: false, detail: onPath.detail })
  if (!onPath.ok) {
    checks.push({ name: 'binary_responds', ok: false, skipped: true, detail: 'skipped — binary not on PATH' })
    checks.push({ name: 'memory_roundtrip', ok: false, skipped: true, detail: 'skipped — binary not on PATH' })
    return finalize(checks)
  }

  const responds = await probes.binaryResponds()
  checks.push({ name: 'binary_responds', ok: responds.ok, skipped: false, detail: responds.detail })
  if (!responds.ok) {
    checks.push({ name: 'memory_roundtrip', ok: false, skipped: true, detail: 'skipped — binary did not respond' })
    return finalize(checks)
  }

  const round = await probes.memoryRoundtrip()
  checks.push({ name: 'memory_roundtrip', ok: round.ok, skipped: false, detail: round.detail })
  return finalize(checks)
}

function finalize(checks: DoctorCheck[]): DoctorReport {
  return { ok: checks.every((c) => c.ok), checks }
}

// ── upgrade: idempotent decision ─────────────────────────────────────────────

export interface UpgradeDecision {
  shouldUpgrade: boolean
  reason: string
  /** The currently-recorded installed ref, or null when none is on record. */
  from: string | null
  /** The latest upstream ref to move to. */
  to: string
}

/** First 9 chars of a 40-hex sha; the value verbatim otherwise. */
export function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 9) : ref
}

/**
 * Decide whether to (re-)install. IDEMPOTENT: a recorded ref equal to the
 * latest upstream ref is a no-op (`shouldUpgrade: false`) — running the doctor
 * repeatedly on a cadence never re-installs an up-to-date brain. A `null`
 * recorded ref (first run, or the binary was installed before the doctor
 * existed) installs the latest so the ref is pinned + recorded.
 */
export function decideUpgrade(input: {
  installedRef: string | null
  latestRef: string
  force?: boolean
}): UpgradeDecision {
  const { installedRef, latestRef } = input
  if (input.force === true) {
    return { shouldUpgrade: true, reason: 'forced re-install', from: installedRef, to: latestRef }
  }
  if (installedRef === null) {
    return {
      shouldUpgrade: true,
      reason: `no recorded gbrain ref — pinning latest (${shortRef(latestRef)})`,
      from: null,
      to: latestRef,
    }
  }
  if (installedRef === latestRef) {
    return {
      shouldUpgrade: false,
      reason: `already at latest (${shortRef(latestRef)})`,
      from: installedRef,
      to: latestRef,
    }
  }
  return {
    shouldUpgrade: true,
    reason: `upstream advanced ${shortRef(installedRef)} → ${shortRef(latestRef)}`,
    from: installedRef,
    to: latestRef,
  }
}

// ── persisted state (the recorded ref, mirrors cc-update-doctor's .cc-version) ─

export interface DoctorState {
  /** The gbrain commit SHA this doctor last installed + recorded. */
  installed_ref: string | null
  /** Did the post-install doctor verify the round-trip? */
  verified_ok: boolean
  /** ISO-8601 timestamp of the last check (stamped by the caller). */
  last_check_iso: string | null
}

/**
 * Where the recorded ref lives. Under `NEUTRON_HOME` (the instance data dir
 * install.sh pins) when set, else `$HOME/neutron/data` — the same default
 * neutron-service.sh resolves. Sibling to the per-instance `gbrain/` brain dir.
 */
export function resolveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['NEUTRON_HOME']
  const home =
    typeof explicit === 'string' && explicit.trim().length > 0
      ? explicit.trim()
      : join(env['HOME'] ?? tmpdir(), 'neutron', 'data')
  return join(home, 'gbrain-doctor.json')
}

export async function readDoctorState(path: string): Promise<DoctorState | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DoctorState>
    return {
      installed_ref:
        typeof parsed.installed_ref === 'string' ? parsed.installed_ref : null,
      verified_ok: parsed.verified_ok === true,
      last_check_iso:
        typeof parsed.last_check_iso === 'string' ? parsed.last_check_iso : null,
    }
  } catch {
    // Missing / unreadable / malformed → treat as "no record" (first run).
    return null
  }
}

export async function writeDoctorState(path: string, state: DoctorState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

// ── command runner seam (git ls-remote + bun install) ────────────────────────
// Moved to `./command-runner.ts` (L3, 2026-07) to cut the
// `ensure-brain-init.ts` → `gbrain-doctor.ts` static import edge; imported for
// internal use here and re-exported so existing import specifiers (barrel +
// consumers) stay valid (test-policy §2.2 barrel rule).
import { type CommandResult, type CommandRunner, bunCommandRunner } from './command-runner.ts'
export { type CommandResult, type CommandRunner, bunCommandRunner } from './command-runner.ts'

/**
 * Resolve the latest upstream gbrain commit via `git ls-remote <url> HEAD`.
 * Throws on a non-zero exit or unparseable output so the caller treats "can't
 * reach upstream" as a doctor failure rather than silently skipping the upgrade.
 */
export async function resolveLatestUpstreamRef(
  runner: CommandRunner,
  gitUrl: string = GBRAIN_GIT_URL,
): Promise<string> {
  const res = await runner.run('git', ['ls-remote', gitUrl, 'HEAD'], { timeoutMs: 20_000 })
  if (res.code !== 0) {
    throw new Error(`git ls-remote ${gitUrl} failed (code ${res.code}): ${res.stderr.trim().slice(0, 200)}`)
  }
  const sha = res.stdout.trim().split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`unexpected git ls-remote output: ${res.stdout.trim().slice(0, 120)}`)
  }
  return sha
}

/**
 * The install command for a pinned ref. Default `bun install -g
 * github:garrytan/gbrain#<sha>` — the canonical command from gbrain's README,
 * pinned to the resolved commit for reproducibility. `NEUTRON_GBRAIN_INSTALL_CMD`
 * overrides it entirely (the same test seam install.sh's `ensure_gbrain` uses),
 * routed through `sh -c` so a full command string works.
 */
export function buildInstallCommand(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] } {
  const override = env['NEUTRON_GBRAIN_INSTALL_CMD']
  if (typeof override === 'string' && override.trim().length > 0) {
    return { cmd: 'sh', args: ['-c', override] }
  }
  return { cmd: 'bun', args: ['install', '-g', `${GBRAIN_REF}#${ref}`] }
}

// ── upgrade orchestration ────────────────────────────────────────────────────

export interface UpgradeOptions {
  runner: CommandRunner
  probes: DoctorProbes
  statePath: string
  gitUrl?: string
  env?: NodeJS.ProcessEnv
  /** Force a re-install even when the recorded ref is already latest. */
  force?: boolean
  /** ISO timestamp stamped into the persisted state (injected so the logic stays pure). */
  nowIso?: string
  log?: (msg: string) => void
}

export interface UpgradeResult {
  decision: UpgradeDecision
  /** Did we run the install command? */
  installed: boolean
  /** Install exit-0? null when no install ran. */
  installOk: boolean | null
  /** Post-install (or verify-only) doctor report; null only if upstream was unreachable. */
  doctor: DoctorReport | null
  /** Did a broken upgrade trigger a rollback to the previous ref? */
  rolledBack: boolean
  /** Overall success: gbrain is installed and the round-trip verifies. */
  ok: boolean
  detail: string
}

/**
 * Drive one auto-upgrade cycle: resolve latest → decide (idempotent) → install
 * if advanced → VERIFY via the doctor → roll back a broken upgrade. A no-op
 * decision still runs the doctor so the cadence doubles as a health check (the
 * cc-update-doctor contract: verify every run, not just on a version bump).
 */
export async function runUpgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const env = opts.env ?? process.env
  const log = opts.log ?? (() => {})
  const nowIso = opts.nowIso ?? null

  const prev = await readDoctorState(opts.statePath)
  const installedRef = prev?.installed_ref ?? null

  const latestRef = await resolveLatestUpstreamRef(opts.runner, opts.gitUrl)
  const decision = decideUpgrade({
    installedRef,
    latestRef,
    ...(opts.force === true ? { force: true } : {}),
  })
  log(`decision: ${decision.reason}`)

  // No-op path: verify the existing install still works, refresh the timestamp.
  if (!decision.shouldUpgrade) {
    const doctor = await runDoctor(opts.probes)
    await writeDoctorState(opts.statePath, {
      installed_ref: installedRef,
      verified_ok: doctor.ok,
      last_check_iso: nowIso,
    })
    return {
      decision,
      installed: false,
      installOk: null,
      doctor,
      rolledBack: false,
      ok: doctor.ok,
      detail: doctor.ok
        ? `up to date (${shortRef(latestRef)}) — verified healthy`
        : `up to date (${shortRef(latestRef)}) — but DOCTOR FAILED; gbrain needs attention`,
    }
  }

  // Install the target ref.
  const install = buildInstallCommand(decision.to, env)
  log(`installing gbrain ${shortRef(decision.to)} (${install.cmd} ${install.args.join(' ')})`)
  const installRes = await opts.runner.run(install.cmd, install.args, { timeoutMs: 180_000 })
  if (installRes.code !== 0) {
    // Install failed → keep the old recorded ref untouched (non-destructive).
    return {
      decision,
      installed: true,
      installOk: false,
      doctor: null,
      rolledBack: false,
      ok: false,
      detail: `install failed (code ${installRes.code}): ${installRes.stderr.trim().slice(0, 200)}`,
    }
  }

  // Verify the freshly-installed binary actually works.
  const doctor = await runDoctor(opts.probes)
  if (doctor.ok) {
    await writeDoctorState(opts.statePath, {
      installed_ref: decision.to,
      verified_ok: true,
      last_check_iso: nowIso,
    })
    return {
      decision,
      installed: true,
      installOk: true,
      doctor,
      rolledBack: false,
      ok: true,
      detail: `installed + verified ${shortRef(decision.to)}`,
    }
  }

  // Broken upgrade. Roll back to the previous ref when we have one to return to.
  if (decision.from !== null && decision.from !== decision.to) {
    log(`upgrade to ${shortRef(decision.to)} FAILED verification — rolling back to ${shortRef(decision.from)}`)
    const rollback = buildInstallCommand(decision.from, env)
    const rbRes = await opts.runner.run(rollback.cmd, rollback.args, { timeoutMs: 180_000 })
    const rbDoctor = rbRes.code === 0 ? await runDoctor(opts.probes) : null
    await writeDoctorState(opts.statePath, {
      installed_ref: decision.from,
      verified_ok: rbDoctor?.ok ?? false,
      last_check_iso: nowIso,
    })
    return {
      decision,
      installed: true,
      installOk: true,
      doctor,
      rolledBack: true,
      ok: false,
      detail:
        rbDoctor?.ok === true
          ? `upgrade ${shortRef(decision.to)} broke gbrain — rolled back to ${shortRef(decision.from)} (healthy)`
          : `upgrade ${shortRef(decision.to)} broke gbrain — rollback to ${shortRef(decision.from)} did NOT recover`,
    }
  }

  // No prior ref to roll back to (first install broke). Record the failure.
  await writeDoctorState(opts.statePath, {
    installed_ref: decision.to,
    verified_ok: false,
    last_check_iso: nowIso,
  })
  return {
    decision,
    installed: true,
    installOk: true,
    doctor,
    rolledBack: false,
    ok: false,
    detail: `installed ${shortRef(decision.to)} but DOCTOR FAILED (no prior ref to roll back to)`,
  }
}

// ── real probes ──────────────────────────────────────────────────────────────

/** Bound a promise so a wedged `gbrain serve` connect can't hang the doctor. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Real "does gbrain work" probes. The round-trip uses the PRODUCTION transport
 * (`GBrainStdioMcpClient` → `GBrainMemoryStore`) against an EPHEMERAL throwaway
 * brain (a temp `GBRAIN_HOME`), so it exercises the exact code path the runtime
 * uses without touching the owner's real brain. No embedder is configured, so
 * the round-trip runs on gbrain's keyword + page store offline — `put_page` then
 * the empty-query `list_pages` read-back must surface the sentinel slug.
 */
export function realProbes(env: NodeJS.ProcessEnv = process.env): DoctorProbes {
  const SENTINEL_SLUG = 'neutron-gbrain-doctor-probe'
  return {
    async binaryOnPath() {
      // Use the SAME absolute-path resolver the serve spawn uses (PATH-first,
      // then probe the bun global-bin + system dirs), so the doctor reflects the
      // runtime's real reachability — not just whether the doctor's own PATH
      // happens to resolve gbrain.
      const resolved = resolveGbrainCommand(env)
      return resolved === null
        ? {
            ok: false,
            detail:
              "'gbrain' not found on PATH or in any known install dir " +
              '($BUN_INSTALL/bin, ~/.bun/bin, /usr/local/bin, /opt/homebrew/bin, ~/.local/bin) ' +
              '(install: bun install -g github:garrytan/gbrain)',
          }
        : { ok: true, detail: `resolved (${resolved})` }
    },
    async binaryResponds() {
      const command = resolveGbrainCommand(env)
      if (command === null) {
        return { ok: false, detail: "'gbrain' not resolvable (skipping --version)" }
      }
      try {
        // Spawn the absolute command with a bun-resolvable child PATH so the
        // `#!/usr/bin/env bun` shebang works under a narrow PATH.
        const res = await bunCommandRunner().run(command, ['--version'], {
          timeoutMs: 15_000,
          env: { PATH: resolveGbrainChildPath({ command, env }) },
        })
        if (res.code === 0) {
          return { ok: true, detail: `responds: ${res.stdout.trim().split('\n')[0] ?? 'ok'}` }
        }
        return { ok: false, detail: `gbrain --version exited ${res.code}: ${res.stderr.trim().slice(0, 120)}` }
      } catch (err) {
        return { ok: false, detail: `gbrain --version failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
    async memoryRoundtrip() {
      let dir: string | null = null
      let client: GBrainStdioMcpClient | null = null
      try {
        dir = await mkdtemp(join(tmpdir(), 'neutron-gbrain-doctor-'))
        const command = resolveGbrainCommand(env)
        const childPath = resolveGbrainChildPath({ command, env })
        client = new GBrainStdioMcpClient({
          brainId: 'neutron-doctor-probe',
          source: 'default',
          // Exercise the EXACT runtime spawn shape: absolute command (when
          // resolvable) + a bun-resolvable child PATH, so the round-trip proves
          // the service path works, not just the doctor's own PATH.
          ...(command !== null ? { command } : {}),
          env: { GBRAIN_HOME: dir, PATH: childPath },
          // Mirror production: init the ephemeral brain BEFORE the first `serve`
          // spawn. Without this, `serve` hits an uninitialized brain ("No brain
          // configured") → `MCP error -32000: Connection closed` → the probe
          // falsely reports DEGRADED on a perfectly healthy install (the
          // round-trip is otherwise the SAME `init`→`serve`→`put_page` seal the
          // runtime uses; the canonical real-serve-roundtrip test inits too).
          // Dynamic import avoids the static gbrain-doctor ↔ ensure-brain-init
          // import cycle; keyword+graph (no embedder), same temp GBRAIN_HOME.
          ensureInitialized: async () => {
            const { ensureBrainInitialized } = await import('./ensure-brain-init.ts')
            await ensureBrainInitialized({
              gbrainHome: dir!,
              embedder: null,
              ...(command !== null ? { command } : {}),
              env: { ...env, PATH: childPath },
            })
          },
        })
        const store = new GBrainMemoryStore(client)
        await withTimeout(
          store.add({
            content: '---\nkind: doctor\n---\n\nGBrain doctor round-trip probe.\n',
            metadata: { slug: SENTINEL_SLUG },
          }),
          45_000,
          'gbrain put_page',
        )
        const rows = await withTimeout(store.query({ query: '', limit: 25 }), 20_000, 'gbrain list_pages')
        const found = rows.some((r) => r.id === SENTINEL_SLUG)
        return found
          ? { ok: true, detail: 'connect → put_page → list_pages round-trip OK' }
          : { ok: false, detail: 'round-trip wrote a page but read-back did not surface it' }
      } catch (err) {
        if (isGbrainBinaryMissingError(err)) {
          return { ok: false, detail: 'gbrain binary unavailable (spawn failed)' }
        }
        return { ok: false, detail: `round-trip failed: ${err instanceof Error ? err.message : String(err)}` }
      } finally {
        if (client !== null) await client.close().catch(() => {})
        if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}

// ── human-readable rendering ─────────────────────────────────────────────────

export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const mark = c.skipped ? '–' : c.ok ? '✓' : '✗'
    return `  ${mark} ${c.name}: ${c.detail}`
  })
  const head = report.ok
    ? 'gbrain doctor: HEALTHY — knowledge-graph + semantic memory verified'
    : 'gbrain doctor: DEGRADED — see failing checks below'
  return [head, ...lines].join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//
// `bun run gbrain-memory/gbrain-doctor.ts <check|upgrade> [--json] [--force]`
//   check   — verify gbrain works (binary on PATH, responds, memory round-trip)
//   upgrade — check latest upstream, (re)install if advanced, verify, roll back
//             a broken upgrade. The scheduled cadence wired by install.sh.
// Honors --no-gbrain via NEUTRON_SKIP_GBRAIN=1 (reports skipped, exits 0).

if (import.meta.main) {
  // F3 — standalone CLI entrypoint (async GBrain round-trip). RESIDUAL: covers
  // the body onward; this dual library+entry module's OWN static imports (stable
  // internal modules) are the accepted in-module-install limit (no bootstrap
  // split — it exports doctor helpers). See installProcessSafetyNet doc.
  installProcessSafetyNet()
  const argv = Bun.argv.slice(2)
  const json = argv.includes('--json')
  const force = argv.includes('--force')
  const sub = argv.find((a) => !a.startsWith('-')) ?? 'check'

  const skip = process.env['NEUTRON_SKIP_GBRAIN']
  if (skip === '1' || skip === 'true') {
    const msg = 'gbrain doctor: skipped (NEUTRON_SKIP_GBRAIN / --no-gbrain). Memory runs DEGRADED (entity pages on disk).'
    process.stdout.write(json ? `${JSON.stringify({ ok: true, skipped: true })}\n` : `${msg}\n`)
    process.exit(0)
  }

  const run = async (): Promise<number> => {
    if (sub === 'check') {
      const report = await runDoctor(realProbes())
      process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderDoctorReport(report)}\n`)
      return report.ok ? 0 : 1
    }
    if (sub === 'upgrade') {
      const result = await runUpgrade({
        runner: bunCommandRunner(),
        probes: realProbes(),
        statePath: resolveStatePath(),
        nowIso: new Date().toISOString(),
        ...(force ? { force: true } : {}),
        log: (m) => process.stderr.write(`[gbrain-doctor] ${m}\n`),
      })
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      } else {
        process.stdout.write(`gbrain doctor (upgrade): ${result.detail}\n`)
        if (result.doctor !== null) process.stdout.write(`${renderDoctorReport(result.doctor)}\n`)
      }
      return result.ok ? 0 : 1
    }
    process.stderr.write(`gbrain-doctor: unknown subcommand '${sub}' (expected: check | upgrade)\n`)
    return 2
  }

  run()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`gbrain-doctor: ${err instanceof Error ? err.message : String(err)}\n`)
      // Non-fatal posture: upstream unreachable / transient errors must not wedge
      // the scheduled job. Exit 1 (degraded) so the timer logs it without crashing.
      process.exit(1)
    })
}
