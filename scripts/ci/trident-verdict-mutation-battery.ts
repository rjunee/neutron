/**
 * scripts/ci/trident-verdict-mutation-battery.ts — prove the gate's tests can FAIL.
 *
 * WHY THIS IS A SCRIPT AND NOT A SENTENCE. The previous round of this work stated
 * in its as-built entry that sixteen mutants had been applied and all sixteen
 * caught. Six had survived. Nobody could tell, because a mutation claim written in
 * prose is indistinguishable from a mutation claim that was measured — a green
 * suite looks identical either way, and that is the whole failure mode a mutation
 * test exists to expose. So the claim now has an artifact: run this, paste the
 * summary. A number nobody can reproduce is not evidence.
 *
 * WHAT IT DOES. For each named mutant it rewrites ONE guard in
 * `scripts/ci/trident-verdict.ts` into its fail-OPEN direction, runs the suite, and
 * records CAUGHT (suite went red) or SURVIVED (suite stayed green). The original
 * file is restored after every case, including on a crash.
 *
 * HOW TO READ A SURVIVOR. A survivor is a hole in the TESTS, never a licence to
 * delete the mutant. It means the guard has code and no coverage: it can be
 * removed by a future refactor and CI will applaud. Every entry below is a
 * direction that makes the gate accept something it exists to refuse.
 *
 *   bun scripts/ci/trident-verdict-mutation-battery.ts
 *
 * Not wired into CI: it deliberately edits a tracked file in place, which is not
 * something a shared runner should do to a checkout other jobs are reading. It is
 * a bench instrument, run when the gate changes.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GATE = fileURLToPath(new URL('trident-verdict.ts', import.meta.url))
const TEST = 'scripts/ci/trident-verdict.test.ts'

/** [name, the exact source to replace, the fail-open replacement] */
const MUTANTS: [string, string, string][] = [
  // ---- the SHA keying, which is the whole premise -----------------------------
  ['sha-comparison-dropped', 'if (verdict.commit.toLowerCase() !== headSha.toLowerCase()) {', 'if (false) {'],
  ['full-sha-unchecked', 'if (!FULL_SHA.test(commit)) {', 'if (false) {'],
  // ---- the review actually happened and reported clean ------------------------
  ['codex-ran-unchecked', 'if (!verdict.codexRan) {', 'if (false) {'],
  ['adversarial-ran-unchecked', 'if (!verdict.adversarialRan) {', 'if (false) {'],
  ['codex-blocking-off-by-one', 'if (verdict.codexBlocking > 0) failures.push', 'if (verdict.codexBlocking > 1) failures.push'],
  ['adversarial-blocking-off-by-one', 'if (verdict.adversarialBlocking > 0) {', 'if (verdict.adversarialBlocking > 1) {'],
  ['mutation-evidence-clause-dropped', 'if (opts.touchesSource && verdict.mutations.length === 0) {', 'if (false) {'],
  // ---- the parser's strictness ------------------------------------------------
  ['count-accepts-empty', 'if (!/^-?\\d+$/.test(trimmed)) {', 'if (!/^-?\\d*$/.test(trimmed)) {'],
  ['negative-count-allowed', "if (trimmed.startsWith('-')) {", 'if (false) {'],
  ['truthy-permissive', "return raw.trim() === 'true'", "return raw.trim().toLowerCase().startsWith('t')"],
  ['duplicate-key-allowed', 'if (scalars.has(key)) {', 'if (false) {'],
  ['two-blocks-allowed', 'if (blocks.length > 1) {', 'if (false) {'],
  [
    'fence-unanchored',
    'export const VERDICT_FENCE = /^```review-evidence[ \\t\\r]*\\n([\\s\\S]*?)\\n```[ \\t\\r]*$/m',
    'export const VERDICT_FENCE = /```review-evidence[ \\t\\r]*\\n([\\s\\S]*?)\\n```[ \\t\\r]*/m',
  ],
  ['placeholder-accepted', 'if (PLACEHOLDER.test(value.trim())) {', 'if (false) {'],
  ['unusable-value-accepted', 'if (UNUSABLE_VALUE.test(value.trim())) {', 'if (false) {'],
  [
    'empty-mutation-field-accepted',
    'if (!value.trim()) throw new VerdictError(`mutation entry has an empty ${key}`)',
    'if (false) throw new VerdictError(`mutation entry has an empty ${key}`)',
  ],
  ['homedir-path-accepted', 'if (HOMEDIR_PATH.test(value)) {', 'if (false) {'],
  // ---- a verdict is an approval, and this repository is public -----------------
  [
    'author-trust-filter-emptied',
    'const candidates = fenced.filter((c) => isTrustedAuthor(c.author_association))',
    'const candidates = fenced.filter(() => true)',
  ],
  ['newest-first-dropped', 'const fenced = [...comments].reverse().filter', 'const fenced = [...comments].filter'],
  // ---- the escape hatch -------------------------------------------------------
  ['bypass-empty-reason-allowed', '  if (!reason) {', '  if (false) {'],
  ['bypass-letter-floor-lowered', 'if (!/[a-z]{3}/i.test(reason)) {', 'if (!/[a-z]{1}/i.test(reason)) {'],
  ['bypass-two-markers-allowed', 'if (found.length > 1) {', 'if (false) {'],
  ['bypass-fence-unanchored', 'const BYPASS_LINE = /^TRIDENT_BYPASS=(.*)$/gm', 'const BYPASS_LINE = /TRIDENT_BYPASS=(.*)$/gm'],
  [
    'bypass-author-trust-dropped',
    "if (bypass.kind !== 'none' && !isTrustedAuthor(prAuthorAssociation)) {",
    'if (false) {',
  ],
  // ---- pagination: the untested direction was the fail-open one ----------------
  ['pagination-stops-after-page-1', 'if (batch.length < PER_PAGE) return items', 'return items'],
  [
    'max-pages-refusal-dropped',
    '  throw new Error(`trident-verdict: ${path} exceeded ${MAX_PAGES * PER_PAGE} items; refusing a truncated view`)',
    '  return items',
  ],
  ['truncation-off-by-one', 'if (files.length < changedFiles) {', 'if (files.length + 1 < changedFiles) {'],
  [
    'changed-files-unvalidated',
    'if (typeof changedFiles !== \'number\' || !Number.isInteger(changedFiles) || changedFiles < 0) {',
    'if (false) {',
  ],
  // ---- fail-closed on a misconfigured invocation -------------------------------
  ['positive-control-ignored', 'if (!control.ok) {', 'if (false) {'],
  ['pr-number-not-fail-closed', 'if (!pr || !/^\\d+$/.test(pr)) {', 'if (false) {'],
  ['head-sha-not-fail-closed', 'if (!headSha || !FULL_SHA.test(headSha)) {', 'if (false) {'],
  [
    'api-throw-uncaught',
    "    deps.log('trident-verdict: FAIL — could not READ this PR, which is not the same as \"no verdict\".')",
    '    throw e',
  ],
  // ---- THE REDEMPTION, which is the requirement the gate exists for ------------
  [
    'redemption-never-printed',
    'function printRedemption(deps: GateDeps, branch: string | undefined, pr: string | undefined): void {',
    'function printRedemption(deps: GateDeps, branch: string | undefined, pr: string | undefined): void {\n  if (1) return',
  ],
  [
    'adopt-instruction-dropped',
    '`ADOPT that branch and that PR: check out ${branch} without creating it, reuse ${pr}, ` +',
    '`` +',
  ],
]

