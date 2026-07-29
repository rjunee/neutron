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
