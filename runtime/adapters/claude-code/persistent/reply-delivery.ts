/**
 * Delivery policy for the terminal `reply` tool.
 *
 * A gateway deploy removes the loopback listener while this dev-channel keeps
 * running under the surviving REPL. Transport failure therefore means
 * "delivery is unknown", not "the reply failed". Retry through the boot
 * adoption evidence window; the successor can then accept the same correlated
 * reply. If the window expires, report an explicit terminal outcome so the
 * agent does not send a duplicate response.
 */

export const REPLY_HANDOFF_BUDGET_MS = 60_000
export const REPLY_HANDOFF_RETRY_MS = 1_000

export type ReplyDeliveryOutcome =
  | { kind: 'delivered'; responseText: string }
  | { kind: 'peer-gone' }
  | { kind: 'delivery-unknown' }

export function replyToolResultText(outcome: ReplyDeliveryOutcome): string {
  switch (outcome.kind) {
    case 'delivered':
      return 'delivered'
    case 'peer-gone':
      return 'The receiving turn no longer exists. Do not call reply again; end this turn now.'
    case 'delivery-unknown':
      return 'Reply delivery could not be confirmed during a gateway restart. Do not call reply again; end this turn now.'
  }
}

export interface ReplyDeliveryDeps {
  fetch: typeof globalThis.fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
}

const defaultDeps: ReplyDeliveryDeps = {
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (line) => process.stderr.write(line),
}

export async function deliverReply(
  url: string,
  token: string,
  body: Record<string, unknown>,
  deps: ReplyDeliveryDeps = defaultDeps,
  budgetMs = REPLY_HANDOFF_BUDGET_MS,
): Promise<ReplyDeliveryOutcome> {
  const deadline = deps.now() + budgetMs
  let lastWasRejection = false
  let attempt = 0

  while (true) {
    attempt += 1
    try {
      const response = await deps.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Sink-Token': token } : {}),
        },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        return { kind: 'delivered', responseText: await response.text() }
      }
      lastWasRejection = response.status === 401
      deps.log(
        `neutron-channel: reply sink refused delivery (attempt ${attempt}, status ${response.status}); waiting for gateway hand-off\n`,
      )
    } catch (error) {
      lastWasRejection = false
      deps.log(
        `neutron-channel: reply sink unavailable (attempt ${attempt}); waiting for gateway hand-off: ${error}\n`,
      )
    }

    if (deps.now() >= deadline) {
      return lastWasRejection ? { kind: 'peer-gone' } : { kind: 'delivery-unknown' }
    }
    await deps.sleep(REPLY_HANDOFF_RETRY_MS)
  }
}
