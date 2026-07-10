#!/usr/bin/env bun
// Helper for scripts/ci/lint.sh — filters an `eslint --format json` report
// down to the rules THIS gate owns, prints each violation to stderr, and
// prints the total count to stdout (the only thing the caller reads). Kept as
// a separate file rather than an inline heredoc so quoting isn't fighting
// bash.
//
// Gated rules:
//  * import/no-relative-packages — L5 cross-workspace relative imports.
//  * no-restricted-syntax        — P2 ProjectDb.raw() restriction (the only
//    no-restricted-syntax entry registered in eslint.config.mjs).
const GATED_RULES = new Set(['import/no-relative-packages', 'no-restricted-syntax'])
const [, , reportPath] = process.argv
const report = JSON.parse(await Bun.file(reportPath).text())

let count = 0
for (const file of report) {
  for (const msg of file.messages ?? []) {
    if (GATED_RULES.has(msg.ruleId)) {
      count++
      console.error(`${file.filePath}:${msg.line}:${msg.column} ${msg.message}`)
    }
  }
}
console.log(count)
