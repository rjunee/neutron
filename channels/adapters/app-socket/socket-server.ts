/**
 * @neutronai/channels — mock app-socket transport (test-only).
 *
 * Per docs/plans/P2-onboarding.md § 6 S5 line 2144. The real app-socket
 * WebSocket transport ships in P5; this minimal in-memory pub/sub
 * exists so the cross-channel parity test
 * (`tests/integration/button-primitive-cross-channel.test.ts`) can
 * exercise the same `RenderButtonPrompt` contract Telegram uses.
 *
 * The mock is deliberately tiny:
 *   - one connection per test
 *   - server.send(envelope) — agent → user; the test asserts the
 *     received envelope shape
 *   - server.deliverChoice(envelope) — user → agent; routes through the
 *     handler the caller registered
 *   - close() — drains the listener queue
 *
 * The mock has no networking; it's purely a typed pub/sub for tests.
 * Production wires the same envelope shape over a real WebSocket.
 */

import type {
  AppSocketButtonPromptMessage,
  AppSocketButtonChoiceMessage,
} from './render-button-prompt.ts'

export type AppSocketOutbound = AppSocketButtonPromptMessage
export type AppSocketInbound = AppSocketButtonChoiceMessage

export type AppSocketInboundHandler = (envelope: AppSocketInbound) => Promise<void> | void
export type AppSocketOutboundListener = (envelope: AppSocketOutbound) => void

export interface MockAppSocketServer {
  /** Server-side: send an outbound envelope (agent → user). */
  send(envelope: AppSocketOutbound): void
  /** Server-side: register a handler invoked when the test delivers an inbound (user → agent). */
  onInbound(handler: AppSocketInboundHandler): void
  /** Test-side: deliver an inbound envelope to the registered handler. */
  deliverChoice(envelope: AppSocketInbound): Promise<void>
  /** Test-side: register a listener invoked for every outbound the server.send fires. */
  onOutbound(listener: AppSocketOutboundListener): void
  /** Test-side: read every outbound the server has emitted, in order. */
  outbounds(): readonly AppSocketOutbound[]
  /** Drain handlers + listeners. Test cleanup. */
  close(): void
}

/**
 * Build an in-memory mock app-socket server. The returned object is the
 * test's seam into both directions of the transport.
 */
export function createMockAppSocketServer(): MockAppSocketServer {
  const outboundLog: AppSocketOutbound[] = []
  const outboundListeners: AppSocketOutboundListener[] = []
  let inboundHandler: AppSocketInboundHandler | null = null
  let closed = false

  return {
    send(envelope: AppSocketOutbound): void {
      if (closed) throw new Error('mock app-socket: send after close')
      outboundLog.push(envelope)
      for (const l of outboundListeners) l(envelope)
    },
    onInbound(handler: AppSocketInboundHandler): void {
      if (closed) throw new Error('mock app-socket: onInbound after close')
      inboundHandler = handler
    },
    async deliverChoice(envelope: AppSocketInbound): Promise<void> {
      if (closed) throw new Error('mock app-socket: deliverChoice after close')
      if (inboundHandler === null) {
        throw new Error('mock app-socket: deliverChoice with no inbound handler registered')
      }
      await inboundHandler(envelope)
    },
    onOutbound(listener: AppSocketOutboundListener): void {
      if (closed) throw new Error('mock app-socket: onOutbound after close')
      outboundListeners.push(listener)
    },
    outbounds(): readonly AppSocketOutbound[] {
      return outboundLog
    },
    close(): void {
      closed = true
      inboundHandler = null
      outboundListeners.length = 0
    },
  }
}
