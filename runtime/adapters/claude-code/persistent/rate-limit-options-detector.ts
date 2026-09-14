import type { DetectorContext, DetectorSpec } from './output-scan.ts'

export const RATE_LIMIT_OPTIONS_STOP_ID = 'rate-limit-options-stop'
export const RATE_LIMIT_OPTIONS_UNRECOGNIZED_ID = 'rate-limit-options-unrecognized'
export const RATE_LIMIT_OPTIONS_BOTTOM_N = 30
export const RATE_LIMIT_OPTIONS_DEBOUNCE_MS = 60_000

// Measured from the picker rendered by Claude Code 2.1.270. The command that
// opens this picker is not rendered, so the family signature is the prompt,
// selection footer, and a usage-specific choice.
const PICKER_QUESTION_RE = /whatdoyouwanttodo\?/i
const PICKER_FOOTER_RE = /entertoconfirm.*esctocancel/i
const USAGE_CHOICE_RE = /(limittoreset|usagecredits|upgradeyourplan)/i
const STOP_OPTION_ONE_RE = /^\s*(?:❯\s*)?1\.\s*Stop and wait for limit to reset\s*$/i

export function rateLimitOptionsPickerPresent(ctx: DetectorContext): boolean {
  return (
    PICKER_QUESTION_RE.test(ctx.normalized) &&
    PICKER_FOOTER_RE.test(ctx.normalized) &&
    USAGE_CHOICE_RE.test(ctx.normalized)
  )
}

export function recognizedRateLimitOptionsPickerPresent(ctx: DetectorContext): boolean {
  return rateLimitOptionsPickerPresent(ctx) && ctx.lines.some((line) => STOP_OPTION_ONE_RE.test(line))
}

export function createRateLimitOptionsDetectors(): readonly [DetectorSpec, DetectorSpec] {
  return [
    {
      id: RATE_LIMIT_OPTIONS_STOP_ID,
      bottomN: RATE_LIMIT_OPTIONS_BOTTOM_N,
      debounceMs: RATE_LIMIT_OPTIONS_DEBOUNCE_MS,
      present: recognizedRateLimitOptionsPickerPresent,
      keys: ['1', 'enter'],
    },
    {
      id: RATE_LIMIT_OPTIONS_UNRECOGNIZED_ID,
      bottomN: RATE_LIMIT_OPTIONS_BOTTOM_N,
      debounceMs: RATE_LIMIT_OPTIONS_DEBOUNCE_MS,
      present: (ctx) =>
        rateLimitOptionsPickerPresent(ctx) && !recognizedRateLimitOptionsPickerPresent(ctx),
    },
  ]
}
