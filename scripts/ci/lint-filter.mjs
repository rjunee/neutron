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

const ROOT_PACKAGE_ADVICE = /Use `neutron\/[^`]+` instead of `[^`]+`/
const WORKING_ROOT_REMEDY =
  'Root support code has no package specifier. Move the helper into the importing workspace and use a workspace-local relative import, or move it into a workspace package and use its `@neutronai/<workspace>/<path>` specifier.'

export function formatGatedMessages(report) {
  const lines = []
  for (const file of report) {
    for (const msg of file.messages ?? []) {
      if (GATED_RULES.has(msg.ruleId)) {
        const message = ROOT_PACKAGE_ADVICE.test(msg.message)
          ? msg.message.replace(ROOT_PACKAGE_ADVICE, WORKING_ROOT_REMEDY)
          : msg.message
        lines.push(`${file.filePath}:${msg.line}:${msg.column} ${message}`)
      }
    }
  }
  return { count: lines.length, lines }
}

if (import.meta.main) {
  const [, , reportPath] = process.argv
  const report = JSON.parse(await Bun.file(reportPath).text())
  const { count, lines } = formatGatedMessages(report)
  for (const line of lines) console.error(line)
  console.log(count)
}
