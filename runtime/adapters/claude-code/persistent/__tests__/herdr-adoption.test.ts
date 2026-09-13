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


describe('detach gives up the pane without ending it — MEASURED against the server', () => {
  /**
   * ARGUS r25. The survival branch hands a live pane to the next gateway, and the
   * retiring wrapper must stop watching and typing without closing anything. The whole
   * design rests on one assumption — that stopping the poll loop is "issue no more
   * requests" rather than "tear down a session" — and that assumption is exactly the one
   * whose failure turns a safe detach into a pane kill. So it is measured here against
   * the real client and the fake server, not reasoned about from the client's source.
   */
  it('issues no further reads, delivers no further screens, and closes NOTHING', async () => {
    const server = new FakeHerdrServer({ paneId: 'w9:p50' })
    const screens: string[] = []
    const child = await hostFor(server).spawn(['claude'], {
      cwd: '/tmp',
      env: {},
      onScreen: (t) => screens.push(t),
    })
    child.beginOutput?.()
    // Let it poll a few times so "it stopped" is distinguishable from "it never started".
    await until(() => server.calls.filter((c) => c.method === 'pane.read').length >= 3, 'polled')
    const readsBefore = server.calls.filter((c) => c.method === 'pane.read').length
    const screensBefore = screens.length

    child.detach?.()
    await Bun.sleep(60)

    // NO FURTHER OBSERVATION. Allow the one read that may already have been in flight
    // when detach landed — the loop can be inside an await — but no more than that.
    const readsAfter = server.calls.filter((c) => c.method === 'pane.read').length
    expect(readsAfter - readsBefore).toBeLessThanOrEqual(1)
    // Deliveries stop outright, because delivery is gated on the flag rather than on the
    // loop having noticed it.
    expect(screens.length).toBe(screensBefore)

    // AND NOTHING WAS CLOSED OR KILLED. This is the measurement the design rests on.
    expect(server.calls.filter((c) => /close|kill|destroy/i.test(c.method))).toEqual([])
    // The pane is still there, per the server itself.
    const inspection = await hostFor(server).inspectHandle('w9:p50')
    expect(inspection.kind).toBe('live')
  })

  it('a read already IN FLIGHT when detach lands delivers nothing', async () => {
    // THE WINDOW THE DELIVERY GATE EXISTS FOR, and the only one it covers: stopping the
    // loop prevents the NEXT read, and says nothing about the one already awaiting a
    // reply. Without holding a read open this case cannot be constructed — the loop is
    // simply stopped and there is nothing left to deliver — which is why an earlier
    // version of the gate mutation would not red.
    const server = new FakeHerdrServer({ paneId: 'w9:p52' })
    const screens: string[] = []
    const child = await hostFor(server).spawn(['claude'], {
      cwd: '/tmp',
      env: {},
      onScreen: (t) => screens.push(t),
    })
    child.beginOutput?.()
    await until(() => server.calls.some((c) => c.method === 'pane.read'), 'first read')
    const before = screens.length
    const readsBefore = server.calls.filter((c) => c.method === 'pane.read').length

    // Hold the NEXT read open, wait until it is genuinely in flight, then detach under it.
    const release = server.holdMethod('pane.read')
    await until(
      () => server.calls.filter((c) => c.method === 'pane.read').length > readsBefore,
      'a read is in flight',
    )
    server.screen = 'a brand new screen the retired wrapper must never see'
    child.detach?.()
    release()
    await Bun.sleep(40)

    expect(screens.length).toBe(before)
  })

  it('sends NOTHING after detach, and tells the caller it was not delivered', async () => {
    // ARGUS r26. The detach cases above covered reads, screens and the absence of close
    // calls, and never attempted an ACTUATION — so a detach that blinded the wrapper
    // while leaving its keyboard connected satisfied all of them. Typing is the half with
    // teeth: the hazard is a retired gateway answering a detector prompt on the owner's
    // live REPL.
    const server = new FakeHerdrServer({ paneId: 'w9:p53' })
    const child = await hostFor(server).spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()

    // THE POSITIVE CONTROL FIRST, in the same case: actuation works before the detach, so
    // the refusals below cannot be passing because typing is broken outright.
    child.writeKey?.('enter')
    await until(() => server.delivered.some((c) => c.method === 'pane.send_keys'), 'a key landed')
    const keysBefore = server.delivered.filter((c) => c.method === 'pane.send_keys').length

    child.detach?.()
    child.writeKey?.('enter')
    child.write?.('some text')
    await Bun.sleep(40)

    // NOTHING REACHED THE PANE. `delivered` rather than `calls`: it is pushed after the
    // hold and the failure check, so it is what the pane would really have seen.
    expect(server.delivered.filter((c) => c.method === 'pane.send_keys')).toHaveLength(keysBefore)
    expect(server.delivered.filter((c) => c.method === 'pane.send_text')).toEqual([])
  })

  it('a call QUEUED BEFORE the detach does not run after it', async () => {
    // The execution-time re-check is the one `detached` most needs to be in: a queue moves
    // the moment of execution away from the moment of the check, so a call accepted before
    // the detach would otherwise type into a pane this wrapper has already given up.
    const server = new FakeHerdrServer({ paneId: 'w9:p54' })
    const child = await hostFor(server).spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    // Hold the actuation the queue is about to run, so the next one is stuck behind it.
    const release = server.holdMethod('pane.send_keys')
    child.writeKey?.('enter')
    await until(() => server.calls.some((c) => c.method === 'pane.send_keys'), 'first key in flight')

    child.writeKey?.('enter')
    // Detach while the second call is still waiting its turn.
    child.detach?.()
    release()
    await Bun.sleep(40)

    // Exactly the one that was already in flight reached the pane; the queued one did not.
    expect(server.delivered.filter((c) => c.method === 'pane.send_keys')).toHaveLength(1)
  })

  it('AND THE CALLER IS TOLD: an interrupt after detach reports not-delivered', async () => {
    // The reported channel, at the one public surface that has it. A caller that latched
    // before calling must hear that nothing was sent — the property `send`'s
    // `onNotDelivered` already argues for, now reachable through detach as well as exit.
    const server = new FakeHerdrServer({ paneId: 'w9:p56' })
    const child = await hostFor(server).spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    child.detach?.()
    child.kill('SIGINT')
    await Bun.sleep(40)
    // THE LATCH IS THE REPORTED CHANNEL at this surface: `send`'s `onNotDelivered` fires
    // `skipped`, which clears `interruptedByUs`. A caller that recorded the turn as
    // abandoned on the strength of an interrupt that never left the process would be
    // making exactly the claim this branch spent four rounds removing.
    expect(child.wasInterruptedByUs?.()).toBe(false)
    expect(server.delivered.filter((c) => c.method === 'pane.send_keys')).toEqual([])
  })

  it('submitLine after detach THROWS rather than reporting a submission that did not happen', async () => {
    const server = new FakeHerdrServer({ paneId: 'w9:p55' })
    const child = await hostFor(server).spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    // Control: it works before.
    await child.submitLine?.('hello')
    expect(server.delivered.some((c) => c.method === 'pane.send_text')).toBe(true)
    const textsBefore = server.delivered.filter((c) => c.method === 'pane.send_text').length

    child.detach?.()
    await expect(child.submitLine?.('after')).rejects.toThrow(/after DETACH/)
    expect(server.delivered.filter((c) => c.method === 'pane.send_text')).toHaveLength(textsBefore)
  })

  it('THE CONTROL: kill DOES end it, so detach is not simply inert', async () => {
    // Without this, a `detach` that did nothing at all — and a `kill` that did nothing at
    // all — would satisfy the case above equally well.
    const server = new FakeHerdrServer({ paneId: 'w9:p51' })
    const child = await hostFor(server).spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    child.kill()
    await child.exited
    expect(server.calls.some((c) => /close|kill/i.test(c.method))).toBe(true)
  })
})
