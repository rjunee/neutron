import { isDeepStrictEqual } from 'node:util'

declare const authorityBrand: unique symbol

/** Host-memory identity. Serialization and structural copies confer no authority. */
export interface ProjectChatOrchestratorAuthority {
  readonly [authorityBrand]: true
}

export interface ProjectChatOrchestratorAuditFacts {
  readonly project_scope: string
  readonly project_id: string
  readonly call_id: string
  readonly chat_id: string
  readonly session_id: string
  readonly thread_id: string
  readonly generation: string
  readonly lease_id: string
}

export interface ProjectChatOrchestratorInvocation {
  project_scope: string
  project_id: string
  call_id: string
  tool_name: string
  args: unknown
}

const grants = new WeakMap<ProjectChatOrchestratorAuthority, {
  facts: Readonly<ProjectChatOrchestratorAuditFacts>
  toolName: string
  args: unknown
  assertCurrent(): void
}>()

/** Only authenticated host transport composition calls this, never tool handlers. */
export function mintProjectChatOrchestratorAuthority(input: {
  facts: ProjectChatOrchestratorAuditFacts
  toolName: string
  args: unknown
  assertCurrent(): void
}): ProjectChatOrchestratorAuthority {
  if (Object.values(input.facts).some(value => typeof value !== 'string' || !value.trim())
    || !input.toolName.trim()) throw new Error('Project-chat invocation identity is incomplete')
  input.assertCurrent()
  const authority = Object.freeze(Object.create(null)) as ProjectChatOrchestratorAuthority
  grants.set(authority, { facts: Object.freeze({ ...input.facts }), toolName: input.toolName,
    args: structuredClone(input.args), assertCurrent: input.assertCurrent })
  return authority
}

/** Recheck after asynchronous evidence reads and synchronously before the source claim. */
export function validateProjectChatOrchestratorAuthority(
  authority: unknown,
  invocation: ProjectChatOrchestratorInvocation,
): Readonly<ProjectChatOrchestratorAuditFacts> {
  const grant = authority !== null && typeof authority === 'object'
    ? grants.get(authority as ProjectChatOrchestratorAuthority) : undefined
  if (!grant || grant.facts.project_scope !== invocation.project_scope
    || grant.facts.project_id !== invocation.project_id || grant.facts.call_id !== invocation.call_id
    || grant.toolName !== invocation.tool_name || !isDeepStrictEqual(grant.args, invocation.args)) {
    throw new Error('Authenticated project-chat orchestrator invocation required')
  }
  grant.assertCurrent()
  return grant.facts
}
