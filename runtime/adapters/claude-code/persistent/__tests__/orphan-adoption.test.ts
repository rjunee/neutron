/**
 * orphan-adoption.test.ts — cross-restart orphan-REPL identity check (ISSUES #105).
 *
 * Simulates the post-restart wedge: an old `claude --resume` survived a gateway
 * restart with a dead dev-channel, the registry still carries its pid, and the
 * in-memory pool has NO entry. The respawn must:
 *   (a) adopt-or-KILL the VERIFIED-ours pid and NOT launch a 2nd concurrent
 *       resume (the resume awaits the orphan's death before spawning), AND
 *   (b) NOT kill a pid whose cmdline does NOT match (recycled-pid safety).
 *
 * Drives the real `adoptOrKillOrphan` / `registerOrphanKill` / `cmdlineMatchesSession`
 * with injected OS deps — no real `ps`, no real `claude`, no module-global pool.
 */

import { describe, it, expect } from 'bun:test'
import {
  adoptOrKillOrphan,
  cmdlineMatchesSession,
  registerOrphanKill,
  type OrphanAdoptionDeps,
} from '../orphan-adoption.ts'

const SESSION = 'b1f3c0de-1234-5678-9abc-def012345678'
/** A realistic cross-restart orphan cmdline (matches build-repl-argv output). */
const OURS_CMDLINE =
  `/usr/local/bin/claude --resume ${SESSION} ` +
  `--dangerously-load-development-channels server:neutron-abcd --tools "" --model claude-opus-4-7`
/** The fresh-spawn shape (`--session-id` instead of `--resume`). Also ours. */
const OURS_FRESH_CMDLINE =
  `/Users/x/.local/bin/claude --session-id ${SESSION} ` +
  `--dangerously-load-development-channels server:neutron-abcd --tools "" --model claude-opus-4-7`
/** A recycled pid now running something unrelated — same number, different proc. */
const RECYCLED_CMDLINE = '/usr/sbin/cupsd -l -f'
/**
 * THE recycled-pid trap (Argus r1 BLOCKER). A recycled pid running `tail -f` on
 * OUR transcript: the path lives under `.claude/` (so the `claude` substring is
 * present) AND embeds the session uuid (so the uuid substring is present). The
 * old loose `includes('claude') && includes(uuid)` matcher returned TRUE here and
 * would have SIGKILLed an unrelated process. The argv0 + `--resume`-value check
 * must reject it.
 */
const RECYCLED_TAIL_TRANSCRIPT =
  `/usr/bin/tail -f /Users/x/.claude/projects/-Users-x-repo/${SESSION}.jsonl`
/** Same trap via an editor with the transcript open. */
const RECYCLED_EDITOR_TRANSCRIPT =
  `/usr/bin/vim /Users/x/.claude/projects/-Users-x-repo/${SESSION}.jsonl`

function deps(over: Partial<OrphanAdoptionDeps> & { killed?: number[] } = {}): {
  deps: OrphanAdoptionDeps
  killed: number[]
  terminateResolvedBefore: () => boolean
} {
  const killed = over.killed ?? []
  let terminateDone = false
  const d: OrphanAdoptionDeps = {
    isPidAlive: over.isPidAlive ?? (() => true),
    readCmdline: over.readCmdline ?? (() => OURS_CMDLINE),
    terminatePid:
      over.terminatePid ??
      (async (pid: number) => {
        // Simulate a SIGTERM that takes a tick to land.
        await Promise.resolve()
        killed.push(pid)
        terminateDone = true
      }),
    log: () => {},
  }
  return { deps: d, killed, terminateResolvedBefore: () => terminateDone }
}

