/**
 * herdr-adoption.test.ts — #539 seam 1/2 at the HOST boundary: a pane can be
 * inspected, re-attached and closed by a process that did not create it.
 *
 * The whole acceptance rests on one property of the herdr backend: a pane is a child
 * of the herdr SERVER, so a gateway restart does not end it and a later gateway can
 * pick it up. These cases pin the three operations that makes possible, and — more
 * importantly — the two places where being wrong is destructive:
 *
 *   - a FAILED ATTACH MUST NOT CLOSE THE PANE. The spawn path closes a pane it
 *     created and could not finish wiring, because otherwise it manufactures an
 *     orphan. The attach path must do the OPPOSITE: the pane was already running the
 *     previous gateway's REPL and its conversation, and destroying it to tidy up our
 *     own wiring failure is the worst outcome available.
 *   - `pane_not_found` and "the call failed" MUST NOT COLLAPSE. Only the first says
 *     the pane is gone; treating the second as absence is how a second owner gets
 *     started on a transcript that already has one.
 */

import { describe, expect, it } from 'bun:test'
import { HerdrHost } from '../herdr-host.ts'
import { FakeHerdrServer, until } from './herdr-fake-server.ts'
import { HerdrError } from '../herdr-client.ts'
import { HERDR_PANE_NOT_FOUND } from '../herdr-protocol.ts'

const hostFor = (server: FakeHerdrServer): HerdrHost =>
  new HerdrHost({
    connect: async () => server,
    pollIntervalMs: 10,
    sleep: (ms) => Bun.sleep(ms),
    workspaceId: 'w9',
    pidWaitMs: 200,
  })

describe('the spawned child carries its durable handle', () => {
  it('paneHandle is the pane id the server minted, not the one we asked for', async () => {
    const server = new FakeHerdrServer({ paneId: 'w9:p42' })
    const child = await hostFor(server).spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    expect(child.paneHandle).toBe('w9:p42')
    child.kill()
    await child.exited
  })
})

describe('inspectHandle reports what the HOST sees', () => {
  it('live, with the foreground argv and pid', async () => {
    const server = new FakeHerdrServer({ paneId: 'w9:p1', shellPid: 999 })
    server.foregroundArgv = ['claude', '--resume', 'abc']
    const v = await hostFor(server).inspectHandle('w9:p1')
    expect(v).toEqual({ kind: 'live', argv: ['claude', '--resume', 'abc'], pid: 999, label: 'neutron-repl' })
  })

  it('a live pane herdr has no process sample for reports an EMPTY argv, not a failure', async () => {
    const server = new FakeHerdrServer()
    server.foregroundArgv = []
    const v = await hostFor(server).inspectHandle(server.paneId)
    expect(v.kind).toBe('live')
    expect(v.kind === 'live' && v.argv).toEqual([])
  })

  it('a TYPED pane_not_found is `gone`', async () => {
    const server = new FakeHerdrServer()
    server.paneGone = true
    expect((await hostFor(server).inspectHandle(server.paneId)).kind).toBe('gone')
  })

  it('an UNTYPED failure is `unavailable` — the question failed, the pane may be alive', async () => {
    const server = new FakeHerdrServer()
    server.transientFailure = true
    const v = await hostFor(server).inspectHandle(server.paneId)
    expect(v.kind).toBe('unavailable')
  })

  it('a process_info failure on an EXISTING pane is `unavailable`, never a verdict about the process', async () => {
    const server = new FakeHerdrServer()
    server.foregroundArgv = ['claude']
    server.failMethod('pane.process_info')
    const v = await hostFor(server).inspectHandle(server.paneId)
    // NOT `live` with an empty argv: that would be classified as "not ours" — a
    // finding about the process — when what happened is that we could not look.
    expect(v.kind).toBe('unavailable')
  })

  it('a SUCCESSFUL reply carrying no pane is `unavailable`, not `gone`', async () => {
    const server = new FakeHerdrServer()
    server.malformMethod('pane.get', { type: 'pane_info' })
    expect((await hostFor(server).inspectHandle(server.paneId)).kind).toBe('unavailable')
  })
})

