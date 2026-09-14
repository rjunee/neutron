// Types for the lint gate's report filter (lint-filter.mjs), so the TS test
// (lint-filter.test.ts) can import it under strict tsc. Same shape as the
// sibling gates' declaration twins (e.g. void-promise-check.d.mts) — the root
// tsconfig has no `allowJs`, so a `.mjs` without one is TS7016 at the import.

/** One message as `eslint --format json` reports it. */
export interface EslintMessage {
  ruleId: string | null
  line: number
  column: number
  message: string
}

/** One file's entry in an `eslint --format json` report. */
export interface EslintFileReport {
  filePath: string
  messages?: EslintMessage[]
}

export function formatGatedMessages(
  report: EslintFileReport[],
): { count: number; lines: string[] }
