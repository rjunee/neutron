/**
 * Unit tests for the web Tasks API client (WAVE 3 PR-8). Pure — the `fetchImpl`
 * is injected, so no DOM and no live server.
 *
 * Covers: list (defaults to the PR-7 prioritized `order=focus_score`), create,
 * update (reprioritize), complete, cancel, delete, the status-coded error path,
 * and the pure helpers (priorityLabel, clampPriority, formatDue).
 */

import { describe, expect, it } from 'bun:test'

import {
  WebTasksClient,
  TasksClientError,
  clampPriority,
  formatDue,
  priorityLabel,
  type Task,
} from '../tasks-client.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    project_slug: 'sam',
    project_id: 'acme',
    title: 'Ship PR-8',
    description: null,
    status: 'open',
    priority: 2,
    due_date: '2026-06-30',
    owner_persona: null,
    source: 'app',
    focus_score: 7,
    focus_score_updated_at: '2026-06-23T00:00:00Z',
    llm_rank: 1,
    llm_reason: 'Blocks the release',
    prioritized_by: 'llm',
    prioritized_at: '2026-06-23T00:00:00Z',
    created_at: '2026-06-20T00:00:00Z',
    updated_at: '2026-06-23T00:00:00Z',
    completed_at: null,
    ...over,
  }
}

interface Call {
  url: string
  method: string
  body: unknown
}

function recorder(handler: (c: Call) => Response): { fetchImpl: (u: string, i?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : undefined
    const call: Call = { url, method: init?.method ?? 'GET', body }
    calls.push(call)
    return handler(call)
  }
  return { fetchImpl, calls }
}

const OPTS = { base_url: 'https://sam.neutron.test', token: 'dev:sam' }

describe('WebTasksClient', () => {
  it('lists with the prioritized order (order=focus_score) by default', async () => {
    const { fetchImpl, calls } = recorder(() => json({ ok: true, tasks: [makeTask()], project_id: 'acme', status: 'open', order: 'focus_score' }))
    const client = new WebTasksClient({ ...OPTS, fetchImpl })
    const rows = await client.list('acme')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.llm_rank).toBe(1)
    expect(calls[0]!.url).toContain('/api/app/projects/acme/tasks?')
    expect(calls[0]!.url).toContain('status=open')
    expect(calls[0]!.url).toContain('order=focus_score')
  })

  it('omits order on the canonical default', async () => {
    const { fetchImpl, calls } = recorder(() => json({ ok: true, tasks: [], project_id: 'acme', status: 'all', order: 'default' }))
    const client = new WebTasksClient({ ...OPTS, fetchImpl })
    await client.list('acme', 'all', 'default')
    expect(calls[0]!.url).toContain('status=all')
    expect(calls[0]!.url).not.toContain('order=')
  })

  it('creates a task (POST with the title)', async () => {
    const { fetchImpl, calls } = recorder(() => json({ ok: true, task: makeTask({ title: 'New' }) }, 201))
    const client = new WebTasksClient({ ...OPTS, fetchImpl })
    const t = await client.create('acme', { title: 'New' })
    expect(t.title).toBe('New')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url.endsWith('/api/app/projects/acme/tasks')).toBe(true)
    expect((calls[0]!.body as { title: string }).title).toBe('New')
  })

  it('reprioritizes via PATCH priority', async () => {
    const { fetchImpl, calls } = recorder(() => json({ ok: true, task: makeTask({ priority: 3 }) }))
    const client = new WebTasksClient({ ...OPTS, fetchImpl })
    const t = await client.update('acme', 't1', { priority: 3 })
    expect(t.priority).toBe(3)
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.url.endsWith('/api/app/projects/acme/tasks/t1')).toBe(true)
    expect((calls[0]!.body as { priority: number }).priority).toBe(3)
  })

  it('completes / cancels via the verb routes', async () => {
    const { fetchImpl, calls } = recorder(() => json({ ok: true, task: makeTask({ status: 'done' }) }))
    const client = new WebTasksClient({ ...OPTS, fetchImpl })
    await client.complete('acme', 't1')
    await client.cancel('acme', 't1')
    expect(calls[0]!.url.endsWith('/tasks/t1/complete')).toBe(true)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[1]!.url.endsWith('/tasks/t1/cancel')).toBe(true)
  })

  it('deletes via DELETE', async () => {
    const { fetchImpl, calls } = recorder(() => json({ ok: true, deleted_task_id: 't1' }))
    const client = new WebTasksClient({ ...OPTS, fetchImpl })
    await client.delete('acme', 't1')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url.endsWith('/api/app/projects/acme/tasks/t1')).toBe(true)
  })

  it('throws a typed TasksClientError on a non-ok response', async () => {
    const { fetchImpl } = recorder(() => json({ ok: false, code: 'invalid_title', message: 'bad' }, 400))
    const client = new WebTasksClient({ ...OPTS, fetchImpl })
    await expect(client.create('acme', { title: '' })).rejects.toMatchObject({
      name: 'TasksClientError',
      code: 'invalid_title',
      status: 400,
    })
  })

  it('wraps a network throw as a `network` error', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('offline')
    }
    const client = new WebTasksClient({ ...OPTS, fetchImpl })
    await expect(client.list('acme')).rejects.toBeInstanceOf(TasksClientError)
  })
})

describe('pure helpers', () => {
  it('priorityLabel maps the 0-3 scale (null = blank)', () => {
    expect(priorityLabel(3)).toBe('P0')
    expect(priorityLabel(2)).toBe('P1')
    expect(priorityLabel(1)).toBe('P2')
    expect(priorityLabel(0)).toBe('P3')
    expect(priorityLabel(null)).toBe('')
  })

  it('clampPriority keeps 0-3 and rejects out-of-band', () => {
    expect(clampPriority(0)).toBe(0)
    expect(clampPriority(3)).toBe(3)
    expect(clampPriority(4)).toBeNull()
    expect(clampPriority(-1)).toBeNull()
    expect(clampPriority(1.5)).toBeNull()
  })

  it('formatDue keeps the YYYY-MM-DD prefix', () => {
    expect(formatDue('2026-06-30T12:00:00Z')).toBe('2026-06-30')
    expect(formatDue('2026-06-30')).toBe('2026-06-30')
    expect(formatDue(null)).toBe('')
    expect(formatDue('')).toBe('')
  })
})
