#!/usr/bin/env bun
// Helper for scripts/ci/lint.sh — filters an `eslint --format json` report
// down to `import/no-relative-packages` findings, prints each violation to
// stderr, and prints the total count to stdout (the only thing the caller
// reads). Kept as a separate file rather than an inline heredoc so quoting
// isn't fighting bash.
const [, , reportPath] = process.argv
const report = JSON.parse(await Bun.file(reportPath).text())

let count = 0
for (const file of report) {
  for (const msg of file.messages ?? []) {
    if (msg.ruleId === 'import/no-relative-packages') {
      count++
      console.error(`${file.filePath}:${msg.line}:${msg.column} ${msg.message}`)
    }
  }
}
console.log(count)
