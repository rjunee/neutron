/**
 * @neutronai/gateway/cores — agent-native Integrations chat tools.
 *
 * Agent-native parity (WAVE 2 Track A): every connect/disconnect action a
 * user can take in the Integrations admin UI, the agent can take in chat.
 * These tools route through the SAME `gateway/cores/integrations.ts` brain
 * the HTTP surface uses — there is no second code path.
 *
 *   - `integrations_list`       — show every OAuth account + API-key slot
 *                                 and its status (no secrets returned).
 *   - `integrations_connect`    — OAuth label → return a click-to-connect
 *                                 URL; API-key label + value → store the key.
 *   - `integrations_disconnect` — OAuth label → revoke + delete tokens;
 *                                 API-key label → clear the stored key.
 *
 * Registered against the per-process `ToolRegistry` in
 * gateway/composition/wire-cores-surfaces.ts, alongside the OAuth surface,
 * so the manager + secrets store + registry are the same instances the
 * HTTP surface holds.
 */

import type { ToolRegistration } from '../../tools/registry.ts'
import type { SecretsStore } from '../../auth/secrets-store.ts'
import type { ProjectDb } from '../../persistence/index.ts'
import type { StartOAuthResult } from '../http/cores-oauth-surface.ts'
import type { OAuthTokenManager } from './oauth-token-manager.ts'
import {
  buildIntegrationsStatus,
  collectApiKeySlots,
  collectOAuthSlots,
  deleteApiKey,
  disconnectOAuth,
  IntegrationsError,
  setApiKey,
  type IntegrationsRegistryView,
} from './integrations.ts'

export interface IntegrationsToolsDeps {
  registry: IntegrationsRegistryView
  tokens: OAuthTokenManager
  secretsStore: SecretsStore
  project_slug: string
  /**
   * Project DB — threaded so the OAuth-disconnect path can flag every
   * affected Core `install_failed_dependency_missing` via the shared
   * `disconnectOAuth` brain, matching the HTTP/UI disconnect path exactly.
   */
  db: ProjectDb
  /**
   * Start a Google OAuth grant in-process and return the PUBLIC Google
   * `authorize_url` (provided by the Cores OAuth surface). The agent hands
   * this link to the user to open — it is NOT a bearer-gated gateway route,
   * so it works in any browser. Same server-side round-trip the UI runs.
   */
  startOAuth: (labels: string[]) => Promise<StartOAuthResult>
}

function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null
    ? (args as Record<string, unknown>)
    : {}
}

function requireLabel(args: unknown): string {
  const label = asRecord(args).label
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new IntegrationsError('unknown_label', 'arg `label` is required')
  }
  return label.trim()
}

/**
 * Build the three agent-native integration tools. Pure — returns
 * registrations; the caller registers them on the ToolRegistry.
 */
export function buildIntegrationsTools(
  deps: IntegrationsToolsDeps,
): ToolRegistration[] {
  const listTool: ToolRegistration = {
    name: 'integrations_list',
    description:
      'List every connected integration: per-Core Google OAuth accounts and standalone API-key slots, each with its connection status. Returns no secret values.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    output_schema: { type: 'object' },
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async () =>
      buildIntegrationsStatus({
        registry: deps.registry,
        tokens: deps.tokens,
        secretsStore: deps.secretsStore,
        project_slug: deps.project_slug,
      }),
  }

  const connectTool: ToolRegistration = {
    name: 'integrations_connect',
    description:
      'Connect an integration. For a Google OAuth account, returns a click-to-connect URL the user opens to grant access. For an API-key slot, pass `value` to store the key.',
    input_schema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description:
            'The integration label (e.g. google_calendar, google_workspace, gmail_compose, tavily).',
        },
        value: {
          type: 'string',
          description: 'API key value (required for API-key slots only).',
        },
      },
      required: ['label'],
      additionalProperties: false,
    },
    output_schema: { type: 'object' },
    capability_required: 'write:project_data',
    approval_policy: 'prompt-user',
    handler: async (args) => {
      const label = requireLabel(args)
      const oauthSlots = collectOAuthSlots(deps.registry)
      const apiKeySlots = collectApiKeySlots(deps.registry)
      if (oauthSlots.has(label)) {
        // Run the SAME server-side start the UI runs and hand back the
        // PUBLIC Google consent URL — never a bearer-gated /start link
        // (that 401s in a browser).
        const started = await deps.startOAuth([label])
        if (!started.ok) {
          throw new IntegrationsError(
            started.code === 'unknown_label' ? 'unknown_label' : 'oauth_start_failed',
            `could not start OAuth for '${label}': ${started.message}`,
          )
        }
        return {
          kind: 'oauth',
          label,
          authorize_url: started.authorize_url,
          message: `To connect ${label}, open this link and grant access: ${started.authorize_url}`,
        }
      }
      if (apiKeySlots.has(label)) {
        const value = asRecord(args).value
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new IntegrationsError(
            'empty_value',
            `api-key slot '${label}' requires a non-empty \`value\``,
          )
        }
        await setApiKey({
          registry: deps.registry,
          secretsStore: deps.secretsStore,
          project_slug: deps.project_slug,
          label,
          value,
        })
        return { kind: 'api_key', label, connected: true, message: `Stored API key for ${label}.` }
      }
      throw new IntegrationsError(
        'unknown_label',
        `label='${label}' is not declared by any bundled Core`,
      )
    },
  }

  const disconnectTool: ToolRegistration = {
    name: 'integrations_disconnect',
    description:
      'Disconnect an integration. For a Google OAuth account, revokes and deletes the stored tokens. For an API-key slot, clears the stored key. Tools that depend on it stop working until reconnected.',
    input_schema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'The integration label to disconnect.',
        },
      },
      required: ['label'],
      additionalProperties: false,
    },
    output_schema: { type: 'object' },
    capability_required: 'write:project_data',
    approval_policy: 'prompt-user',
    handler: async (args) => {
      const label = requireLabel(args)
      const oauthSlots = collectOAuthSlots(deps.registry)
      const apiKeySlots = collectApiKeySlots(deps.registry)
      if (oauthSlots.has(label)) {
        // Route through the SHARED disconnect brain — revoke + delete tokens
        // AND flag every affected Core dependency-missing — so a chat-
        // initiated disconnect leaves /api/cores in the SAME state the UI/HTTP
        // path produces (no "still installed" divergence).
        const { deleted, affected_cores } = await disconnectOAuth({
          tokens: deps.tokens,
          registry: deps.registry,
          projectDb: deps.db,
          project_slug: deps.project_slug,
          label,
        })
        return { kind: 'oauth', label, disconnected: deleted, affected_cores }
      }
      if (apiKeySlots.has(label)) {
        const { deleted } = await deleteApiKey({
          registry: deps.registry,
          secretsStore: deps.secretsStore,
          project_slug: deps.project_slug,
          label,
        })
        return { kind: 'api_key', label, disconnected: deleted }
      }
      throw new IntegrationsError(
        'unknown_label',
        `label='${label}' is not declared by any bundled Core`,
      )
    },
  }

  return [listTool, connectTool, disconnectTool]
}
