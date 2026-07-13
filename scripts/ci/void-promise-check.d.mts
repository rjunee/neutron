// Types for the F3 void-promise gate detector (void-promise-check.mjs), so the
// TS test (void-promise-check.test.ts) can import it under strict tsc.
export function findBareVoidPromiseCalls(
  source: string,
  fileName?: string,
): { line: number; text: string }[]

export function hasVoidExpression(abs: string, src: string): boolean

export function findPreSwallowedWraps(
  source: string,
  fileName?: string,
): { line: number; fn: string; reason: string }[]