describe('cmdlineMatchesSession — identity marker', () => {
  it('matches the resume shape (`--resume <uuid>` after a claude argv0)', () => {
    expect(cmdlineMatchesSession(OURS_CMDLINE, SESSION)).toBe(true)
  })

  it('matches the fresh-spawn shape (`--session-id <uuid>` after a claude argv0)', () => {
    expect(cmdlineMatchesSession(OURS_FRESH_CMDLINE, SESSION)).toBe(true)
  })

  it('rejects a cmdline missing the session UUID (recycled pid)', () => {
    expect(cmdlineMatchesSession(RECYCLED_CMDLINE, SESSION)).toBe(false)
  })

  it('rejects a non-claude process that coincidentally carries the UUID', () => {
    expect(cmdlineMatchesSession(`/usr/bin/tail -f /logs/${SESSION}.jsonl`, SESSION)).toBe(false)
  })

  // ── Argus r1 BLOCKER: the recycled-pid trap (RED before fix, GREEN after) ──
  it('rejects `tail -f` on OUR transcript under .claude (uuid + "claude" substring both present)', () => {
    // The OLD loose matcher returned TRUE here (`.claude` path → "claude"
    // substring; `<uuid>.jsonl` → uuid substring) and would have SIGKILLed an
    // unrelated recycled process. argv0=tail + no `--resume <uuid>` → must reject.
    expect(cmdlineMatchesSession(RECYCLED_TAIL_TRANSCRIPT, SESSION)).toBe(false)
  })

  it('rejects an editor (`vim`) with OUR transcript under .claude open', () => {
    expect(cmdlineMatchesSession(RECYCLED_EDITOR_TRANSCRIPT, SESSION)).toBe(false)
  })

  it('rejects the uuid appearing only as a substring, NOT as the --resume/--session-id value', () => {
    // claude argv0 present, but the uuid is buried in --add-dir, not after a
    // resume flag — must NOT match (a different session resumed in our cwd).
    const OTHER = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb'
    const cmd =
      `/usr/local/bin/claude --resume ${OTHER} ` +
      `--add-dir /Users/x/.claude/projects/-Users-x/${SESSION} --model claude-opus-4-7`
    expect(cmdlineMatchesSession(cmd, SESSION)).toBe(false)
  })

  // ── Argus r2 IMPORTANT: the node-arm substring lookalike (RED before fix) ──
  it('rejects `node /opt/claude-tools/runner.js --resume <uuid>` (substring `/claude`, NOT our claude)', () => {
    // The OLD node-arm accepted any early arg where `t.includes('/claude')` — a
    // SUBSTRING on a SIGKILL path (the exact anti-pattern r1 eliminated):
    // `/opt/claude-tools/runner.js` contains `/claude` so it passed arm 1 even
    // though its basename is `runner.js`, not `claude`. A kill-gate matcher must
    // be EXACT shape: argv0's claude marker is a PATH-SEGMENT (basename) match,
    // not a substring. RED before the fix, GREEN after.
    const cmd = `node /opt/claude-tools/runner.js --resume ${SESSION} --model claude-opus-4-7`
    expect(cmdlineMatchesSession(cmd, SESSION)).toBe(false)
  })

  it('still matches the legitimate node-launched shape `node /usr/local/bin/claude --resume <uuid>` (basename claude)', () => {
    // Guard against over-tightening: when `ps` surfaces the interpreter as argv0
    // (a `#!/usr/bin/env node`-shebang launcher), the early `claude`-basename arg
    // must still match — this is the shape our spawn path can legitimately produce
    // (the launcher file is always named `claude`; see build-repl-argv.ts).
    const cmd = `node /usr/local/bin/claude --resume ${SESSION} --model claude-opus-4-7`
    expect(cmdlineMatchesSession(cmd, SESSION)).toBe(true)
  })

  // ── Argus r4 BLOCKER: the node-arm later-positional false positive (RED before fix) ──
  it('rejects `node /opt/runner.js /tmp/claude --resume <uuid>` (claude is a LATER app arg, NOT the script slot)', () => {
    // The OLD node-arm scanned EVERY non-flag positional before the first flag and
    // matched if ANY had basename `claude`. A recycled `node /opt/runner.js
    // /tmp/claude --resume <uuid>` runs an UNRELATED script (`runner.js`, tokens[1])
    // and only carries a `claude`-basename token as a LATER positional APP arg
    // (`/tmp/claude`, tokens[2]) — NOT our `<interpreter> <claude-script> --flags…`
    // launch shape — yet it passed, so adoptOrKillOrphan would SIGKILL an innocent
    // recycled process. Same recycled-pid-false-positive class as r1/r2/r3, one
    // token position over. The fix checks ONLY the script slot (tokens[1]). RED
    // before the fix, GREEN after.
    const cmd = `node /opt/runner.js /tmp/claude --resume ${SESSION} --model claude-opus-4-7`
    expect(cmdlineMatchesSession(cmd, SESSION)).toBe(false)
  })

  it('rejects undefined / empty cmdline', () => {
    expect(cmdlineMatchesSession(undefined, SESSION)).toBe(false)
    expect(cmdlineMatchesSession('', SESSION)).toBe(false)
  })

  // ── Argus r3 BLOCKER: CLAUDE_BIN override basename (RED before threading) ──
  it('matches a resumed REPL spawned under a custom CLAUDE_BIN basename when that basename is configured', () => {
    // A self-hoster running CLAUDE_BIN=/opt/bin/claude-headless spawns a resumed
    // REPL whose argv0 basename is `claude-headless`. The matcher must compare
    // argv0 basename against the CONFIGURED basename (not the literal `claude`),
    // else it returns not-ours for OUR OWN orphan → killChild skips the kill →
    // spawnResume launches a 2nd --resume → two processes on one transcript
    // (#105 UNFIXED on the binary-override surface). RED with the default
    // `claude`, GREEN when the configured basename is threaded through.
    const cmd = `/opt/bin/claude-headless --resume ${SESSION} --model claude-opus-4-7`
    expect(cmdlineMatchesSession(cmd, SESSION, 'claude-headless')).toBe(true)
  })

  it('matches the node-launched shape under a custom CLAUDE_BIN basename', () => {
    // Same override, but `ps` surfaces the interpreter as argv0 (shebang launcher):
    // `node /opt/bin/claude-headless --resume <uuid>`. The early non-flag arg's
    // basename (`claude-headless`) must match the configured basename.
    const cmd = `node /opt/bin/claude-headless --resume ${SESSION} --model claude-opus-4-7`
    expect(cmdlineMatchesSession(cmd, SESSION, 'claude-headless')).toBe(true)
  })

  it('a custom-basename orphan is REJECTED when the matcher still uses the default `claude`', () => {
    // The defeat condition itself: when the configured basename is NOT threaded
    // (matcher compares against default `claude`), our own `claude-headless`
    // orphan reads as not-ours. This is exactly the r3 failure the threading fixes.
    const cmd = `/opt/bin/claude-headless --resume ${SESSION} --model claude-opus-4-7`
    expect(cmdlineMatchesSession(cmd, SESSION)).toBe(false)
  })

  it('default `claude` and a path-to-claude still match after the basename param is added', () => {
    // Guard: threading the configured basename must NOT regress the default shape.
    expect(cmdlineMatchesSession(OURS_CMDLINE, SESSION, 'claude')).toBe(true)
    expect(cmdlineMatchesSession(OURS_CMDLINE, SESSION)).toBe(true)
  })

  it('rejects a default-`claude` orphan when a DIFFERENT basename is configured', () => {
    // Symmetric guard: if the running process is a plain `claude` but the deploy
    // configured `claude-headless`, that argv0 is not the configured binary →
    // reject (fails safe, never kills a process the config says isn't ours).
    expect(cmdlineMatchesSession(OURS_CMDLINE, SESSION, 'claude-headless')).toBe(false)
  })
})

