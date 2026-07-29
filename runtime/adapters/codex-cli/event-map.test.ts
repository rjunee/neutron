import { describe, expect, test } from 'bun:test'

import { mapCodexEvent, newCodexJsonlMapper } from './event-map.ts'

describe('codex-cli event-map', () => {
  test('thread.started captures thread_id and emits no event', () => {
    const m = newCodexJsonlMapper()
    expect(mapCodexEvent({ type: 'thread.started', thread_id: 't-1' }, m)).toBeNull()
    expect(m.thread_id).toBe('t-1')
  })

  test('item.agent_message → token', () => {
    const m = newCodexJsonlMapper()
    const ev = mapCodexEvent({ type: 'item.agent_message', text: 'hi' }, m)
    expect(ev?.kind).toBe('token')
    if (ev?.kind === 'token') expect(ev.text).toBe('hi')
  })

  test('item.reasoning → thinking', () => {
    const ev = mapCodexEvent({ type: 'item.reasoning', text: 'plan' }, newCodexJsonlMapper())
    expect(ev?.kind).toBe('thinking')
    if (ev?.kind === 'thinking') expect(ev.text).toBe('plan')
  })

  test('item.command_execution → tool_call(name=shell)', () => {
    const ev = mapCodexEvent(
      { type: 'item.command_execution', command: 'ls -la', call_id: 'c-1' },
      newCodexJsonlMapper(),
    )
    expect(ev?.kind).toBe('tool_call')
    if (ev?.kind === 'tool_call') {
      expect(ev.tool_name).toBe('shell')
      expect((ev.args as { command?: string }).command).toBe('ls -la')
      expect(ev.call_id).toBe('c-1')
    }
  })

  test('item.mcp_tool_call → tool_call(name=server.tool)', () => {
    const ev = mapCodexEvent(
      { type: 'item.mcp_tool_call', server: 'memory', tool: 'add', input: { x: 1 } },
      newCodexJsonlMapper(),
    )
    expect(ev?.kind).toBe('tool_call')
    if (ev?.kind === 'tool_call') {
      expect(ev.tool_name).toBe('memory.add')
      expect((ev.args as { x: number }).x).toBe(1)
    }
  })

  test('item.web_search → tool_call(name=web_search)', () => {
    const ev = mapCodexEvent(
      { type: 'item.web_search', query: 'bun http2' },
      newCodexJsonlMapper(),
    )
    expect(ev?.kind).toBe('tool_call')
    if (ev?.kind === 'tool_call') {
      expect(ev.tool_name).toBe('web_search')
      expect((ev.args as { query: string }).query).toBe('bun http2')
    }
  })

  test('item.file_change → tool_call(name=edit, args.path)', () => {
    const ev = mapCodexEvent(
      { type: 'item.file_change', path: '/tmp/x.ts', diff: '+++' },
      newCodexJsonlMapper(),
    )
    expect(ev?.kind).toBe('tool_call')
    if (ev?.kind === 'tool_call') {
      expect(ev.tool_name).toBe('edit')
      expect((ev.args as { path: string; diff: string }).path).toBe('/tmp/x.ts')
    }
  })

  test('item.plan_update → thinking with serialized plan', () => {
    const ev = mapCodexEvent(
      { type: 'item.plan_update', plan: { steps: ['a', 'b'] } },
      newCodexJsonlMapper(),
    )
    expect(ev?.kind).toBe('thinking')
    if (ev?.kind === 'thinking') expect(ev.text).toContain('"steps"')
  })

  test('turn.completed emits completion with last seen usage and substrate_instance_id', () => {
    const m = newCodexJsonlMapper()
    mapCodexEvent({ type: 'thread.started', thread_id: 't-42' }, m)
    const ev = mapCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } },
      m,
    )
    expect(ev?.kind).toBe('completion')
    if (ev?.kind === 'completion') {
      expect(ev.usage.input_tokens).toBe(10)
      expect(ev.usage.output_tokens).toBe(20)
      expect(ev.substrate_instance_id).toBe('t-42')
    }
  })

  test('error envelope → error event', () => {
    const ev = mapCodexEvent({ type: 'error', message: 'boom' }, newCodexJsonlMapper())
    expect(ev?.kind).toBe('error')
    if (ev?.kind === 'error') expect(ev.message).toBe('boom')
  })

  test('unrecognised types return null', () => {
    expect(mapCodexEvent({ type: 'unknown.type' }, newCodexJsonlMapper())).toBeNull()
  })
})
