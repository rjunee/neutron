/**
 * @neutronai/agent-dispatch — agent-native surface tests.
 *
 * Proves the HARD invariant: the `dispatch_agent` tool (what the live agent
 * calls) and the `/dispatch` chat command (what the user types) reach the SAME
 * `DispatchService.dispatch` backend with the same request — there is no second
 * code path. Plus the parser grammar + error handling for both surfaces.
 */

import { describe, expect, test } from 'bun:test'

import { ToolRegistry } from '../tools/registry.ts'
import { SubagentRegistry, newControlState } from '../runtime/subagent/index.ts'
import {
  DISPATCH_AGENT_TOOL,
  DispatchService,
  executeDispatchCommand,
  parseAndExecuteDispatchCommand,
  parseDispatchCommand,
  registerDispatchToolSurface,
  type DispatchRequest,
} from './index.ts'

/** A service whose `dispatch` is recorded + resolves immediately. */
function recordingService(calls: DispatchRequest[]): DispatchService {
  const registry = new SubagentRegistry()
  const control = newControlState(registry)
  let seq = 0
  return new DispatchService({
    registry,
    control,
    dispatch: () => Promise.resolve({ result: 'ok', status: 'completed' as const }),
    report: () => {},
    instance_key: 'inst-a',
    repo_path: '/home/owner',
    board: {
      get: (_slug: string, id: string) => ({ id, title: 'a fully specified plan item with plenty of detail here', design_doc_ref: null }),
      attachRun: async () => undefined,
      clearRun: async () => undefined,
    },
    project_slug: 'proj-1',
    default_model: 'm',
    persona_loader: () => ({ content: 'ROLE', source: 'fallback' }),
    mint_run_id: () => `run-${++seq}`,
  })
}

describe('dispatch_agent tool', () => {
  test('registers with the dispatch capability + prompt-user approval', () => {
    const reg = new ToolRegistry()
    registerDispatchToolSurface(reg, recordingService([]))
    const tool = reg.get(DISPATCH_AGENT_TOOL)
    expect(tool).toBeDefined()
    expect(tool!.capability_required).toBe('agent:dispatch_subagent')
    expect(tool!.approval_policy).toBe('prompt-user')
    expect(tool!.input_schema.required).toEqual(['kind', 'task', 'board_item_id'])
  })

  test('handler dispatches via the service and returns a run id', async () => {
    const calls: DispatchRequest[] = []
    const reg = new ToolRegistry()
    const svc = recordingService(calls)
    // Wrap dispatch to record the request the tool builds.
    const orig = svc.dispatch.bind(svc)
    svc.dispatch = (req) => {
      calls.push(req)
      return orig(req)
    }
    registerDispatchToolSurface(reg, svc)
    const tool = reg.get(DISPATCH_AGENT_TOOL)!
    const out = (await tool.handler(
      { kind: 'research', task: 'dig into X', board_item_id: 'it1' },
      { project_slug: 'p', topic_id: null, call_id: 'c1', speaker_user_id: null },
    )) as Record<string, unknown>
    expect(out.status).toBe('dispatched')
    expect(out.kind).toBe('research')
    expect(out.agent_kind).toBe('atlas')
    expect(typeof out.run_id).toBe('string')
    expect(calls).toEqual([{ kind: 'research', task: 'dig into X', board_item_id: 'it1' }])
  })

  test('handler rejects an unknown kind + an empty task', async () => {
    const reg = new ToolRegistry()
    registerDispatchToolSurface(reg, recordingService([]))
    const tool = reg.get(DISPATCH_AGENT_TOOL)!
    const ctx = { project_slug: 'p', topic_id: null, call_id: 'c', speaker_user_id: null }
    await expect(tool.handler({ kind: 'nope', task: 't', board_item_id: 'it1' }, ctx)).rejects.toThrow(/kind/)
    await expect(tool.handler({ kind: 'research', task: '   ', board_item_id: 'it1' }, ctx)).rejects.toThrow(
      /task/,
    )
  })

  test('Phase 2b — handler rejects a missing board_item_id (no untracked dispatches)', async () => {
    const reg = new ToolRegistry()
    registerDispatchToolSurface(reg, recordingService([]))
    const tool = reg.get(DISPATCH_AGENT_TOOL)!
    const ctx = { project_slug: 'p', topic_id: null, call_id: 'c', speaker_user_id: null }
    await expect(tool.handler({ kind: 'research', task: 'do a thing' }, ctx)).rejects.toThrow(
      /board_item_id/,
    )
  })

  test('Phase 2b — the service blocks an underspecified item (ask-before-acting)', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const svc = new DispatchService({
      registry,
      control,
      dispatch: () => Promise.resolve({ result: 'ok', status: 'completed' as const }),
      report: () => {},
      instance_key: 'inst-a',
      // A board whose item is terse + has no design doc → underspecified.
      board: {
        get: (_slug, id) => ({ id, title: 'auth', design_doc_ref: null }),
        attachRun: async () => undefined,
        clearRun: async () => undefined,
      },
      project_slug: 'proj-1',
      repo_path: '/home/owner',
      default_model: 'm',
      persona_loader: () => ({ content: 'ROLE', source: 'fallback' }),
      mint_run_id: () => 'run-u',
    })
    await expect(svc.dispatch({ kind: 'adhoc', task: 'go', board_item_id: 'terse' })).rejects.toThrow(
      /underspecified/,
    )
  })
})

