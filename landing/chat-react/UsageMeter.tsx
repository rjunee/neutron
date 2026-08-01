/**
 * landing/chat-react — the usage meter.
 *
 * Two hairlines that ARE the seam between the tab band and the chat stage: the
 * 5-hour session window on top, the 7-day window beneath it. Each fills from the
 * left, and the whole fill changes colour at once — green below 85%, amber to
 * 95%, red past it.
 *
 * WHY IT LIVES IN THE DIVIDER. The number matters constantly and deserves
 * attention almost never. A line already crossing the full width of the window
 * costs nothing to look at, is legible from the corner of the eye, and needs no
 * label — while a badge, a pill, or a percentage in a corner would demand
 * reading. Two pixels is the entire budget.
 *
 * WHEN THERE IS NOTHING TO SHOW it renders as the plain divider: both lines are
 * the border colour, no fill at all. That is deliberately indistinguishable from
 * the divider that was there before this component existed, because "we don't
 * know" and "nothing to report" should both look like ordinary window chrome.
 * What it must never do is draw an empty coloured track, which reads as the very
 * specific and possibly false claim "0% used".
 *
 * The thresholds come from `@neutronai/contracts` rather than from a local
 * constant, so the web bar, the phone bar, and the server that measures them
 * cannot disagree about where amber starts.
 */

import { clampFraction, usageBand, type UsageBand } from '@neutronai/contracts/credential-usage.ts'
import type { UsagePayload } from './usage-client.ts'

const BAND_CLASS: Record<UsageBand, string> = {
  nominal: 'car-usage-nominal',
  warning: 'car-usage-warning',
  critical: 'car-usage-critical',
}

/**
 * The width is a plain percentage; the "measured but tiny still shows" floor is
 * `min-width` on `.car-usage-fill` in the stylesheet, so the sliver is a
 * presentation concern and this stays a pure percentage of the track.
 */
function fillWidth(fraction: number): string {
  return `${(clampFraction(fraction) * 100).toFixed(2)}%`
}

function UsageLine({ fraction, label }: { fraction: number | null; label: string }): React.JSX.Element {
  if (fraction === null) {
    // Bare track. No `role`, no label — nothing is being reported, and an empty
    // progressbar announced to a screen reader would be noise.
    return <div className="car-usage-line" />
  }
  const pct = Math.round(clampFraction(fraction) * 100)
  return (
    <div
      className="car-usage-line"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}% used`}
    >
      <div
        className={`car-usage-fill ${BAND_CLASS[usageBand(fraction)]}`}
        style={{ width: fillWidth(fraction) }}
      />
    </div>
  )
}

export function UsageMeter({ usage }: { usage: UsagePayload }): React.JSX.Element {
  const available = usage.available
  return (
    <div className="car-usage" data-testid="usage-meter" data-available={String(available)}>
      <UsageLine fraction={available ? usage.session : null} label="Session usage (5 hours)" />
      <UsageLine fraction={available ? usage.weekly : null} label="Weekly usage (7 days)" />
    </div>
  )
}
