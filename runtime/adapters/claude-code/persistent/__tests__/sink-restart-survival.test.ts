/**
 * ISSUES #537 — the reply sink survives a gateway restart.
 *
 * The acceptance is not "a token file exists"; it is that a REPL spawned by ONE
 * gateway process can still authenticate to the NEXT one. Both coordinates the
 * child is baked with — the sink's loopback PORT (`spawn.ts`'s `SINK_PORT` in the
 * per-session MCP config env, and `build-settings.ts`'s literal `SINK_PORT=…` hook
 * env prefix) and its TOKEN (`SINK_TOKEN` in the same two places) — used to be
 * per-process: `port: 0` plus a fresh `randomBytes(24)`. The child reads them once
 * at startup (`dev-channel-impl.ts`) and there is no protocol to re-point it, so
 * every surviving bridge POSTed into a dead port with a stale secret.
 *
 * So the central case here (`sequential sink instances`) is written as a restart:
 * start a sink, take its coordinates the way a spawn would, STOP it, start a
 * second one against the same state, and require that the second binds the same
 * port and accepts the FIRST one's token.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { SUBSTRATE_ERROR_CODES } from '../../../../errors.ts'
import { deriveReplSupervisionPaths } from '../../index.ts'
import { classifySpawnError } from '../classify-spawn-error.ts'
import { flockAvailable } from '../registry-lock.ts'
import { ReplSink, sink } from '../pool-state.ts'
import { ReplSession } from '../repl-session.ts'
import { setReplActivityTap, setReplToolBridge } from '../repl-sink.ts'
import { getReplSinkInfo } from '../repl-sink.ts'
import { injectMessage } from '../spawn.ts'
import {
  SINK_PORT_WINDOW_BASE,
  SINK_PORT_WINDOW_SIZE,
  SINK_TOKEN_FILENAME,
  SINK_TOKEN_MIN_LEN,
  defaultSinkTokenLock,
  defaultSinkTokenPath,
  deriveSinkPort,
  loadOrCreateSinkToken,
  parseSinkPortOverride,
  resolveSinkPort,
  setReplSinkPortOverride,
  sinkTokenLockPath,
  stagingTokenPath,
} from '../sink-coordinates.ts'

const scratchDirs: string[] = []
/** Sessions registered with the PROCESS singleton sink, dropped after each test so no
 *  test inherits another's authorization. */
const registeredSessions: ReplSession[] = []
const liveServers: ReturnType<typeof Bun.serve>[] = []
const liveSinks: ReplSink[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-sink-537-'))
  scratchDirs.push(dir)
  return dir
}

/** A port nothing holds right now: bind ephemeral, remember the number, release.
 *  Used instead of the fixed default so this suite can never collide with the
 *  process-singleton sink other test files start via `await getReplSinkInfo()`. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('probe') })
  const port = probe.port
  if (port === undefined || port === 0) throw new Error('probe server bound no port')
  probe.stop(true)
  return port
}

const SINK_COORDINATES_MODULE = join(import.meta.dir, '..', 'sink-coordinates.ts')

/** Run `body` in a FRESH bun process — the only way to observe behaviour that
 *  depends on a module's state being new (a per-process counter, here). The body
 *  must `process.stdout.write('RESULT:' + JSON.stringify(...))`. */
function spawnChild(body: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, '-e', body], { stdout: 'pipe', stderr: 'pipe' })
}

function occupy(port: number): ReturnType<typeof Bun.serve> {
  const s = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('occupied') })
  liveServers.push(s)
  return s
}

async function startSink(config: { port: number; tokenPath: string }): Promise<ReplSink> {
  const s = new ReplSink()
  liveSinks.push(s)
  await s.ensureStarted({ ...config, bindAttempts: 2, bindRetryDelayMs: 5 })
  return s
}