describe('/dispatch command parser', () => {
  test('named kinds, ad-hoc fallthrough, stop, help', () => {
    expect(parseDispatchCommand('/dispatch research find the bug')).toEqual({
      kind: 'dispatch',
      dispatch_kind: 'research',
      task: 'find the bug',
    })
    expect(parseDispatchCommand('/dispatch review the launch brief')).toEqual({
      kind: 'dispatch',
      dispatch_kind: 'review',
      task: 'the launch brief',
    })
    // No recognised sub-verb → ad-hoc on the WHOLE body.
    expect(parseDispatchCommand('/dispatch summarise the meeting')).toEqual({
      kind: 'dispatch',
      dispatch_kind: 'adhoc',
      task: 'summarise the meeting',
    })
    expect(parseDispatchCommand('/dispatch stop abc123')).toEqual({ kind: 'stop', run_ref: 'abc123' })
    expect(parseDispatchCommand('/dispatch stop')).toEqual({ kind: 'stop' })
    expect(parseDispatchCommand('/dispatch')).toEqual({ kind: 'help' })
    expect(parseDispatchCommand('/dispatch help')).toEqual({ kind: 'help' })
  })

  test('a named kind with no task is a friendly reject', () => {
    const cmd = parseDispatchCommand('/dispatch research')
    expect(cmd.kind).toBe('unrecognized')
  })

  test('a non-/dispatch body returns null from the bridge entry (LLM fallthrough)', async () => {
    const res = await parseAndExecuteDispatchCommand('hello there', {
      service: recordingService([]),
    })
    expect(res).toBeNull()
  })
})

describe('agent-native parity — tool + command share one backend', () => {
  test('the command executor dispatches via the SAME service.dispatch the tool uses', async () => {
    const calls: DispatchRequest[] = []
    const svc = recordingService(calls)
    const orig = svc.dispatch.bind(svc)
    svc.dispatch = (req) => {
      calls.push(req)
      return orig(req)
    }

    // Path A: the chat command.
    const cmdRes = await parseAndExecuteDispatchCommand('/dispatch research --item it1 trace the leak', {
      service: svc,
      delivery_target: { channel: 'app_socket', binding_id: 'b1' },
    })
    expect(cmdRes?.error).toBeUndefined()
    expect(cmdRes?.text).toContain('Dispatched')

    // Path B: the agent tool.
    const reg = new ToolRegistry()
    registerDispatchToolSurface(reg, svc)
    await reg
      .get(DISPATCH_AGENT_TOOL)!
      .handler(
        { kind: 'research', task: 'trace the leak', board_item_id: 'it1' },
        { project_slug: 'p', topic_id: null, call_id: 'c', speaker_user_id: null },
      )

    // Both reached the same backend with the same kind+task.
    expect(calls).toHaveLength(2)
    expect(calls[0]!.kind).toBe('research')
    expect(calls[0]!.task).toBe('trace the leak')
    expect(calls[0]!.delivery_target).toEqual({ channel: 'app_socket', binding_id: 'b1' })
    expect(calls[1]!).toMatchObject({ kind: 'research', task: 'trace the leak' })
  })

  test('command stop targets a live dispatch by id prefix', async () => {
    // A service whose substrate turn never settles, so the dispatch stays live.
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const svc = new DispatchService({
      registry,
      control,
      dispatch: () => new Promise(() => {}),
      report: () => {},
      instance_key: 'inst-a',
      repo_path: '/home/owner',
      board: {
      get: (_slug: string, id: string) => ({ id, title: 'a fully specified plan item with plenty of detail here', design_doc_ref: null }),
      attachRun: async () => undefined,
      clearRun: async () => undefined,
    },
    project_slug: 'proj-1',
    default_model: 'm',
      persona_loader: () => ({ content: 'ROLE', source: 'fallback' }),
      mint_run_id: () => 'run-stopme-1234',
    })
    const handle = await svc.dispatch({ kind: 'adhoc', task: 'long task', board_item_id: 'it1' })
    const res = await executeDispatchCommand(
      { kind: 'stop', run_ref: handle.run_id.slice(0, 6) },
      { service: svc },
    )
    expect(res.error).toBeUndefined()
    expect(res.text).toContain('Stopped')
    expect(registry.byRunId('run-stopme-1234')?.status).toBe('cancelled')
  })
})
