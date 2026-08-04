// Types for the wall-clock timing-assertion gate (wall-clock-bound-check.mjs),
// so the TS test (wall-clock-bound-check.test.ts) can import it under strict tsc.
export const MIN_JUSTIFICATION_CHARS: number

export const MARKER: string

export function findWallClockBounds(
  source: string,
  fileName?: string,
): { line: number; text: string; marker: 'none' | 'bare' | 'justified' }[]

export function classifyMarker(commentText: string): {
  state: 'none' | 'bare' | 'justified'
  justification: string
}

export function isTestFile(rel: string): boolean

export function mightCarryBound(src: string): boolean
