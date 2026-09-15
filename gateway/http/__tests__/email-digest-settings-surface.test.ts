import { describe, expect, test } from 'bun:test'
import { createEmailDigestSettingsSurface } from '../email-digest-settings-surface.ts'

describe('email digest settings surface', () => {
  test('reads and updates the product setting', async () => {
    let enabled = true
    const surface = createEmailDigestSettingsSurface({
      auth: { mode: 'dev-bypass', resolve: async () => ({ project_slug: 'owner', user_id: 'owner', mode: 'dev-bypass' }) },
      readEnabled: () => enabled,
      writeEnabled: async (next) => { enabled = next },
    })
    const put = await surface.handler(new Request('http://example.test/api/app/email-digest', { method: 'PUT', headers: { authorization: 'Bearer value', 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }))
    expect(put?.status).toBe(200)
    expect(await put?.json()).toEqual({ ok: true, enabled: false })
    const invalid = await surface.handler(new Request('http://example.test/api/app/email-digest', { method: 'PUT', headers: { authorization: 'Bearer value', 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }) }))
    expect(invalid?.status).toBe(400)
    expect(enabled).toBe(false)
  })
})
