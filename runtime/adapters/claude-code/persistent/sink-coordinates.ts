/**
 * persistent-repl-substrate.ts → sink-coordinates.ts
 *
 * The DURABLE coordinates of the reply sink: its loopback PORT and its auth
 * TOKEN. Both used to be per-process values (`port: 0` + a fresh
 * `randomBytes(24)` per boot, in `pool-state.ts`'s `ReplSink`), and that is the
 * whole reason a REPL could not outlive its gateway (ISSUES #537).
 *
 * WHY A PROCESS-LOCAL PORT/TOKEN IS FATAL TO A SURVIVING REPL. The sink's
 * coordinates are BAKED into each spawned child at spawn time, in two places —
 * the per-session MCP config env (`spawn.ts`, `SINK_PORT`/`SINK_TOKEN` in the
 * `mcpServers` entry) and the settings hooks, as a literal shell env prefix
 * (`build-settings.ts`, the TodoWrite + activity-tap hook commands). The child
 * reads them ONCE at startup (`dev-channel-impl.ts` — `const SINK_PORT =
 * parseInt(process.env['SINK_PORT'] || '0', 10)`) and POSTs to
 * `http://127.0.0.1:${SINK_PORT}` for the rest of its life. There is no protocol
 * to re-point a running bridge. And the bridge DOES outlive a gateway restart:
 * `dev-channel-impl.ts` exits when *claude's* stdio closes, which a gateway
 * restart does not touch when the REPL is hosted outside the gateway process. So
 * the surviving bridge kept POSTing `/reply`, `/channel-ready`, `/tool-call`
 * into a dead port with a stale secret — silently.
 *
 * Making both coordinates STABLE (a per-instance derived loopback port + a token
 * persisted in the instance's supervision state dir) is what LETS a restarted
 * gateway adopt a REPL that is still running — a precondition, not the adoption
 * itself. Nothing here re-registers a surviving REPL into the sink's session map,
 * and `pool.ts` still needs an in-memory `session.channelPort` to inject, so today
 * a surviving bridge's `/reply` is refused with 401. Authorization runs
 * CREDENTIAL -> SESSION and the restarted sink has registered nothing, so the
 * survivor's credential resolves to no session and the request never reaches a
 * session lookup — there is no authenticated-but-unrouted state on this path, and
 * no `no-session` 404 (grep: the only `no-session*` in the adapter is
 * `no-session-to-resume`, a 409 in `session-respawn.ts`). Closing that is #539's
 * work; this is the coordinate half.
 *
 * SECURITY POSTURE, AND WHAT PERSISTING THE TOKEN WIDENS. `spawn.ts` writes the
 * per-session config dir 0700 and its files 0600 precisely BECAUSE they carry
 * this token in plaintext: any same-uid process that could read one would be able
 * to dispatch tools against the bridge. That reasoning is unchanged and those
 * modes are unchanged — but the exposure WINDOW is now wider, and this comment
 * says so plainly rather than pretending otherwise: a per-process token was worth
 * one gateway lifetime, whereas this file's token is worth every lifetime until
 * the file is removed. That widening is a DELIBERATE trade for restart survival,
 * not something this module eliminates. What it does do is keep the blast radius
 * as small as a file can be: owner-only at every instant — `open` is given 0600,
 * which a umask can only NARROW (0600 under `umask 0277` lands as 0400), and
 * `stageFreshToken` then normalises with `fchmod` on the descriptor it already
 * HOLDS, never on a path, so there is no window for a swap and the mode is never
 * group- or world-accessible even momentarily. The property that matters is that
 * last clause, not the absence of a chmod: a later TIGHTEN would be the unsafe
 * shape, because it cannot un-expose bytes another local user may already have
 * read, and nothing here ever starts wider and narrows. It is never inside a
 * working tree (it
 * lives in the same `<home>/.neutron` state dir as the REPL registry), refused
 * and re-minted if it is ever found group/world-accessible, and refused and
 * re-minted if it is a symlink or too short to be a real secret.
 *
 * SO THE TOKEN AUTHENTICATES THE CHANNEL AND A REGISTERED SESSION AUTHORIZES THE
 * ACTION — two questions, and one credential must not answer both. This is the part
 * of the posture that durability FORCED, and the reasoning outlives the fix: a
 * per-process token was REVOKED by every restart, so a `claude` orphaned by a
 * previous incarnation could not be believed by the next gateway, automatically. A
 * durable token does not revoke. You cannot make a credential longer-lived without
 * making it narrower, and this module made one longer-lived.
 *
 * WHAT SHIPS (`pool-state.ts`'s `ReplSink.handle`): authorization runs
 * CREDENTIAL -> SESSION. Every POST must present a per-child credential —
 * `HMAC(root token, childGeneration)`, handed only into that child's own 0600
 * config — and the sink DERIVES which session it belongs to. The body's
 * `session_id` is advisory: it never grants anything, because a session id is an
 * IDENTIFIER and not a credential. EVERY ROUTE — `/tools`, `/tool-call` and
 * `/activity` included — is behind that lookup. `/tools` and
 * `/tool-call` used to be answered AHEAD of that lookup, because they dispatch
 * against the process-global `ReplToolBridge` and carry no in-flight turn; true, and
 * beside the point, because the bridge is the most privileged thing the sink can
 * reach (`note`, `dispatch_agent`, `reminders`, `project_*`) and an orphan with a
 * fabricated `session_id` reached it. Measured at the time on a bridgeless instance:
 * 503 "no tool bridge wired" / "no-tap" — past the token check, stopped only by the
 * bridge being absent. The gate closes that, and it costs a live child nothing:
 * `spawnSession` registers the session BEFORE it spawns the child, so what is
 * refused is a call from a dying, evicted or orphaned one.
 *
 * THAT GAP IS NOW CLOSED, and this paragraph records it rather than still promising
 * it: the sink used to check that a caller named a session it drives, not that it
 * named its OWN, and the per-session token this note deferred is the credential
 * described above. `spawn.ts` derives and writes it per child. A previous revision
 * of this header still described the session-id gate as current and the credential
 * as future work, which is the more expensive half of the same mistake — a reader
 * would have believed the weaker design was what shipped.
 *
 * WHAT IS STILL OPEN, so this is not read as a clean bill: same-uid read access
 * defeats it. The credential lives in the child's own config (dir 0700, files 0600)
 * and in its process env, so anything running as the owner's uid that can read
 * those can impersonate that child. The acceptance criteria live in
 * `docs/spec-items/a-repl-must-survive-its-gateways-restart.md`.
 *
 * REUSE NOTE. `open/persisted-secret.ts` implements this same discipline. It
 * cannot be imported here — the `nobody-imports-composition` rule in
 * `.dependency-cruiser.cjs` forbids anything outside `^open`/`^gateway` from
 * importing `^open`, and `runtime/` is below that band — so the read/install
 * discipline below mirrors it deliberately, and the concurrency half is served by
 * the `flock(2)` helper that already exists in THIS directory
 * (`registry-lock.ts`'s `withFlockSync`) rather than by a second hand-rolled
 * lockfile protocol.
 *
 * A PREVIOUS REVISION OF THIS HEADER argued no lock was needed, "because the sink
 * binds an exclusive loopback port, so two live sinks cannot race over one token
 * file". That was wrong, and wrong in the way that mattered: the token is resolved
 * BEFORE the bind, so both processes are in the token path together and only one
 * of them goes on to hold the port. With an unconditional `rename` publish, the
 * process that LOST the bind could be the one whose token was left on disk — the
 * live gateway then authenticating with a secret the next gateway would not
 * present. Port exclusivity orders the SOCKET, never the file.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { withFlockSync } from './registry-lock.ts'

/**
 * The base of the sink's port window — and the only hard-coded port number here.
 *
 * WHY THIS NUMBER. It must be (a) outside Linux's default ephemeral range
 * (32768-60999 — a port inside it is randomly squatted by any outbound connection
 * or ephemeral listener on the box, which would turn the loud EADDRINUSE in
 * `pool-state.ts` into a coin flip) and (b) not otherwise used in this repo or in
 * `/etc/services`. Bound on 127.0.0.1 only, never a wide bind.
 */