describe('the protocol gate covers the adoption surface too', () => {
  it('a server on another protocol is UNAVAILABLE — not gone, not live', async () => {
    const server = new FakeHerdrServer()
    server.foregroundArgv = ['claude', '--resume', 'abc']
    server.malformMethod('ping', { type: 'pong', version: '0.9.9', protocol: 99 })
    const v = await hostFor(server).inspectHandle(server.paneId)
    // The pane may be perfectly alive; what we cannot do is READ this server's answers
    // with the semantics this client was measured against. Declining is the safe
    // direction, and `gone` would license a cold spawn over a live REPL.
    expect(v.kind).toBe('unavailable')
    expect(v.kind === 'unavailable' && v.reason).toContain('protocol')
  })

  it('and a close is REFUSED on that server, having closed nothing', async () => {
    const server = new FakeHerdrServer()
    server.malformMethod('ping', { type: 'pong', version: '0.9.9', protocol: 99 })
    await expect(hostFor(server).closeHandle(server.paneId)).rejects.toThrow(/protocol/)
    expect(server.paneClosed).toBe(false)
    expect(server.callsTo('pane.close')).toHaveLength(0)
  })

  it('the SAME calls succeed against a server on the measured protocol', async () => {
    // The positive control: the two refusals above are the gate firing, not the
    // methods being broken.
    const server = new FakeHerdrServer()
    server.foregroundArgv = ['claude']
    expect((await hostFor(server).inspectHandle(server.paneId)).kind).toBe('live')
    await hostFor(server).closeHandle(server.paneId)
    expect(server.paneClosed).toBe(true)
  })
})

describe('attach re-attaches to a pane this process did not create', () => {
  it('delivers the pane\'s screens and creates NOTHING', async () => {
    const server = new FakeHerdrServer({ paneId: 'w9:p7' })
    server.screen = 'the previous gateway left this on screen'
    const screens: string[] = []
    const child = await hostFor(server).attach('w9:p7', {
      cwd: '/tmp',
      env: {},
      onScreen: (s) => screens.push(s),
    })
    child.beginOutput?.()
    await until(() => screens.length > 0, 'first screen')
    expect(screens[0]).toBe('the previous gateway left this on screen')
    expect(child.paneHandle).toBe('w9:p7')
    // The attach path must never exec anything.
    expect(server.callsTo('layout.apply')).toHaveLength(0)
    child.kill()
    await child.exited
  })

  it('REFUSES a pane that does not exist rather than spawning a replacement', async () => {
    const server = new FakeHerdrServer()
    server.paneGone = true
    await expect(hostFor(server).attach(server.paneId, { cwd: '/tmp', env: {} })).rejects.toThrow(
      /does not exist/,
    )
    expect(server.callsTo('layout.apply')).toHaveLength(0)
  })

  it('DOES NOT CLOSE THE PANE when wiring fails after the pane was claimed', async () => {
    // The pid never arrives — the same refusal the spawn path makes. On a spawn that
    // closes the pane; on an attach it must not, because the pane is somebody else's
    // live conversation.
    const server = new FakeHerdrServer({ shellPid: null })
    await expect(hostFor(server).attach(server.paneId, { cwd: '/tmp', env: {} })).rejects.toThrow(
      /never reported a pid/,
    )
    expect(server.paneClosed).toBe(false)
    expect(server.callsTo('pane.close')).toHaveLength(0)
  })

  it('the SPAWN path still closes a pane it created and could not wire', async () => {
    // The positive control for the case above: the difference is the path, not the
    // fixture. Same failure, opposite obligation.
    const server = new FakeHerdrServer({ shellPid: null })
    await expect(hostFor(server).spawn(['claude'], { cwd: '/tmp', env: {} })).rejects.toThrow(
      /never reported a pid/,
    )
    expect(server.paneClosed).toBe(true)
  })
})

describe('closeHandle', () => {
  it('closes the pane', async () => {
    const server = new FakeHerdrServer()
    await hostFor(server).closeHandle(server.paneId)
    expect(server.paneClosed).toBe(true)
  })

  it('is idempotent on a pane that is already gone', async () => {
    const server = new FakeHerdrServer()
    server.paneGone = true
    await hostFor(server).closeHandle(server.paneId)
    expect(server.paneClosed).toBe(false)
  })

  it('REJECTS on any other failure — a close that did not happen must not read as one that did', async () => {
    const server = new FakeHerdrServer()
    server.failMethod('pane.close', new Error('server busy'))
    await expect(hostFor(server).closeHandle(server.paneId)).rejects.toThrow(/server busy/)
    expect(server.paneClosed).toBe(false)
    // And the typed absence still resolves, so the two are genuinely distinguished.
    server.clearFailure('pane.close')
    server.failMethod('pane.close', new HerdrError(HERDR_PANE_NOT_FOUND, 'pane not found'))
    await hostFor(server).closeHandle(server.paneId)
  })
})
