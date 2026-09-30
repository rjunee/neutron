import { createHash } from 'node:crypto'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { ClaudeToolGeneration, ClaudeToolHandlerAdmission } from '@neutronai/runtime/adapters/claude-code/persistent/tool-handler-generation.ts'

/** MCP HANDLER completion only. Neither process death nor downstream effect settlement. */
export class ClaudeMcpHandlerDrain implements ClaudeToolHandlerAdmission {
  constructor(private readonly db: ProjectDb, private readonly ownerHandle: string) {}

  private identity(input: ClaudeToolGeneration): { key: string; identity: string; scope: string } {
    if (!this.ownerHandle.trim() || !input.sessionId.trim() || !input.childGeneration.trim()
      || (input.projectId !== null && (typeof input.projectId !== 'string' || !input.projectId.trim()))
      || !Number.isSafeInteger(input.admissionGeneration) || input.admissionGeneration! < 0) {
      throw new Error('Claude MCP handler generation is unknown')
    }
    const identity = JSON.stringify([this.ownerHandle, input.projectId, input.sessionId,
      input.childGeneration, input.admissionGeneration])
    return { identity, key: createHash('sha256').update(identity).digest('hex'),
      scope: JSON.stringify([this.ownerHandle, input.projectId]) }
  }

  async dispatch<T>(input: ClaudeToolGeneration, invocationId: string, binding: string,
    current: () => boolean, handler: () => Promise<T>): Promise<T> {
    const id = this.identity(input)
    binding = createHash('sha256').update(binding).digest('hex')
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(invocationId)) throw new Error('Unique invocation identity required')
    await this.db.transaction(async tx => {
      await tx.run('UPDATE project_admission_fences SET generation = generation WHERE scope_key = ?', [id.scope])
      const fence = tx.get<{ generation: number; phase: string }>(
        'SELECT generation, phase FROM project_admission_fences WHERE scope_key = ?', [id.scope])
      if (!current() || !fence || fence.phase !== 'open' || fence.generation !== input.admissionGeneration) {
        throw new Error('Claude MCP handler admission is closed or unknown')
      }
      tx.runSync(`INSERT INTO claude_mcp_handler_generations (generation_key, identity, covered)
        VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, [id.key, id.identity, input.adopted ? 0 : 1])
      const generation = tx.get<{ closed: number; identity: string }>(
        'SELECT closed, identity FROM claude_mcp_handler_generations WHERE generation_key = ?', [id.key])
      if (!generation || generation.closed || generation.identity !== id.identity) throw new Error('Claude MCP handler generation closed')
      const prior = tx.get<{ binding: string }>(
        'SELECT binding FROM claude_mcp_handler_calls WHERE generation_key = ? AND invocation_id = ?', [id.key, invocationId])
      if (prior) throw new Error(prior.binding === binding ? 'Duplicate invocation; do not replay' : 'Conflicting invocation identity')
      tx.runSync('INSERT INTO claude_mcp_handler_calls (generation_key, invocation_id, binding) VALUES (?, ?, ?)',
        [id.key, invocationId, binding])
    })
    // Revocation may run while the durable commit yields. Refusal is journaled as
    // a returned handler boundary; no handler is entered on that path.
    let result: T
    try {
      if (!current()) throw new Error('Claude MCP handler authorization revoked before invocation')
      result = await handler()
    } catch (error) {
      await this.settle(id.key, invocationId, { kind: 'threw', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    // Serialization/persistence failures deliberately leave acceptance unresolved.
    await this.settle(id.key, invocationId, { kind: 'returned', value: result })
    return result
  }

  private async settle(key: string, call: string, outcome: unknown): Promise<void> {
    // Preserve outcome identity without duplicating tool secrets in this ledger.
    const encoded = JSON.stringify(outcome)
    const digest = JSON.stringify({ kind: (outcome as { kind: string }).kind,
      sha256: createHash('sha256').update(encoded).digest('hex') })
    await this.db.transaction(tx => {
      const result = tx.runSync(`UPDATE claude_mcp_handler_calls SET outcome = ?
        WHERE generation_key = ? AND invocation_id = ? AND outcome IS NULL`, [digest, key, call])
      if (result.changes !== 1) throw new Error('Claude MCP handler outcome remains unknown')
    })
  }

  async close(input: ClaudeToolGeneration): Promise<void> {
    const id = this.identity(input)
    await this.db.run(`INSERT INTO claude_mcp_handler_generations (generation_key, identity, covered, closed)
      VALUES (?, ?, ?, 1) ON CONFLICT(generation_key) DO UPDATE SET closed = 1`,
    // Closing an unobserved identity cannot invent historical coverage.
    [id.key, id.identity, 0])
  }

  /** Read-only, exact identity. Never a native-lease release or recovery authority. */
  async proof(input: ClaudeToolGeneration): Promise<{ status: 'mcp-handlers-drained' | 'unknown'; downstreamEffects: 'unknown' }> {
    // A caller's uncommitted transaction cannot supply a committed proof. Do not
    // re-enter it (or begin a nested transaction) through ProjectDb's mutex bypass.
    if (this.db.isInTransaction()) return { status: 'unknown', downstreamEffects: 'unknown' }
    try {
      const id = this.identity(input)
      return await this.db.transaction(tx => {
        const row = tx.get<{ closed: number; covered: number; pending: number; identity: string }>(
          `SELECT g.closed, g.covered, g.identity,
            (SELECT COUNT(*) FROM claude_mcp_handler_calls c WHERE c.generation_key = g.generation_key AND c.outcome IS NULL) AS pending
            FROM claude_mcp_handler_generations g WHERE generation_key = ?`, [id.key])
        const outcomesValid = tx.all<{ outcome: string | null }>(
          'SELECT outcome FROM claude_mcp_handler_calls WHERE generation_key = ?', [id.key]).every(call => {
          if (call.outcome === null) return false
          const value: unknown = JSON.parse(call.outcome)
          if (typeof value !== 'object' || value === null) return false
          const receipt = value as { kind?: unknown; sha256?: unknown }
          return (receipt.kind === 'returned' || receipt.kind === 'threw')
            && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256)
        })
        return { status: row?.identity === id.identity && row.closed === 1 && row.covered === 1 && row.pending === 0
          && outcomesValid
          ? 'mcp-handlers-drained' as const : 'unknown' as const, downstreamEffects: 'unknown' as const }
      })
    } catch { return { status: 'unknown', downstreamEffects: 'unknown' } }
  }
}