export const SINK_PORT_WINDOW_BASE = 18537

/** Size of the window `deriveSinkPort` picks from: `18537 … 32767`, i.e. every
 *  port between the base and the bottom of the ephemeral range. */
export const SINK_PORT_WINDOW_SIZE = 32768 - SINK_PORT_WINDOW_BASE

/**
 * The port for the instance whose supervision state lives in `stateDir` —
 * DERIVED, not global.
 *
 * A SINGLE fixed port was the first shape of this change, and it was wrong in two
 * ways that a reviewer measured rather than argued:
 *
 *   - a second instance on one box could never bind (one port, two owners), so
 *     every spawn hard-failed until a human set an override that nothing generates;
 *     and
 *   - the test suite starts this sink from ~25 files, on boxes that also run a live
 *     gateway, and with the runner's own `JOBS>1` several test PROCESSES run at
 *     once. Measured on the single-port build: a held 18537 turned
 *     `tool-bridge.test.ts` into 1 pass / 8 fail, and three suites run concurrently
 *     lost 2/7/5 tests where `origin/main` lost none. `port: 0` is why they
 *     coexisted.
 *
 * Both are the same requirement: the port must be a function of the INSTANCE, not
 * of the box. `NEUTRON_HOME` already is per-instance, the token path is already
 * derived from it, and this hashes that same state dir into the window — so the
 * port is stable across restarts of one instance (the property #537 needs), and
 * different for a different instance, a different install, and every test process
 * (the preload gives each one a fresh `mkdtemp` home).
 *
 * It is a HASH, so two state dirs can collide (~1 in 14 000). That is not papered
 * over: the loser gets the loud EADDRINUSE failure, which names the port and the
 * override. The alternative — probing for a free port — would make the value
 * depend on who else was up at the time, which is exactly the non-reproducibility
 * this module exists to delete.
 */
export function deriveSinkPort(stateDir: string): number {
  const digest = createHash('sha256').update(stateDir).digest()
  return SINK_PORT_WINDOW_BASE + (digest.readUInt32BE(0) % SINK_PORT_WINDOW_SIZE)
}