describe('adoptOrKillOrphan — verdicts', () => {
  it('(a) verified-ours alive pid → KILLED (terminated)', async () => {
    const { deps: d, killed } = deps()
    const verdict = await adoptOrKillOrphan(4242, SESSION, d)
    expect(verdict).toBe('killed')
    expect(killed).toEqual([4242])
  })

  it('(b) recycled pid (alive, cmdline mismatch) → NOT-OURS, never terminated', async () => {
    const { deps: d, killed } = deps({ readCmdline: () => RECYCLED_CMDLINE })
    const verdict = await adoptOrKillOrphan(4242, SESSION, d)
    expect(verdict).toBe('not-ours')
    expect(killed).toEqual([]) // recycled-pid safety: we did NOT SIGTERM it
  })

  it('(b′) recycled pid running `tail -f OUR-transcript` → NOT-OURS, never terminated (Argus r1 BLOCKER)', async () => {
    const { deps: d, killed } = deps({ readCmdline: () => RECYCLED_TAIL_TRANSCRIPT })
    const verdict = await adoptOrKillOrphan(4242, SESSION, d)
    expect(verdict).toBe('not-ours')
    expect(killed).toEqual([]) // would have been SIGKILLed by the old loose matcher
  })

  it('dead pid → DEAD, cmdline never read, never terminated', async () => {
    let cmdlineReads = 0
    const { deps: d, killed } = deps({
      isPidAlive: () => false,
      readCmdline: () => {
        cmdlineReads++
        return OURS_CMDLINE
      },
    })
    const verdict = await adoptOrKillOrphan(4242, SESSION, d)
    expect(verdict).toBe('dead')
    expect(cmdlineReads).toBe(0)
    expect(killed).toEqual([])
  })

  it('missing / invalid pid → NO-PID', async () => {
    const { deps: d } = deps()
    expect(await adoptOrKillOrphan(undefined, SESSION, d)).toBe('no-pid')
    expect(await adoptOrKillOrphan(0, SESSION, d)).toBe('no-pid')
    expect(await adoptOrKillOrphan(-1, SESSION, d)).toBe('no-pid')
  })

  it('cmdline unreadable (ps failure) → NOT-OURS (safe direction, no kill)', async () => {
    const { deps: d, killed } = deps({ readCmdline: () => undefined })
    expect(await adoptOrKillOrphan(4242, SESSION, d)).toBe('not-ours')
    expect(killed).toEqual([])
  })
})

