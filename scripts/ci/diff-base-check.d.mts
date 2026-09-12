// Types for the #546 diff-base gate detector (diff-base-check.mjs), so the TS
// test (diff-base-check.test.ts) can import it under strict tsc.
export const SCAN_ROOTS: string[]
export const MIN_JUSTIFICATION_CHARS: number
export const EXEMPT_MARKER: string
export const POSITIVE_CONTROL: string
export const NEGATIVE_CONTROL: string

export function taintedNames(source: string): Set<string>

export function logicalLines(lines: string[]): { text: string; line: number }[]

export function commentOpenerIndex(line: string): number

export function findBareBaseRanges(source: string): { line: number; name: string; text: string }[]
