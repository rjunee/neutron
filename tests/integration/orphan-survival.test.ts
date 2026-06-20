import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const GATEWAY_ENTRY = join(REPO_ROOT, 'gateway', 'index.ts')

// Per-file shared tempdir root. Each test's `ownerDir` is a subdir under
// this root, so a SIGINT/timeout leaks at most ONE top-level dir per file.
// See docs/research/bun-test-parallel-load-flakiness-2026-05-19.md § 4 #3.
const FILE_TMPROOT = mkdtempSync(join(tmpdir(), 'neutron-orphan-root-'))

afterAll(() => {
  rmSync(FILE_TMPROOT, { recursive: true, force: true })
})

// Linux-only piece of the contract (systemd respawn). On non-Linux platforms
// the systemd portion is skipped — documented inline below — but the WAL +
// close-on-SIGTERM portion runs everywhere because that's a standalone
// invariant of the gateway's shutdown path.
const IS_LINUX = process.platform === 'linux'

describe('orphan survival — gateway boot + clean shutdown', () => {
  test('SIGTERM cleanup: gateway closes the per-owner DB cleanly; a fresh process re-opens it without WAL corruption', async () => {
    const ownerDir = mkdtempSync(join(FILE_TMPROOT, 'sigterm-'))
    const dbPath = join(ownerDir, 'owner.db')
    try {
      // `--port=0` requests an OS-assigned ephemeral port so the subprocess
      // does NOT collide with the default 7800 — which a dev-mode gateway
      // (or a previous orphan from a flaky test run) may already hold. Picked
      // this fix over a fixed alternate port because we don't read the bound
      // port from the subprocess; we only assert clean SIGTERM exit + DB
      // re-openability, both of which are port-agnostic.
      const proc = Bun.spawn({
        cmd: ['bun', 'run', GATEWAY_ENTRY, '--port=0'],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          NEUTRON_DB_PATH: dbPath,
          // Explicitly clear NOTIFY_SOCKET so sdNotify is a no-op on macOS dev.
          // Without this, an inherited NOTIFY_SOCKET from the test runner could
          // make the gateway throw on a missing socket path.
          NOTIFY_SOCKET: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // The gateway's boot() path is:
      //   1. mkdirSync(dirname(dbPath))
      //   2. ProjectDb.open(dbPath)         ← creates the file
      //   3. applyMigrations(db.raw())     ← writes _migrations rows
      //   4. composeProductionGraph(...)   ← async, can be slow under load
      //   5. SIGTERM handler installed
      //   6. Bun.serve(...).listen()
      //
      // The previous `Bun.sleep(400)` was a fixed delay sized to step 5; under
      // heavy parent-process load (full `bun test` suite, Argus/Forge/
      // orchestrator sharing the box) bun's cold-start + module-graph init
      // routinely spills past 400 ms and the test fails with SQLITE_CANTOPEN
      // because the DB file did not exist yet. Replace the fixed sleep with a
      // poll that waits for the DB file to materialise AND for _migrations to
      // have at least one row (proves the gateway reached step 3). Cap the
      // wait at 15 s — well inside the outer 30 s test budget — and surface
      // the gateway's captured stderr on timeout so the failure mode is
      // actionable rather than a bare SQLITE_CANTOPEN.
      const dbReadyDeadline = Date.now() + 15_000
      let bootMs = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (existsSync(dbPath) && statSync(dbPath).size > 0) {
          try {
            const probe = new Database(dbPath, { readonly: true })
            try {
              const row = probe
                .query<{ count: number }, []>(
                  "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='_migrations'",
                )
                .get()
              if (row !== null && row.count > 0) {
                const migCount = probe
                  .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM _migrations')
                  .get()
                if (migCount !== null && migCount.count > 0) {
                  bootMs = Date.now() - (dbReadyDeadline - 15_000)
                  break
                }
              }
            } finally {
              probe.close()
            }
          } catch {
            // mid-open from the gateway's writer; back off and retry.
          }
        }
        if (Date.now() >= dbReadyDeadline) {
          const stderr = await new Response(proc.stderr).text()
          const stdout = await new Response(proc.stdout).text()
          throw new Error(
            `gateway boot did not produce a populated _migrations table within 15 s.\n` +
              `dbPath exists: ${existsSync(dbPath)}\n` +
              `stderr: ${stderr.slice(0, 4000)}\n` +
              `stdout: ${stdout.slice(0, 1000)}\n`,
          )
        }
        await Bun.sleep(50)
      }
      expect(bootMs).toBeGreaterThan(0)

      // SIGTERM handler is installed AFTER applyMigrations() returns, so the
      // poll above proves the handler is registered. A small extra wait gives
      // the listener + WS upgrade path time to bind so SIGTERM lands on a
      // fully-booted process (production parity).
      await Bun.sleep(100)

      // Sanity: DB file should exist before we kill the process.
      const verifyAfterBoot = new Database(dbPath, { readonly: true })
      try {
        const row = verifyAfterBoot
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM _migrations')
          .get()
        expect(row?.count).toBeGreaterThan(0)
      } finally {
        verifyAfterBoot.close()
      }

      proc.kill('SIGTERM')
      const exitCode = await proc.exited
      expect(exitCode).toBe(0)

      // Re-open the DB with a fresh ProjectDb. WAL frames written during boot
      // should be checkpointed (or at least replayable) — applying migrations
      // again must succeed and report zero new applies (idempotent path).
      const fresh = ProjectDb.open(dbPath)
      try {
        const result = applyMigrations(fresh.raw())
        expect(result.applied).toEqual([])
        expect(result.skipped.length).toBeGreaterThan(0)

        // FK enforcement should still be on (PRAGMA carries on every connection).
        expect(fresh.pragma('foreign_keys')).toBe(1)
        expect(String(fresh.pragma('journal_mode'))).toBe('wal')
      } finally {
        fresh.close()
      }
    } finally {
      rmSync(ownerDir, { recursive: true, force: true })
    }
  }, 30_000)

  test.skipIf(!IS_LINUX)(
    'systemd respawn: under `systemd-run --user --service-type=notify`, gateway killed with SIGKILL is restarted within RestartSec; fresh process re-opens DB cleanly',
    async () => {
      // This test exercises the full Type=notify + Restart=always + WatchdogSec
      // contract. It runs only when the host has systemd available (Linux);
      // macOS dev / WSL-without-systemd / containerized CI without --privileged
      // skip via test.skipIf above.
      //
      // Re-check the systemd user-manager actually answers — `systemd-run
      // --version` succeeds even on headless Linux / container images / WSL
      // hosts where the binary exists but `systemd --user` isn't running.
      // Without an active user manager + user D-Bus session the subsequent
      // `systemd-run --user ...` invocation would fail with `Failed to
      // connect to bus`, which would surface as a test failure rather than a
      // skip. The probe-of-record is `systemctl --user list-units` because
      // it touches the user manager + D-Bus and exits 0 only when both are
      // up; --version alone touches neither.
      const versionProbe = spawnSync('systemd-run', ['--version'])
      if (versionProbe.status !== 0) {
        console.log(
          'orphan-survival systemd test: skipping — `systemd-run` not on PATH (Linux-without-systemd host)',
        )
        return
      }
      const userProbe = spawnSync('systemctl', ['--user', 'list-units', '--no-pager', '--no-legend'])
      if (userProbe.status !== 0) {
        console.log(
          'orphan-survival systemd test: skipping — `systemctl --user` failed (no user manager / D-Bus session): ' +
            userProbe.stderr.toString().trim().slice(0, 200),
        )
        return
      }

      const ownerDir = mkdtempSync(join(FILE_TMPROOT, 'systemd-'))
      const dbPath = join(ownerDir, 'owner.db')
      const unitName = `test-unit-${process.pid}-${Date.now()}`

      try {
        // Launch under systemd-run with the locked unit shape from
        // `scripts/install/gateway-unit.template`. We use the
        // user manager so the test doesn't need root.
        const launch = spawnSync('systemd-run', [
          '--user',
          `--unit=${unitName}`,
          '--service-type=notify',
          '--property=WatchdogSec=10',
          '--property=Restart=always',
          '--property=RestartSec=5',
          '--property=KillMode=process',
          `--setenv=NEUTRON_DB_PATH=${dbPath}`,
          'bun',
          'run',
          GATEWAY_ENTRY,
          // Same ephemeral-port rationale as the SIGTERM subtest above —
          // a Linux dev / CI runner with a parallel gateway already on
          // 7800 must not collide with this systemd unit. Codex r1 review.
          '--port=0',
        ])
        expect(launch.status).toBe(0)

        // Give the unit time to send READY=1.
        await Bun.sleep(2_000)

        const status = spawnSync('systemctl', ['--user', 'is-active', unitName])
        expect(status.stdout.toString().trim()).toBe('active')

        // Capture the PID, kill the process forcibly, then verify systemd
        // brings up a fresh process within RestartSec=5s + slack.
        const pidProbe = spawnSync('systemctl', [
          '--user',
          'show',
          '-p',
          'MainPID',
          '--value',
          unitName,
        ])
        const oldPid = Number(pidProbe.stdout.toString().trim())
        expect(oldPid).toBeGreaterThan(0)

        spawnSync('kill', ['-KILL', String(oldPid)])
        await Bun.sleep(7_000) // RestartSec=5 + boot slack

        const reactive = spawnSync('systemctl', ['--user', 'is-active', unitName])
        expect(reactive.stdout.toString().trim()).toBe('active')

        const newPidProbe = spawnSync('systemctl', [
          '--user',
          'show',
          '-p',
          'MainPID',
          '--value',
          unitName,
        ])
        const newPid = Number(newPidProbe.stdout.toString().trim())
        expect(newPid).toBeGreaterThan(0)
        expect(newPid).not.toBe(oldPid)

        // Stop cleanly and verify the DB is re-openable with no corruption.
        spawnSync('systemctl', ['--user', 'stop', unitName])
        await Bun.sleep(1_000)

        const fresh = ProjectDb.open(dbPath)
        try {
          expect(applyMigrations(fresh.raw()).applied).toEqual([])
          expect(String(fresh.pragma('journal_mode'))).toBe('wal')
        } finally {
          fresh.close()
        }
      } finally {
        spawnSync('systemctl', ['--user', 'reset-failed', unitName])
        spawnSync('systemctl', ['--user', 'stop', unitName])
        rmSync(ownerDir, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
