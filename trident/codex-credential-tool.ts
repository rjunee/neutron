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

import type { JsonSchemaDocument } from '@neutronai/cores-sdk/manifest'
import type { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { CodexCredentialService } from './codex-credential.ts'
import { asOwnerHandle } from '@neutronai/persistence/index.ts'

export const CODEX_STATUS_TOOL = 'codex_status'
export const CODEX_CONNECT_TOOL = 'codex_connect'

const statusInputSchema: JsonSchemaDocument = { type: 'object', properties: {}, additionalProperties: false }
const statusOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      description:
        "'connected' | 'expired' | 'revoked' | 'not_connected'. 'revoked' means a LIVE probe of " +
        'the ChatGPT backend refused the stored token even though it has not expired — the seat ' +
        'is dead until the owner reconnects it, and no local field can show that.',
    },
    materialized: { type: 'boolean', description: 'Whether an auth.json is present at the owner CODEX_HOME.' },
    expires_at: { type: 'string' },
    detail: { type: 'string' },
    accounts: {
      type: 'array',
      description:
        'Every connected Codex seat: slot, status, whether it is cooling off after hitting a ' +
        'usage cap, and its last known usage percentage. Never contains token material.',
      items: { type: 'object' },
    },
    next: { type: 'string', description: 'The seat the next trident run will use.' },
    exhausted: {
      type: 'boolean',
      description: 'True when EVERY seat is cooling — the next run keeps the current seat and will likely fail.',
    },
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
    account: {
      type: 'string',
      description:
        'Optional NAME for this seat when the owner is connecting a SECOND ChatGPT subscription ' +
        "(e.g. 'work'). 1-32 chars, lowercase letters, digits and dashes. Omit for the owner's " +
        'first/primary seat. Each named seat is stored separately and trident rotates between them ' +
        'when one hits its usage cap.',
    },
    label: { type: 'string', description: 'Optional human-readable label shown in the settings pane.' },
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
  account?: unknown
  label?: unknown
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
      'Returns connected / expired / revoked / not_connected — `revoked` comes from a LIVE probe ' +
      'of the ChatGPT backend, so a seat whose token was invalidated server-side is reported dead ' +
      'instead of connected. Call this before telling the owner about codex review status.',
    input_schema: statusInputSchema,
    output_schema: statusOutputSchema,
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async (_args, ctx) => {
      const owner = asOwnerHandle(ctx.project_slug)
      // PROBE BEFORE READING. Everything below this line is a read of stored
      // bytes, and stored bytes cannot show a token the server revoked — which is
      // exactly the state this tool reported as `connected` while every build
      // died on `refresh_token_invalidated`. The probe is TTL-cached per seat and
      // bounded at 3s, and it never throws: an unreachable endpoint leaves the
      // reading precisely as it was before this call.
      await deps.service.refreshSeatLiveness(owner)
      // ONE pass, and the POOL's status — the same two corrections the HTTP
      // route needed, for the same reasons. Asking for the seats and the next
      // seat separately reconciled the pool twice and let the two halves answer
      // against different state; and `status(owner)` alone describes seat one, so
      // an owner running only a NAMED seat would be told Codex was not connected
      // while trident was running reviews with it.
      //
      // Both survive the rebase deliberately: main's probe answers "are these bytes
      // still good", this branch's single pass answers "which seats are there". They
      // are different questions and the tool needs both.
      const { accounts, next } = deps.service.accountsView(owner)
      return {
        ...deps.service.poolStatus(owner, accounts),
        accounts,
        ...(next !== null ? { next: next.slot, exhausted: next.exhausted } : {}),
      }
    },
  })

  registry.register({
    name: CODEX_CONNECT_TOOL,
    description:
      'Connect the Codex cross-model reviewer by storing the owner\'s pasted ~/.codex/auth.json ' +
      '(a ChatGPT SUBSCRIPTION login). Only use when the owner explicitly provides their auth.json. ' +
      'A metered OPENAI_API_KEY is rejected — never metered. On success it is stored encrypted and ' +
      'materialized so trident reviews run codex. Pass `account` to add a SECOND ChatGPT ' +
      'subscription: trident then rotates between seats, skipping any that has hit its usage cap. ' +
      'Tell the owner that once a seat is connected here they should stop using that same ChatGPT ' +
      'login for codex elsewhere — the CLI rotates refresh tokens, so two live copies of one ' +
      'account revoke each other.',
    input_schema: connectInputSchema,
    output_schema: connectOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'prompt-user',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as ConnectArgs
      const result = await deps.service.connectAccount(asOwnerHandle(ctx.project_slug), a.auth, {
        ...(typeof a.account === 'string' ? { slot: a.account } : {}),
        label: typeof a.label === 'string' ? a.label : null,
      })
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'could not connect Codex', ...(result.code !== undefined ? { code: result.code } : {}) }
      }
      return { ok: true, status: result.status, mode: result.mode, account: result.slot }
    },
  })

  return { statusTool: CODEX_STATUS_TOOL, connectTool: CODEX_CONNECT_TOOL }
}