/** POST `/reply` with `token` as the caller's credential, as a surviving child would. */
async function postWithToken(
  port: number,
  token: string,
  sessionId = 'survivor-session',
): Promise<{ status: number; body: string }> {
  const resp = await fetch(`http://127.0.0.1:${port}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
    body: JSON.stringify({ session_id: sessionId, text: 'hello from before the restart' }),
  })
  return { status: resp.status, body: await resp.text() }
}

/** Register a session on `s` so a credential exists for it, and return that
 *  credential — the value `spawnSession` would have baked into that child. */
function credentialOn(s: ReplSink, generation: string, sessionId = `sid-${generation}`): string {
  const session = new ReplSession('key', generation, sessionId, 'chan', '/tmp')
  s.register(sessionId, session)
  return s.credentialFor(session)
}

afterEach(() => {
  for (const s of registeredSessions.splice(0)) sink.unregister(s.sessionId)
  // The late-bound bridge/tap are PROCESS-wide singletons like the port override:
  // a test that wired one must not leave it armed for the next file.
  setReplToolBridge(undefined)
  setReplActivityTap(undefined)
  // The port override is PROCESS-wide (it stands in for the operator's boot-config
  // knob), so it is cleared between tests — a latched override would silently steer
  // every later test in this process.
  setReplSinkPortOverride(undefined)
  for (const s of liveSinks.splice(0)) s.stop()
  for (const s of liveServers.splice(0)) s.stop(true)
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('sink token — load or create (#537)', () => {
  test('an absent token file is created 0600 and returned', () => {
    const path = join(scratch(), '.neutron', SINK_TOKEN_FILENAME)
    expect(existsSync(path)).toBe(false)

    const token = loadOrCreateSinkToken(path)

    // ABSOLUTE, not `>= SINK_TOKEN_MIN_LEN`: asserting against the same constant the
    // production predicate uses means lowering that constant moves both and the test
    // stays green. The criterion is a real secret's worth of entropy — 24 random
    // bytes, 48 hex chars — so that is what is asserted, with the floor pinned
    // separately below.
    expect(token).toMatch(/^[0-9a-f]{48}$/)
    expect(SINK_TOKEN_MIN_LEN).toBeGreaterThanOrEqual(32)
    // The mode we ACTUALLY got, not the mode we asked for.
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8').trim()).toBe(token)
  })

  test('an existing valid token file is returned UNCHANGED — this is restart survival', () => {
    const dir = scratch()
    const path = join(dir, SINK_TOKEN_FILENAME)
    const planted = 'a'.repeat(48)
    writeFileSync(path, `${planted}\n`, { mode: 0o600 })

    // Twice, because a "stable" token that is only stable on the second read is
    // not stable at all.
    expect(loadOrCreateSinkToken(path)).toBe(planted)
    expect(loadOrCreateSinkToken(path)).toBe(planted)
    expect(readFileSync(path, 'utf8').trim()).toBe(planted)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('a SYMLINKED lock path does not truncate its target — the lock is opened O_NOFOLLOW', () => {
    // EFFECT-BASED, through the production loader. The lock is opened with O_TRUNC, and
    // O_TRUNC applies AT OPEN — so without O_NOFOLLOW the victim is already destroyed
    // before `withFlockSync` has done anything, and no assertion about flock or about
    // call counts would notice. What is asserted here is the victim's BYTES.
    //
    // Reachable because the token path is caller-supplied (`PersistentReplSubstrateOptions
    // .sinkTokenPath`), so the lock can be made to land in a directory someone else writes.
    // The token's own reader carries O_NOFOLLOW; the lock introduced beside it did not.
    const dir = scratch()
    const victim = join(dir, 'precious.txt')
    const contents = 'do not truncate me\n'
    writeFileSync(victim, contents, { mode: 0o600 })

    const path = join(dir, SINK_TOKEN_FILENAME)
    symlinkSync(victim, join(dir, `${SINK_TOKEN_FILENAME}.lock`))

    // The mint must not succeed by quietly following the link either, so the outcome is
    // pinned as well as the bytes: this call FAILS.
    expect(() => loadOrCreateSinkToken(path)).toThrow()

    // The assertion that matters. Under the defect this file is empty.
    expect(readFileSync(victim, 'utf8')).toBe(contents)
  })

  test('a lock path that is a DIRECTORY fails promptly rather than locking something else', () => {
    // The complement O_NOFOLLOW does not cover: the flag rejects a symlink, the fstat
    // rejects everything that is not a regular file. Without the type check this opens
    // EISDIR anyway — so this case is here to keep the check honest if the open flags
    // ever change, and it fails fast rather than hanging.
    const dir = scratch()
    const path = join(dir, SINK_TOKEN_FILENAME)
    mkdirSync(join(dir, `${SINK_TOKEN_FILENAME}.lock`), { recursive: true })

    expect(() => loadOrCreateSinkToken(path)).toThrow()
  })

  test('a group/world-readable token file is REFUSED and replaced', () => {
    const dir = scratch()
    const path = join(dir, SINK_TOKEN_FILENAME)
    const exposed = 'b'.repeat(48)
    writeFileSync(path, `${exposed}\n`, { mode: 0o600 })
    chmodSync(path, 0o644)

    const token = loadOrCreateSinkToken(path)

    // A token other local users may already have read is compromised: it is
    // replaced, never tightened-and-trusted.
    expect(token).not.toBe(exposed)
    expect(token.length).toBeGreaterThanOrEqual(SINK_TOKEN_MIN_LEN)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8').trim()).toBe(token)
  })

  test('an empty token file is REFUSED and replaced', () => {
    const path = join(scratch(), SINK_TOKEN_FILENAME)
    writeFileSync(path, '', { mode: 0o600 })

    const token = loadOrCreateSinkToken(path)

    expect(token.length).toBeGreaterThanOrEqual(SINK_TOKEN_MIN_LEN)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('a whitespace-only token file is REFUSED and replaced', () => {
    const path = join(scratch(), SINK_TOKEN_FILENAME)
    writeFileSync(path, '   \n\t\n', { mode: 0o600 })

    const token = loadOrCreateSinkToken(path)

    expect(token.trim()).toBe(token)
    expect(token.length).toBeGreaterThanOrEqual(SINK_TOKEN_MIN_LEN)
  })

  test('a short token file is REFUSED and replaced', () => {
    const path = join(scratch(), SINK_TOKEN_FILENAME)
    writeFileSync(path, 'deadbeef\n', { mode: 0o600 })

    expect(loadOrCreateSinkToken(path)).not.toBe('deadbeef')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('a token file granting GROUP or OTHER access is refused and replaced', () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o601]) {
      const path = join(scratch(), SINK_TOKEN_FILENAME)
      const planted = 'f'.repeat(48)
      writeFileSync(path, `${planted}\n`, { mode: 0o600 })
      chmodSync(path, mode)

      expect(loadOrCreateSinkToken(path)).not.toBe(planted)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  test('a token file that is STRICTER than 0600 is ACCEPTED — refusing it is the boot-block', () => {
    // THE PAIRED CASE, without which the refusal above is untested in the direction
    // that matters: a check that refuses everything passes a test that only feeds it
    // 0644. The invariant is "no group or other access", so 0400 and 0700 are SAFE and
    // must be USED, not re-minted. An earlier revision asked for equality with 0600
    // and therefore rotated a token that had never been exposed — silently stranding
    // every child baked with it — while the same predicate on the CREATE path threw
    // outright under `umask 0277`, so the sink never started.
    for (const mode of [0o400, 0o600, 0o700, 0o500]) {
      const path = join(scratch(), SINK_TOKEN_FILENAME)
      const planted = 'f'.repeat(48)
      writeFileSync(path, `${planted}\n`, { mode: 0o600 })
      chmodSync(path, mode)

      expect(loadOrCreateSinkToken(path)).toBe(planted)
      // …and it is left exactly as the operator's umask made it: adopting a safe file
      // must not rewrite it either.
      expect(statSync(path).mode & 0o777).toBe(mode)
    }
  })

  test('creation under a RESTRICTIVE umask starts the sink, and normalises the file to 0600', async () => {
    // A SUBPROCESS, because `process.umask()` is process-global and the suite's other
    // tests (and any concurrent file) would inherit it. POSIX applies the umask to the
    // `open` mode, so `0600` under `umask 0277` lands as 0400: safe, stricter than
    // asked, and refused by an exact-equality check — which on this path means the
    // gateway does not start at all.
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const child = spawnChild(
      `process.umask(0o277);
       const m = await import(${JSON.stringify(SINK_COORDINATES_MODULE)});
       const fs = await import('node:fs');
       const token = m.loadOrCreateSinkToken(${JSON.stringify(tokenPath)});
       process.stdout.write('RESULT:' + JSON.stringify({
         token,
         mode: (fs.statSync(${JSON.stringify(tokenPath)}).mode & 0o777).toString(8),
       }) + '\\n')`,
    )
    const result = await racerResult(child)

    expect(result['token']).toMatch(/^[0-9a-f]{48}$/)
    // `fchmod` on the held fd normalises it, so the on-disk fleet is uniform whatever
    // the operator's umask — belt to the predicate's braces, not a substitute for it.
    expect(result['mode']).toBe('600')
    expect(result['token']).toBe(readFileSync(tokenPath, 'utf8').trim())
  }, 20_000)

  test('a staging file a KILLED process left behind is swept; a fresh one is left alone', () => {
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const orphan = join(dir, `${SINK_TOKEN_FILENAME}.99999.1.tmp`)
    const live = join(dir, `${SINK_TOKEN_FILENAME}.99999.2.tmp`)
    writeFileSync(orphan, 'abandoned\n', { mode: 0o600 })
    writeFileSync(live, 'in flight\n', { mode: 0o600 })
    // Backdate only the orphan: the window between staging and publishing is a few
    // syscalls, so an hour-old staging file belongs to a process that was killed.
    const hourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(orphan, hourAgo, hourAgo)

    loadOrCreateSinkToken(tokenPath)

    expect(existsSync(orphan)).toBe(false)
    // A CONCURRENT racer's staging file must survive — sweeping it would delete the
    // very file that is about to be published.
    expect(existsSync(live)).toBe(true)
    expect(existsSync(tokenPath)).toBe(true)
  })

  test('no two stagings ever choose the same path — the requirement, asserted directly', () => {
    // The contract that makes `O_EXCL` a guard against a real concurrent writer
    // instead of a trap that fires on a dead process's litter. Asserted on the name
    // builder because a constant-but-unique-LOOKING name (a fixed suffix, a
    // once-per-process value) satisfies every downstream test while reintroducing the
    // collision — a mutation to exactly that shape went green against the remnant
    // test below, which is why this assertion exists separately.
    const dir = scratch()
    const names = new Set(Array.from({ length: 64 }, () => stagingTokenPath(dir)))
    expect(names.size).toBe(64)
    for (const name of names) {
      expect(name.startsWith(join(dir, `${SINK_TOKEN_FILENAME}.`))).toBe(true)
      expect(name.endsWith('.tmp')).toBe(true)
      // …and the sweep must recognise it, or an orphan would live forever.
      expect(basename(name).startsWith(`${SINK_TOKEN_FILENAME}.`)).toBe(true)
    }
  })

  test('a crash remnant carrying THIS pid does not block the start — in a FRESH process, which is the only place it can', async () => {
    // IT HAS TO BE A SUBPROCESS. The defect is that a pid+counter staging name
    // restarts at `.1` in every process, so the collision happens on a fresh
    // process's FIRST mint. Written in-process, this test planted `.1` and passed
    // against the deterministic scheme too — because earlier tests in this file had
    // already advanced the module counter past it. That version reached the wrong
    // boundary, and the mutation check is what said so.
    //
    // So the child does both halves itself: plant the remnant under ITS OWN pid,
    // fresh (too young for the 60s sweep, so it is present at the moment of the
    // call), then mint. Under the deterministic scheme its first staging attempt
    // picks that exact name, `O_EXCL` throws EEXIST, and the sink never starts — a
    // dead incarnation's litter blocking the restart this module exists to make
    // survivable.
    const dir = scratch()
    const child = spawnChild(
      `const fs = await import('node:fs');
       const remnant = ${JSON.stringify(dir)} + '/' + ${JSON.stringify(SINK_TOKEN_FILENAME)} + '.' + process.pid + '.1.tmp';
       fs.writeFileSync(remnant, 'debris from a killed incarnation\\n', { mode: 0o600 });
       const m = await import(${JSON.stringify(SINK_COORDINATES_MODULE)});
       const token = m.loadOrCreateSinkToken(${JSON.stringify(join(dir, SINK_TOKEN_FILENAME))});
       process.stdout.write('RESULT:' + JSON.stringify({ token, remnantKept: fs.existsSync(remnant) }) + '\\n')`,
    )
    const result = await racerResult(child)

    expect(result['token']).toMatch(/^[0-9a-f]{48}$/)
    // The remnant is STILL THERE: too young to sweep, so the start genuinely
    // happened alongside it rather than after a cleanup removed it.
    expect(result['remnantKept']).toBe(true)
    expect(statSync(join(dir, SINK_TOKEN_FILENAME)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((f) => f.endsWith('.1.tmp')).length).toBe(1)
  }, 20_000)

  // NON-REGULAR TOKEN PATHS. `isFile()` intends to reject every one of these, and for
  // a FIFO that intention was unreachable: `openSync(O_RDONLY)` on a FIFO with no
  // writer never returns, so the gateway HUNG at startup instead of re-minting —
  // measured on the unpatched tree, where a JS watchdog could not even fire because
  // the blocking open pins the thread. Each case therefore runs in a SUBPROCESS under
  // a hard deadline: a hang has to fail as a hang, not as a suite that never finishes.
  //
  // A char/block DEVICE is the one type not covered, and the reason is that creating
  // one needs privileges this suite does not have. It is the same branch as the three
  // below (`!st.isFile()`), reached through the same non-blocking open, which is what
  // `O_NONBLOCK` guarantees for a device that would otherwise wait on a carrier.
  for (const [species, makeIt, expectedReason] of [
    [
      'a FIFO with no writer',
      (tokenPath: string) => {
        Bun.spawnSync(['mkfifo', tokenPath])
      },
      'not a regular file',
    ],
    ['a DIRECTORY', (tokenPath: string) => mkdirSync(tokenPath), 'not a regular file'],
    [
      'a UNIX SOCKET',
      // The listener must STAY UP for the duration: `stop(true)` UNLINKS the socket,
      // and a first version of this case stopped it immediately — so the child found
      // an ABSENT path, minted a token with no complaint, and the assertions passed
      // while testing nothing. The teardown is returned instead.
      (tokenPath: string) => {
        const server = Bun.listen({ unix: tokenPath, socket: { data: () => {} } })
        return () => server.stop(true)
      },
      // A socket cannot be opened at all (ENXIO), so it is refused one step earlier —
      // asserting the FIFO's reason here would be asserting the wrong mechanism.
      'unreadable',
    ],
  ] as ReadonlyArray<[string, (tokenPath: string) => (() => void) | void, string]>) {
    test(`${species} at the token path is REPLACED, not waited on`, async () => {
      const dir = scratch()
      const tokenPath = join(dir, SINK_TOKEN_FILENAME)
      const teardown = makeIt(tokenPath)
      // The bad thing must exist AT THE MOMENT THE CHILD LOOKS, or the case proves
      // nothing — see the socket note above.
      expect(lstatSync(tokenPath).isFile()).toBe(false)

      const child = spawnChild(
        `const m = await import(${JSON.stringify(SINK_COORDINATES_MODULE)});
         const token = m.loadOrCreateSinkToken(${JSON.stringify(tokenPath)});
         process.stdout.write('RESULT:' + JSON.stringify({ token }) + '\\n')`,
      )
      const result = await childResultWithin(child, 15_000, species)
      // TEARDOWN AFTER THE ASSERTIONS, not before: `server.stop(true)` unlinks whatever
      // now sits at the socket's path — which, once the child has replaced it, is the
      // freshly minted TOKEN. Running it first deleted the very file being asserted on.
      try {
        expect(result['token']).toMatch(/^[0-9a-f]{48}$/)
        // THE REASON THE OPERATOR IS TOLD, not merely that something was replaced. For
        // a FIFO and a directory the refusal must come from the TYPE check: without
        // this assertion, deleting `isFile()` leaves those cases green — the later read
        // fails anyway (EAGAIN, EISDIR) and the file is replaced for a different
        // reason. The outcome is the same; the diagnostic an operator gets is not, and
        // a check nothing depends on is not a guard.
        expect(result.__stderr).toContain(expectedReason)
        // …and the path is a regular owner-only file again, holding what was returned.
        expect(statSync(tokenPath).isFile()).toBe(true)
        expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
        expect(result['token']).toBe(readFileSync(tokenPath, 'utf8').trim())
      } finally {
        if (teardown !== undefined) teardown()
      }
    }, 30_000)
  }

  test('a SYMLINK in the token path is never followed — it is replaced by a real 0600 file', () => {
    const dir = scratch()
    const path = join(dir, SINK_TOKEN_FILENAME)
    const elsewhere = join(dir, 'attacker-controlled')
    const planted = 'c'.repeat(48)
    writeFileSync(elsewhere, `${planted}\n`, { mode: 0o600 })
    symlinkSync(elsewhere, path)

    const token = loadOrCreateSinkToken(path)

    expect(token).not.toBe(planted)
    expect(lstatSync(path).isSymbolicLink()).toBe(false)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // The link target is left alone: the rename replaced the NAME, so nothing was
    // written through the link.
    expect(readFileSync(elsewhere, 'utf8').trim()).toBe(planted)
  })

  test('the token lives with the rest of the durable REPL state, under the home', () => {
    // The CRITERION is placement, not the `join` expression: the token must sit in
    // the same state dir as the other durable supervision files (so one function
    // owns the layout) and under the instance home (so it is outside every working
    // tree). Asserting `join(stateDir, FILENAME)` would only restate the
    // implementation back to itself.
    const home = scratch()
    const paths = deriveReplSupervisionPaths(home)
    expect(dirname(paths.sinkTokenPath)).toBe(dirname(paths.replRegistryPath))
    expect(dirname(paths.sinkTokenPath)).toBe(dirname(paths.heartbeatFile))
    expect(dirname(paths.sinkTokenPath)).toBe(paths.stateDir)
    expect(paths.sinkTokenPath.startsWith(`${home}/`)).toBe(true)
  })
})

describe('sink port — per instance, never ephemeral (#537)', () => {
  test('the port is DERIVED from the instance state dir: stable per dir, different across dirs', () => {
    const a = '/var/lib/example/instance-a/.neutron'
    const b = '/var/lib/example/instance-b/.neutron'
    // Stable: the same state dir must give the same port in the next process, or a
    // surviving REPL cannot find its restarted gateway.
    expect(deriveSinkPort(a)).toBe(deriveSinkPort(a))
    // Per-instance: a single box-global port meant the SECOND instance could never
    // bind, and meant the test suite (whose preload gives every process a fresh
    // home) collided with itself and with any live gateway on the box.
    expect(deriveSinkPort(a)).not.toBe(deriveSinkPort(b))
    // …and inside the window, which is above the privileged ports and below the
    // 32768-60999 ephemeral range the kernel hands out to everyone else.
    for (const dir of [a, b, '/tmp/x/.neutron', process.cwd()]) {
      const port = deriveSinkPort(dir)
      expect(port).toBeGreaterThanOrEqual(SINK_PORT_WINDOW_BASE)
      expect(port).toBeLessThan(SINK_PORT_WINDOW_BASE + SINK_PORT_WINDOW_SIZE)
      expect(port).toBeLessThan(32768)
    }
    expect(SINK_PORT_WINDOW_BASE).toBeGreaterThan(1024)
  })

  test('a derived port spreads across the window rather than clustering', () => {
    // A derivation that returned the base (or a handful of values) would recreate the
    // box-global collision it exists to avoid, while still passing the test above.
    const ports = new Set(
      Array.from({ length: 64 }, (_v, i) => deriveSinkPort(`/var/lib/example/i-${i}/.neutron`)),
    )
    expect(ports.size).toBeGreaterThanOrEqual(60)
  })

  test('an unconfigured sink resolves a PER-INSTANCE port, not a shared constant', () => {
    // Stated without naming `deriveSinkPort`, because "the resolver returns what the
    // deriver returns" compares one implementation to another and would stay green if
    // both became a constant. The criterion is that two instances get DIFFERENT ports
    // and each gets the SAME one every time.
    const a = deriveReplSupervisionPaths(scratch()).stateDir
    const b = deriveReplSupervisionPaths(scratch()).stateDir
    const portA = resolveSinkPort({ stateDir: a })
    const portB = resolveSinkPort({ stateDir: b })
    expect(portA).not.toBe(portB)
    expect(resolveSinkPort({ stateDir: a })).toBe(portA)
    // …and it is the same value the derivation names, so the sink and anything else
    // reading the layout agree.
    expect(portA).toBe(deriveSinkPort(a))
  })

  // --- THE BOUNDARY EVERY CONFIGURATION SOURCE SHARES --------------------------
  // The first revision of this change validated the ENV value and handed the
  // OPTION straight to `Bun.serve`: measured, `sinkPort: 0` bound 43235, `-1` bound
  // 38983, `NaN` bound 37299 and `70000` silently became 65535 — #537 re-entered
  // through the seam documented as *the* way a second instance gets its own port.
  // These cases therefore drive BOTH sources through the same expectations.

  const STATE_DIR = '/var/lib/example/boundary/.neutron'

  test('a 0 port is REFUSED from every configuration source, by name', () => {
    expect(() => resolveSinkPort({ explicit: 0, stateDir: STATE_DIR })).toThrow(
      /sinkPort option is 0/,
    )
    expect(() => resolveSinkPort({ explicit: 0, stateDir: STATE_DIR })).toThrow(/EPHEMERAL/)
    // The operator knob is coerced + validated at the boundary that reads it, so a 0
    // in the boot configuration never reaches the sink either.
    expect(() => parseSinkPortOverride('0')).toThrow(/NEUTRON_REPL_SINK_PORT is 0/)
  })

  test('a port that is not a whole 1-65535 number is REFUSED from every source', () => {
    for (const bad of [-1, 1.5, 65536, 70000, Number.NaN]) {
      expect(() => resolveSinkPort({ explicit: bad, stateDir: STATE_DIR })).toThrow(
        /not a usable TCP port/,
      )
    }
    for (const bad of ['-1', '1.5', '70000', 'eighteen-thousand']) {
      expect(() => parseSinkPortOverride(bad)).toThrow(/not a usable TCP port/)
    }
    // Unset and blank are UNSET, not errors: they mean "no override".
    expect(parseSinkPortOverride(undefined)).toBeUndefined()
    expect(parseSinkPortOverride('   ')).toBeUndefined()
  })

  test('a valid override is honoured — the substrate option over the wired knob over derived', () => {
    expect(parseSinkPortOverride('23456')).toBe(23456)

    // Nothing wired: the per-instance derivation.
    expect(resolveSinkPort({ stateDir: STATE_DIR })).toBe(deriveSinkPort(STATE_DIR))
    // Wired (the operator's boot-config knob): it wins over the derivation…
    setReplSinkPortOverride(23456)
    expect(resolveSinkPort({ stateDir: STATE_DIR })).toBe(23456)
    // …and the more specific per-substrate option wins over that.
    expect(resolveSinkPort({ explicit: 19999, stateDir: STATE_DIR })).toBe(19999)
    // Cleared: back to the derivation, so nothing latches for the process.
    setReplSinkPortOverride(undefined)
    expect(resolveSinkPort({ stateDir: STATE_DIR })).toBe(deriveSinkPort(STATE_DIR))
  })

  test('ensureStarted({ port: 0 }) fails BEFORE it binds anything or writes a token', async () => {
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const sink = new ReplSink()
    liveSinks.push(sink)

    await expect(sink.ensureStarted({ port: 0, tokenPath })).rejects.toThrow(/is 0/)

    // Nothing bound — not the derived port, and above all not an ephemeral one.
    expect(() => sink.port).toThrow(/not started/)
    // And nothing written: the validation runs before the token is even resolved,
    // so a refused configuration leaves no state behind to be adopted later.
    expect(existsSync(tokenPath)).toBe(false)
  })

  test('a sink given ONLY a tokenPath binds the DERIVED port — the derivation, not the fixture', async () => {
    // The acceptance says a restart against the same state dir binds the same port. The
    // sequential-instances case below hands BOTH sinks the same explicit `port`, so its
    // `second.port === first.port` is satisfied by the fixture telling them the same
    // number: delete the state-dir derivation from `startOnce` and that test stays
    // green. A test satisfiable by a mechanism other than the one under test measures
    // the wrong thing.
    //
    // This one supplies NO port and asserts against `deriveSinkPort` itself, so the
    // derivation is what is being checked. Equality between two instances could not do
    // that job alone — two equally wrong ports are still equal.
    const dir = scratch()
    const s = new ReplSink()
    liveSinks.push(s)
    await s.ensureStarted({ tokenPath: join(dir, SINK_TOKEN_FILENAME), bindAttempts: 4, bindRetryDelayMs: 25 })
    expect(s.port).toBe(deriveSinkPort(dir))
  })

  test('sequential sink instances agree, and the second authorizes a child the FIRST baked', async () => {
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const port = freePort()
    // The generation a child was spawned with. In production this is a per-spawn UUID
    // that the REPL registry persists (`child_generation`), which is what lets the NEXT
    // gateway re-derive the same credential without storing a secret.
    const generation = 'generation-of-a-surviving-child'

    // --- gateway process #1 ---
    const first = await startSink({ port, tokenPath })
    const bakedPort = first.port
    const rootBefore = first.token
    expect(bakedPort).toBe(port)
    expect(rootBefore.length).toBeGreaterThanOrEqual(SINK_TOKEN_MIN_LEN)
    // What the child carries is DERIVED from the root, never the root itself.
    const childCredential = credentialOn(first, generation)
    expect(childCredential).not.toBe(rootBefore)
    const beforeRestart = await postWithToken(bakedPort, childCredential, `sid-${generation}`)
    expect(beforeRestart.status).toBe(200)

    // --- the gateway restarts ---
    first.stop()

    const second = await startSink({ port, tokenPath })
    expect(second.port).toBe(bakedPort)
    expect(second.token).toBe(rootBefore)
    // The new gateway re-derives the SAME credential for that child from the persisted
    // root and the generation — no secret moved, nothing was stored.
    expect(credentialOn(second, generation)).toBe(childCredential)

    // THE ACCEPTANCE: the child baked by process #1 is authorized by process #2 with
    // the credential it has held all along.
    const afterRestart = await postWithToken(bakedPort, childCredential, `sid-${generation}`)
    expect(afterRestart.status).toBe(200)

    // …and the ROOT token is not a credential: it authorizes nothing, which is the
    // whole point of deriving per-child values from it.
    expect((await postWithToken(bakedPort, rootBefore)).status).toBe(401)
    // …nor is a foreign value.
    expect((await postWithToken(bakedPort, 'd'.repeat(64))).status).toBe(401)
  })

  test('a port already in use FAILS LOUDLY and binds nothing else', async () => {
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const port = freePort()
    const squatter = occupy(port)
    expect(squatter.port).toBe(port)

    const sink = new ReplSink()
    liveSinks.push(sink)

    let thrown: unknown
    try {
      await sink.ensureStarted({ port, tokenPath, bindAttempts: 2, bindRetryDelayMs: 5 })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(Error)
    const msg = (thrown as Error).message
    expect(msg).toContain(String(port))
    // The message is not just prose: `classifySpawnError` matches on it to stamp the
    // FATAL class, so the criterion is "this failure classifies as fatal", not "the
    // string mentions the sink". Asserting the classifier closes the loop between the
    // producer's wording and the ladder's behaviour — a rename that broke the match
    // would leave a `toContain('repl-sink')` assertion green.
    expect(classifySpawnError(msg)).toBe('channel_wedged')
    expect(SUBSTRATE_ERROR_CODES.channel_wedged.retryable).toBe(false)

    // THE POINT OF THIS TEST: it must not have quietly bound SOME OTHER port. A
    // silent `port: 0` fallback would also "throw nothing useful and carry on",
    // and every child spawned afterwards would be baked with a coordinate the next
    // restart cannot reproduce — the exact #537 failure.
    expect(() => sink.port).toThrow(/not started/)
    // The squatter still owns the port; nothing was stolen or shared.
    expect(squatter.port).toBe(port)
  })

  test('a sink that cannot bind still leaves the persisted token intact for the next try', async () => {
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const port = freePort()
    occupy(port)

    const failed = new ReplSink()
    liveSinks.push(failed)
    await expect(
      failed.ensureStarted({ port, tokenPath, bindAttempts: 1, bindRetryDelayMs: 1 }),
    ).rejects.toThrow()

    // The token was resolved before the bind was attempted, so it is on disk 0600
    // and the next process reads the SAME value rather than minting a second one.
    expect(existsSync(tokenPath)).toBe(true)
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    const onDisk = readFileSync(tokenPath, 'utf8').trim()
    expect(failed.token).toBe(onDisk)
    expect(loadOrCreateSinkToken(tokenPath)).toBe(onDisk)
  })

  test('two concurrent starts share ONE attempt — the loser never sees the winner as EADDRINUSE', async () => {
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const port = freePort()
    const squatter = occupy(port)

    const sink = new ReplSink()
    liveSinks.push(sink)
    // Release the port DURING the retry window, so both callers wake from the same
    // sleep with the port free. Under independent retries the first to bind becomes
    // the second's EADDRINUSE — its own healthy listener — and the second rejects
    // with the fatal, non-retryable class while the singleton is fine. That is the
    // window `await Bun.sleep` opened and `Bun.sleepSync` never could.
    setTimeout(() => squatter.stop(true), 60)

    const config = { port, tokenPath, bindAttempts: 20, bindRetryDelayMs: 20 }
    const settled = await Promise.allSettled([
      sink.ensureStarted(config),
      sink.ensureStarted(config),
    ])

    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(sink.port).toBe(port)
    // Both callers describe the SAME sink, because there was only ever one start.
    expect(sink.token).toBe(readFileSync(tokenPath, 'utf8').trim())
  })

  test('a concurrent caller inherits a genuine failure rather than inventing a second sink', async () => {
    // The other half of sharing one attempt: when the start really cannot succeed,
    // every caller must hear so. A loser that silently returned would hand its
    // spawn a sink that does not exist.
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const port = freePort()
    occupy(port)

    const sink = new ReplSink()
    liveSinks.push(sink)
    const config = { port, tokenPath, bindAttempts: 2, bindRetryDelayMs: 5 }
    const settled = await Promise.allSettled([
      sink.ensureStarted(config),
      sink.ensureStarted(config),
    ])

    expect(settled.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    for (const r of settled) {
      expect(String((r as PromiseRejectedResult).reason)).toContain(String(port))
    }
    expect(() => sink.port).toThrow(/not started/)
  })

  test('a SECOND home borrows the first sink\'s coordinates — the documented one-sink-per-process limit', async () => {
    // Pinning the constraint as BEHAVIOUR rather than leaving it as prose in the
    // docblock, because it is the in-process corollary of #537 itself: two instances
    // in one process share one sink, so the second one's REPLs are baked with the
    // FIRST one's coordinates and stop being reachable after a restart. Production
    // hosts one instance per process, so this is a test-suite shape today — but it is
    // a real constraint on ever hosting two, and the fix would be a sink per state
    // dir. Asserting it here means a future change that silently altered which
    // coordinates win has to face this test.
    const firstDir = scratch()
    const secondDir = scratch()
    const firstToken = join(firstDir, SINK_TOKEN_FILENAME)
    const secondToken = join(secondDir, SINK_TOKEN_FILENAME)
    const firstPort = freePort()
    const secondPort = freePort()

    const s = await startSink({ port: firstPort, tokenPath: firstToken })
    const coordinates = { port: s.port, token: s.token }

    // A second instance asks for its own port and its own token file…
    await s.ensureStarted({ port: secondPort, tokenPath: secondToken })

    // …and gets the first one's, because children already carry them.
    expect(s.port).toBe(coordinates.port)
    expect(s.token).toBe(coordinates.token)
    expect(s.tokenPath).toBe(firstToken)
    // The second home's token file is not even created — nothing read or wrote it.
    expect(existsSync(secondToken)).toBe(false)
    // And the live sink still derives credentials from the FIRST root, which is what
    // the children of BOTH instances are actually carrying — while the root itself
    // authorizes nothing, as everywhere else.
    const accepted = await postWithToken(
      coordinates.port,
      credentialOn(s, 'generation-under-the-first-root'),
      'sid-generation-under-the-first-root',
    )
    expect(accepted.status).toBe(200)
    expect((await postWithToken(coordinates.port, coordinates.token)).status).toBe(401)
  })

  test('a freeing port is adopted within the bounded retry window', async () => {
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const port = freePort()

    // The overlap window the retry exists for: the OUTGOING gateway still holds the
    // port for a moment after the incoming one starts. Now that the wait is `await
    // Bun.sleep` rather than a blocking one, an in-process holder CAN let go while
    // the sink waits — which is itself the proof that the retry no longer pins the
    // event loop: this `setTimeout` could never have fired under `Bun.sleepSync`.
    const outgoing = occupy(port)
    let released = false
    setTimeout(() => {
      released = true
      outgoing.stop(true)
    }, 60)

    const sink = new ReplSink()
    liveSinks.push(sink)
    await sink.ensureStarted({ port, tokenPath, bindAttempts: 12, bindRetryDelayMs: 20 })
    expect(released).toBe(true)
    expect(sink.port).toBe(port)
  })
})

describe('sink token — state-dir placement', () => {
  test('the sink records the token path it used, and it is outside any repo tree', async () => {
    const home = scratch()
    mkdirSync(join(home, '.neutron'), { recursive: true })
    const paths = deriveReplSupervisionPaths(home)
    const sink = await startSink({ port: freePort(), tokenPath: paths.sinkTokenPath })

    expect(sink.tokenPath).toBe(paths.sinkTokenPath)
    expect(existsSync(paths.sinkTokenPath)).toBe(true)
    expect(statSync(paths.sinkTokenPath).mode & 0o777).toBe(0o600)
  })
})

// ---------------------------------------------------------------------------
// CONCURRENT FIRST STARTUP — two processes, one token file.
//
// The token is resolved BEFORE the port is bound, so port exclusivity does NOT
// serialise token creation: both processes can see "absent" and both can mint.
// The first revision of this change published with an unconditional `rename`, so
// the process that LOST the bind could be the one whose token was left on disk —
// the live gateway authenticating with a secret the next gateway would not
// present, which is exactly the failure #537 exists to close.
//
// It has to be real PROCESSES: the mechanisms under test are an advisory
// `flock(2)` (`registry-lock.ts`'s `withFlockSync`) and a `link`-based publish,
// and neither is exercised by two objects inside one event loop.
// ---------------------------------------------------------------------------

const POOL_STATE_MODULE = join(import.meta.dir, '..', 'pool-state.ts')

/**
 * Source for a lock that GENUINELY SERIALISES across processes using only POSIX file
 * primitives: `O_EXCL` create as the mutex, bounded spin, unlink on release.
 *
 * WHY NOT ASSERT THE AMBIENT ONE. Production's lock is `withFlockSync`, which needs
 * Bun's FFI and runs UNGUARDED without it — a configuration this module deliberately
 * supports and whose bounded behaviour is its own criterion. A test that REQUIRED
 * `flockAvailable()` would therefore fail, on exactly the host the fallback exists
 * for, before it could test the fallback: the suite refusing the configuration the
 * feature is about. Injecting a lock removes the environment from the assertion
 * instead of skipping the case, which is what the self-describing `{ available, run }`
 * seam is for. The native `withFlockSync` path is still exercised by every
 * single-process case in this file, none of which passes a lock at all.
 */
const SERIALISING_LOCK = `{
  run: (lockPath, fn) => {
    const mutex = lockPath + '.test-mutex'
    const deadline = Date.now() + 15000
    for (;;) {
      try {
        nodeFs.closeSync(nodeFs.openSync(mutex, 'wx'))
        break
      } catch (e) {
        if (Date.now() > deadline) throw new Error('test mutex never acquired: ' + mutex)
        Bun.sleepSync(2)
      }
    }
    try {
      return { acquired: true, value: fn() }
    } finally {
      try { nodeFs.unlinkSync(mutex) } catch {}
    }
  },
}`

/**
 * Await a child that MUST finish, killing it if it does not.
 *
 * A hang has to fail as a hang: without the deadline a blocking `openSync` in the
 * child would simply never return, and the suite would die on its own timeout with
 * nothing pointing at the cause.
 */
async function childResultWithin(
  proc: ReturnType<typeof Bun.spawn>,
  ms: number,
  what: string,
): Promise<Record<string, unknown> & { __stderr: string }> {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, ms)
  try {
    return await racerResult(proc)
  } catch (e) {
    if (timedOut) throw new Error(`${what}: the child HUNG — killed after ${ms}ms`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Spawn a racer that spins until `startAt` and then runs `body`, which must
 *  `process.stdout.write('RESULT:' + JSON.stringify(...))`. The spin barrier is
 *  what makes the race a race: `bun` startup alone varies by tens of ms. */
function spawnRacer(startAt: number, body: string): ReturnType<typeof Bun.spawn> {
  const code = `const START = ${startAt};\n${body}`
  return Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' })
}

/** Drain a piped child stream. `Bun.spawn`'s `stdout`/`stderr` are typed as
 *  `number | ReadableStream | undefined` (they are a number when inherited), so the
 *  'pipe' contract is narrowed here rather than asserted with a cast. */
async function pipedText(stream: unknown): Promise<string> {
  if (!(stream instanceof ReadableStream)) throw new Error('racer stream is not piped')
  return await new Response(stream).text()
}

async function racerResult(
  proc: ReturnType<typeof Bun.spawn>,
): Promise<Record<string, unknown> & { __stderr: string }> {
  const out = await pipedText(proc.stdout)
  const err = await pipedText(proc.stderr)
  await proc.exited
  const line = out.split('\n').find((l) => l.startsWith('RESULT:'))
  if (line === undefined) {
    throw new Error(`racer produced no RESULT line (exit=${proc.exitCode})\nstdout: ${out}\nstderr: ${err}`)
  }
  // `__stderr` travels with the result because one of the guarantees under test is a
  // WARNING — the unlocked mode must be observable, and stderr is where it is observed.
  return { ...(JSON.parse(line.slice('RESULT:'.length)) as Record<string, unknown>), __stderr: err }
}

describe('concurrent first startup — the live token IS the persisted token (#537)', () => {
  test('four processes minting the same absent token all end up with the ON-DISK value', async () => {
    // Deliberately the AMBIENT lock — nothing injected — because creation converges
    // with NO serialisation at all: the publish is one atomic `link`. That is the
    // criterion this case verifies, and it holds on a host without FFI too.
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const startAt = Date.now() + 700

    const racers = [0, 1, 2, 3].map(() =>
      spawnRacer(
        startAt,
        `const m = await import(${JSON.stringify(SINK_COORDINATES_MODULE)});
         while (Date.now() < START) {}
         process.stdout.write('RESULT:' + JSON.stringify({ token: m.loadOrCreateSinkToken(${JSON.stringify(tokenPath)}) }) + '\\n')`,
      ),
    )
    const results = await Promise.all(racers.map(racerResult))

    const onDisk = readFileSync(tokenPath, 'utf8').trim()
    expect(onDisk.length).toBeGreaterThanOrEqual(SINK_TOKEN_MIN_LEN)
    // EVERY racer adopted the winner. A loser that overwrote the winner (or kept
    // its own secret) shows up here as a token that is not the one on disk.
    for (const r of results) expect(r['token']).toBe(onDisk)
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    // No staging files left behind by the losers. Deliberately NOT an assertion
    // about the whole directory listing: the lockfile's existence is pinned by its
    // own test below, and folding it in here would make THIS test go red for a
    // reason that has nothing to do with convergence.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  }, 20_000)

  test('when two processes race for the PORT too, the one that BOUND it holds the persisted token', async () => {
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    const port = freePort()
    const startAt = Date.now() + 700

    const racers = [0, 1].map(() =>
      spawnRacer(
        startAt,
        `const { ReplSink } = await import(${JSON.stringify(POOL_STATE_MODULE)});
         while (Date.now() < START) {}
         const s = new ReplSink();
         let bound = false, err = '';
         try {
           await s.ensureStarted({ port: ${port}, tokenPath: ${JSON.stringify(tokenPath)}, bindAttempts: 1, bindRetryDelayMs: 1 });
           bound = true;
         } catch (e) { err = String((e && e.message) || e) }
         process.stdout.write('RESULT:' + JSON.stringify({ bound, token: s.token, err }) + '\\n');
         if (bound) { await Bun.sleep(400); s.stop() }`,
      ),
    )
    const results = await Promise.all(racers.map(racerResult))

    const onDisk = readFileSync(tokenPath, 'utf8').trim()
    const winners = results.filter((r) => r['bound'] === true)
    // The port is exclusive, so exactly one of them is the live gateway…
    expect(winners.length).toBe(1)
    // …and the secret IT authenticates with is the secret the NEXT process will
    // read. This is the assertion the unconditional-rename publish could fail.
    expect(winners[0]?.['token']).toBe(onDisk)
    // The loser converged on the same value rather than keeping its own mint.
    for (const r of results) expect(r['token']).toBe(onDisk)
  }, 20_000)

  // CONCURRENT REPLACEMENT of a present-but-INVALID token — distinct from the
  // concurrent CREATION of an absent one above, and the gap a review found. The old
  // replacement path published with an unconditional `rename`, so two processes
  // finding the same bad file both "won": one bound the port holding token A while
  // the disk held token B, which is #537 on the restart-overlap path #537 exists to
  // make survivable. Real processes, because the mechanisms are `rename`/`link` and
  // an advisory `flock` — none of which two objects in one event loop exercise.
  for (const [species, plant] of [
    [
      'group-readable',
      (tokenPath: string) => {
        writeFileSync(tokenPath, `${'a'.repeat(48)}\n`, { mode: 0o600 })
        chmodSync(tokenPath, 0o644)
      },
    ],
    [
      'too short',
      (tokenPath: string) => writeFileSync(tokenPath, 'deadbeef\n', { mode: 0o600 }),
    ],
    [
      'a symlink',
      (tokenPath: string) => {
        const elsewhere = `${tokenPath}.attacker-target`
        writeFileSync(elsewhere, `${'b'.repeat(48)}\n`, { mode: 0o600 })
        symlinkSync(elsewhere, tokenPath)
      },
    ],
  ] as ReadonlyArray<[string, (tokenPath: string) => void]>) {
    test(`four processes replacing a ${species} token converge on the ON-DISK value`, async () => {
      const dir = scratch()
      const tokenPath = join(dir, SINK_TOKEN_FILENAME)
      plant(tokenPath)
      const startAt = Date.now() + 700

      const racers = [0, 1, 2, 3].map(() =>
        spawnRacer(
          startAt,
          `const m = await import(${JSON.stringify(SINK_COORDINATES_MODULE)});
           const nodeFs = await import('node:fs');
           const locked = ${SERIALISING_LOCK};
           while (Date.now() < START) {}
           process.stdout.write('RESULT:' + JSON.stringify({ token: m.loadOrCreateSinkToken(${JSON.stringify(tokenPath)}, locked) }) + '\\n')`,
        ),
      )
      const results = await Promise.all(racers.map(racerResult))

      const onDisk = readFileSync(tokenPath, 'utf8').trim()
      expect(onDisk).toMatch(/^[0-9a-f]{48}$/)
      // EVERY racer holds what the file holds. A replacer that published
      // unconditionally would leave some of them holding their own mint instead.
      for (const r of results) expect(r['token']).toBe(onDisk)
      // The refused bytes were quarantined, not silently destroyed, and the real name
      // is a regular 0600 file again.
      expect(lstatSync(tokenPath).isSymbolicLink()).toBe(false)
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
      expect(readdirSync(dir).filter((f) => f.includes('.rejected.')).length).toBeGreaterThan(0)
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    }, 20_000)
  }

  test('the LOCKED path converges AND says nothing — the guarantee is in force', async () => {
    // Serialisation is INJECTED, not assumed: see `SERIALISING_LOCK`. This case says
    // which mode it ran in by CONSTRUCTING that mode, so it means the same thing on a
    // host with Bun FFI and on one without — where production degrades and this
    // guarantee is explicitly not claimed.
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    writeFileSync(tokenPath, 'deadbeef\n', { mode: 0o600 })
    const startAt = Date.now() + 700

    const racers = [0, 1, 2, 3].map(() =>
      spawnRacer(
        startAt,
        `const m = await import(${JSON.stringify(SINK_COORDINATES_MODULE)});
         const nodeFs = await import('node:fs');
         const locked = ${SERIALISING_LOCK};
         while (Date.now() < START) {}
         process.stdout.write('RESULT:' + JSON.stringify({ token: m.loadOrCreateSinkToken(${JSON.stringify(tokenPath)}, locked) }) + '\\n')`,
      ),
    )
    const results = await Promise.all(racers.map(racerResult))

    const onDisk = readFileSync(tokenPath, 'utf8').trim()
    for (const r of results) {
      expect(r['token']).toBe(onDisk)
      // …and no warning, because nothing is weaker here. This is the half that stops
      // the warning below from being asserted by a line that always fires.
      expect(r.__stderr).not.toContain('flock(2) was not acquired')
    }
  }, 20_000)

  test('a region that was NOT SERIALISED says so, and its weaker outcome is bounded', async () => {
    // The state `withFlockSync` reaches TWO ways — no FFI, or FFI present and `flock`
    // returning nonzero — reached here by handing the loader a lock that reports
    // `acquired: false`, which is the only way to exercise either on a host where
    // locking works. Two things are asserted, and neither is "it converges", because
    // without serialisation it may not:
    //
    //   1. THE DEGRADATION IS OBSERVABLE. A guarantee that quietly weakens is the
    //      complaint this test exists to answer, so the warning naming what is weaker
    //      must appear — once.
    //   2. THE OUTCOME IS STILL BOUNDED. Every process returns a token that was
    //      actually PUBLISHED at the destination — the final one, or one that a
    //      competitor quarantined — never a private mint that no reader could ever
    //      have seen. That is the real difference between "narrow window" and
    //      "anything can happen", and it is falsifiable.
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    writeFileSync(tokenPath, 'deadbeef\n', { mode: 0o600 })
    const startAt = Date.now() + 700

    const racers = [0, 1, 2, 3].map(() =>
      spawnRacer(
        startAt,
        `const m = await import(${JSON.stringify(SINK_COORDINATES_MODULE)});
         // ACQUISITION FAILED — the shape both failing states collapse into: no FFI,
         // or FFI present and \`flock\` returning nonzero. The caller cannot tell them
         // apart and must not need to.
         const unacquired = { run: (_p, fn) => ({ acquired: false, value: fn() }) };
         while (Date.now() < START) {}
         process.stdout.write('RESULT:' + JSON.stringify({
           token: m.loadOrCreateSinkToken(${JSON.stringify(tokenPath)}, unacquired),
         }) + '\\n')`,
      ),
    )
    const results = await Promise.all(racers.map(racerResult))

    // (1) said out loud by every process that actually ran the weaker region, exactly
    // once each. NOT "every racer warns": a racer that arrives after a competitor has
    // published takes the fast read path, which needs no lock and correctly says
    // nothing — asserting otherwise made this test pass alone and fail in the full
    // file, which is the same over-reach this suite has already been caught in twice.
    const warners = results.filter((r) => r.__stderr.includes('flock(2) was not acquired'))
    if (warners.length === 0) {
      // Diagnosable rather than bare: this assertion went red once in a loaded
      // full-directory run and could not be reproduced in four subsequent runs, so if
      // it recurs the next reader gets the four racers' actual outcomes instead of a
      // boolean. A racer that arrives after a competitor has published legitimately
      // says nothing (fast path, no lock needed) — what must not happen is ALL of them
      // being silent, which would mean nobody entered the region at all.
      throw new Error(
        `no racer reported the unlocked region: ${JSON.stringify(
          results.map((r) => ({ token: r['token'], stderr: r.__stderr.slice(0, 300) })),
        )}`,
      )
    }
    expect(warners.length).toBeGreaterThan(0)
    for (const r of warners) {
      expect(r.__stderr.split('flock(2) was not acquired').length - 1).toBe(1)
      expect(r.__stderr).toContain('ISSUES #537')
    }

    // (2) every returned token was published somewhere a reader could have seen it.
    const published = new Set<string>([readFileSync(tokenPath, 'utf8').trim()])
    for (const name of readdirSync(dir)) {
      if (name.includes('.rejected.')) published.add(readFileSync(join(dir, name), 'utf8').trim())
    }
    for (const r of results) {
      expect(typeof r['token']).toBe('string')
      expect(published.has(r['token'] as string)).toBe(true)
    }
    // The destination is still a regular owner-only file with a real token.
    expect(readFileSync(tokenPath, 'utf8').trim()).toMatch(/^[0-9a-f]{48}$/)
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
  }, 20_000)

  test('the default lock REPORTS acquisition rather than capability', () => {
    // The three-state finding, pinned at the seam. `flockAvailable()` answers "did the
    // library load"; the guarantee needs "was the lock held", and those differ exactly
    // when a host looks capable and is not (`flock` returning nonzero, which
    // `withFlockSync` logs and then runs unguarded anyway). So the seam reports the
    // outcome, and on a host where locking works that report must be TRUE — a positive
    // control, without which `acquired` could be hardcoded false and every run would
    // warn, or hardcoded true and none would.
    const dir = scratch()
    const observed = defaultSinkTokenLock().run(join(dir, 'probe.lock'), () => 'body-ran')
    expect(observed.value).toBe('body-ran')
    expect(observed.acquired).toBe(flockAvailable())
    // …and the body runs either way: a lock that could not be acquired must not skip
    // the work, which is `withFlockSync`'s documented choice and the reason the caller
    // has to be told rather than protected.
    const unacquirable = defaultSinkTokenLock().run(join(dir, 'probe2.lock'), () => 42)
    expect(unacquirable.value).toBe(42)
  })

  test('the create path goes through the flock helper this directory already has', () => {
    // WIRING PIN for the reuse of `registry-lock.ts`'s `withFlockSync`: the sibling
    // lockfile only exists because the token install ran inside it. The `link`
    // publish above is the second, independent mechanism; this one pins the first.
    const dir = scratch()
    const tokenPath = join(dir, SINK_TOKEN_FILENAME)
    loadOrCreateSinkToken(tokenPath)
    expect(existsSync(sinkTokenLockPath(tokenPath))).toBe(true)
    expect(sinkTokenLockPath(tokenPath)).toBe(join(dir, `${SINK_TOKEN_FILENAME}.lock`))
    // The lock carries no secret — it exists only to be flocked.
    expect(readFileSync(sinkTokenLockPath(tokenPath), 'utf8')).toBe('')
  })
})

describe('a credential names WHICH session; a session id names nothing (#537)', () => {
  /**
   * THE INPUT A WRONG IMPLEMENTATION GETS RIGHT is not a foreign token, and it is not
   * a fabricated session id either — both are refused by any check that consults the
   * registry at all. The dangerous input is **a real id belonging to a live session,
   * presented by a caller that is not it**, because session ids are published to the
   * process table by `--session-id` / `--resume` (this tree's own
   * `orphan-adoption.ts` parses exactly that) while the sink token used to be shared
   * by every child. An orphan could read a live child's command line and be authorized
   * as it.
   *
   * A session id is an IDENTIFIER, not a credential. So these cases drive the seam the
   * other way round: the caller presents a per-child credential and the sink derives
   * which session that is.
   */
  async function post(
    port: number,
    credential: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: string }> {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sink-Token': credential },
      body: JSON.stringify(body),
    })
    return { status: resp.status, body: await resp.text() }
  }

  /** A wired bridge and tap, so nothing below is refused merely because the gateway had
   *  nothing to dispatch to — a 503 "unwired" would make these cases pass vacuously. */
  function wireBridgeAndTap(): { dispatched: string[]; tapped: string[] } {
    const dispatched: string[] = []
    const tapped: string[] = []
    setReplToolBridge({
      listToolSchemas: () => [
        { name: 'note', description: 'write a note', input_schema: { type: 'object' } },
      ],
      dispatch: async (input) => {
        dispatched.push(input.tool_name)
        return { ok: true }
      },
    })
    setReplActivityTap((row) => void tapped.push(row.tool_name))
    return { dispatched, tapped }
  }

  const PRIVILEGED = ['/tool-call', '/activity', '/tools'] as const

  function bodyFor(path: string, sessionId: string): Record<string, unknown> {
    if (path === '/tool-call') {
      return { session_id: sessionId, tool_name: 'note', args: { text: 'x' }, call_id: 'c1' }
    }
    if (path === '/activity') {
      return { session_id: sessionId, phase: 'pre', tool_name: 'Bash', detail: 'rm -rf' }
    }
    return { session_id: sessionId }
  }

  test('an orphan presenting a LIVE session\'s id — lifted from the process table — is refused', async () => {
    // THE CASE THE PREVIOUS ROUND MISSED. The orphan does not guess anything: it uses a
    // REAL id belonging to a session this gateway is driving right now, exactly as it
    // would read it out of `/proc/<pid>/cmdline`. What it does not have is that child's
    // credential.
    const dir = scratch()
    const s = await startSink({ port: freePort(), tokenPath: join(dir, SINK_TOKEN_FILENAME) })
    const { dispatched, tapped } = wireBridgeAndTap()

    const liveId = 'session-this-gateway-is-driving'
    const live = new ReplSession('key', 'generation-of-the-live-child', liveId, 'chan', dir)
    live.projectId = 'acme'
    s.register(liveId, live)

    // The orphan's OWN credential: minted for an incarnation that is gone.
    const orphanCredential = s.credentialFor(
      new ReplSession('key', 'generation-of-a-dead-child', liveId, 'chan', dir),
    )
    // And the instance root, which an orphan of the pre-#537 design would have carried.
    for (const credential of [orphanCredential, s.token]) {
      for (const path of PRIVILEGED) {
        const res = await post(s.port, credential, path, bodyFor(path, liveId))
        expect(res.status).toBe(401)
      }
    }
    // Nothing ran: the refusal is before the dispatch, not a status painted over a
    // side effect that already happened.
    expect(dispatched).toEqual([])
    expect(tapped).toEqual([])
    // …and `/reply` is not a softer door: an orphan must not be able to fabricate
    // assistant output into a live session's turn either.
    expect((await post(s.port, orphanCredential, '/reply', { session_id: liveId, text: 'forged' })).status).toBe(401)
  })

  test('an orphan whose session has since RESPAWNED is refused, though the id is unchanged', async () => {
    // Respawn-is-always-resume REUSES the session id, so a credential bound to the ID
    // would still be valid for the REPLACEMENT child — the orphan-from-a-previous-
    // generation case. Binding to the incarnation is what makes the old credential die.
    const dir = scratch()
    const s = await startSink({ port: freePort(), tokenPath: join(dir, SINK_TOKEN_FILENAME) })
    wireBridgeAndTap()

    const sessionId = 'session-that-gets-respawned'
    const first = new ReplSession('key', 'generation-1', sessionId, 'chan', dir)
    s.register(sessionId, first)
    const firstCredential = s.credentialFor(first)
    expect((await post(s.port, firstCredential, '/tool-call', bodyFor('/tool-call', sessionId))).status).toBe(200)

    // The respawn: same id, new incarnation. `unregisterIf` drops the old mapping, and
    // the replacement registers under the same id.
    const second = new ReplSession('key', 'generation-2', sessionId, 'chan', dir)
    s.unregisterIf(sessionId, first)
    s.register(sessionId, second)
    const secondCredential = s.credentialFor(second)
    expect(secondCredential).not.toBe(firstCredential)

    // The PREVIOUS incarnation's credential is dead even though its session id is live
    // again — which is the whole orphan scenario.
    expect((await post(s.port, firstCredential, '/tool-call', bodyFor('/tool-call', sessionId))).status).toBe(401)
    // …and the replacement works, or this test would pass against a sink that refuses
    // everything after a respawn.
    expect((await post(s.port, secondCredential, '/tool-call', bodyFor('/tool-call', sessionId))).status).toBe(200)
  })

  test('a replacement registered with NO unregister still revokes the displaced credential', async () => {
    // The production boundary. The respawn case above calls `unregisterIf` first, so it
    // walks around the path that actually runs: nothing in production is obliged to
    // unregister before a replacement registers, and `unregisterIf` is identity-guarded
    // — once B holds the id, A's own death handler no-ops. If `register` does not revoke
    // what it displaces, A's credential lives forever.
    const dir = scratch()
    const s = await startSink({ port: freePort(), tokenPath: join(dir, SINK_TOKEN_FILENAME) })
    wireBridgeAndTap()

    const sessionId = 'session-replaced-without-an-unregister'
    const first = new ReplSession('key', 'generation-1', sessionId, 'chan', dir)
    s.register(sessionId, first)
    const firstCredential = s.credentialFor(first)
    expect((await post(s.port, firstCredential, '/tool-call', bodyFor('/tool-call', sessionId))).status).toBe(200)

    // The replacement, with NO unregister of any kind in between.
    const second = new ReplSession('key', 'generation-2', sessionId, 'chan', dir)
    s.register(sessionId, second)
    const secondCredential = s.credentialFor(second)
    expect(secondCredential).not.toBe(firstCredential)

    // The displaced incarnation is refused on EVERY privileged route, not just the one
    // this test happened to open with.
    for (const path of PRIVILEGED) {
      expect((await post(s.port, firstCredential, path, bodyFor(path, sessionId))).status).toBe(401)
    }
    // The positive control: the replacement still works, so this cannot be satisfied by
    // a `register` that drops both credentials.
    expect((await post(s.port, secondCredential, '/tool-call', bodyFor('/tool-call', sessionId))).status).toBe(200)
  })

  test('the LEGITIMATE child still succeeds on every privileged route, with its scope', async () => {
    // The positive control. Without it, every refusal above is satisfied by a sink that
    // refuses everything — and the PR would have traded a security hole for an outage.
    const dir = scratch()
    const s = await startSink({ port: freePort(), tokenPath: join(dir, SINK_TOKEN_FILENAME) })
    const { dispatched, tapped } = wireBridgeAndTap()

    const sessionId = 'session-this-gateway-is-driving'
    const live = new ReplSession('key', 'generation-of-the-live-child', sessionId, 'chan', dir)
    live.projectId = 'acme'
    s.register(sessionId, live)
    const credential = s.credentialFor(live)

    for (const path of PRIVILEGED) {
      const res = await post(s.port, credential, path, bodyFor(path, sessionId))
      expect(res.status).toBe(200)
    }
    expect(dispatched).toEqual(['note'])
    expect(tapped).toEqual(['Bash'])
    // The credential also carries the SCOPE, because it resolved to the session: a
    // work-board write lands on that session's project, not the owner default.
    expect(JSON.parse((await post(s.port, credential, '/tools', { session_id: sessionId })).body).tools).toHaveLength(1)
  })

  test('a credential is accepted even when the body names a DIFFERENT session', async () => {
    // The body's `session_id` is advisory: the credential already said whose call this
    // is. Pinning that deliberately, because the alternative — cross-checking the two —
    // reads like extra safety and is not: an id a caller can read from the process table
    // adds nothing to a credential it cannot, and requiring them to agree would just
    // make a legitimate child fail when it reported its own id imprecisely.
    const dir = scratch()
    const s = await startSink({ port: freePort(), tokenPath: join(dir, SINK_TOKEN_FILENAME) })
    const { dispatched } = wireBridgeAndTap()
    const live = new ReplSession('key', 'generation-x', 'the-real-id', 'chan', dir)
    live.projectId = 'acme'
    s.register('the-real-id', live)

    const res = await post(s.port, s.credentialFor(live), '/tool-call', {
      session_id: 'some-other-live-looking-id',
      tool_name: 'note',
      args: {},
      call_id: 'c9',
    })
    expect(res.status).toBe(200)
    expect(dispatched).toEqual(['note'])
  })

  test('unregistering a session revokes its credential immediately — the reap has teeth', async () => {
    const dir = scratch()
    const s = await startSink({ port: freePort(), tokenPath: join(dir, SINK_TOKEN_FILENAME) })
    wireBridgeAndTap()
    const sessionId = 'session-about-to-be-evicted'
    const session = new ReplSession('key', 'generation-1', sessionId, 'chan', dir)
    s.register(sessionId, session)
    const credential = s.credentialFor(session)

    const before = await post(s.port, credential, '/tool-call', bodyFor('/tool-call', sessionId))
    s.unregister(sessionId)
    const after = await post(s.port, credential, '/tool-call', bodyFor('/tool-call', sessionId))

    expect(before.status).toBe(200)
    expect(after.status).toBe(401)
  })
})

describe('the OTHER direction — the gateway reaching a surviving child (#537)', () => {
  /** What a fake child actually RECEIVED, which is the only thing that proves the
   *  production request is the one the child would accept. */
  interface Received {
    path: string
    method: string
    token: string | null
    contentType: string | null
    body: string
  }

  /**
   * Stand-in for a surviving dev-channel, recording every request. Its auth is the
   * real child's, transcribed: `spawn.ts` bakes `SINK_TOKEN: sink.token` into the
   * child's MCP config env and the child refuses any inbound POST whose
   * `X-Sink-Token` differs (`dev-channel-impl.ts` — `if (req.method === 'POST' &&
   * SINK_TOKEN) { if (token !== SINK_TOKEN) return 401 }`).
   */
  function survivingChild(bakedToken: string, log: Received[]): ReturnType<typeof Bun.serve> {
    const s = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url)
        const token = req.headers.get('X-Sink-Token')
        log.push({
          path: url.pathname,
          method: req.method,
          token,
          contentType: req.headers.get('Content-Type'),
          body: await req.text(),
        })
        if (req.method === 'POST' && token !== bakedToken) {
          return Response.json({ status: 'unauthorized' }, { status: 401 })
        }
        return Response.json({ status: 'ok' })
      },
    })
    liveServers.push(s)
    return s
  }

  /** A live session registered with the sink, so a credential exists for it. */
  function liveSession(generation: string, port: number): ReplSession {
    const session = new ReplSession('key', generation, `sid-${generation}`, 'chan', '/tmp')
    session.channelPort = port
    sink.register(session.sessionId, session)
    registeredSessions.push(session)
    return session
  }

  test('the PRODUCTION inject path sends THIS CHILD\'S credential, in the request the child expects', async () => {
    // Drive the REAL function the substrate uses to deliver a turn into a live REPL
    // — not a hand-rolled fetch, and not a source-text assertion that a header
    // string appears somewhere in `spawn.ts`. An earlier version of this test did
    // exactly that, and it would have stayed green if `injectMessage` had changed
    // its URL, method, body or token, or stopped making the request at all.
    //
    // `injectMessage` reads the PROCESS SINGLETON's token, so the singleton is the
    // subject: start it the way production does, and that value is what `spawn.ts`
    // bakes into a child as `SINK_TOKEN`.
    //
    // THIS TEST OWNS ONE HALF OF THE DIRECTION AND SAYS WHICH. It proves the request
    // production actually makes — URL, method, content type, body, and that the token
    // on the wire is the SINK's rather than anything per-turn. That the sink's token is
    // the PERSISTED one is the other half, owned by the tests above that round-trip a
    // token file through two sink instances; two earlier versions of this test tried to
    // own both and each died on a different property of the shared process — first by
    // assuming the singleton used `defaultSinkTokenPath()`, then by assuming the file
    // it did use still EXISTS, when the foreign test that started the sink had already
    // removed its temp home. Neither was a logic error in the subject; both were this
    // test reaching for state it does not own. A composition of two proven claims is
    // honest where one over-reaching assertion is not.
    await getReplSinkInfo()
    const log: Received[] = []
    // The child is baked with ITS OWN credential — `HMAC(root, childGeneration)` — so
    // this fake child validates against exactly that, which is what the real
    // `dev-channel-impl.ts` does with the `SINK_TOKEN` it was handed.
    const placeholder = new ReplSession('key', 'gen-inject-1', 'sid-inject-1', 'chan', '/tmp')
    const baked = sink.credentialFor(placeholder)
    expect(baked).toMatch(/^[0-9a-f]{64}$/)
    const child = survivingChild(baked, log)
    const childPort = child.port
    if (childPort === undefined) throw new Error('fake child bound no port')
    const session = liveSession('gen-inject-1', childPort)

    await injectMessage(session, 'still here?', 'turn-9:1', true)

    expect(log.length).toBe(1)
    const got = log[0]
    if (got === undefined) throw new Error('no request recorded')
    expect(got.path).toBe('/message')
    expect(got.method).toBe('POST')
    expect(got.contentType).toBe('application/json')
    // THE POINT: the token on the wire is THIS CHILD'S credential, which is what the
    // child was baked with — so the gateway→child leg authenticates for the child it
    // is actually talking to, and for no other.
    expect(got.token).toBe(baked)
    expect(JSON.parse(got.body)).toEqual({
      text: 'still here?',
      turn_id: 'turn-9:1',
      additional: true,
    })
  })

  test('a child holding a DIFFERENT token refuses the production inject, and injectMessage says so', async () => {
    // The control that makes the assertion above meaningful: the token is what the
    // child authenticates on, and a mismatch is surfaced rather than swallowed —
    // which is precisely what every surviving REPL saw before #537.
    const log: Received[] = []
    const child = survivingChild('e'.repeat(48), log)
    const childPort = child.port
    if (childPort === undefined) throw new Error('fake child bound no port')
    // A DIFFERENT incarnation's session: its credential is not the one this child
    // holds, which is exactly the mismatch a stale coordinate produced before #537.
    const session = liveSession('gen-inject-2', childPort)

    await expect(injectMessage(session, 'stale secret', 'turn-9:2')).rejects.toThrow(
      /inject failed \(401\)/,
    )
    expect(log.length).toBe(1)
    expect(log[0]?.token).not.toBe('e'.repeat(48))
  })
})
