/**
 * @neutronai/app — `fetchProjects` mapping test (ISSUES #9).
 *
 * Verifies `fetchProjects({ base_url, token })` calls the gateway's
 * `GET /api/app/projects` and projects the canonical
 * `ProjectSettings` response onto the legacy `Project` shape the
 * project-list UI consumes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { fetchProjects, sortProjectsByActivity, type Project } from '../lib/projects';
import type { ProjectListItem } from '../lib/projects-client';

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | undefined;
}

function makeFetchStub(
  responder: (req: CapturedRequest) => { status: number; body: unknown },
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchFn: typeof globalThis.fetch = (async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    let authorization: string | undefined;
    const h = (init as RequestInit).headers;
    if (h instanceof Headers) {
      authorization = h.get('authorization') ?? undefined;
    } else if (h !== undefined) {
      const map = h as Record<string, string>;
      authorization = map['authorization'] ?? map['Authorization'];
    }
    const captured: CapturedRequest = {
      url,
      method: (init as RequestInit).method ?? 'GET',
      authorization,
    };
    calls.push(captured);
    const result = responder(captured);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

const originalFetch: typeof globalThis.fetch = globalThis.fetch;

describe('fetchProjects (ISSUES #9)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('maps server ProjectListItem to legacy Project shape, preserving kind+origin (M2.3)', async () => {
    const serverProjects: ProjectListItem[] = [
      {
        id: 'neutron',
        name: 'Neutron',
        description: 'Build Neutron itself.',
        persona: 'Forge',
        emoji: '⚛️',
        privacy_mode: 'private',
        billing_mode: 'personal',
        agent_engagement_mode: 'all_messages',
        members: [
          { user_id: 'sam', name: 'Sam', role: 'owner' },
          { user_id: 'nova', name: 'Nova', role: 'member' },
        ],
        kind: 'solo',
        origin_instance: 'demo',
        owning_instance_slug: 'demo',
        last_activity_at: '2023-11-14T22:13:20.000Z',
        unread_count: 5,
      },
      {
        id: 'acme-roadmap',
        name: 'Acme Roadmap',
        description: '',
        persona: '',
        emoji: '🚀',
        privacy_mode: 'private',
        billing_mode: 'personal',
        agent_engagement_mode: 'all_messages',
        members: [],
        kind: 'shared',
        origin_instance: 'acme',
        owning_instance_slug: 'acme',
        last_activity_at: '',
        unread_count: 0,
      },
    ];
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        projects: serverProjects,
        project_slug: 'demo',
        source_errors: [{ workspace_instance_slug: 'beta-co', error: 'http_504' }],
      },
    }));
    globalThis.fetch = stub.fetch;
    const got = await fetchProjects({
      base_url: 'http://example.test',
      token: 'dev:sam',
      now: 1_700_000_000_000,
    });
    expect(got.projects.length).toBe(2);
    const p: Project = got.projects[0]!;
    expect(p.id).toBe('neutron');
    expect(p.name).toBe('Neutron');
    expect(p.description).toBe('Build Neutron itself.');
    expect(p.persona).toBe('Forge');
    expect(p.privacy_mode).toBe('private');
    // emoji + unread_count flow straight off the list item.
    expect(p.emoji).toBe('⚛️');
    expect(p.unread_count).toBe(5);
    // last_activity_at ISO parses to wall-clock ms (this ISO == `now`).
    expect(p.last_activity_ms).toBe(1_700_000_000_000);
    expect(p.kind).toBe('solo');
    expect(p.origin_instance).toBe('demo');
    expect(p.members).toEqual([
      { name: 'Sam', role: 'owner' },
      { name: 'Nova', role: 'member' },
    ]);
    // Shared item keeps its origin so the UI can render the workspace pill.
    const shared: Project = got.projects[1]!;
    expect(shared.kind).toBe('shared');
    expect(shared.origin_instance).toBe('acme');
    expect(shared.emoji).toBe('🚀');
    expect(shared.unread_count).toBe(0);
    // Empty last_activity_at falls back to `now`.
    expect(shared.last_activity_ms).toBe(1_700_000_000_000);
    // source_errors flow through for the degraded-workspace notice.
    expect(got.sourceErrors).toEqual([{ workspace_instance_slug: 'beta-co', error: 'http_504' }]);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe('http://example.test/api/app/projects');
    expect(stub.calls[0]!.authorization).toBe('Bearer dev:sam');
  });

  it('defaults emoji + unread_count when an older gateway omits them', async () => {
    // Simulate a pre-rail gateway: no emoji / last_activity_at / unread_count.
    const legacyItem = {
      id: 'legacy',
      name: 'Legacy',
      description: '',
      persona: '',
      privacy_mode: 'private',
      billing_mode: 'personal',
      agent_engagement_mode: 'all_messages',
      members: [],
      kind: 'solo',
      origin_instance: 'demo',
      owning_instance_slug: 'demo',
    };
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, projects: [legacyItem], project_slug: 'demo', source_errors: [] },
    }));
    globalThis.fetch = stub.fetch;
    const got = await fetchProjects({
      base_url: 'http://example.test',
      token: 'dev:sam',
      now: 1_700_000_000_000,
    });
    const p: Project = got.projects[0]!;
    expect(p.emoji).toBe('📁');
    expect(p.unread_count).toBe(0);
    // Missing last_activity_at falls back to `now`.
    expect(p.last_activity_ms).toBe(1_700_000_000_000);
  });

  it('sortProjectsByActivity orders most-recent first, stable by id on ties', () => {
    const base = (ms: number, id: string): Project => ({
      id,
      name: id,
      description: '',
      emoji: '📁',
      last_activity_ms: ms,
      unread_count: 0,
      members: [],
      persona: '',
      privacy_mode: 'private',
      kind: 'solo',
      origin_instance: 'demo',
    });
    const older = base(1000, 'older');
    const newer = base(3000, 'newer');
    const tieA = base(2000, 'aaa');
    const tieB = base(2000, 'bbb');
    const sorted = sortProjectsByActivity([older, tieB, newer, tieA]);
    expect(sorted.map((p) => p.id)).toEqual(['newer', 'aaa', 'bbb', 'older']);
  });

  it('propagates the underlying client error on network failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof globalThis.fetch;
    let err: unknown = null;
    try {
      await fetchProjects({ base_url: 'http://x', token: 't' });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
  });
});
