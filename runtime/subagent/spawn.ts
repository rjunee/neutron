/**
 * @neutronai/runtime — subagent spawn validator + initial registration.
 *
 * Lifted from OpenClaw's `subagent-spawn.ts` shape, hardened with the
 * Hermes-style signed-delegation tokens.
 *
 * Validation chain (each step throws on violation):
 *
 *   1. spawn_depth ≤ MAX_SPAWN_DEPTH (walk parent ancestry)
 *   2. live children of `parent_run_id` < MAX_CHILDREN_PER_AGENT
 *   3. live registry size < MAX_CONCURRENT_SUBAGENTS
 *   4. delegation token verifies + claims match expected scope
 *
 * Returns the freshly-created `SubagentRecord` (status=`pending`). The caller
 * is responsible for kicking off the actual substrate dispatch and calling
 * `registry.update(run_id, { status: 'running', ... })` once the child is alive.
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
  const live = deps.registry.live()
  if (live.length >= MAX_CONCURRENT_SUBAGENTS) {
    throw new Error(
      `subagent spawn: global concurrency cap hit (${live.length}/${MAX_CONCURRENT_SUBAGENTS}); refusing new spawn`,
    )
  }

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
    const childCount = deps.registry.byParent(input.parent_run_id).filter((r) => r.status === 'pending' || r.status === 'running').length
    if (childCount >= MAX_CHILDREN_PER_AGENT) {
      throw new Error(
        `subagent spawn: parent ${input.parent_run_id} already has ${childCount} live children (cap ${MAX_CHILDREN_PER_AGENT})`,
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
  return deps.registry.create(createInput)
}

function defaultMintRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}
