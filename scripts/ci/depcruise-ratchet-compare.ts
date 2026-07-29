/**
 * scripts/ci/depcruise-ratchet-compare.ts — the G8 depcruise ratchet-growth
 * comparator (the boundary Codex flagged on G4).
 *
 * G4 grandfathers a set of cross-band edges in
 * `.dependency-cruiser-known-violations.json` and CI trusts EVERY entry
 * (`depcruise --ignore-known "$BASELINE"`). Nothing stopped a PR from
 * grandfathering a NEW violation by simply ADDING it to the committed baseline —
 * CI stayed green while the stated "the baseline should only ever shrink"
 * invariant was silently violated (depcruise-refresh-baseline.sh only WARNS on
 * growth, and only when someone runs it).
 *
 * This comparator is the pure, git-free core of the enforcement: given main's
 * baseline and the committed (HEAD) baseline, it FAILS if the committed set
 * contains ANY violation key not already present in main's set. Equal or
 * shrunk → pass. It is deliberately a plain function so it can be unit-tested
 * against fixtures with no git and no dependency-cruiser run; the shell wrapper
 * (depcruise-ratchet-guard.sh) supplies the two baselines from git.
 */
import { readFileSync } from 'node:fs'

export interface DepcruiseViolation {
  from?: string
  to?: string
  type?: string
  rule?: { name?: string; severity?: string }
}

/**
 * Normalize a violation to a stable identity key. Two baseline entries are "the
 * same grandfathered edge" iff they share (rule name, from, to). `from`/`to` are
 * the module paths; `rule.name` distinguishes the several rules that legitimately
 * flag the SAME edge (e.g. migrations/runner.ts→open/owner-identity.ts appears
 * under both `contracts-are-leaves` and `nobody-imports-composition`).
 */
export function violationKey(v: DepcruiseViolation): string {
  const rule = v?.rule?.name ?? '(no-rule)'
  const from = v?.from ?? '(no-from)'
  const to = v?.to ?? '(no-to)'
  return `${rule}|${from}|${to}`
}

export interface RatchetResult {
  /** true iff the committed baseline added NO new keys relative to main. */
  ok: boolean
  /** keys present in the committed baseline but NOT in main's (the violations). */
  added: string[]
  /** keys present in main's baseline but not committed (informational; shrink). */
  removed: string[]
  mainCount: number
  committedCount: number
}

/**
 * Compare main's baseline to the committed (HEAD) baseline. The ratchet invariant
 * is "shrink-only": any key in `committed` that is absent from `main` is a NEW
 * grandfathered violation and fails the guard.
 */
export function compareBaselines(
  mainViolations: DepcruiseViolation[],
  committedViolations: DepcruiseViolation[],
): RatchetResult {
  const mainKeys = new Set(mainViolations.map(violationKey))
  const committedKeys = new Set(committedViolations.map(violationKey))

  const added: string[] = []
  for (const k of committedKeys) if (!mainKeys.has(k)) added.push(k)

  const removed: string[] = []
  for (const k of mainKeys) if (!committedKeys.has(k)) removed.push(k)

  return {
    ok: added.length === 0,
    added: added.sort(),
    removed: removed.sort(),
    mainCount: mainKeys.size,
    committedCount: committedKeys.size,
  }
}

function parseBaselineFile(path: string): DepcruiseViolation[] {
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`baseline ${path} is not a JSON array of violations`)
  }
  return parsed as DepcruiseViolation[]
}

/** CLI: `bun depcruise-ratchet-compare.ts <mainBaseline.json> <committedBaseline.json>` */
function main(argv: string[]): number {
  const [mainPath, committedPath] = argv
  if (!mainPath || !committedPath) {
    console.error(
      'usage: depcruise-ratchet-compare.ts <mainBaseline.json> <committedBaseline.json>',
    )
    return 2
  }
  let result: RatchetResult
  try {
    result = compareBaselines(parseBaselineFile(mainPath), parseBaselineFile(committedPath))
  } catch (e) {
    console.error(`depcruise-ratchet-compare: ${(e as Error).message}`)
    return 2
  }

  if (result.ok) {
    console.log(
      `DEPCRUISE RATCHET: OK — baseline did not grow ` +
        `(main=${result.mainCount}, committed=${result.committedCount}, ` +
        `removed=${result.removed.length}) ✅`,
    )
    return 0
  }

  console.error('DEPCRUISE RATCHET: FAIL — the known-violations baseline GREW.')
  console.error(
    '  The layering baseline may only ever SHRINK. A PR cannot grandfather a NEW',
  )
  console.error(
    '  cross-band edge by adding it to .dependency-cruiser-known-violations.json —',
  )
  console.error('  fix the edge instead. New grandfathered entries (rule|from|to):')
  for (const k of result.added) console.error(`    + ${k}`)
  return 1
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
