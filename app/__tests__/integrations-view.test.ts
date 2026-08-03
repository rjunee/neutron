/**
 * WAVE 2 Track A — Integrations screen view-model tests.
 *
 * The Integrations UI lists connected OAuth accounts + API keys with the
 * correct status. These assert the pure transform that drives that list.
 */

import { describe, expect, test } from 'bun:test'

import type { IntegrationsResponse } from '../lib/cores-client';
import {
  apiKeyRow,
  oauthRow,
  summarizeIntegrations,
} from '../lib/integrations-view';

const RESPONSE: IntegrationsResponse = {
  ok: true,
  oauth: [
    {
      kind: 'oauth',
      label: 'google_calendar',
      scope: 'https://www.googleapis.com/auth/calendar',
      core_slugs: ['calendar_core'],
      connected: true,
      email: 'me@example.com',
      scopes: ['https://www.googleapis.com/auth/calendar'],
      connected_at: 1,
      last_refresh_at: null,
      last_refresh_outcome: 'ok',
      expires_at: 2,
    },
    {
      kind: 'oauth',
      label: 'gmail_compose',
      scope: 'https://www.googleapis.com/auth/gmail.compose',
      core_slugs: ['email_core'],
      connected: false,
      email: null,
      scopes: [],
      connected_at: null,
      last_refresh_at: null,
      last_refresh_outcome: null,
      expires_at: null,
    },
  ],
  api_keys: [
    {
      kind: 'api_key',
      label: 'tavily',
      name: 'tavily_api_key',
      core_slugs: ['research_core'],
      required: false,
      install_prompt: 'Paste your Tavily API key',
      connected: false,
    },
  ],
};

describe('oauthRow', () => {
  test('connected account shows "Connected as <email>"', () => {
    const row = oauthRow(RESPONSE.oauth[0]!);
    expect(row.kind).toBe('oauth');
    expect(row.connected).toBe(true);
    expect(row.statusLabel).toBe('Connected as me@example.com');
    expect(row.detail).toContain('calendar_core');
  });

  test('disconnected account shows "Not connected"', () => {
    const row = oauthRow(RESPONSE.oauth[1]!);
    expect(row.connected).toBe(false);
    expect(row.statusLabel).toBe('Not connected');
  });
});

describe('apiKeyRow', () => {
  test('absent key shows the paste prompt as the detail', () => {
    const row = apiKeyRow(RESPONSE.api_keys[0]!);
    expect(row.kind).toBe('api_key');
    expect(row.connected).toBe(false);
    expect(row.statusLabel).toBe('No key');
    expect(row.detail).toBe('Paste your Tavily API key');
  });

  test('stored key shows "Key stored" + cores detail', () => {
    const row = apiKeyRow({ ...RESPONSE.api_keys[0]!, connected: true });
    expect(row.statusLabel).toBe('Key stored');
    expect(row.detail).toContain('research_core');
  });
});

describe('summarizeIntegrations', () => {
  test('counts connected across both sections', () => {
    const view = summarizeIntegrations(RESPONSE);
    expect(view.oauth).toHaveLength(2);
    expect(view.apiKeys).toHaveLength(1);
    expect(view.totalCount).toBe(3);
    expect(view.connectedCount).toBe(1); // only google_calendar
  });

  test('reflects a stored key + second connected account', () => {
    const view = summarizeIntegrations({
      ...RESPONSE,
      oauth: RESPONSE.oauth.map((o) => ({ ...o, connected: true })),
      api_keys: RESPONSE.api_keys.map((k) => ({ ...k, connected: true })),
    });
    expect(view.connectedCount).toBe(3);
    expect(view.totalCount).toBe(3);
  });
});

describe('oauthRow title — composite labels must not leak a hash to the owner', () => {
  const base = {
    kind: 'oauth' as const,
    scope: 'https://www.googleapis.com/auth/calendar',
    core_slugs: ['calendar_core'],
    connected: true,
    scopes: ['https://www.googleapis.com/auth/calendar'],
    connected_at: 1,
    last_refresh_at: null,
    last_refresh_outcome: 'ok' as const,
    expires_at: null,
  }

  test('a multi-account label renders a human service name, not the account key', () => {
    // Labels became `<service>#<account_key>` when a service gained multiple
    // accounts. `title` is rendered straight into the Integrations list, so the
    // raw label would put a hex digest in front of the owner.
    const row = oauthRow({ ...base, label: 'google_calendar#a1b2c3d4', email: 'me@example.com' })
    expect(row.title).toBe('Google Calendar')
    expect(row.title).not.toContain('#')
    expect(row.title).not.toContain('a1b2c3d4')
    // The ACCOUNT is identified on the status line, so the title needn't repeat it.
    expect(row.statusLabel).toBe('Connected as me@example.com')
    // `id` keeps the FULL label — it is the row key and must stay unique across
    // two accounts on the same service.
    expect(row.id).toBe('google_calendar#a1b2c3d4')
  })

  test('two accounts on one service get distinct ids but the same title', () => {
    const a = oauthRow({ ...base, label: 'google_calendar#aaaa1111', email: 'work@example.com' })
    const b = oauthRow({ ...base, label: 'google_calendar#bbbb2222', email: 'personal@example.com' })
    expect(a.id).not.toBe(b.id)
    expect(a.title).toBe(b.title)
    expect(a.statusLabel).not.toBe(b.statusLabel)
  })

  test('a legacy un-keyed label still renders (no # to strip)', () => {
    const row = oauthRow({ ...base, label: 'gmail_compose', email: null })
    expect(row.title).toBe('Gmail Compose')
    expect(row.id).toBe('gmail_compose')
  })
})
