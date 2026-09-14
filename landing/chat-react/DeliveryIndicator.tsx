import React from 'react'
import type { DeliveryState } from './controller.ts'

/** Keep unknown delivery visible without offering a failure retry. */
export function DeliveryIndicator({ state, onRetry }: {
  state: DeliveryState
  onRetry: () => void
}): React.JSX.Element {
  if (state === 'failed') {
    return (
      <button type="button" className="car-msg-failed" onClick={onRetry}
        aria-label="Message failed to send — retry">
        ⚠️ Failed — retry
      </button>
    )
  }
  const label = state === 'pending' ? 'Message pending acknowledgement'
    : state === 'read' ? 'Message read' : 'Message delivered'
  return <span className="car-msg-delivery" aria-label={label}>
    {state === 'pending' ? '🕓' : '✓✓'}
  </span>
}
