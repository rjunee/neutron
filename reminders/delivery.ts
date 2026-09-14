/** Five tries tolerate a brief outage without repeating an uncertain send forever. */
export const MAX_REMINDER_DELIVERY_ATTEMPTS = 5
/** After one hour the original nudge is stale, even if few ticks have run. */
export const REMINDER_DELIVERY_WINDOW_SECONDS = 60 * 60

export type DeliveryObservation =
  | { state: 'delivered' }
  | { state: 'known-not-delivered'; reason: string }
  | { state: 'not-yet-known'; reason: string }

/** Observation and retry disposition are independent: exhaustion cannot prove failure. */
export interface ReminderDelivery {
  reminder_id: string
  fire_at: number
  attempts: number
  state: DeliveryObservation['state']
  reason: string | null
  observed_at: number | null
  delivered_at: number | null
  next_attempt_at: number
  exhausted_reason: string | null
}

export function exhaustionReason(attempts: number, fire_at: number, now: number): string | null {
  if (attempts >= MAX_REMINDER_DELIVERY_ATTEMPTS) return 'undelivered: attempt limit reached'
  if (now > fire_at + REMINDER_DELIVERY_WINDOW_SECONDS) return 'undelivered: delivery window expired'
  return null
}
