import { describe, expect, test } from 'bun:test'
import {
  readOpenInstanceBaseUrlTemplate,
  resolveOpenInstanceBaseUrl,
} from './open-instance-source-resolver.ts'

describe('resolveOpenInstanceBaseUrl', () => {
  test('interpolates {slug} from the template', () => {
    expect(
      resolveOpenInstanceBaseUrl('acme', {
        template: 'https://{slug}.neutron.example',
      }),
    ).toBe('https://acme.neutron.example')
  })

  test('strips trailing slashes', () => {
    expect(
      resolveOpenInstanceBaseUrl('topline', { template: 'https://{slug}.neutron.example/' }),
    ).toBe('https://topline.neutron.example')
  })

  test('override takes priority over template', () => {
    const overrides = new Map([['acme', 'https://custom.example/cross']])
    expect(
      resolveOpenInstanceBaseUrl('acme', {
        template: 'https://{slug}.neutron.example',
        overrides,
      }),
    ).toBe('https://custom.example/cross')
  })

  test('null when no template and no override', () => {
    expect(resolveOpenInstanceBaseUrl('x', {})).toBeNull()
  })

  test('null when template lacks {slug}', () => {
    expect(resolveOpenInstanceBaseUrl('x', { template: 'https://fixed.example' })).toBeNull()
  })
})

describe('readOpenInstanceBaseUrlTemplate', () => {
  test('reads + trims the env value', () => {
    expect(
      readOpenInstanceBaseUrlTemplate({ NEUTRON_OPEN_INSTANCE_BASE_URL: ' https://{slug}.x ' }),
    ).toBe('https://{slug}.x')
  })
  test('undefined when unset/empty', () => {
    expect(readOpenInstanceBaseUrlTemplate({})).toBeUndefined()
    expect(readOpenInstanceBaseUrlTemplate({ NEUTRON_OPEN_INSTANCE_BASE_URL: '' })).toBeUndefined()
  })
})