/**
 * The PROCESS-WIDE port override, wired ONCE from the resolved `BootConfig` (see
 * {@link setReplSinkPortOverride}). Undefined ⇒ no override.
 *
 * A holder object rather than a `let`, so a setter in another module can reassign
 * it — the `replToolBridgeRef` / `todoSyncRef` / `activityTapRef` pattern this
 * sink's other process-level wiring already uses.
 */
const sinkPortOverrideRef: { current: number | undefined } = { current: undefined }

/**
 * Wire (or clear, with `undefined`) the operator's `NEUTRON_REPL_SINK_PORT`
 * override, as the composer resolved it.
 *
 * THIS REPLACED A SECOND READ OF `process.env`, and the difference is not
 * cosmetic. `resolveBootConfig()` is this tree's single env resolution; it already
 * validated and stored this knob as `BootConfig.replSinkPort`. While
 * `resolveSinkPort` ALSO read the raw environment, an injected `BootConfig` was
 * INERT — a caller could resolve a config carrying `NEUTRON_REPL_SINK_PORT=23456`,
 * boot from it with the process variable cleared, and watch the sink derive a
 * different port. Reviewed and reproduced. A fallback to the environment is what
 * keeps two such paths silently divergent (whichever one the caller forgot wins),
 * so there is no fallback: the value arrives here or it does not arrive.
 *
 * Wired next to `setReplActivityTap` in `composeProductionGraph`, from
 * `options.config` when an entrypoint threaded one and from `env` only when it did
 * not (the composer-direct / embed shape, where nothing resolved a config at all).
 */
export function setReplSinkPortOverride(port: number | undefined): void {
  sinkPortOverrideRef.current = port
}

/**
 * Coerce the RAW `NEUTRON_REPL_SINK_PORT` string (as `BootConfig` keeps it) into a
 * validated port, or `undefined` when it is unset/blank. Throws on a value that is
 * not a usable port — including 0 — through the same validator every other source
 * goes through.
 */
export function parseSinkPortOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return validateSinkPort(Number(raw.trim()), 'NEUTRON_REPL_SINK_PORT')
}

/**
 * THE ONE CHOKEPOINT every sink port passes through, whatever configured it.
 *
 * Precedence, highest first:
 *   1. `explicit` — `PersistentReplSubstrateOptions.sinkPort`, the per-substrate
 *      programmatic override (most specific, so it wins);
 *   2. the process override wired from `BootConfig.replSinkPort`
 *      ({@link setReplSinkPortOverride}) — the operator's per-box knob;
 *   3. `deriveSinkPort(stateDir)` — the per-instance default.
 *
 * Every override is VALIDATED here, by one function, in one way. An earlier
 * revision validated only the env value and passed the option straight to
 * `Bun.serve`, and both review gates measured what that cost: `sinkPort: 0` bound
 * 43235, `-1` bound 38983, `NaN` bound 37299 and `70000` silently became 65535 —
 * the exact failure this module exists to prohibit, reached through the seam
 * `types.ts` documents as *the* way a second instance gets its own port. A guard
 * that covers one source of a value is not a guard on the value.
 *
 * REFUSED, LOUDLY, RATHER THAN DEFAULTED: 0 above all (it *is* the bug — "let the
 * kernel choose" is unreproducible by the next process), and anything that is not
 * a whole port number. Silently falling back would leave the operator who typed
 * the value never learning it was ignored.
 */
export function resolveSinkPort(input: { explicit?: number; stateDir: string }): number {
  if (input.explicit !== undefined) return validateSinkPort(input.explicit, 'the sinkPort option')
  const wired = sinkPortOverrideRef.current
  if (wired !== undefined) return validateSinkPort(wired, 'the wired NEUTRON_REPL_SINK_PORT override')
  return deriveSinkPort(input.stateDir)
}

function validateSinkPort(candidate: number, source: string): number {
  if (candidate === 0) {
    throw new Error(
      `repl-sink: ${source} is 0, which asks the kernel for an EPHEMERAL port. ` +
        `The sink's port is baked into every spawned REPL and must be reproducible by the ` +
        `next gateway process, so 0 is refused (ISSUES #537). Leave it unset for the ` +
        `per-instance derived port, or name a fixed one.`,
    )
  }
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
    throw new Error(
      `repl-sink: ${source} is ${String(candidate)}, which is not a usable TCP port ` +
        `(want a whole number 1-65535, or nothing at all for the per-instance derived port).`,
    )
  }
  return candidate
}

