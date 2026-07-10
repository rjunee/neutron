/**
 * @neutronai/runtime — subagent spawn validator + initial registration.
 *
 * Lifted from OpenClaw's `subagent-spawn.ts` shape, hardened with the
 * Hermes-style signed-delegation tokens.
 *
 * Validation chain (each step throws on violation), in order:
 *
 *   1. nested authorization (only when `parent_run_id` is set):
 *        a. parent exists + spawn_depth ≤ MAX_SPAWN_DEPTH
 *        b. delegation token present, verifies, and its claims match the
 *           requested instance + depth
 *   2. double-spawn guard: if `spawn_key` is set and a same-instance LIVE
 *      record already holds it, coalesce (return the in-flight record) or
 *      refuse (throw). Runs AFTER step 1's authorization so a coalesce only
 *      ever returns an authorized caller their own twin, and after step 1's
 *      `await` so the check-then-create is atomic (no TOCTOU); runs BEFORE
 *      steps 3-4 so a coalescing retry (which adds no child + reuses the live
 *      slot) is never blocked by the child or concurrency caps.
 *   3. live children of `parent_run_id` < MAX_CHILDREN_PER_AGENT (new children only)
 *   4. live registry size < MAX_CONCURRENT_SUBAGENTS
 *
 * Returns the freshly-created `SubagentRecord` (status=`pending`). The caller
 * is responsible for kicking off the actual substrate dispatch and calling
 * `registry.update(run_id, { status: 'running', ... })` once the child is alive.
 *
 * The double-spawn guard (step 0) mirrors the Vajra incident class where a
 * registry-only pid that was never killed let two processes attach to one
 * logical session. By keying on a caller-supplied logical `spawn_key`
 * (e.g. `code-gen:<task_id>:forge`), a duplicate in-flight spawn for the same
 * task coalesces onto the existing run instead of starting a second process.
 * It pairs with the agent-aware watchdog (`watchdog.ts`): the watchdog reaps a
 * registry-live-but-process-dead record so a legitimate re-spawn can proceed,
 * while the guard blocks a concurrent duplicate while the first is genuinely
 * in flight.
 */

import {
  MAX_CHILDREN_PER_AGENT,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SPAWN_DEPTH,
  type AgentKind,
  type SubagentRecord,
  type SubagentRegistry,
} from './registry.ts'

export interface DelegationClaims {
  /** Instance the delegation is bound to. */
  instance: string
  /** Spawn depth this delegation authorizes. */
  depth: number
  /** Capability scope inherited from the parent's JWT. */
  scope: string[]
  /** Unique JWT id — used for revocation lists. */
  jti: string
}

export interface DelegationVerifier {
  /**
   * Verify a JWT token and return its claims, or throw on bad signature /
   * expired / wrong audience. Tests inject a stub; production uses
   * @neutronai/jwt-validator (lands in S2).
   */
  (token: string): Promise<DelegationClaims>
}

export interface SpawnInput {
  parent_run_id?: string
  instance_key: string
  agent_kind: AgentKind
  /** Signed delegation token from the parent. REQUIRED for nested spawns. */
  delegation_token?: string
  parent_session_id?: string
  delivery_target?: { channel: string; binding_id: string }
  /**
   * Logical de-dup key for the double-spawn guard. When set, a spawn for a key
   * already held by a LIVE (`pending`|`running`) record is coalesced/refused
   * rather than starting a second process for the same task. Callers should
   * namespace it so distinct logical tasks never collide — e.g.
   * `${instance_key}:${task_id}:${agent_kind}`. Omit to opt out of the guard.
   */
  spawn_key?: string
  /**
   * Behaviour when `spawn_key` collides with a live record:
   *   - `'coalesce'` (default): return the existing in-flight record (no new
   *     process, no throw) — the safe "don't double-spawn" default.
   *   - `'refuse'`: throw, so the caller learns a duplicate was attempted.
   */
  on_duplicate?: 'coalesce' | 'refuse'
}

export interface SpawnDeps {
  registry: SubagentRegistry
  verify_delegation: DelegationVerifier
  /** Mint a fresh run_id. Tests inject a stub for determinism. */
  mint_run_id?: () => string
}

