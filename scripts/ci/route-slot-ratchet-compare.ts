/**
 * scripts/ci/route-slot-ratchet-compare.ts — the pure comparator behind the
 * route-slot allowlist ratchet.
 *
 * `open/__tests__/route-slot-coverage.test.ts` asserts that every slot listed in
 * `MOUNTED_SLOTS` is still served by the composed product. That check reads its
 * own baseline, so it cannot see the one edit that defeats it: MOVE a slot out of
 * `MOUNTED_SLOTS` and into `UNMOUNTED_SLOTS`, and the assertion that would have
 * gone red simply stops existing. The layering ratchet next door exists for the
 * identical hole (a PR could grandfather a new cross-band edge by adding it to
 * the committed baseline), and this is that guard for this baseline.
 *
 * THE INVARIANT: relative to main, the served set may only GROW. A rung main
 * serves must still be listed as served — unless the slot no longer EXISTS, which
 * is why the comparator takes the live declared-rung list as its third input:
 * deleting a surface outright is a legitimate change and must not be reported as a
 * regression, or the guard becomes a false alarm and false alarms are how a gate
 * gets ignored.
 *
 * Pure + git-free on purpose, so it can be unit-tested against fixtures with no
 * git and no graph compose. The shell wrapper (route-slot-ratchet-guard.sh)
 * supplies main's inventory from `git show`.
 */

export interface RouteSlotInventory {
  /** Rungs the branch claims the product serves. */
  mounted: readonly string[]
  /** Rungs the branch allowlists as unserved. */
  unmounted: readonly string[]
}

export interface RouteSlotRatchetResult {
  /** true iff no rung was demoted out of the served baseline. */
  ok: boolean
  /** served on main, still declared, and no longer listed as served — the failures. */
  demoted: string[]
  /** newly listed as served (informational; the ratchet turning the right way). */
  promoted: string[]
  /** served on main and no longer declared at all — an allowed deletion. */
  deleted: string[]
}

/**
 * @param main         main's inventory (`git show <ref>:<path>`).
 * @param committed    the branch's inventory.
 * @param declaredRungs every rung `ROUTE_SLOTS` declares TODAY, on the branch.
 */
export function compareRouteSlotInventories(
  main: RouteSlotInventory,
  committed: RouteSlotInventory,
  declaredRungs: readonly string[],
): RouteSlotRatchetResult {
  const declared = new Set(declaredRungs)
  const committedMounted = new Set(committed.mounted)

  const demoted: string[] = []
  const deleted: string[] = []
  for (const rung of main.mounted) {
    if (committedMounted.has(rung)) continue
    if (declared.has(rung)) demoted.push(rung)
    else deleted.push(rung)
  }

  const mainMounted = new Set(main.mounted)
  const promoted = committed.mounted.filter((r) => !mainMounted.has(r))

  return {
    ok: demoted.length === 0,
    demoted: demoted.sort(),
    promoted: [...promoted].sort(),
    deleted: deleted.sort(),
  }
}

/**
 * Read an inventory module by path. The inventory file imports NOTHING (it is
 * plain data) precisely so main's copy can be written to a temp path and imported
 * from there without its relative imports breaking.
 */
async function loadInventory(path: string): Promise<RouteSlotInventory> {
  const mod = (await import(path)) as {
    MOUNTED_SLOTS?: ReadonlyArray<{ rung: string }>
    UNMOUNTED_SLOTS?: ReadonlyArray<{ rung: string }>
  }
  if (!Array.isArray(mod.MOUNTED_SLOTS) || !Array.isArray(mod.UNMOUNTED_SLOTS)) {
    throw new Error(`${path} does not export MOUNTED_SLOTS + UNMOUNTED_SLOTS arrays`)
  }
  return {
    mounted: mod.MOUNTED_SLOTS.map((s) => s.rung),
    unmounted: mod.UNMOUNTED_SLOTS.map((s) => s.rung),
  }
}

/** CLI: `bun route-slot-ratchet-compare.ts <main-inventory.ts> <committed-inventory.ts> <route-slots.ts>` */
async function main(argv: string[]): Promise<number> {
  const [mainPath, committedPath, slotsPath] = argv
  if (!mainPath || !committedPath || !slotsPath) {
    console.error(
      'usage: route-slot-ratchet-compare.ts <main-inventory.ts> <committed-inventory.ts> <route-slots.ts>',
    )
    return 2
  }

  let mainInv: RouteSlotInventory
  let committedInv: RouteSlotInventory
  let declaredRungs: string[]
  try {
    mainInv = await loadInventory(mainPath)
    committedInv = await loadInventory(committedPath)
    const slots = (await import(slotsPath)) as {
      ROUTE_SLOTS?: ReadonlyArray<{ rung: string; composition: string | null }>
    }
    if (!Array.isArray(slots.ROUTE_SLOTS)) throw new Error(`${slotsPath} exports no ROUTE_SLOTS`)
    declaredRungs = slots.ROUTE_SLOTS.filter((s) => s.composition !== null).map((s) => s.rung)
    // A registry that suddenly declares nothing would make every rung look
    // DELETED and pass. Refuse to render a verdict on an empty world.
    if (declaredRungs.length === 0) throw new Error(`${slotsPath} declares no composed slots`)
  } catch (e) {
    console.error(`route-slot-ratchet: ${(e as Error).message}`)
    return 2
  }

  const result = compareRouteSlotInventories(mainInv, committedInv, declaredRungs)

  if (result.ok) {
    console.log(
      `ROUTE-SLOT RATCHET: OK — served baseline did not shrink ` +
        `(main=${mainInv.mounted.length}, committed=${committedInv.mounted.length}, ` +
        `promoted=${result.promoted.length}, deleted=${result.deleted.length}) ✅`,
    )
    if (result.promoted.length > 0) console.log(`  + now served: ${result.promoted.join(', ')}`)
    if (result.deleted.length > 0) console.log(`  - slot deleted: ${result.deleted.join(', ')}`)
    return 0
  }

  console.error('ROUTE-SLOT RATCHET: FAIL — a route slot was demoted out of the served baseline.')
  console.error('  These rungs are served on main, still declared, and this branch no longer')
  console.error('  lists them as served. Moving a slot into UNMOUNTED_SLOTS deletes the')
  console.error('  assertion that it is reachable; the route starts 404ing and CI stays green.')
  console.error('  Re-wire the surface, or delete the slot and its dead surface entirely.')
  for (const rung of result.demoted) console.error(`    - ${rung}`)
  return 1
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
