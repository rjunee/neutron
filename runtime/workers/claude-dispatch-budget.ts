import { setTimeout as delay } from 'node:timers/promises'

/** One dispatch, one bounded writer-queue interval. Preparation and execution
 * retain their original allowance; only observed lock wait is reimbursed. */
export class ClaudeDispatchBudget {
  private queued = false
  constructor(public deadline_ms: number, private readonly now = Date.now) {}

  beginQueue(signal: AbortSignal): () => void {
    if (this.queued) throw new Error('Writer queue budget already consumed')
    this.queued = true
    const started = this.now()
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const finished = this.now()
      // An expired admission cannot acquire new execution time. A late holder
      // must release without submitting; cancellation likewise never buys time.
      if (!signal.aborted && finished < this.deadline_ms) {
        this.deadline_ms += Math.max(0, finished - started)
      }
    }
  }
}

export async function waitForClaudeDeadline(deadline: () => number, signal: AbortSignal): Promise<void> {
  do {
    await delay(Math.max(1, deadline() - Date.now()), undefined, { signal })
  } while (Date.now() < deadline())
}