/**
 * THE CREDENTIAL A CHILD ACTUALLY PRESENTS: `HMAC-SHA256(root token, childGeneration)`.
 *
 * WHY THE ROOT TOKEN IS NOT IT. Every child used to carry the instance's root token
 * and the sink authorized any `session_id` that was currently registered. Session ids
 * are NOT secrets — they are published to the process table by design, because
 * `--resume`/`--session-id` is how resume works, and this tree's own orphan scanner
 * parses exactly that representation (`orphan-adoption.ts`). So an orphan holding the
 * shared token could read a live child's `/proc/<pid>/cmdline`, lift its session id and
 * be authorized as it. **A session id is an identifier, not a credential**, and no
 * check that consults only an identifier can distinguish its owner from a reader.
 *
 * So authorization runs the other way: the caller presents a credential and the sink
 * derives WHICH SESSION that is. The properties this shape has, each load-bearing:
 *
 *   - PER CHILD. A child is handed only its own derived value, never the root, so it
 *     cannot compute another child's credential.
 *   - PER INCARNATION. `childGeneration` is a fresh UUID per spawn, and
 *     respawn-is-always-resume REUSES the session id — so a credential bound to the
 *     session id would stay valid for the REPLACEMENT child, which is precisely the
 *     orphan-from-a-previous-generation case. Binding to the generation makes the
 *     credential die with the process it was minted for.
 *   - NOT GUESSABLE FROM THE PROCESS TABLE. The generation is never on argv and never
 *     in the child's env; it lives in the gateway and in the 0600 registry row.
 *   - RECOMPUTABLE, SO NOTHING NEW IS STORED. A restarted gateway holding the root
 *     token plus the persisted `child_generation` can re-derive exactly the credential
 *     a surviving child is still presenting. That is what lets the adoption work in
 *     ISSUES #539 re-establish authorization with NO new secret at rest.
 *
 * HMAC rather than a hash of a concatenation: the root is a key here, not a prefix,
 * and length-extension games on `hash(root || generation)` are not worth the thought.
 */
export function deriveChildSinkToken(rootToken: string, childGeneration: string): string {
  return createHmac('sha256', rootToken).update(childGeneration).digest('hex')
}

/** Basename of the persisted token inside a supervision state dir. */
export const SINK_TOKEN_FILENAME = '.sink-token'

/** Bytes of entropy minted for a fresh token (48 hex chars — unchanged from the
 *  per-process `randomBytes(24)` this replaces). */
const SINK_TOKEN_BYTES = 24

/** Shortest on-disk value trusted as a token. A truncated/empty/whitespace file
 *  is not a secret; it is re-minted (loudly) rather than used. */
export const SINK_TOKEN_MIN_LEN = 32

// EXCLUSIVE, NO-FOLLOW create: O_CREAT|O_EXCL fails on ANY existing entry
// (including a symlink); O_NOFOLLOW is belt-and-suspenders.
const WX_NOFOLLOW =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW

/**
 * Where the token lives when NO path was wired.
 *
 * Production always wires one: `deriveReplSupervisionPaths(home).sinkTokenPath`
 * puts it in the instance's `<home>/.neutron` state dir next to the REPL
 * registry (`runtime/adapters/claude-code/index.ts`). This fallback serves the
 * callers that have no supervision home at all — `getReplSinkInfo()` in tests, an
 * LLM-less boot — and mirrors the SAME two rules that derivation uses: the
 * `<home>/.neutron` layout, and `NEUTRON_HOME` as the home of last resort
 * (`index.ts`'s `rawHome = process.env['NEUTRON_HOME']`). With neither, the token
 * goes to the OS temp dir — outside every working tree, which is the property
 * that must not be given up.
 *
 * BLANK IS UNSET, and the value is returned VERBATIM: the predicate trims, so an
 * empty or whitespace-only `NEUTRON_HOME` falls through to the temp dir rather
 * than resolving `.neutron` against the filesystem root — while a home whose real
 * bytes include surrounding spaces (a legal POSIX directory name) is used as
 * spelled, because trimming the RETURN silently relocates such a path. Both
 * halves are the rule `config/index.ts` states for this family of values and are
 * pinned in `__tests__/sink-restart-survival.test.ts`.
 */
export function defaultSinkTokenPath(): string {
  const envHome = process.env['NEUTRON_HOME']
  const home = envHome !== undefined && envHome.trim() !== '' ? envHome : tmpdir()
  return join(home, '.neutron', SINK_TOKEN_FILENAME)
}

type ReadResult =
  | { kind: 'ok'; value: string }
  /** Exists but is NOT trustworthy (symlink / non-regular / group- or
   *  world-accessible / too short) → re-mint, with a reason to report. */
  | { kind: 'reject'; why: string }
  /** No file → mint (first use). */
  | { kind: 'absent' }

/**
 * Read the token through a NO-FOLLOW, NON-BLOCKING DESCRIPTOR: open
 * `O_NOFOLLOW|O_NONBLOCK` (a symlink throws ELOOP → reject), `fstat` THAT fd
 * (require a regular file and owner-only permissions), then read the bytes FROM the
 * fd — no second path-based open, so there is no TOCTOU window between the
 * permission check and the read.
 *
 * `O_NONBLOCK` IS WHAT MAKES THE TYPE CHECK REACHABLE. Without it, a FIFO at the
 * token path blocks the OPEN until a writer appears — forever, in practice — so the
 * `isFile()` rejection below could never run for the very input it was written for,
 * and the gateway hung at startup instead of re-minting. Measured on the unpatched
 * tree: the process never returned, and a JS watchdog timer could not rescue it
 * either, because the blocking `openSync` pins the thread. A validation downstream of
 * an operation the invalid input can block is not a validation.
 *
 * It is ADDED to the original flags rather than replacing them: `O_NOFOLLOW` plus
 * `fstat` on the SAME fd is what defeats a symlink swap, which is a different threat
 * and still the right answer to it. That threat model was correct; it was not
 * complete, because it asked where the open LANDED and never what it landed ON.
 * `O_NONBLOCK` changes nothing for a regular file (it affects neither `read` nor the
 * bytes), so the happy path is byte-for-byte what it was. A socket answers ENXIO and
 * a device that would block answers immediately, both landing in the reject branch
 * below rather than hanging.
 */
