/**
 * X1 — dispatch-time capability gate (LOG-ONLY) tests.
 *
 * Proves that `McpServer.dispatch`:
 *   - journals a capability verdict to O4's `system_events` on EVERY dispatch,
 *     with the right provenance (platform vs core) + declared capability;
 *   - classifies platform tools with their explicit platform policy class;
 *   - is LOG-ONLY: dispatch behavior is byte-identical (nothing blocked, the
 *     handler runs, its result is returned) — the verdict is observability;
 *   - never lets a `system_events`-sink throw perturb dispatch;
 *   - does NOT touch `secret_audit_log` (it emits to a NEW event stream).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  registerSystemEventSink,
  type SystemEventInput,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import { ToolRegistry, type ToolProvenance } from '@neutronai/tools/registry.ts'
import { McpServer } from './server.ts'

const sampleSchema = { type: 'object', properties: {} }

/** In-memory sink that captures every emitted event for assertions. */
class CapturingSink implements SystemEventSink {
  readonly events: SystemEventInput[] = []
  record(input: SystemEventInput): { id: string } {
    this.events.push(input)
    return { id: `evt-${this.events.length}` }
  }
}

/** Sink whose record() throws synchronously — the emit path must swallow it. */
class ThrowingSink implements SystemEventSink {
  record(): { id: string } {
    throw new Error('sink is on fire')
  }
}

function capabilityVerdicts(sink: CapturingSink): SystemEventInput[] {
  return sink.events.filter((e) => e.event === 'capability_verdict')
}

afterEach(() => {
  // Clear the ambient sink so tests don't leak into each other.
  registerSystemEventSink(null)
})

