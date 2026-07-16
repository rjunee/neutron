/**
 * @neutronai/trident — Codex connect/status AGENT tools (Part B).
 *
 * Agent-native parity for the admin-panel "Connect Codex" flow: anything the
 * owner can do in the Settings tab, the live agent can do too. Both the HTTP
 * surface (`gateway/http/codex-credential-surface.ts`) and these tools dispatch
 * the SAME `CodexCredentialService`, so validation (subscription-only, metered
 * `OPENAI_API_KEY` rejected), storage (#149 credential store), and materialization
 * to the per-project `CODEX_HOME/auth.json` happen in ONE place.
 *
 *   - `codex_status`  — connected / expired / not_connected (read, auto-approve)
 *   - `codex_connect` — paste a ChatGPT-subscription auth.json to connect (write,
 *                       prompt-user; a metered key paste is rejected, never stored)
 */

import type { JsonSchemaDocument } from '@neutronai/core-sdk/types.ts'
import type { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { CodexCredentialService } from './codex-credential.ts'
import { asOwnerHandle } from '@neutronai/persistence/index.ts'

export const CODEX_STATUS_TOOL = 'codex_status'
export const CODEX_CONNECT_TOOL = 'codex_connect'

const statusInputSchema: JsonSchemaDocument = { type: 'object', properties: {}, additionalProperties: false }
const statusOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    status: { type: 'string', description: "'connected' | 'expired' | 'not_connected'" },
    materialized: { type: 'boolean', description: 'Whether an auth.json is present at the owner CODEX_HOME.' },
    expires_at: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['status', 'detail'],
}

const connectInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    auth: {
      type: 'string',
      description:
        'The full contents of the owner\'s ~/.codex/auth.json (a ChatGPT SUBSCRIPTION login). ' +
        'MUST be subscription auth (tokens.refresh_token present); a metered OPENAI_API_KEY is REJECTED.',
    },
  },
  required: ['auth'],
  additionalProperties: false,
}
const connectOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string' },
    mode: { type: 'string' },
    error: { type: 'string', description: 'Set when ok=false — incl. the metered-key rejection guidance.' },
  },
  required: ['ok'],
}

interface ConnectArgs {
  auth?: unknown
}

/** Register `codex_status` + `codex_connect` against `registry`. */
export function registerCodexCredentialToolSurface(
  registry: ToolRegistry,
  deps: { service: CodexCredentialService },
): { statusTool: string; connectTool: string } {
  registry.register({
    name: CODEX_STATUS_TOOL,
    description:
      'Report whether the Codex cross-model reviewer is connected (a ChatGPT subscription auth). ' +
      'Returns connected / expired / not_connected. Call this before telling the owner about codex review status.',
    input_schema: statusInputSchema,
    output_schema: statusOutputSchema,
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async (_args, ctx) => {
      return { ...deps.service.status(asOwnerHandle(ctx.project_slug)) }
    },
  })

  registry.register({
    name: CODEX_CONNECT_TOOL,
    description:
      'Connect the Codex cross-model reviewer by storing the owner\'s pasted ~/.codex/auth.json ' +
      '(a ChatGPT SUBSCRIPTION login). Only use when the owner explicitly provides their auth.json. ' +
      'A metered OPENAI_API_KEY is rejected — never metered. On success it is stored encrypted and ' +
      'materialized so trident reviews run codex.',
    input_schema: connectInputSchema,
    output_schema: connectOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'prompt-user',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as ConnectArgs
      const result = await deps.service.connect(asOwnerHandle(ctx.project_slug), a.auth)
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'could not connect Codex', ...(result.code !== undefined ? { code: result.code } : {}) }
      }
      return { ok: true, status: result.status, mode: result.mode }
    },
  })

  return { statusTool: CODEX_STATUS_TOOL, connectTool: CODEX_CONNECT_TOOL }
}