function readSinkToken(path: string): ReadResult {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'reject', why: `unreadable (${code ?? 'unknown'})` }
  }
  try {
    const st = fstatSync(fd)
    // Every non-regular type lands here — FIFO, directory, socket, device — now that
    // the open above cannot be held hostage by one of them.
    if (!st.isFile()) return { kind: 'reject', why: 'not a regular file' }
    const perms = st.mode & 0o777
    // THE INVARIANT IS "NO GROUP OR OTHER ACCESS", and this predicate says exactly
    // that. Any group/other bit means another local user may ALREADY have read the
    // token and could dispatch tools against every live bridge; a chmod cannot
    // un-expose it, so such a file is compromised and is replaced rather than
    // tightened-and-trusted.
    //
    // IT IS NOT `perms !== 0o600`. It was, for one round, to mirror
    // `open/persisted-secret.ts` and because "a file this code did not write with
    // exactly 0600 has unknown provenance" sounded like the same thing. It is not the
    // same thing: equality on a permission mask ALSO refuses files that are STRICTER
    // than demanded — 0400 under a hardened umask — and refusing those costs
    // everything on this path. The read side would silently re-mint a token that was
    // never exposed, stranding every child baked with it; the create side (see
    // `confirmInstalled`) would THROW and the sink would never start. An operator with
    // `umask 0277` is not a threat model. Provenance is not what this check can
    // establish anyway — an attacker who can write this directory can write 0600.
    if ((perms & 0o077) !== 0) {
      return {
        kind: 'reject',
        why: `mode ${perms.toString(8).padStart(4, '0')} grants group/other access`,
      }
    }
    const value = readFileSync(fd, 'utf8').trim()
    if (value.length < SINK_TOKEN_MIN_LEN) {
      return { kind: 'reject', why: `value too short (${value.length} chars)` }
    }
    return { kind: 'ok', value }
  } catch (err) {
    return { kind: 'reject', why: `read failed (${err instanceof Error ? err.message : String(err)})` }
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* already closed / invalid fd — non-fatal */
    }
  }
}

/** The advisory lockfile that serialises token CREATION/REPLACEMENT for a token
 *  path — a sibling of the token, the way `registryLockPath` is a sibling of the
 *  registry. Never holds a secret; it exists only to be flocked. */
export function sinkTokenLockPath(tokenPath: string): string {
  return join(dirname(tokenPath), `${SINK_TOKEN_FILENAME}.lock`)
}

/**
 * Write a fresh secret to a UNIQUE temp sibling at mode 0600 and return both. The
 * file is CREATED 0600 (`O_CREAT|O_EXCL`, no chmod afterwards) and the write loops
 * to completion, because a legal short write would otherwise publish a TRUNCATED
 * token.
 *
 * THE STAGING NAME IS RANDOM, AND THAT IS NOT A CONTRADICTION OF THE TOKEN BEING
 * DERIVED. The two requirements are opposites and both are deliberate:
 *
 *   - the PORT must be DETERMINISTIC and the TOKEN must be STABLE — different
 *     properties with the same purpose, and conflating them reads as though the token
 *     were re-derivable, i.e. computable by anyone who knows the inputs. The port is
 *     derived (`deriveSinkPort`, a hash of the state dir, nothing stored); the token is
 *     minted with `randomBytes` and made stable by PERSISTING it. Either way a child
 *     baked with them
 *     has to still authenticate after a restart — that IS #537;
 *   - this STAGING NAME must be UNIQUE, because nothing ever reads it by name and
 *     its only job is that two writers never choose the same path.
 *
 * An earlier revision built it from `process.pid` plus a counter that restarted at 1
 * in every process, which made it deterministic in the one place determinism is a
 * defect: a process killed between the `openSync` and the publish leaves
 * `.sink-token.<pid>.1.tmp` behind, and the next process to be given that PID
 * within the sweep's 60s window picks the SAME name, gets `EEXIST` from `O_EXCL`,
 * and throws — so the sink never starts. That is a crash remnant preventing the very
 * restart this module exists to make survivable, which is the failure mode and not
 * an edge case. Random bytes delete the class outright, rather than a retry loop
 * that would paper over it one iteration wider, and `O_EXCL` goes back to guarding
 * what it is for: a genuine concurrent staging attempt, not a dead process's litter.
 * The PID is kept in the name purely so an operator can see who left an orphan; the
 * uniqueness comes from the random half alone.
 */
/** Age after which an unpublished staging file is certainly an orphan: a stage +
 *  publish is a handful of syscalls, so anything this old belongs to a process that
 *  was killed between the two. */
const STALE_STAGING_MS = 60_000