describe('X1 capability gate (log-only)', () => {
  test('every dispatch journals a capability_verdict with platform provenance + capability', async () => {
    const sink = new CapturingSink()
    registerSystemEventSink(sink)

    const reg = new ToolRegistry()
    reg.register({
      name: 'doc_search',
      description: 'search docs',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:docs',
      approval_policy: 'auto',
      handler: async () => ({ ok: true }),
      // No provenance declared → the registry normalizes it to platform.
    })
    const server = new McpServer({ project_slug: 'owner-slug', registry: reg })

    const result = await server.dispatch({ tool_name: 'doc_search', args: {}, call_id: 'c1' })

    // Dispatch is unchanged — the handler ran and its result flows back.
    expect(result).toEqual({ ok: true })

    const verdicts = capabilityVerdicts(sink)
    expect(verdicts.length).toBe(1)
    const payload = verdicts[0]?.payload as Record<string, unknown>
    expect(payload['tool_name']).toBe('doc_search')
    expect(payload['verdict']).toBe('allow')
    expect(payload['capability']).toBe('read:docs')
    expect(payload['approval_policy']).toBe('auto')
    expect(payload['enforcement']).toBe('log-only')
    expect(payload['provenance']).toEqual({ kind: 'platform' })
    expect(verdicts[0]?.level).toBe('info')
    expect(verdicts[0]?.module).toBe('capability-gate')
    expect(verdicts[0]?.project_slug).toBe('owner-slug')
  })

  test('a Core-provenance tool journals its verdict attributed to the Core slug', async () => {
    const sink = new CapturingSink()
    registerSystemEventSink(sink)

    const reg = new ToolRegistry()
    const provenance: ToolProvenance = { kind: 'core', slug: 'tasks_core' }
    reg.register({
      name: 'tasks_add',
      description: 'add a task',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'write:tasks_core.items',
      approval_policy: 'auto',
      provenance,
      handler: async () => ({ id: 't1' }),
    })
    const server = new McpServer({ project_slug: 'owner-slug', registry: reg })

    await server.dispatch({ tool_name: 'tasks_add', args: {}, call_id: 'c1' })

    const payload = capabilityVerdicts(sink)[0]?.payload as Record<string, unknown>
    expect(payload['provenance']).toEqual({ kind: 'core', slug: 'tasks_core' })
    expect(payload['capability']).toBe('write:tasks_core.items')
    expect(payload['verdict']).toBe('allow')
  })

  test("a HITL tool ('prompt-user') journals 'gated-approval' but STILL dispatches (log-only)", async () => {
    const sink = new CapturingSink()
    registerSystemEventSink(sink)

    const reg = new ToolRegistry()
    let handlerRan = false
    reg.register({
      name: 'send_email',
      description: 'send an email',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'write:gmail',
      approval_policy: 'prompt-user',
      handler: async () => {
        handlerRan = true
        return { sent: true }
      },
    })
    const server = new McpServer({ project_slug: 'owner-slug', registry: reg })

    const result = await server.dispatch({ tool_name: 'send_email', args: {}, call_id: 'c1' })

    // LOG-ONLY: even though the verdict is 'gated-approval', the tool is NOT
    // blocked — the handler ran and returned normally.
    expect(handlerRan).toBe(true)
    expect(result).toEqual({ sent: true })
    const payload = capabilityVerdicts(sink)[0]?.payload as Record<string, unknown>
    expect(payload['verdict']).toBe('gated-approval')
    expect(payload['approval_policy']).toBe('prompt-user')
  })

  test("a denying capability_gate journals 'denied-capability' — behavior UNCHANGED (existing throw preserved)", async () => {
    const sink = new CapturingSink()
    registerSystemEventSink(sink)

    const reg = new ToolRegistry()
    reg.register({
      name: 'restricted',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'write:gmail',
      approval_policy: 'auto',
      handler: async () => ({}),
    })
    // A wired gate that denies — the EXISTING (pre-X1) behavior is to throw.
    const server = new McpServer({
      project_slug: 'owner-slug',
      registry: reg,
      capability_gate: (cap) => cap !== 'write:gmail',
    })

    // Byte-identical to the pre-X1 behavior: the existing gate still throws.
    await expect(
      server.dispatch({ tool_name: 'restricted', args: {}, call_id: 'c1' }),
    ).rejects.toThrow(/write:gmail/)

    // …AND the verdict was journaled (before the throw) as denied-capability.
    const verdicts = capabilityVerdicts(sink)
    expect(verdicts.length).toBe(1)
    const payload = verdicts[0]?.payload as Record<string, unknown>
    expect(payload['verdict']).toBe('denied-capability')
    expect(verdicts[0]?.level).toBe('warn')
  })

  test('a system_events sink that THROWS does not break dispatch', async () => {
    registerSystemEventSink(new ThrowingSink())

    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async (args) => ({ got: args }),
    })
    const server = new McpServer({ project_slug: 'owner-slug', registry: reg })

    // The sink throws on every emit; dispatch must be entirely unaffected.
    const result = await server.dispatch({ tool_name: 'echo', args: { x: 1 }, call_id: 'c1' })
    expect(result).toEqual({ got: { x: 1 } })
  })

  test('with NO sink registered, dispatch is a byte-identical no-op emit (unchanged)', async () => {
    // No registerSystemEventSink call — the ambient stack is empty.
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async (args) => ({ got: args }),
    })
    const server = new McpServer({ project_slug: 'owner-slug', registry: reg })
    const result = await server.dispatch({ tool_name: 'echo', args: { y: 2 }, call_id: 'c1' })
    expect(result).toEqual({ got: { y: 2 } })
  })

  test('unknown tool throws BEFORE any verdict is journaled (no tool to gate)', async () => {
    const sink = new CapturingSink()
    registerSystemEventSink(sink)

    const reg = new ToolRegistry()
    const server = new McpServer({ project_slug: 'owner-slug', registry: reg })
    await expect(
      server.dispatch({ tool_name: 'nope', args: {}, call_id: 'c1' }),
    ).rejects.toThrow(/unknown tool 'nope'/)
    expect(capabilityVerdicts(sink).length).toBe(0)
  })
})
