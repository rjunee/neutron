import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const GATEWAY_ENTRY = join(REPO_ROOT, 'gateway', 'index.ts')

/**
 * How many rows a COMPLETED `applyMigrations()` leaves in `_migrations` on a
 * fresh DB — one per migration file, which is the runner's contract.
 *
 * Derived from disk rather than hardcoded so adding a migration never means
 * editing this test (#407). #407 used it as the READINESS gate; readiness is
 * now the signal-handler marker, which is emitted strictly later, so this
 * serves as the post-boot ASSERTION that the replay finished — the strong form
 * of the `> 0` sanity check it replaces.
 */
const MIGRATION_FILE_COUNT = readdirSync(join(REPO_ROOT, 'migrations')).filter((f) =>
  f.endsWith('.sql'),
).length

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

// Probed ONCE, at module scope, so an unavailable systemd registers a real
// `skip` in the reporter. Probing inside the test body and returning early
// counts the test as PASSED without running a line of its body — a silent green
// on exactly the guards this file exists to hold.
//
// `systemd-run --version` succeeds even on headless Linux / container images /
// WSL hosts where the binary exists but `systemd --user` isn't running, so the
// probe-of-record is `systemctl --user list-units`: it touches the user manager
// AND the D-Bus session and exits 0 only when both are up. Short-circuits on
// non-Linux so no spawn happens there at all.
const SYSTEMD_USER_AVAILABLE = ((): boolean => {
  if (!IS_LINUX) return false
  if (spawnSync('systemd-run', ['--version']).status !== 0) return false
  return spawnSync('systemctl', ['--user', 'list-units', '--no-pager', '--no-legend']).status === 0
})()

