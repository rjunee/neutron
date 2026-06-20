/**
 * @neutronai/cores-runtime — capability gating runtime.
 *
 * Every tool call from inside a Core's substrate dispatch carries a
 * `calling_core_id`. The runtime checks the call against the Core's
 * manifest-declared capabilities (`<verb>:<resource>` per Sprint 2B
 * locked syntax). Out-of-scope tool calls fail with
 * `CapabilityDeniedError` and write a `capability_denied` row to
 * `secret_audit_log`.
 *
 * The runtime sees TWO shapes of denial:
 *   1. Tool name not declared in the manifest's `tools[]`.
 *   2. Tool's `capability_required` not declared in `capabilities[]`.
 *
 * Both surface as `CapabilityDeniedError` with a distinct `code`. The
 * audit row is a single `op='tool_call'` write keyed on the Core slug
 * and tool name; an admin / Argus surface filters on
 * `outcome='capability_denied'`.
 *
 * The composition shape:
 *
 *     guard = new CapabilityGuard({manifest, core_slug, project_slug, audit})
 *     handler = guard.wrapToolHandler({tool_name, capability_required, fn})
 *     await handler(input)
 *
 * `wrapToolHandler` returns a function that:
 *   - records `op='tool_call' outcome='ok'` on success
 *   - records `op='tool_call' outcome='capability_denied'` + throws
 *     `CapabilityDeniedError` on a manifest-declared mismatch
 *   - records `op='tool_call' outcome='error'` if the inner `fn` throws
 *     (and re-throws the original error)
 */

import type { NeutronManifest } from '@neutronai/cores-sdk'

import { CapabilityDeniedError } from './errors.ts'
import type { SecretAuditLog } from './secret-audit.ts'

export interface CapabilityGuardOptions {
  manifest: NeutronManifest
  core_slug: string
  project_slug: string
  audit: SecretAuditLog
  /**
   * Multi-author attribution (connect-spec §4.3 layer 3). The author whose turn
   * drives this guard's tool dispatches — owner = 'owner', each collaborator a
   * stable local_slug. Stamped onto every `op='tool_call'` audit row so a Core
   * side-effect is attributable to WHO triggered it. Optional: when omitted the
   * row falls back to the audit log's own default (owner-native in Open) or NULL.
   */
  author_id?: string
}

export interface ToolCheckInput {
  tool_name: string
  capability_required: string
}

export type ToolCheckResult =
  | { ok: true }
  | { ok: false; code: 'tool_not_declared' | 'capability_not_declared' | 'capability_mismatch'; reason: string }

export class CapabilityGuard {
  private readonly manifest: NeutronManifest
  private readonly core_slug: string
  private readonly project_slug: string
  private readonly audit: SecretAuditLog
  private readonly author_id: string | undefined
  private readonly toolMap: Map<string, string>

  constructor(options: CapabilityGuardOptions) {
    this.manifest = options.manifest
    this.core_slug = options.core_slug
    this.project_slug = options.project_slug
    this.audit = options.audit
    this.author_id = options.author_id
    // Pre-index tools[] for O(1) lookup. The manifest is small but
    // we hit this on every tool dispatch.
    this.toolMap = new Map()
    for (const t of options.manifest.tools) {
      this.toolMap.set(t.name, t.capability_required)
    }
  }

  /**
   * Synchronous, side-effect-free check. Used by callers that want to
   * inspect the result without writing an audit row. The wrapping
   * handler (`wrapToolHandler`) calls this and writes the row.
   */
  check(input: ToolCheckInput): ToolCheckResult {
    const declaredRequirement = this.toolMap.get(input.tool_name)
    if (declaredRequirement === undefined) {
      return {
        ok: false,
        code: 'tool_not_declared',
        reason: `tool=${input.tool_name} is not declared in core=${this.core_slug} manifest tools[]`,
      }
    }
    if (declaredRequirement !== input.capability_required) {
      return {
        ok: false,
        code: 'capability_mismatch',
        reason: `tool=${input.tool_name} declared capability_required=${declaredRequirement} but caller passed capability_required=${input.capability_required}`,
      }
    }
    if (!this.manifest.capabilities.includes(input.capability_required)) {
      return {
        ok: false,
        code: 'capability_not_declared',
        reason: `tool=${input.tool_name} requires capability=${input.capability_required} which is not in core=${this.core_slug} manifest capabilities[]`,
      }
    }
    return { ok: true }
  }

  /**
   * Audited check + throw. Records a `secret_audit_log` row and throws
   * `CapabilityDeniedError` on rejection. Returns void on success (the
   * caller proceeds to dispatch).
   */
  async assertOrDeny(input: ToolCheckInput): Promise<void> {
    const result = this.check(input)
    if (result.ok) {
      return
    }
    await this.audit.recordToolCall({
      project_slug: this.project_slug,
      core_slug: this.core_slug,
      tool_name: input.tool_name,
      outcome: 'capability_denied',
      error: result.reason,
      ...(this.author_id !== undefined ? { author_id: this.author_id } : {}),
    })
    throw new CapabilityDeniedError(result.code, result.reason, {
      core_id: this.core_slug,
      tool_name: input.tool_name,
      capability: input.capability_required,
    })
  }

  /**
   * Wrap a Core-author tool handler so the guard runs on every dispatch.
   * The returned function:
   *   - calls `assertOrDeny` first (audited + throws on deny)
   *   - awaits `fn(input)` and writes outcome='ok' on success
   *   - writes outcome='error' on inner throw and rethrows
   */
  wrapToolHandler<I, O>(
    input: ToolCheckInput & { fn: (toolInput: I) => Promise<O> },
  ): (toolInput: I) => Promise<O> {
    const tool_name = input.tool_name
    const capability_required = input.capability_required
    return async (toolInput: I): Promise<O> => {
      await this.assertOrDeny({ tool_name, capability_required })
      try {
        const out = await input.fn(toolInput)
        await this.audit.recordToolCall({
          project_slug: this.project_slug,
          core_slug: this.core_slug,
          tool_name,
          outcome: 'ok',
          ...(this.author_id !== undefined ? { author_id: this.author_id } : {}),
        })
        return out
      } catch (err) {
        await this.audit.recordToolCall({
          project_slug: this.project_slug,
          core_slug: this.core_slug,
          tool_name,
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
          ...(this.author_id !== undefined ? { author_id: this.author_id } : {}),
        })
        throw err
      }
    }
  }
}