describe('registerOrphanKill — cross-restart killChild→spawnResume ordering (#105)', () => {
  it('(a) registers an orphan-termination promise; the resume that awaits it does NOT spawn until the verified orphan is dead — exactly ONE resume', async () => {
    // Simulate makeReplRespawnDeps' pending-kill seam + spawnResume's await.
    const pending = new Map<string, Promise<void>>()
    const killed: number[] = []
    let terminateDone = false
    const d: OrphanAdoptionDeps = {
      isPidAlive: () => true,
      readCmdline: () => OURS_CMDLINE,
      terminatePid: async (pid) => {
        await Promise.resolve()
        await Promise.resolve()
        killed.push(pid)
        terminateDone = true
      },
      log: () => {},
    }

    // killChild (cross-restart branch): no in-memory child; registry has the pid.
    registerOrphanKill(
      'instance-a /home/a',
      { pid: 4242, sessionId: SESSION },
      d,
      (k, p) => pending.set(k, p),
    )

    // spawnResume: must await the pending kill BEFORE launching the resume.
    let resumeSpawns = 0
    const spawnResume = async (sessionKey: string) => {
      const pendingKill = pending.get(sessionKey)
      pending.delete(sessionKey)
      if (pendingKill !== undefined) await pendingKill
      // INVARIANT: by the time we spawn, the orphan must already be dead.
      expect(terminateDone).toBe(true)
      resumeSpawns++
    }

    await spawnResume('instance-a /home/a')
    expect(killed).toEqual([4242]) // the verified orphan was killed
    expect(resumeSpawns).toBe(1) // exactly ONE resume — no concurrent 2nd process
  })

  it('(b) recycled pid → registers a NO-OP kill; resume spawns without killing the unrelated process', async () => {
    const pending = new Map<string, Promise<void>>()
    const killed: number[] = []
    const d: OrphanAdoptionDeps = {
      isPidAlive: () => true,
      readCmdline: () => RECYCLED_CMDLINE, // pid recycled to an unrelated process
      terminatePid: async (pid) => {
        killed.push(pid)
      },
      log: () => {},
    }

    registerOrphanKill(
      'instance-a /home/a',
      { pid: 4242, sessionId: SESSION },
      d,
      (k, p) => pending.set(k, p),
    )

    let resumeSpawns = 0
    const spawnResume = async (sessionKey: string) => {
      const pendingKill = pending.get(sessionKey)
      if (pendingKill !== undefined) await pendingKill
      resumeSpawns++
    }
    await spawnResume('instance-a /home/a')

    expect(killed).toEqual([]) // recycled-pid safety: never SIGTERM'd
    expect(resumeSpawns).toBe(1)
  })

  it('no pid in the record → registers nothing', () => {
    const pending = new Map<string, Promise<void>>()
    const { deps: d } = deps()
    registerOrphanKill('k', { sessionId: SESSION }, d, (k, p) => pending.set(k, p))
    expect(pending.size).toBe(0)
  })
})
