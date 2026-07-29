/**
 * event-channel.ts — a minimal push/pull async queue of substrate `Event`s.
 *
 * The bridge (`persistent-repl-substrate.ts`) produces a turn's Events from
 * out-of-band callbacks (the reply-sink HTTP handlers, the PTY death hook),
 * not from a single linear async function. This channel lets those callbacks
 * `push()` events while the `SessionHandle.events` consumer pulls them via
 * `for await`. `close()` ends the iterator; backpressure is unbounded but a
 * turn only ever pushes a handful of events (status*, then token+completion,
 * or one error), so no bound is needed.
 */

import type { Event } from '../../../events.ts'

export class EventChannel {
  private queue: Event[] = []
  private resolvers: Array<(r: IteratorResult<Event>) => void> = []
  private done = false

  /** Push an event to consumers (no-op once closed). */
  push(ev: Event): void {
    if (this.done) return
    const next = this.resolvers.shift()
    if (next) {
      next({ value: ev, done: false })
    } else {
      this.queue.push(ev)
    }
  }

  /** Close the channel — the iterator ends after draining queued events. */
  close(): void {
    if (this.done) return
    this.done = true
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()
      if (r) r({ value: undefined, done: true })
    }
  }

  get closed(): boolean {
    return this.done
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Event, void, void> {
    while (true) {
      const queued = this.queue.shift()
      if (queued !== undefined) {
        yield queued
        continue
      }
      if (this.done) return
      const result = await new Promise<IteratorResult<Event>>((res) => {
        this.resolvers.push(res)
      })
      if (result.done) return
      yield result.value
    }
  }
}
