import { describe, expect, test } from 'bun:test'
import {
  ProjectListCache,
  getUnifiedProjects,
} from '../unified-project-list.ts'
import type { ProjectRef } from '../api/server.ts'

const localSolo: ProjectRef[] = [
  {
    project_id: 'p-solo-1',
    display_name: 'My Notes',
    kind: 'solo',
    owning_instance_slug: 'alice',
  },
]

describe('getUnifiedProjects', () => {
  test('returns solo + group projects deduplicated', async () => {
    const fakeFetch = async (url: string): Promise<Response> => {
      if (url.includes('workspace-1')) {
        const projects: ProjectRef[] = [
          {
            project_id: 'p-group-1',
            display_name: 'W1 Project',
            kind: 'group',
            owning_instance_slug: 'workspace-1',
          },
        ]
        return new Response(JSON.stringify({ projects }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const projects: ProjectRef[] = [
        {
          project_id: 'p-group-2',
          display_name: 'W2 Project',
          kind: 'group',
          owning_instance_slug: 'workspace-2',
        },
      ]
      return new Response(JSON.stringify({ projects }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const r = await getUnifiedProjects({
      user_instance_slug: 'alice',
      local_solo_projects: localSolo,
      instance_sources: [
        {
          instance_slug: 'workspace-1',
          base_url: 'https://workspace-1.example',
          bearer_token: 'tk',
        },
        {
          instance_slug: 'workspace-2',
          base_url: 'https://workspace-2.example',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
    })
    expect(r.projects).toHaveLength(3)
    expect(r.projects.map((p) => p.project_id).sort()).toEqual([
      'p-group-1',
      'p-group-2',
      'p-solo-1',
    ])
    expect(r.source_errors).toEqual([])
  })

  test('cache hit avoids the upstream call', async () => {
    let calls = 0
    const fakeFetch = async (): Promise<Response> => {
      calls += 1
      const projects: ProjectRef[] = []
      return new Response(JSON.stringify({ projects }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const cache = new ProjectListCache()
    const args = {
      user_instance_slug: 'alice',
      local_solo_projects: [],
      instance_sources: [
        {
          instance_slug: 'workspace-1',
          base_url: 'https://workspace-1.example',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
      cache,
    }
    await getUnifiedProjects(args)
    await getUnifiedProjects(args) // second call hits cache
    expect(calls).toBe(1)
  })

  test('cache TTL expiry forces a re-fetch', async () => {
    let calls = 0
    const fakeFetch = async (): Promise<Response> => {
      calls += 1
      return new Response(JSON.stringify({ projects: [] }), { status: 200 })
    }
    const cache = new ProjectListCache(30_000)
    const t0 = 1_000_000
    const args = {
      user_instance_slug: 'alice',
      local_solo_projects: [],
      instance_sources: [
        {
          instance_slug: 'workspace-1',
          base_url: 'https://w1.example',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
      cache,
    }
    await getUnifiedProjects({ ...args, now: () => t0 })
    await getUnifiedProjects({ ...args, now: () => t0 + 31_000 })
    expect(calls).toBe(2)
  })

  test('upstream 5xx surfaces as a source_error, not a thrown failure', async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response('upstream', { status: 503 })
    const r = await getUnifiedProjects({
      user_instance_slug: 'alice',
      local_solo_projects: localSolo,
      instance_sources: [
        {
          instance_slug: 'workspace-1',
          base_url: 'https://w1.example',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
    })
    expect(r.projects).toHaveLength(1) // local solo still surfaced
    expect(r.source_errors).toHaveLength(1)
    expect(r.source_errors[0]?.instance_slug).toBe('workspace-1')
    expect(r.source_errors[0]?.error).toBe('http_503')
  })

  test('a hung workspace aborts on the deadline + the rest still resolve', async () => {
    // workspace-slow accepts the request but never responds — it only
    // settles when the per-workspace AbortSignal fires. workspace-fast
    // responds immediately. The slow one must degrade to a `timeout`
    // source_error WITHOUT stalling or blanking the fast one.
    const fakeFetch = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (url.includes('slow')) {
        // Hang until the caller's deadline aborts us — mirrors a
        // mid-provisioning workspace whose listener accepted the socket but
        // never writes a response.
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            if (signal.aborted) {
              reject(signal.reason)
              return
            }
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          }
        })
      }
      const projects: ProjectRef[] = [
        {
          project_id: 'p-fast',
          display_name: 'Fast',
          kind: 'group',
          owning_instance_slug: 'workspace-fast',
        },
      ]
      return new Response(JSON.stringify({ projects }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const r = await getUnifiedProjects({
      user_instance_slug: 'alice',
      local_solo_projects: localSolo,
      instance_sources: [
        {
          instance_slug: 'workspace-slow',
          base_url: 'https://workspace-slow.example',
          bearer_token: 'tk',
        },
        {
          instance_slug: 'workspace-fast',
          base_url: 'https://workspace-fast.example',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
      // Shrink the deadline so the test exercises the abort path in ms, not
      // the production 5s. Production never overrides this.
      timeout_ms: 30,
    })

    // The fast workspace + local solo still surface; the hung one degrades.
    expect(r.projects.map((p) => p.project_id).sort()).toEqual([
      'p-fast',
      'p-solo-1',
    ])
    expect(r.source_errors).toHaveLength(1)
    expect(r.source_errors[0]?.instance_slug).toBe('workspace-slow')
    expect(r.source_errors[0]?.error).toBe('timeout')
  })

  test('headers arrive but the body stalls past the deadline → timeout, not a hang', async () => {
    // Argus r2 IMPORTANT — the 5s deadline must bound the WHOLE round-trip,
    // not just the header phase. A mid-provisioning workspace can return
    // 200 + headers immediately then stall the body forever. Here the
    // `Response` resolves at once but its body read (`res.json()`) hangs
    // until the same per-workspace signal aborts it. The slow workspace
    // must degrade to `timeout` while the fast one + local solo still
    // surface — and the whole call must settle in ~deadline ms, not hang.
    const stallingBody = (signal: AbortSignal): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          // Never enqueue/close — the read pulls forever until aborted.
          const onAbort = (): void => {
            try {
              controller.error(signal.reason)
            } catch {
              // already torn down
            }
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        },
      })

    const fakeFetch = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal ?? undefined
      if (url.includes('slow')) {
        // Headers come back instantly (status 200), but the body never
        // completes — `res.json()` will hang on this stream until the
        // signal fires.
        return new Response(signal ? stallingBody(signal) : null, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const projects: ProjectRef[] = [
        {
          project_id: 'p-fast',
          display_name: 'Fast',
          kind: 'group',
          owning_instance_slug: 'workspace-fast',
        },
      ]
      return new Response(JSON.stringify({ projects }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const started = performance.now()
    const r = await getUnifiedProjects({
      user_instance_slug: 'alice',
      local_solo_projects: localSolo,
      instance_sources: [
        {
          instance_slug: 'workspace-slow',
          base_url: 'https://workspace-slow.example',
          bearer_token: 'tk',
        },
        {
          instance_slug: 'workspace-fast',
          base_url: 'https://workspace-fast.example',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
      timeout_ms: 30,
    })
    const elapsed = performance.now() - started

    // Settled near the deadline, NOT hung indefinitely.
    expect(elapsed).toBeLessThan(2_000)
    expect(r.projects.map((p) => p.project_id).sort()).toEqual([
      'p-fast',
      'p-solo-1',
    ])
    expect(r.source_errors).toHaveLength(1)
    expect(r.source_errors[0]?.instance_slug).toBe('workspace-slow')
    expect(r.source_errors[0]?.error).toBe('timeout')
  })

  test('connection failures normalize to a stable code, never leak the raw address', async () => {
    // Argus r2 MINOR — a raw `ECONNREFUSED 127.0.0.1:53187` message must
    // not reach the client-facing `source_errors`. Classify by error code
    // into a stable token instead.
    const refused = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:53187'),
      { code: 'ECONNREFUSED' },
    )
    const fakeFetch = async (): Promise<Response> => {
      throw refused
    }
    const r = await getUnifiedProjects({
      user_instance_slug: 'alice',
      local_solo_projects: localSolo,
      instance_sources: [
        {
          instance_slug: 'workspace-1',
          base_url: 'http://127.0.0.1:53187',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
    })
    expect(r.projects).toHaveLength(1) // local solo still surfaced
    expect(r.source_errors).toHaveLength(1)
    expect(r.source_errors[0]?.error).toBe('connection_refused')
    // The loopback port must NOT appear anywhere in the surfaced error.
    expect(r.source_errors[0]?.error).not.toContain('127.0.0.1')
    expect(r.source_errors[0]?.error).not.toContain('53187')
  })

  test('undici-style nested cause code is classified (network_unreachable)', async () => {
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND host'), {
        code: 'ENOTFOUND',
      }),
    })
    const fakeFetch = async (): Promise<Response> => {
      throw wrapped
    }
    const r = await getUnifiedProjects({
      user_instance_slug: 'alice',
      local_solo_projects: [],
      instance_sources: [
        {
          instance_slug: 'workspace-1',
          base_url: 'https://w1.example',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
    })
    expect(r.source_errors[0]?.error).toBe('network_unreachable')
  })

  test('an unrecognised failure collapses to fetch_failed (no raw message echo)', async () => {
    const fakeFetch = async (): Promise<Response> => {
      throw new Error('something internal leaked /var/run/secret.sock')
    }
    const r = await getUnifiedProjects({
      user_instance_slug: 'alice',
      local_solo_projects: [],
      instance_sources: [
        {
          instance_slug: 'workspace-1',
          base_url: 'https://w1.example',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
    })
    expect(r.source_errors[0]?.error).toBe('fetch_failed')
  })

  test('duplicate project across solo + group dedupes by (owning_owner, project_id)', async () => {
    const dup: ProjectRef = {
      project_id: 'p-dup',
      display_name: 'Dup',
      kind: 'group',
      owning_instance_slug: 'workspace-1',
    }
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ projects: [dup, dup] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const r = await getUnifiedProjects({
      user_instance_slug: 'alice',
      local_solo_projects: [],
      instance_sources: [
        {
          instance_slug: 'workspace-1',
          base_url: 'https://w1.example',
          bearer_token: 'tk',
        },
      ],
      fetch: fakeFetch,
    })
    expect(r.projects).toHaveLength(1)
  })
})
