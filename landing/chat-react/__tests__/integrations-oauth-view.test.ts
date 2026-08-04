/**
 * Unit tests for the web Admin tab's OAuth view-model. Pure — no DOM.
 *
 * The thing being pinned is the MULTI-ACCOUNT contract: the server returns one
 * row per connected account under a composite `<service>#<account_key>` label,
 * and the account key is a hex digest that must never be rendered at the owner.
 * Grouping is what lets one service show three independently-disconnectable
 * accounts AND still offer a connect action for the next one.
 */

import { describe, expect, it } from 'bun:test'

import type { OAuthAccountIntegration } from '../integrations-client.ts'
import {
  groupOAuthAccounts,
  oauthAccountStatus,
  oauthService,
  oauthServiceTitle,
} from '../integrations-oauth-view.ts'

function acc(
  label: string,
  email: string | null,
  connected = true,
  core_slugs: string[] = ['calendar-core'],
): OAuthAccountIntegration {
  return {
    kind: 'oauth',
    label,
    connected,
    scopes: [],
    email,
    connected_at: null,
    last_refresh_at: null,
    last_refresh_outcome: null,
    expires_at: null,
    scope: '',
    core_slugs,
  }
}

describe('oauthService / oauthServiceTitle', () => {
  it('strips the account key — CONNECT must address the manifest-declared service', () => {
    expect(oauthService('google_calendar#a1b2c3d4')).toBe('google_calendar')
    // A legacy un-keyed grant (and a not-yet-connected placeholder) is already
    // the service.
    expect(oauthService('google_calendar')).toBe('google_calendar')
  })

  it('humanises the service and never leaks the hex account key into the title', () => {
    expect(oauthServiceTitle('google_calendar#a1b2c3d4')).toBe('Google Calendar')
    expect(oauthServiceTitle('google_workspace')).toBe('Google Workspace')
    expect(oauthServiceTitle('gmail_compose#deadbeef')).not.toContain('deadbeef')
  })
})

describe('oauthAccountStatus', () => {
  it('names the ACCOUNT, since the title only names the service', () => {
    expect(oauthAccountStatus(acc('google_calendar#a1', 'sam@example.com'))).toBe(
      'Connected as sam@example.com',
    )
    expect(oauthAccountStatus(acc('google_calendar#a1', null))).toBe('Connected')
    expect(oauthAccountStatus(acc('google_calendar', null, false))).toBe('Not connected')
  })
})

describe('groupOAuthAccounts', () => {
  it('folds three accounts on one service into one group, each keeping its FULL label', () => {
    const groups = groupOAuthAccounts([
      acc('google_calendar#aaa', 'one@example.com'),
      acc('google_calendar#bbb', 'two@example.com'),
      acc('google_calendar#ccc', 'three@example.com'),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.service).toBe('google_calendar')
    expect(groups[0]!.title).toBe('Google Calendar')
    expect(groups[0]!.connectedCount).toBe(3)
    // The full labels survive — they are what DISCONNECT addresses, and losing
    // them would make the three rows indistinguishable to the server.
    expect(groups[0]!.accounts.map((a) => a.label)).toEqual([
      'google_calendar#aaa',
      'google_calendar#bbb',
      'google_calendar#ccc',
    ])
  })

  it('keeps distinct services apart and preserves the server ordering', () => {
    const groups = groupOAuthAccounts([
      acc('google_calendar#aaa', 'one@example.com'),
      acc('google_workspace', null, false, ['workspace-core']),
      acc('google_calendar#bbb', 'two@example.com'),
    ])

    expect(groups.map((g) => g.service)).toEqual(['google_calendar', 'google_workspace'])
    expect(groups[0]!.accounts).toHaveLength(2)
    expect(groups[1]!.connectedCount).toBe(0)
  })

  it('unions the Core slugs across a service accounts, first-seen order, no repeats', () => {
    const groups = groupOAuthAccounts([
      acc('google_calendar#aaa', 'one@example.com', true, ['calendar-core', 'email-core']),
      acc('google_calendar#bbb', 'two@example.com', true, ['email-core', 'workspace-core']),
    ])
    expect(groups[0]!.coreSlugs).toEqual(['calendar-core', 'email-core', 'workspace-core'])
  })

  it('an empty payload yields no groups (the tab renders its empty state)', () => {
    expect(groupOAuthAccounts([])).toEqual([])
  })
})
