/**
 * @neutronai/app — `fetchProjects` mapping test (ISSUES #9).
 *
 * Verifies `fetchProjects({ base_url, token })` calls the gateway's
 * `GET /api/app/projects` and projects the canonical
 * `ProjectSettings` response onto the legacy `Project` shape the
 * project-list UI consumes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { fetchProjects, type Project } from '../lib/projects';
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
      },
      {
        id: 'acme-roadmap',
        name: 'Acme Roadmap',
        description: '',
        persona: '',
        privacy_mode: 'private',
        billing_mode: 'personal',
        agent_engagement_mode: 'all_messages',
        members: [],
        kind: 'shared',
        origin_instance: 'acme',
        owning_instance_slug: 'acme',
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
    // source_errors flow through for the degraded-workspace notice.
    expect(got.sourceErrors).toEqual([{ workspace_instance_slug: 'beta-co', error: 'http_504' }]);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe('http://example.test/api/app/projects');
    expect(stub.calls[0]!.authorization).toBe('Bearer dev:sam');
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
