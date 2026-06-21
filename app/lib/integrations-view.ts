/**
 * @neutronai/app — Integrations screen view-model helpers.
 *
 * Pure transforms from the `GET /api/cores/integrations` payload into the
 * display rows the Integrations screen renders. Kept separate from the RN
 * component so the list/status logic is unit-testable (mirrors
 * `task-create-modal-helpers.ts` etc.).
 *
 * Cross-ref: app/app/integrations.tsx, app/lib/cores-client.ts,
 * gateway/cores/integrations.ts.
 */

import type {
  ApiKeyIntegration,
  IntegrationsResponse,
  OAuthAccountIntegration,
} from './cores-client';

export interface IntegrationRow {
  /** Stable id = the integration label. */
  id: string;
  kind: 'oauth' | 'api_key';
  /** Human-facing title (the label, e.g. `google_calendar`). */
  title: string;
  connected: boolean;
  /** One-line status, e.g. "Connected as a@b.com" / "Not connected". */
  statusLabel: string;
  /** Secondary detail line (cores using it, or the paste prompt). */
  detail: string;
  /** Only meaningful for api_key rows. */
  required: boolean;
  /** Bundled Core slugs that declare this integration. */
  cores: string[];
}

export interface IntegrationsView {
  oauth: IntegrationRow[];
  apiKeys: IntegrationRow[];
  /** Connected count across both sections. */
  connectedCount: number;
  /** Total integration slots across both sections. */
  totalCount: number;
}

function coresDetail(cores: string[]): string {
  if (cores.length === 0) return 'No Cores';
  return `Used by ${cores.join(', ')}`;
}

export function oauthRow(account: OAuthAccountIntegration): IntegrationRow {
  const statusLabel = account.connected
    ? account.email !== null
      ? `Connected as ${account.email}`
      : 'Connected'
    : 'Not connected';
  return {
    id: account.label,
    kind: 'oauth',
    title: account.label,
    connected: account.connected,
    statusLabel,
    detail: coresDetail(account.core_slugs),
    required: false,
    cores: account.core_slugs,
  };
}

export function apiKeyRow(slot: ApiKeyIntegration): IntegrationRow {
  const statusLabel = slot.connected ? 'Key stored' : 'No key';
  // Prefer the Core's paste-prompt copy when not connected; fall back to
  // which Cores use it once a key is stored.
  const detail =
    !slot.connected && slot.install_prompt.length > 0
      ? slot.install_prompt
      : coresDetail(slot.core_slugs);
  return {
    id: slot.label,
    kind: 'api_key',
    title: slot.label,
    connected: slot.connected,
    statusLabel,
    detail,
    required: slot.required,
    cores: slot.core_slugs,
  };
}

/**
 * Summarize the full payload into render-ready rows + connection counts.
 * Order is preserved from the server (already label-sorted).
 */
export function summarizeIntegrations(
  res: IntegrationsResponse,
): IntegrationsView {
  const oauth = res.oauth.map(oauthRow);
  const apiKeys = res.api_keys.map(apiKeyRow);
  const all = [...oauth, ...apiKeys];
  return {
    oauth,
    apiKeys,
    connectedCount: all.filter((r) => r.connected).length,
    totalCount: all.length,
  };
}
