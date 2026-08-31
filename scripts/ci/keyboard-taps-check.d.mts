// Types for the keyboard-taps gate (keyboard-taps-check.mjs), so the TS test
// (keyboard-taps-check.test.ts) can import it under strict tsc.
export const MARKER: string

export const MIN_JUSTIFICATION_CHARS: number

export type KeyboardTapsState = 'prop' | 'exempt' | 'bare-exempt' | 'offense' | 'forbidden'

export interface KeyboardTapsSite {
  line: number
  tag: string
  state: KeyboardTapsState
  text: string
}

export function findScrollableSites(source: string, fileName?: string): KeyboardTapsSite[]

export function mightCarrySite(src: string): boolean

export function scanTree(rootDir: string): {
  files: number
  sites: (KeyboardTapsSite & { rel: string })[]
}