/**
 * Drop OUR OWN litter once it is certainly dead: staging files a killed process left
 * behind (between `openSync` and the publish, the one window where our temp name can
 * outlive us) and quarantined rejected tokens, which are kept for a while so an
 * operator can see what was refused. Best-effort and bounded: it runs only on the
 * create/replace path, which a healthy instance takes once in its lifetime, and it
 * only ever removes names derived from the token's own.
 */
function sweepStaleStaging(dir: string): void {
  try {
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      // Our litter: staging files AND quarantined rejects, both named from the token.
      if (!name.startsWith(`${SINK_TOKEN_FILENAME}.`)) continue
      if (!name.endsWith('.tmp') && !name.includes('.rejected.')) continue
      const candidate = join(dir, name)
      try {
        if (now - statSync(candidate).mtimeMs > STALE_STAGING_MS) unlinkSync(candidate)
      } catch {
        /* vanished or not ours to remove — non-fatal */
      }
    }
  } catch {
    /* unreadable dir — the install below surfaces a real failure */
  }
}

/**
 * The staging path for one publish attempt. Exported because its contract is a
 * REQUIREMENT rather than an implementation detail — two writers must never choose
 * the same path, in this process or in any other — and that is testable directly
 * here, where an assertion about it cannot be satisfied by accident.
 */
