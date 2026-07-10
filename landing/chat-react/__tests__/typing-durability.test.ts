/**
 * W7 sub-fix (c) / #356 — the typing indicator is TURN-SCOPED and
 * RECONNECT-DURABLE.
 *
 * The live symptom (jank report #356): a 162s cold-start agent turn showed NO
 * typing indicator because the app-ws churned (open→close→open reconnect) during
 * the wait and the "agent is replying" state was dropped — the chat "looked
 * dead". The indicator renders off `vm.awaitingFirstToken` (the optimistic
 * on-send bracket, plus the server-authoritative `agent_typing` frames) ORed with
 * `vm.hasActiveWork` (the board `in_progress` signal).
 *
 * The durability invariant this pins: a socket status churn (`reconnecting` /
 * `closed` / `open`) mid-turn NEVER clears the awaiting bracket — only a real
 * reply / error / command result / project switch does. So the dots survive the
 * whole cold-start, across as many reconnects as the wait takes. Driven at the
 * controller seam with a fake session so we can inject status + frames directly
 * (no real socket timing).
 */
import { describe, expect, it } from 'bun:test'

import {
  NeutronChatController,
  type ControllerSession,
  type ControllerSinks,
} from '../controller.ts'

const TOPIC = 'app:sam'

/** A minimal fake session that captures the controller's sinks so a test can
 *  drive `onStatus` / `onFrame` / `onChange` directly. */
function setup(projectId: string | null = null) {
  let sinks!: ControllerSinks
  const fake: ControllerSession = {
    start() {},
    stop() {},
    setActive() {},
    status() {
      return 'open'
    },
    async send() {},
    async messages() {
      return []
    },
    async pendingCount() {
      return 0
    },
  }
  const controller = new NeutronChatController({
    projectId,
    createSession: (s) => {
      sinks = s
      return fake
    },
  })
  return { controller, sinks: () => sinks }
}

describe('#356 — typing indicator survives app-ws reconnect churn', () => {
  it('keeps the awaiting bracket lit across reconnecting→closed→open after an optimistic send', async () => {
    const { controller, sinks } = setup()
    controller.start()

    await controller.send('kick off a cold-start turn')
    // Optimistic bracket on immediately (no stream yet).
    expect(controller.getViewModel().awaitingFirstToken).toBe(true)

    // The app-ws churns while the cold workspace wakes — the EXACT sequence the
    // #356 report logged. None of these may drop the bracket.
    for (const status of ['reconnecting', 'closed', 'connecting', 'open', 'reconnecting', 'open'] as const) {
      sinks().onStatus(status)
      expect(controller.getViewModel().awaitingFirstToken).toBe(true)
    }

    // The real reply finally streams → the bracket clears (turn-scoped: it ends
    // when the turn does, not when the socket flaps).
    sinks().onFrame({ v: 1, type: 'agent_message_partial', message_id: 'm1', body_delta: 'Hi', ts: 1 })
    expect(controller.getViewModel().awaitingFirstToken).toBe(false)
  })

  it('keeps the server-authoritative agent_typing state lit across a reconnect', async () => {
    const { controller, sinks } = setup()
    controller.start()

    // A warm turn with no optimistic send: the gateway fans `agent_typing start`
    // when it picks up the live turn. (No project_id → not a foreign frame.)
    sinks().onFrame({ v: 1, type: 'agent_typing', state: 'start', ts: 1 })
    expect(controller.getViewModel().awaitingFirstToken).toBe(true)

    // Reconnect churn mid-typing → bracket persists.
    sinks().onStatus('reconnecting')
    sinks().onStatus('open')
    expect(controller.getViewModel().awaitingFirstToken).toBe(true)

    // The turn settles → the server fans `end` (a dropped `end` is also covered:
    // the next agent_message clears it regardless).
    sinks().onFrame({ v: 1, type: 'agent_typing', state: 'end', ts: 2 })
    expect(controller.getViewModel().awaitingFirstToken).toBe(false)
  })

  it('a genuine project switch DOES reset the bracket (it is turn-scoped, not global)', async () => {
    const { controller, sinks } = setup('alpha')
    controller.start()
    await controller.send('hi on alpha')
    expect(controller.getViewModel().awaitingFirstToken).toBe(true)

    // Switching to a different project re-scopes the session; the outgoing turn's
    // ephemeral typing state must NOT bleed into the new conversation.
    controller.setProject('beta')
    expect(controller.getViewModel().awaitingFirstToken).toBe(false)
    // The freshly-scoped session exposes the same sink surface (sanity).
    expect(typeof sinks().onStatus).toBe('function')
  })
})
