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
