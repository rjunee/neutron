/**
 * CODE GATE — the pool's liveness keepalive MUST carry `keepalive: true`.
 *
 * WHY A SOURCE-LEVEL GATE. This one line is the linchpin of the whole Activity
 * Inspector: `pool.ts` pushes a synthetic `status` heartbeat on a timer while the
 * `claude` child is alive, and the inspector's two-clocks design distinguishes it from
 * real work SOLELY by that flag (the two events are byte-identical otherwise). Drop
 * the flag and every keepalive counts as activity, so a wedged session reports as
 * working forever — ISSUES #386 rebuilt, and rebuilt SILENTLY, because nothing else
 * in the system reads the flag.
 *
 * Exercising it behaviourally would mean spawning a real `claude` REPL and waiting out
 * a ~10 s keepalive interval, which is neither cheap nor reliable in a unit suite. So
 * this asserts the source, in the same spirit as the repo's other code gates (e.g. the
 * trident "no `claude -p` in the live path" grep gate). It is a narrow, honest guard:
 * it cannot prove the interval fires, but it does catch the one silent regression that
 * would gut the feature — verified by mutation (removing the flag reddens this file,
 * and reddened nothing before it existed).
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const POOL = join(import.meta.dir, '..', 'pool.ts')

describe('pool.ts liveness keepalive', () => {
  const src = readFileSync(POOL, 'utf8')

  it('pushes the periodic keepalive status WITH the synthetic marker', () => {
    // The keepalive lives inside the `setInterval` that runs while the turn is
    // unsettled and the child is alive. Locate that interval body and assert its
    // status push is marked.
    const idx = src.indexOf('const keepalive = setInterval(')
    expect(idx).toBeGreaterThan(-1)
    const body = src.slice(idx, idx + 1200)
    const push = /channel\.push\(\{\s*kind:\s*'status',[^}]*\}\)/.exec(body)
    expect(push).not.toBeNull()
    expect(push![0]).toContain('keepalive: true')
  })

  it('does NOT mark the INJECT-time status — that one is real turn progress', () => {
    // The push right after `injectMessage` means "the turn actually went in", which is
    // genuine progress and must advance the real-activity clock. Marking it synthetic
    // would make a just-injected turn look like it had done nothing.
    const idx = src.indexOf('const initialDelivery = injectMessage(session.channelPort, spec.prompt, turn.turnId)')
    expect(idx).toBeGreaterThan(-1)
    const push = /channel\.push\(\{\s*kind:\s*'status',[^}]*\}\)/.exec(src.slice(idx, idx + 800))
    expect(push).not.toBeNull()
    expect(push![0]).not.toContain('keepalive')
  })

  it('is the ONLY event PUSH in the pool that marks a status synthetic', () => {
    // A second synthetic producer would be a second thing able to fake liveness, and
    // it should have to justify itself here rather than appear silently. Counted over
    // `channel.push(...)` calls specifically, so prose mentioning the flag (including
    // the rationale comment beside it) does not inflate the count.
    const pushes = src.match(/channel\.push\(\{[^}]*\}\)/g) ?? []
    const marked = pushes.filter((p) => /keepalive:\s*true/.test(p))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain("kind: 'status'")
  })
})
