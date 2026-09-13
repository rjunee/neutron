/**
 * local-ownership.ts — which ownership ids THIS PROCESS currently holds (#539, Argus r59).
 *
 * THE RULE THIS MODULE EXISTS TO SERVE, stated in the ownership model section of the as-built
 * and repeated here because the predicate that consults it is the place it can be got wrong:
 *
 *   **The claimant id is identity. The pid is evidence about liveness, and nothing else.**
 *
 * Both ownership predicates used to treat any claim or reservation bearing this process's pid
 * as OURS, whatever claimant id it carried. That reads as a sensible shortcut — same process,
 * so obviously the same owner — and it is false exactly where this system supports two logical
 * gateways in one process (`gateway/index.ts`, the overlapping-boot note): the second boot
 * passed the predicate, overwrote the first boot's claim, and replaced its pool entry while the
 * first was still live and serving. A whole-branch review found it; nine rounds of incremental
 * review could not, because no single round's diff contained both the predicate and the place
 * that makes a pid ambiguous.
 *
 * BUT THE SHORTCUT WAS COVERING SOMETHING REAL, and deleting it outright would break that: a
 * replacement spawn runs while the row may still carry the DEAD child's claim (its id was
 * minted per pass, and its pid is this process, which is alive). With no exception at all, the
 * liveness probe answers `alive` — it is our own pid — and the gateway would refuse to respawn
 * its own session for the whole takeover window.
 *
 * So the exception is narrowed from "same pid" to "same pid, AND no live owner in this process
 * holds that id":
 *
 *   | row claimant | pid | this set | verdict |
 *   |---|---|---|---|
 *   | ours | any | — | not blocking — it is ours by identity |
 *   | other | ours | held | **BLOCKING** — another logical gateway in this process owns it |
 *   | other | ours | not held | not blocking — our own dead incarnation's, or a recycled pid |
 *   | other | other | — | recency + liveness decide, as before |
 *
 * ASYMMETRY, DELIBERATE. A claim is noted when the funnel writes it, even if the save is later
 * prevented (noting an id we do not hold blocks nobody: the predicate only ever looks up the id
 * a ROW names). A claim is dropped when the funnel writes the transition that gives it up, even
 * if that save is prevented — because the worst case there is that this process later overwrites
 * a stale claim of its OWN, which is the one claim it is entitled to overwrite. Both errors
 * therefore fall on the recoverable side, which is the same disposition the rest of this
 * subsystem takes.
 */

/** Ownership ids — adoption claims and spawn reservations — this process currently holds. */
const held = new Set<string>()

/** Record that this process holds `id`. Called from the ownership funnel, not from call sites:
 *  a bookkeeping obligation spread over call sites is the shape round forty rejected. */
export function noteLocalOwnership(id: string | undefined): void {
  if (id !== undefined) held.add(id)
}

/** Record that this process no longer holds `id`. */
export function dropLocalOwnership(id: string | undefined): void {
  if (id !== undefined) held.delete(id)
}

/** Does a live owner in THIS process hold `id`? */
export function isHeldLocally(id: string | undefined): boolean {
  return id !== undefined && held.has(id)
}

/** Test seam: forget everything. Production never calls this — a process that has forgotten
 *  what it owns is exactly the state this module exists to prevent. */
export function resetLocalOwnershipForTests(): void {
  held.clear()
}