const original = readFileSync(GATE, 'utf8')
const results: [string, string][] = []

for (const [name, from, to] of MUTANTS) {
  const hits = original.split(from).length - 1
  if (hits !== 1) {
    // A mutant whose pattern no longer matches is a STALE mutant, and it must be
    // loud: silently skipping it would shrink the battery while the summary still
    // read "all caught".
    results.push([name, `STALE-PATTERN (${hits} matches)`])
    console.log(`STALE     ${name} — pattern matched ${hits} times, not 1`)
    continue
  }
  writeFileSync(GATE, original.replace(from, to))
  try {
    const p = spawnSync('bun', ['test', TEST], { cwd: REPO_ROOT, encoding: 'utf8' })
    const verdict = p.status !== 0 ? 'CAUGHT' : 'SURVIVED'
    results.push([name, verdict])
    console.log(`${verdict.padEnd(9)} ${name}`)
  } finally {
    writeFileSync(GATE, original)
  }
}

const caught = results.filter(([, v]) => v === 'CAUGHT').length
console.log(`\n${results.length} mutants applied, ${caught} caught, ${results.length - caught} survived`)
for (const [name, verdict] of results) {
  if (verdict !== 'CAUGHT') console.log(`  ${verdict}: ${name}`)
}
process.exit(caught === results.length ? 0 : 1)