describe('orphan survival — gateway boot + clean shutdown', () => {
  test('SIGTERM cleanup: gateway closes the per-owner DB cleanly; a fresh process re-opens it without WAL corruption', async () => {
    const ownerDir = mkdtempSync(join(FILE_TMPROOT, 'sigterm-'))
    const dbPath = join(ownerDir, 'owner.db')
    // Declared outside the try so the finally can reap the child on EVERY exit
    // path. The readiness wait below throws on timeout, and without this the
    // spawned gateway survives the test — a live server, its watchdog interval,
    // and two stream readers all holding a data dir we are about to delete.
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | null = null
    try {
      // `--port=0` requests an OS-assigned ephemeral port so the subprocess
      // does NOT collide with the default 7800 — which a dev-mode gateway
      // (or a previous orphan from a flaky test run) may already hold. Picked
      // this fix over a fixed alternate port because we don't read the bound
      // port from the subprocess; we only assert clean SIGTERM exit + DB
      // re-openability, both of which are port-agnostic.
      proc = Bun.spawn({
        cmd: ['bun', 'run', GATEWAY_ENTRY, '--port=0'],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          NEUTRON_DB_PATH: dbPath,
          // Explicitly clear NOTIFY_SOCKET so sdNotify is a no-op on macOS dev.
          // Without this, an inherited NOTIFY_SOCKET from the test runner could
          // make the gateway throw on a missing socket path.
          NOTIFY_SOCKET: '',
          // PINNED, not inherited: the readiness marker we poll for below is a
          // log.info, and the logger drops anything above the resolved level
          // (logger/index.ts, emit()). Inheriting a runner that exports
          // NEUTRON_LOG_LEVEL=warn or error would suppress the line and make
          // this test time out deterministically — a probe that cannot observe
          // the positive it is looking for. Same pinning as
          // gateway/__tests__/app-devices-surface.test.ts.
          NEUTRON_LOG_LEVEL: 'info',
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
      // "the handlers are bound", and in gateway/index.ts boot() that bind is
      // the last thing that happens:
      //
      //   ProjectDb.open(dbPath)          creates the DB file
      //   applyMigrationsToProjectDb(db)  writes the _migrations rows
      //   composeProductionGraph(...)     async, slow, unbounded under load
      //   Bun.serve(...)                  the HTTP listener is accepting HERE
      //   log.info(loopRegistry.bootLine) the boot inventory line is logged HERE
      //   process.once('SIGTERM'|'SIGINT') ← the handlers bind only HERE
      //   sdNotify('READY=1')             systemd is told "ready" HERE
      //   log.info('gateway_signal_handlers_ready')  ← so we wait for THIS
      //
      // Note where READY=1 sits: this PR moved it BELOW the binds, because
      // `Type=notify` lets systemd queue a stop job the moment it lands. That is
      // what makes the sibling systemd subtest's `is-active` wait sound. It is
      // no use to US, though — NOTIFY_SOCKET is cleared above, so sdNotify is a
      // no-op here and the log line is the only observable marker.
      //
      // TWO REVISIONS PRECEDE THIS ONE; NEITHER WAITED FOR THE BIND.
      //
      // The revision that reddened #406 and #407 polled `_migrations` for
      // `count > 0` and then slept a fixed 100 ms, under a comment claiming the
      // poll "proved the handler is registered". It proved no such thing, twice
      // over: each migration commits in its own transaction, so a non-zero row
      // count means migration k of N, not N of N (measured breaking at
      // k=2..60), and the handlers bind long after the replay finishes anyway.
      // Measured on an idle box, the gap between that poll breaking and the
      // handlers binding was 116-683 ms — already wider than the 100 ms sleep
      // meant to cover it, and it widens without bound as the box gets busier.
      //
      // #407 then landed the revision now on the base branch: poll until
      // `_migrations` holds every file on disk, wait for the `[loop-registry]`
      // composition line, then sleep 50 ms. That is a real improvement — the
      // composition line is direct evidence the slow async step finished — but
      // the remaining 50 ms is still a guess covering the statements between
      // that log and the binds, so the race is narrowed rather than removed.
      //
      // A sleep of any length is the same bug with a different window, so wait
      // for the readiness line instead: it is emitted on the same synchronous
      // tick as the binds, with no `await` between, so observing it means the
      // child is genuinely able to handle the signal we are about to send. It
      // is emitted strictly later than both of #407's conditions, so waiting on
      // it subsumes them and the sleep goes away.
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
      // BOUNDED await of those readers. They resolve on pipe EOF, and EOF needs
      // every holder of the write end closed — a gateway descendant that
      // inherited the fds and outlived its parent would hold them open and hang
      // this test with no diagnostic at all, which is a worse failure than the
      // one being fixed. 2 s is far past the drain of a few KB of boot logs, and
      // settling early costs at most a truncated tail in a failure message.
      const drained = (): Promise<unknown> => Promise.race([readers, Bun.sleep(2_000)])

      // Cap at 20 s, inside a 45 s outer budget. The outer budget must exceed
      // this cap by more than the work that FOLLOWS it (shutdown drain, then
      // ProjectDb.open + a full migration replay on the reopen) — otherwise a
      // 19 s readiness leaves the test to die on the runner's bare timeout,
      // which reports nothing, instead of on the diagnostic throw below, which
      // carries the child's stderr. Same reasoning as the sibling systemd
      // subtest's 90 s budget over its 20+25+20 s of waits.
      const startedAt = Date.now()
      const readyDeadline = startedAt + 20_000
      while (!stdoutBuf.includes(READY_EVENT)) {
        if (proc.exitCode !== null) {
          await drained()
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

      // The migration replay committed IN FULL before we kill the process —
      // every file on disk, not merely a non-empty table. Asserting the exact
      // count (rather than `> 0`) is #407's contribution, kept: it is what makes
      // a partial replay a named failure here instead of a confusing
      // `applied !== []` on the re-open below.
      const verifyAfterBoot = new Database(dbPath, { readonly: true })
      try {
        const row = verifyAfterBoot
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM _migrations')
          .get()
        expect(
          row?.count,
          `_migrations holds ${row?.count} of ${MIGRATION_FILE_COUNT} migrations on disk`,
        ).toBe(MIGRATION_FILE_COUNT)
      } finally {
        verifyAfterBoot.close()
      }

      // The `-wal` assertion after the exit is only meaningful if a sidecar
      // existed to be checkpointed. Establish that here, while the gateway still
      // holds the connection open, so a future change that stopped using WAL
      // could not silently turn that assertion into a tautology.
      const walPath = `${dbPath}-wal`
      expect(
        existsSync(walPath),
        'no -wal sidecar while the gateway is live — the post-exit checkpoint ' +
          'assertion below would hold vacuously',
      ).toBe(true)

      proc.kill('SIGTERM')
      const exitCode = await proc.exited
      await drained()
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
      // behind (measured: 152472 bytes). Take care mutating this to re-check it:
      // `db.close()` has six call sites in gateway/index.ts and five are error
      // paths a healthy boot never reaches, so a text-matched edit lands on one
      // of those, changes nothing, and the resulting green reads as "this
      // assertion is vacuous" rather than "the mutation was a no-op".
      // Assert on the byte count, not on existence —
      // a clean close on this platform truncates the file rather than unlinking
      // it, so an existence check would pass for the wrong reason. (That the
      // sidecar existed at all is established above, before the signal.)
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
      // SIGKILL, not SIGTERM: every path that reaches here with a live child is
      // one where the handlers may never have bound, and SIGTERM to an unbound
      // child is precisely the condition under test. Await the exit so the dir
      // removal below can't race a process still writing to it. No-op on the
      // success path, where `await proc.exited` already ran.
      if (proc !== null && proc.exitCode === null) {
        proc.kill('SIGKILL')
        await proc.exited
      }
      rmSync(ownerDir, { recursive: true, force: true })
    }
  }, 45_000)

  test.skipIf(!SYSTEMD_USER_AVAILABLE)(
    // The name deliberately does NOT say "within RestartSec". RestartSec=5 is a
    // MINIMUM delay systemd waits before retrying, not a deadline it promises to
    // meet; the respawn also has to cold-start bun and replay every migration.
    // The wait below is bounded at 25 s for that reason, and a name claiming a
    // 5 s bound would be asserting something this test does not check.
    'systemd respawn: under `systemd-run --user --service-type=notify`, gateway killed with SIGKILL is respawned by Restart=always with a fresh MainPID; fresh process re-opens DB cleanly',
    async () => {
      // This test exercises the full Type=notify + Restart=always + WatchdogSec
      // contract. It runs only where a systemd USER manager answers — macOS dev,
      // WSL-without-systemd, and containerized CI without --privileged all skip
      // via the SYSTEMD_USER_AVAILABLE probe above, which registers a reported
      // `skip` rather than an early return that would read as a pass.
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
        // Read the STATE, not a boolean, so predicates can distinguish the
        // states that matter. `is-active` collapses `activating`, `deactivating`,
        // `failed` and a systemctl error (empty stdout) into one "not active"
        // answer, and a stop-wait written as `!isActive()` would therefore be
        // satisfied mid-shutdown or by a broken systemctl.
        const activeState = (): string =>
          spawnSync('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', unitName])
            .stdout.toString()
            .trim()
        const isActive = (): boolean => activeState() === 'active'
        const mainPid = (): number =>
          Number(
            spawnSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unitName])
              .stdout.toString()
              .trim(),
          )

        // Type=notify: the unit becomes `active` exactly when the gateway sends
        // READY=1, so this waits on the gateway's own readiness, not a guess.
        // Sound as a shutdown precondition only because this PR moved that
        // sdNotify BELOW the SIGTERM/SIGINT binds in boot() — while READY=1 was
        // sent at the listener bind, `active` meant "accepting traffic", not
        // "will handle a stop", and the `stop` issued further down could land on
        // a process with no handler. WAL recovery on the reopen is forgiving
        // enough that the assertions would still have passed, certifying a clean
        // shutdown that never happened.
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
        //
        // Capture the PID that SATISFIED the predicate. Re-reading `MainPID`
        // afterwards to assert on would be a fourth spawn answering a different
        // question — a second respawn between the two reads would make the
        // assertions describe a process the wait never saw.
        let newPid = 0
        await waitFor('systemd to respawn the unit with a fresh MainPID', 25_000, () => {
          const pid = mainPid()
          if (pid <= 0 || pid === oldPid) return false
          if (!isActive()) return false
          newPid = pid
          return true
        })
        expect(newPid).toBeGreaterThan(0)
        expect(newPid).not.toBe(oldPid)

        // Stop cleanly, then verify the DB is re-openable with no corruption.
        // The blocking `spawnSync` below is what actually guarantees the drain
        // finished: `systemctl stop` returns only once the job completes, so the
        // gateway has already closed the DB by the time it returns. Its exit
        // status is therefore load-bearing — a stop that never ran (unknown
        // unit, dead user manager) would otherwise leave the assertions below to
        // certify a shutdown that was never requested.
        const stopped = spawnSync('systemctl', ['--user', 'stop', unitName])
        expect(
          stopped.status,
          `systemctl stop failed: ${stopped.stderr.toString().slice(0, 500)}`,
        ).toBe(0)
        // Belt-and-braces re-read after the blocking stop. Asserted against the
        // literal terminal state rather than `!isActive()`, which is also true
        // while `deactivating` (mid-shutdown) and when systemctl itself errors
        // and prints nothing — both of which would pass for the wrong reason.
        await waitFor('the unit to settle in ActiveState=inactive', 20_000, () => {
          const state = activeState()
          return state === 'inactive' || state === 'failed'
        })
        expect(activeState()).toBe('inactive')

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
