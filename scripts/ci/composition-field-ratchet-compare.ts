/**
 * scripts/ci/composition-field-ratchet-compare.ts — the pure comparator behind
 * the composition-field allowlist ratchet.
 *
 * `open/__tests__/composition-field-coverage.test.ts` asserts that every field
 * listed in `WIRED_FIELDS` is still set by the composed product. That check
 * reads its own baseline, so it cannot see the one edit that defeats it: MOVE a
 * field out of `WIRED_FIELDS` and into `UNWIRED_FIELDS`, and the assertion that
 * would have gone red simply stops existing. The route-slot ratchet next door
 * exists for the identical hole on the identical shape of baseline, and the
 * layering ratchet for a third; this is that guard for this one.
 *
 * THE INVARIANT: relative to main, the wired set may only GROW. A field main
 * wires must still be listed as wired — unless the field no longer EXISTS on
 * `CompositionInput`, which is why the comparator takes the live declared-field
 * list as its third input: deleting a field outright is a legitimate change and
 * must not be reported as a regression, or the guard becomes a false alarm, and
 * false alarms are how a gate gets ignored.
 *
 * Pure + git-free on purpose, so it can be unit-tested against fixtures with no
 * git and no graph compose. The shell wrapper
 * (`composition-field-ratchet-guard.sh`) supplies main's inventory from
 * `git show`.
 */

export interface CompositionFieldInventory {
  /** Fields the branch claims the product sets. */
  wired: readonly string[]
  /** Fields the branch allowlists as unset. */
  unwired: readonly string[]
}

export interface CompositionFieldRatchetResult {
  /** true iff no field was demoted out of the wired baseline. */
  ok: boolean
  /** wired on main, still declared, and no longer listed as wired — the failures. */
  demoted: string[]
  /** newly listed as wired (informational; the ratchet turning the right way). */
  promoted: string[]
  /** wired on main and no longer declared at all — an allowed deletion. */
  deleted: string[]
}

/**
 * @param main           main's inventory (`git show <ref>:<path>`).
 * @param committed      the branch's inventory.
 * @param declaredFields every field `CompositionInput` declares TODAY, on the branch.
 */
export function compareCompositionFieldInventories(
  main: CompositionFieldInventory,
  committed: CompositionFieldInventory,
  declaredFields: readonly string[],
): CompositionFieldRatchetResult {
  const declared = new Set(declaredFields)
  const committedWired = new Set(committed.wired)

  const demoted: string[] = []
  const deleted: string[] = []
  for (const field of main.wired) {
    if (committedWired.has(field)) continue
    if (declared.has(field)) demoted.push(field)
    else deleted.push(field)
  }

  const mainWired = new Set(main.wired)
  const promoted = committed.wired.filter((f) => !mainWired.has(f))

  return {
    ok: demoted.length === 0,
    demoted: demoted.sort(),
    promoted: [...promoted].sort(),
    deleted: deleted.sort(),
  }
}

/**
 * Read an inventory module by path. The inventory file imports NOTHING (it is
 * plain data) precisely so main's copy can be written to a scratch path and
 * imported from there without its relative imports breaking.
 */
async function loadInventory(path: string): Promise<CompositionFieldInventory> {
  const mod = (await import(path)) as {
    WIRED_FIELDS?: ReadonlyArray<{ field: string }>
    UNWIRED_FIELDS?: ReadonlyArray<{ field: string }>
  }
  if (!Array.isArray(mod.WIRED_FIELDS) || !Array.isArray(mod.UNWIRED_FIELDS)) {
    throw new Error(`${path} does not export WIRED_FIELDS + UNWIRED_FIELDS arrays`)
  }
  return {
    wired: mod.WIRED_FIELDS.map((f) => f.field),
    unwired: mod.UNWIRED_FIELDS.map((f) => f.field),
  }
}

/** CLI: `bun composition-field-ratchet-compare.ts <main-inventory.ts> <committed-inventory.ts> <repo-root>` */
async function main(argv: string[]): Promise<number> {
  const [mainPath, committedPath, repoRoot] = argv
  if (!mainPath || !committedPath || !repoRoot) {
    console.error(
      'usage: composition-field-ratchet-compare.ts <main-inventory.ts> <committed-inventory.ts> <repo-root>',
    )
    return 2
  }

  let mainInv: CompositionFieldInventory
  let committedInv: CompositionFieldInventory
  let declaredFields: string[]
  try {
    mainInv = await loadInventory(mainPath)
    committedInv = await loadInventory(committedPath)
    const reader = (await import(`${repoRoot}/open/__tests__/declared-composition-fields.ts`)) as {
      readDeclaredCompositionFields?: (root: string) => { name: string }[]
    }
    if (typeof reader.readDeclaredCompositionFields !== 'function') {
      throw new Error('declared-composition-fields.ts exports no readDeclaredCompositionFields')
    }
    // The reader already refuses an empty/unreadable declaration set and throws
    // (floor + shape checks), so a world where nothing is declared — which would
    // make every field look DELETED and pass — cannot reach the comparison.
    declaredFields = reader.readDeclaredCompositionFields(repoRoot).map((f) => f.name)
  } catch (e) {
    console.error(`composition-field-ratchet: ${(e as Error).message}`)
    return 2
  }

  const result = compareCompositionFieldInventories(mainInv, committedInv, declaredFields)

  if (result.ok) {
    console.log(
      `COMPOSITION-FIELD RATCHET: OK — wired baseline did not shrink ` +
        `(main=${mainInv.wired.length}, committed=${committedInv.wired.length}, ` +
        `promoted=${result.promoted.length}, deleted=${result.deleted.length}) ✅`,
    )
    if (result.promoted.length > 0) console.log(`  + now wired: ${result.promoted.join(', ')}`)
    if (result.deleted.length > 0) console.log(`  - field deleted: ${result.deleted.join(', ')}`)
    return 0
  }

  console.error(
    'COMPOSITION-FIELD RATCHET: FAIL — a field was demoted out of the wired baseline.',
  )
  console.error('  These fields are set on main, still declared, and this branch no longer')
  console.error('  lists them as wired. Moving a field into UNWIRED_FIELDS deletes the')
  console.error('  assertion that the product sets it; its consumer takes the `undefined`')
  console.error('  branch, the capability goes dark, and CI stays green.')
  console.error('  Re-wire it in open/composer.ts, or delete the field and its dead consumer.')
  for (const field of result.demoted) console.error(`    - ${field}`)
  return 1
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
