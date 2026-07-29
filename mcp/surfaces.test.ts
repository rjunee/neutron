import { describe, expect, test } from 'bun:test'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { NEUTRON_TOOL_NAMES, registerNeutronToolsSurface } from './surfaces/neutron-tools.ts'
import { registerCoreTool, unregisterCoreTools } from './surfaces/core-tools.ts'

const sampleSchema = { type: 'object', properties: {} }

describe('neutron-tools surface', () => {
  test('register installs the full Hermes 9-tool surface + Neutron extras', () => {
    const reg = new ToolRegistry()
    const names = registerNeutronToolsSurface(reg)
    expect(names.sort()).toEqual([...NEUTRON_TOOL_NAMES].sort())
    expect(reg.size()).toBe(NEUTRON_TOOL_NAMES.length)
  })

  test('stub handlers throw a descriptive error', async () => {
    const reg = new ToolRegistry()
    registerNeutronToolsSurface(reg)
    const tool = reg.get('conversations_list')
    await expect(
      tool!.handler({}, { project_slug: 't', project_id: null, topic_id: null, call_id: 'c', speaker_user_id: null }),
    ).rejects.toThrow(/conversations_list/)
  })
})

describe('core-tools surface', () => {
  test('registerCoreTool prefixes name with the core_id', () => {
    const reg = new ToolRegistry()
    const name = registerCoreTool(reg, 'cc', {
      base_name: 'analyze',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async () => ({}),
    })
    expect(name).toBe('cc:analyze')
    expect(reg.get('cc:analyze')).toBeDefined()
  })

  test('unregisterCoreTools removes only that core_id\'s tools', () => {
    const reg = new ToolRegistry()
    registerCoreTool(reg, 'cc', { base_name: 'a', description: '', input_schema: sampleSchema, output_schema: sampleSchema, capability_required: 'read:project_data', approval_policy: 'auto', handler: async () => null })
    registerCoreTool(reg, 'cc', { base_name: 'b', description: '', input_schema: sampleSchema, output_schema: sampleSchema, capability_required: 'read:project_data', approval_policy: 'auto', handler: async () => null })
    registerCoreTool(reg, 'other', { base_name: 'c', description: '', input_schema: sampleSchema, output_schema: sampleSchema, capability_required: 'read:project_data', approval_policy: 'auto', handler: async () => null })
    const removed = unregisterCoreTools(reg, 'cc')
    expect(removed).toBe(2)
    expect(reg.get('cc:a')).toBeUndefined()
    expect(reg.get('other:c')).toBeDefined()
  })
})
