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

      // WHAT THIS TEST NEEDS TO WAIT FOR, AND WHY NOTHING ELSE WILL DO.
      //
      // The assertion below is `exitCode === 0`, i.e. "SIGTERM ran the gateway's
      // graceful-shutdown handler". Signalling before `process.once('SIGTERM')`
      // has been bound kills the child at the SIGNAL'S DEFAULT DISPOSITION —
      // exit 143 — with the DB never closed. So the ONLY sound precondition is
      // "the handlers are bound". Every cheaper proxy is unsound, because in
      // gateway/index.ts boot() the handler bind is the LAST thing that happens:
      //
      //   ProjectDb.open(dbPath)          creates the DB file
      //   applyMigrationsToProjectDb(db)  writes the _migrations rows
      //   composeProductionGraph(...)     async, slow, unbounded under load
      //   Bun.serve(...)                  the HTTP listener is accepting HERE
      //   sdNotify('READY=1')             systemd is told "ready" HERE
      //   log.info(loopRegistry.bootLine) the boot inventory line is logged HERE
      //   process.once('SIGTERM'|'SIGINT') ← the handlers bind only HERE
      //   log.info('gateway_signal_handlers_ready')  ← so we wait for THIS
      //
      // The previous revision polled `_migrations` for `count > 0` and then
      // slept a fixed 100 ms, under a comment claiming the poll "proves the
      // handler is registered". It proves no such thing, twice over: the poll
      // breaks PART-WAY THROUGH the migration replay (each migration commits in
      // its own transaction, so a non-zero row count means migration k of 124,
      // not 124 of 124 — measured breaking at k=2..60), and the handlers are
      // bound long after the replay finishes anyway. Measured on an IDLE box,
      // the gap between the poll breaking and the handlers binding was
      // 116-683 ms — already wider than the 100 ms sleep meant to cover it, and
      // it widens without bound as the box gets busier. Hence the red CI runs.
      //
      // A longer sleep would be the same bug with a wider window, so wait for
      // the readiness line instead: it is emitted on the same synchronous tick
      // as the binds, with no `await` between, so observing it means the child
      // is genuinely able to handle the signal we are about to send.
      const READY_EVENT = 'event=gateway_signal_handlers_ready'

      // ONE reader per stream for the whole test: the readiness poll and the
      // timeout diagnostic below both read these buffers. Consuming a stream
      // twice (the previous `new Response(proc.stdout)` on the timeout path)
      // would throw on an already-locked stream and mask the real failure.
      let stdoutBuf = ''
      let stderrBuf = ''
      const drain = async (stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void) => {
        const decoder = new TextDecoder()
        for await (const chunk of stream) onChunk(decoder.decode(chunk, { stream: true }))
      }
      const readers = Promise.all([
        drain(proc.stdout as ReadableStream<Uint8Array>, (s) => {
          stdoutBuf += s
        }).catch(() => {}),
        drain(proc.stderr as ReadableStream<Uint8Array>, (s) => {
          stderrBuf += s
        }).catch(() => {}),
      ])

      // Cap at 20 s — inside the outer 30 s budget, with room for the shutdown
      // and DB-reopen assertions that follow.
      const startedAt = Date.now()
      const readyDeadline = startedAt + 20_000
      while (!stdoutBuf.includes(READY_EVENT)) {
        if (proc.exitCode !== null) {
          await readers
          throw new Error(
            `gateway exited with ${proc.exitCode} during boot, before signal handlers were bound.\n` +
              `stderr: ${stderrBuf.slice(0, 4000)}\n` +
              `stdout: ${stdoutBuf.slice(0, 1000)}\n`,
          )
        }
        if (Date.now() >= readyDeadline) {
          throw new Error(
            `gateway did not report signal-handler readiness within 20 s.\n` +
              `dbPath exists: ${existsSync(dbPath) && statSync(dbPath).size > 0}\n` +
              `stderr: ${stderrBuf.slice(0, 4000)}\n` +
              `stdout: ${stdoutBuf.slice(0, 1000)}\n`,
          )
        }
        await Bun.sleep(25)
      }
      // No elapsed-time assertion here on purpose. The loop above IS the
      // assertion: it either observes the readiness line or throws with the
      // child's output. The old `expect(bootMs).toBeGreaterThan(0)` measured
      // wall clock and could not fail for any reason worth catching.

      // Sanity: the migration replay committed before we kill the process.
      // (The exhaustive check is the re-open below — a PARTIAL replay would
      // leave rows for applyMigrations() to apply, failing `applied === []`.)
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
      await readers
      // 143 here is SIGTERM at its default disposition — the handlers were not
      // bound when we signalled, which is exactly what the readiness wait above
      // exists to prevent. Any other non-zero is a genuine shutdown fault, so
      // carry the child's own stderr into the failure message either way.
      expect(exitCode, `gateway stderr:\n${stderrBuf.slice(-2000)}`).toBe(0)

      // …and the DB was actually CLOSED, which the exit code alone does not
      // prove. Verified by mutation: delete the `db.close()` from shutdown()'s
      // drain and every other assertion in this test still passes — the process
      // exits 0, the OS reaps the handle, and SQLite's WAL is replayable enough
      // that the re-open below succeeds. The discriminating signal is the WAL
      // itself: closing the last connection CHECKPOINTS it, so the sidecar is
      // absent or truncated to 0 bytes. Skipping the close leaves the frames
      // behind (measured: 86 KB). Assert on the byte count, not on existence —
      // a clean close on this platform truncates the file rather than unlinking
      // it, so an existence check would pass for the wrong reason.
      const walPath = `${dbPath}-wal`
      const walBytes = existsSync(walPath) ? statSync(walPath).size : 0
      expect(
        walBytes,
        `-wal still holds ${walBytes} uncheckpointed bytes after exit — the gateway ` +
          `exited without closing the DB`,
      ).toBe(0)

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

        // Same defect as the SIGTERM subtest above, in its systemd dialect:
        // this used three fixed sleeps (2 s / 7 s / 1 s) as stand-ins for three
        // conditions systemd will answer directly. `systemd-run` returns as
        // soon as the job is QUEUED, so the unit is `activating` until the
        // gateway's READY=1 lands — on a loaded runner that is well past 2 s,
        // and `is-active` then returns `activating` and the test goes red on
        // work that is fine. Poll the real condition with a generous deadline
        // instead; the fast path stays fast because it exits on first match.
        const waitFor = async (
          what: string,
          deadlineMs: number,
          predicate: () => boolean,
        ): Promise<void> => {
          const until = Date.now() + deadlineMs
          while (!predicate()) {
            if (Date.now() >= until) {
              const journal = spawnSync('systemctl', ['--user', 'status', unitName, '--no-pager'])
              throw new Error(
                `timed out after ${deadlineMs} ms waiting for ${what}\n` +
                  journal.stdout.toString().slice(0, 2000),
              )
            }
            await Bun.sleep(100)
          }
        }
        const isActive = (): boolean =>
          spawnSync('systemctl', ['--user', 'is-active', unitName]).stdout.toString().trim() ===
          'active'
        const mainPid = (): number =>
          Number(
            spawnSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unitName])
              .stdout.toString()
              .trim(),
          )

        // Type=notify: the unit becomes `active` exactly when the gateway sends
        // READY=1, so this waits on the gateway's own readiness, not a guess.
        await waitFor('the unit to report READY=1 (is-active == active)', 20_000, isActive)

        // Capture the PID, kill the process forcibly, then verify systemd
        // brings up a fresh process within RestartSec=5s + slack.
        const oldPid = mainPid()
        expect(oldPid).toBeGreaterThan(0)

        spawnSync('kill', ['-KILL', String(oldPid)])
        // Restart=always + RestartSec=5. Wait for BOTH facts that matter — a
        // different MainPID and an active unit — rather than sleeping past the
        // restart and hoping. A stale-but-active read (systemd has not yet
        // reaped the killed PID) no longer passes as a respawn.
        await waitFor(
          'systemd to respawn the unit with a fresh MainPID',
          25_000,
          () => isActive() && mainPid() > 0 && mainPid() !== oldPid,
        )

        const newPid = mainPid()
        expect(newPid).toBeGreaterThan(0)
        expect(newPid).not.toBe(oldPid)

        // Stop cleanly and verify the DB is re-openable with no corruption.
        // Waiting for the unit to actually leave `active` is what guarantees
        // the gateway finished its shutdown and CLOSED the DB — reading the
        // file while the stop is still draining is what would surface as WAL
        // corruption that isn't really there.
        spawnSync('systemctl', ['--user', 'stop', unitName])
        await waitFor('the unit to stop (is-active != active)', 20_000, () => !isActive())

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
    // The three waits above are bounded at 20 s + 25 s + 20 s. Budget past
    // their sum so a genuine stall fails with the waitFor() message (which
    // carries `systemctl status`) instead of a bare test-timeout that says
    // nothing about which step hung.
    90_000,
  )
})
