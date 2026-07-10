import { describe, expect, test } from 'bun:test'
import { ToolRegistry } from './registry.ts'

const noopHandler = async () => null

const sampleSchema = { type: 'object', properties: {} }

describe('ToolRegistry', () => {
  test('register + get returns the same registration', () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo args back',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: noopHandler,
    })
    const got = reg.get('echo')
    expect(got?.name).toBe('echo')
    expect(got?.capability_required).toBe('read:project_data')
    expect(got?.approval_policy).toBe('auto')
    expect(reg.size()).toBe(1)
  })

  test('X1 — a registration with no provenance is normalized to the platform marker', () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'doc_search',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:docs',
      approval_policy: 'auto',
      handler: noopHandler,
    })
    expect(reg.get('doc_search')?.provenance).toEqual({ kind: 'platform' })
  })

  test('X1 — an explicit core provenance is preserved verbatim', () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'tasks_add',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'write:tasks_core.items',
      approval_policy: 'auto',
      provenance: { kind: 'core', slug: 'tasks_core' },
      handler: noopHandler,
    })
    expect(reg.get('tasks_add')?.provenance).toEqual({ kind: 'core', slug: 'tasks_core' })
  })

  test('duplicate register throws', () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: noopHandler,
    })
    expect(() =>
      reg.register({
        name: 'echo',
        description: 'echo dup',
        input_schema: sampleSchema,
        output_schema: sampleSchema,
        capability_required: 'read:project_data',
        approval_policy: 'auto',
        handler: noopHandler,
      }),
    ).toThrow(/already registered/)
  })

  test('list returns alphabetic order regardless of registration order', () => {
    const reg = new ToolRegistry()
    for (const name of ['zzz', 'aaa', 'mmm']) {
      reg.register({
        name,
        description: name,
        input_schema: sampleSchema,
        output_schema: sampleSchema,
        capability_required: 'read:project_data',
        approval_policy: 'auto',
        handler: noopHandler,
      })
    }
    expect(reg.list().map((r) => r.name)).toEqual(['aaa', 'mmm', 'zzz'])
  })

  test('unregister returns true when present and false when absent', () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: noopHandler,
    })
    expect(reg.unregister('echo')).toBe(true)
    expect(reg.unregister('echo')).toBe(false)
    expect(reg.get('echo')).toBeUndefined()
  })
})