export function stagingTokenPath(dir: string): string {
  return join(dir, `${SINK_TOKEN_FILENAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
}

function stageFreshToken(dir: string): { tmp: string; secret: string } {
  sweepStaleStaging(dir)
  const secret = randomBytes(SINK_TOKEN_BYTES).toString('hex')
  const tmp = stagingTokenPath(dir)
  const fd = openSync(tmp, WX_NOFOLLOW, 0o600)
  try {
    const buf = Buffer.from(`${secret}\n`, 'utf8')
    let written = 0
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written)
      if (n <= 0) throw new Error(`short write: ${written}/${buf.length} bytes`)
      written += n
    }
    // NORMALISE THE MODE ON THE FD WE ALREADY HOLD. POSIX applies the process umask
    // to the `open` mode, so `0600` under `umask 0277` lands as 0400 — owner-only, so
    // perfectly safe, but not what was asked for. `fchmod` on this descriptor (never a
    // path — no window for a swap) makes every token this code writes exactly 0600
    // whatever the operator's umask, which keeps the on-disk fleet uniform. It is
    // belt to the predicate's braces, NOT a substitute: the acceptance rule stays
    // "no group or other access", because a 0400 token from an older build or another
    // umask must still be USABLE rather than re-minted.
    fchmodSync(fd, 0o600)
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* non-fatal */
    }
  }
  return { tmp, secret }
}

function discard(tmp: string): void {
  try {
    unlinkSync(tmp)
  } catch {
    /* already gone — non-fatal */
  }
}

/**
 * Confirm what is actually on disk at `path` and return those bytes.
 *
 * NOT A GUARD, AND LABELLED AS ONE RATHER THAN COUNTED AS TWO. Both assertions
 * below — the mode re-check on the installed file and the read-back — are
 * belt-and-braces behind the create mode (`O_CREAT|O_EXCL, 0600` plus the `fchmod`)
 * and the atomic publish. The mode assertion asks the INVARIANT (no group/other
 * access) and not equality with 0600: an earlier revision asked for equality here
 * and that is a boot-block, because `umask 0277` makes the file 0400 — stricter than
 * demanded, and refused. No test can reach either without
 * sabotaging the filesystem, so neither is mutation-provable, and the honest
 * statement is that the guarantee comes from the CREATE, which IS mutation-proved.
 * They stay because the cost is two syscalls and the failure they would catch (a
 * token readable by another local user) is the one this module must never tolerate
 * silently.
 */
function confirmInstalled(path: string): string {
  const perms = statSync(path).mode & 0o777
  if ((perms & 0o077) !== 0) {
    throw new Error(
      `repl-sink: refusing to use sink token at ${path}: it was created with mode ${perms
        .toString(8)
        .padStart(4, '0')}, which grants group/other access`,
    )
  }
  const back = readSinkToken(path)
  if (back.kind !== 'ok') {
    throw new Error(
      `repl-sink: could not confirm the sink token just written to ${path} (${
        back.kind === 'reject' ? back.why : 'vanished'
      })`,
    )
  }
  return back.value
}

/**
 * CREATE-IF-ABSENT, and LOSE GRACEFULLY.
 *
 * `link(tmp, path)` publishes the staged token under its final name in ONE atomic
 * syscall that FAILS with EEXIST if anything is already there. So a first-boot
 * race has exactly one winner, and every loser re-reads and ADOPTS the winner's
 * token instead of overwriting it.
 *
 * WHY NOT `rename`, which this used to do. `rename` succeeds unconditionally, and
 * two processes minting at the same moment therefore both "won": A published token
 * A and bound the port; B published token B and lost the bind. The live gateway
 * then authenticated with A while the disk held B — so the NEXT gateway start
 * presented B to children baked with A, which is the precise failure this whole
 * change exists to prevent. Port exclusivity cannot serialise it, because the
 * token is resolved BEFORE the bind. `rename` survives in exactly two places and
 * NEITHER publishes over the destination: it moves a STAGED file into a name that is
 * absent (`link`'s loser cleanup aside, that is this function), and it moves an
 * UNTRUSTED file ASIDE into a unique quarantine name (`replaceUntrustedToken`, which
 * then comes back through the `link` publish here). An earlier revision did use it to
 * publish a replacement over the destination; that was the same defect this paragraph
 * describes, one function over.
 */
function createTokenIfAbsent(path: string): string {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const { tmp } = stageFreshToken(dir)
  try {
    linkSync(tmp, path)
  } catch (err) {
    discard(tmp)
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // Someone else got there first. Their token is COMPLETE (they linked it, so it
    // was fully written before it had a name), so adopt it.
    const winner = readSinkToken(path)
    if (winner.kind === 'ok') return winner.value
    // The name exists but is not trustworthy (a hostile plant, or a file from an
    // older build). Hand it to the replacement path, which quarantines it and comes
    // back here — one hop, not a loop: the quarantine makes the name ABSENT, so the
    // next `link` either wins or adopts a competitor's good token, and neither
    // outcome re-enters this branch.
    return replaceUntrustedToken(path, winner.kind === 'reject' ? winner.why : 'vanished')
  }
  // The inode now has two names; drop ours and keep the published one.
  discard(tmp)
  return confirmInstalled(path)
}

/**
 * Replace a file that exists but cannot be trusted (symlink, non-regular,
 * group/other-accessible, empty/whitespace/short) with a fresh owner-only token —
 * and CONVERGE with any other process doing the same thing at the same moment.
 *
 * IT USED TO BE AN UNCONDITIONAL `rename`, and that was the PR's own failure mode
 * reachable through the PR's own code. Two processes finding the same bad file both
 * published: A renamed token A and read A back, B renamed token B and bound the
 * port, and the live sink then authenticated with a secret the disk did not hold —
 * which is #537, on the restart-overlap path that #537 exists to make survivable. A
 * documented residual is only honest when the scenario is incidental, and two
 * gateways overlapping IS the scenario.
 *
 * The shape now, in order, and what each step is worth:
 *
 *   1. RE-VERIFY under the caller's lock, immediately before acting: if the name has
 *      become trustworthy since we decided to replace it, ADOPT it and write nothing.
 *      That is what makes a competitor's freshly published token survive us instead
 *      of being clobbered by a decision taken before it existed.
 *   2. MOVE THE BAD FILE ASIDE to a unique quarantine name (one atomic `rename`),
 *      rather than renaming over the name. Losing that race is fine and expected —
 *      `ENOENT` means a competitor already moved it.
 *   3. CREATE-IF-ABSENT at the real name via `createTokenIfAbsent`'s `link`, which
 *      has exactly ONE winner; every loser re-reads and ADOPTS the winner's bytes.
 *
 * So the value returned is always the value ON DISK, and two concurrent replacers
 * end up holding the SAME token rather than two different ones.
 *
 * WHAT IS STILL NOT CLOSED, stated rather than implied, because "return what is on
 * disk" does not by itself converge: a re-read happens at a moment, and a writer can
 * land after it. If B's re-verify (1) observes the bad file in the instant before A's
 * `link` (3) publishes, B will quarantine A's good token and publish its own, and A —
 * which already read its own value back — diverges from the disk. That window is a
 * few syscalls wide, requires an ALREADY-INVALID token file plus a second process
 * entering the same region within it, and it is the residue of a compare-and-swap on
 * a filename, which POSIX does not offer. Closing it entirely needs serialisation:
 * `withFlockSync` provides exactly that whenever Bun's FFI is available, which is
 * every supported deployment — it is defence in depth here, NOT the correctness
 * argument, because the steps above converge without it.
 */
function replaceUntrustedToken(path: string, why: string): string {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  // (1) A competitor may have published a good token since the caller looked. This
  // step NARROWS the window rather than closing it, and it is not mutation-provable:
  // remove it and the four-process tests stay green, because what it protects against
  // is a sub-syscall interleaving. It stays because it is two syscalls and it is the
  // difference between "a competitor's fresh token survives us" and "we clobber it".
  const current = readSinkToken(path)
  if (current.kind === 'ok') return current.value
  process.stderr.write(
    `[repl-sink] refusing the sink token at ${path}: ${why}; minting a replacement. ` +
      `Every REPL spawned before this moment can no longer reach the sink and must be respawned.\n`,
  )
  // (2) Quarantine under a unique name — never `rename` over the destination, which
  // is what let two writers both "succeed". The rejected bytes are kept, not
  // unlinked: an operator investigating a refused token can still see what was there,
  // and the sweep removes it with the rest of our litter.
  const quarantined = `${path}.rejected.${randomBytes(6).toString('hex')}`
  try {
    renameSync(path, quarantined)
  } catch (err) {
    // ENOENT: a competitor moved it first — fine, we are both heading for (3).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  // (3) One winner, and every loser adopts the winner's bytes.
  return createTokenIfAbsent(path)
}

/**
 * The serialisation the token's create/replace region runs under, and WHETHER IT WAS
 * ACTUALLY HELD.
 *
 * THE DOMAIN HAS THREE STATES AND A BOOLEAN CAPABILITY FLAG COVERS TWO. `flock(2)`
 * can be unavailable (no FFI), available and ACQUIRED, or available and NOT acquired
 * — `withFlockSync` logs a nonzero `flock` and then deliberately runs the body
 * unguarded anyway. An earlier revision of this seam carried `available:
 * flockAvailable()`, which reports only whether the LIBRARY LOADED: the third state,
 * the one where a host looks fully capable and silently is not, was advertised as
 * successful locking and produced no warning. "The library loaded" was standing in
 * for "the lock is held", and those differ exactly when it matters.
 *
 * So `run` REPORTS the outcome instead of the caller inferring it from a proxy, and
 * the two failing states collapse into the one thing the caller must act on: the
 * region was not serialised. A generic lock cannot name what is weaker for a specific
 * caller, and by the same argument it must not decide what to do about it — it
 * reports, the caller rules.
 *
 * This is also the seam both directions are TESTED through: a test can inject a lock
 * that genuinely serialises (`O_EXCL` + spin, no FFI needed) or one that reports
 * `acquired: false`, which is the only way to reach either branch deterministically on
 * a real host.
 */
export interface SinkTokenLockResult<T> {
  /** True only if the region was genuinely serialised across processes. */
  acquired: boolean
  value: T
}

export interface SinkTokenLock {
  run: <T>(lockPath: string, fn: () => T) => SinkTokenLockResult<T>
}

/** Production's lock: `registry-lock.ts`'s `flock(2)`, reporting what actually
 *  happened rather than what was installed. */
export function defaultSinkTokenLock(): SinkTokenLock {
  return {
    run: <T>(lockPath: string, fn: () => T): SinkTokenLockResult<T> => {
      let acquired = false
      const value = withFlockSync(lockPath, fn, (ok) => {
        acquired = ok
      })
      return { acquired, value }
    },
  }
}

/** One warning per process, not per mint. */
let warnedUnlocked = false

function warnUnlockedOnce(path: string): void {
  if (warnedUnlocked) return
  warnedUnlocked = true
  process.stderr.write(
    `[repl-sink] flock(2) was not acquired, so the sink token at ${path} was ` +
      `created/replaced WITHOUT cross-process serialisation. Creation is still ` +
      `winner-preserving (one atomic link), but a concurrent REPLACEMENT of an ` +
      `untrusted token can leave this gateway holding a token the file does not: if a ` +
      `second process re-verifies in the instant before this one publishes, it will ` +
      `quarantine the token just published and publish its own. A restart then hands ` +
      `surviving REPLs a secret they do not have (ISSUES #537).\n`,
  )
}

/**
 * Load the persisted sink token from `path`, creating it 0600 on first use.
 *
 * An existing, trustworthy token is returned UNCHANGED — that is the property a
 * restarted gateway depends on, because the surviving children were baked with
 * it — and that fast path takes no lock and writes nothing. An existing but
 * UNTRUSTWORTHY one is replaced, loudly: silently using it would defeat the
 * 0700/0600 posture the spawn-time config files maintain, and silently failing
 * would strand every REPL.
 *
 * CONCURRENT STARTUP, AND EXACTLY WHAT IS GUARANTEED. Two processes can both see
 * "absent" or both see the same bad file — the token is resolved before the port is
 * bound, so the port cannot serialise them — and the live sink's token MUST equal the
 * token on disk or the next restart hands children a secret they do not have. Two
 * mechanisms, with DIFFERENT strengths, and the difference is the point:
 *
 *   1. `createTokenIfAbsent`'s `link`-based publish has exactly one winner and every
 *      loser adopts. This needs NO lock: concurrent CREATION converges
 *      unconditionally.
 *   2. `replaceUntrustedToken` quarantines and then goes through that same publish,
 *      which makes concurrent REPLACEMENT converge WHILE THE LOCK IS HELD. Without a
 *      lock a narrow window remains — the interleaving is spelled out on that
 *      function — because replacing is a compare-and-swap on a filename and POSIX
 *      offers none.
 *
 * So the lock is load-bearing for (2) and not for (1), and a host without FFI gets a
 * one-time warning naming precisely that, rather than a quietly weaker guarantee.
 */
export function loadOrCreateSinkToken(path: string, lock?: SinkTokenLock): string {
  const found = readSinkToken(path)
  if (found.kind === 'ok') return found.value
  const effective = lock ?? defaultSinkTokenLock()
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    /* the staged write below surfaces a real failure */
  }
  const { acquired, value } = effective.run(sinkTokenLockPath(path), () => {
    // Re-read INSIDE the lock: a competitor may have installed a good token in the
    // window between the fast-path read and the lock being granted.
    const underLock = readSinkToken(path)
    if (underLock.kind === 'ok') return underLock.value
    if (underLock.kind === 'reject') return replaceUntrustedToken(path, underLock.why)
    return createTokenIfAbsent(path)
  })
  // WARNED ON THE FACT, NOT ON A PROXY FOR IT. `acquired` is false when FFI is
  // missing AND when `flock` returned nonzero — two states that look different to a
  // capability check and identical to the guarantee. After the region rather than
  // before, because that is when the answer exists; a region that THREW never reports,
  // and the caller has an error instead of a token, which is louder than any warning.
  if (!acquired) warnUnlockedOnce(path)
  return value
}
