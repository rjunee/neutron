import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { createAdminPersonalitySurface } from '../admin-personality-surface.ts'

test('editor history preserves pre-versioning bytes and rejects invalid filenames', async () => {
  const home = mkdtempSync(join(tmpdir(), 'persona-route-'))
  try {
    mkdirSync(join(home, 'persona'))
    writeFileSync(join(home, 'persona', 'SOUL.md'), 'legacy')
    const surface = createAdminPersonalitySurface({
      owner_home: home, project_slug: 'demo',
      auth: createAppWsAuthResolver({ project_slug: 'demo', bypass: true }),
    })
    const request = (route: string, method = 'GET', body?: object) => surface.handler(new Request(
      `http://localhost/api/app/persona/${route}`,
      { method, headers: { authorization: 'Bearer dev:test-user', 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) },
    ))
    expect((await request('file?name=SOUL.md', 'PATCH', { content: 'edited', expected_mtime: -1 }))!.status).toBe(200)
    const history = await (await request('history?name=SOUL.md'))!.json() as { versions: { content: string | null }[] }
    expect(history.versions.map(v => v.content)).toEqual(['legacy', 'edited'])
    expect((await request('history?name=../secret'))!.status).toBe(403)
    expect((await request('restart-from-scratch', 'POST', { confirm: true }))!.status).toBe(200)
    const deleted = await (await request('history?name=SOUL.md'))!.json() as { versions: { content: string | null }[] }
    expect(deleted.versions.map(v => v.content)).toEqual(['legacy', 'edited', null])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