export async function spawnSubagent(
  input: SpawnInput,
  deps: SpawnDeps,
): Promise<SubagentRecord> {
  // Authorize a nested spawn FIRST. Two reasons the double-spawn guard runs
  // AFTER this block rather than before it:
  //
  //   (P2) Authorize-before-coalesce. Coalescing returns another run's record;
  //        doing that before verifying `parent_run_id` + the delegation token
  //        would hand an unauthorized / malformed nested request (one that
  //        guessed or replayed a `spawn_key`) a live record it never proved it
  //        owns, and bypass the mandatory nested-delegation check.
  //
  //   (P1) No-TOCTOU. `verify_delegation` is the only `await` in this function.
  //        If the guard's `liveByKey` read ran before it, two concurrent nested
  //        spawns sharing a key could BOTH pass the read, then both resume past
  //        the await and create separate records. Reading `liveByKey`
  //        immediately before the synchronous `create` below (no await between)
  //        makes the check-then-create atomic, so the second caller always sees
  //        the first caller's record.
  let spawn_depth = 0
  let claims: DelegationClaims | undefined
  if (input.parent_run_id !== undefined) {
    const parent = deps.registry.byRunId(input.parent_run_id)
    if (!parent) {
      throw new Error(
        `subagent spawn: unknown parent_run_id ${JSON.stringify(input.parent_run_id)}`,
      )
    }
    spawn_depth = parent.spawn_depth + 1
    if (spawn_depth > MAX_SPAWN_DEPTH) {
      throw new Error(
        `subagent spawn: depth ${spawn_depth} exceeds MAX_SPAWN_DEPTH=${MAX_SPAWN_DEPTH}`,
      )
    }
    if (!input.delegation_token) {
      throw new Error('subagent spawn: nested spawn requires a signed delegation token')
    }
    claims = await deps.verify_delegation(input.delegation_token)
    if (claims.instance !== input.instance_key) {
      throw new Error(
        `subagent spawn: delegation instance ${JSON.stringify(claims.instance)} != requested instance ${JSON.stringify(input.instance_key)}`,
      )
    }
    if (claims.depth < spawn_depth) {
      throw new Error(
        `subagent spawn: delegation authorizes depth ${claims.depth} but spawn requires depth ${spawn_depth}`,
      )
    }
    // NOTE: the child-count cap is intentionally checked AFTER the double-spawn
    // guard below — a coalescing retry adds no child, so it must not be
    // rejected by a parent that is already at MAX_CHILDREN_PER_AGENT (the
    // in-flight twin it coalesces onto is itself one of those children).
  }

  // Double-spawn guard. Runs here — after nested AUTHORIZATION (parent +
  // delegation token verified, so a coalesce only ever returns an authorized
  // caller their own record) and after the only `await` above (so the
  // `liveByKey` read and the synchronous `create` below are not separated by
  // any `await` → check-then-create is atomic against a concurrent duplicate),
  // but BEFORE the child + concurrency caps so a coalesced duplicate is never
  // cap-blocked. The lookup is instance-scoped, so a cross-instance key
  // collision can neither hide a same-instance duplicate nor leak across.
  if (input.spawn_key !== undefined) {
    const inflight = deps.registry.liveByKey(input.spawn_key, input.instance_key)
    if (inflight) {
      if (input.on_duplicate === 'refuse') {
        throw new Error(
          `subagent spawn: duplicate in-flight spawn for key ${JSON.stringify(input.spawn_key)} ` +
            `(live run_id=${inflight.run_id}, status=${inflight.status}); refusing`,
        )
      }
      // Coalesce: hand back the existing run so the caller awaits the one
      // genuine process instead of starting a second.
      return inflight
    }
  }

  // Child-count cap — only a genuinely-new nested child reaches here (a
  // coalescing retry already returned above).
  if (input.parent_run_id !== undefined) {
    const childCount = deps.registry
      .byParent(input.parent_run_id)
      .filter((r) => r.status === 'pending' || r.status === 'running').length
    if (childCount >= MAX_CHILDREN_PER_AGENT) {
      throw new Error(
        `subagent spawn: parent ${input.parent_run_id} already has ${childCount} live children (cap ${MAX_CHILDREN_PER_AGENT})`,
      )
    }
  }

  const live = deps.registry.live()
  if (live.length >= MAX_CONCURRENT_SUBAGENTS) {
    throw new Error(
      `subagent spawn: global concurrency cap hit (${live.length}/${MAX_CONCURRENT_SUBAGENTS}); refusing new spawn`,
    )
  }

  const run_id = (deps.mint_run_id ?? defaultMintRunId)()
  const createInput: Parameters<SubagentRegistry['create']>[0] = {
    run_id,
    instance_key: input.instance_key,
    agent_kind: input.agent_kind,
    spawn_depth,
  }
  if (input.parent_run_id !== undefined) createInput.parent_run_id = input.parent_run_id
  if (input.parent_session_id !== undefined) createInput.parent_session_id = input.parent_session_id
  if (input.delivery_target !== undefined) createInput.delivery_target = input.delivery_target
  if (claims !== undefined) createInput.delegation_claims = claims
  if (input.spawn_key !== undefined) createInput.spawn_key = input.spawn_key
  return await deps.registry.create(createInput)
}

function defaultMintRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}
