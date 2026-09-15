import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stampExistingUserTimezone } from '../wiring/user-timezone-stamp.ts'

let ownerHome: string

beforeEach(() => {
  ownerHome = mkdtempSync(join(tmpdir(), 'neutron-user-timezone-'))
  mkdirSync(join(ownerHome, 'persona'))
})

afterEach(() => rmSync(ownerHome, { recursive: true, force: true }))

test('an existing USER.md from before timezone capture is stamped without regeneration', async () => {
  const path = join(ownerHome, 'persona', 'USER.md')
  writeFileSync(path, '# USER.md\n\n## Identity\n\n- **Name:** Sam\n\n## Preferences\n\n- concise\n')

  expect(await stampExistingUserTimezone(ownerHome, 'Pacific/Auckland')).toBe('written')
  const stamped = readFileSync(path, 'utf8')
  expect(stamped).toContain('- **Timezone:** Pacific/Auckland')
  expect(stamped).toContain('- **Name:** Sam')
  expect(stamped).toContain('- concise')
})

test('an existing timezone is updated and an identical reconnect is a no-op', async () => {
  const path = join(ownerHome, 'persona', 'USER.md')
  writeFileSync(path, '# USER.md\n\n- **Timezone:** UTC\n')

  expect(await stampExistingUserTimezone(ownerHome, 'Asia/Tokyo')).toBe('written')
  expect(await stampExistingUserTimezone(ownerHome, 'Asia/Tokyo')).toBe('unchanged')
  expect(readFileSync(path, 'utf8').match(/\*\*Timezone:/g)).toHaveLength(1)
})

test('a missing USER.md is left for persona-gen', async () => {
  expect(await stampExistingUserTimezone(ownerHome, 'Asia/Tokyo')).toBe('missing')
})
