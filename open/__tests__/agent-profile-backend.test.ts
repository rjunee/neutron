/**
 * Open AgentProfileBackend — the anti-"broken-promise" gate for Settings (M1).
 *
 * THE GAP (m1-e2e-round4 § Settings): Open never threaded an
 * `AgentProfileBackend`, so `update_agent_name` / `update_personality`
 * short-circuited on `profile.available === false` and returned
 * `SETTINGS_BACKEND_UNAVAILABLE_ERROR` ("Settings backend unavailable — please
 * report this") on EVERY box — even though onboarding promises "switch
 * personality / update my name later — just ask."
 *
 * THE FIX: `buildOpenAgentProfileBackend` persists name + personality to
 * `<owner_home>/persona/{agent-profile.json,SOUL.md}`, the SOUL.md being the
 * exact file `PersonaPromptLoader` reads every agent turn — so a later turn
 * reflects the change.
 *
 * This suite proves, against REAL files in a temp dir + the REAL agent-settings
 * Core backend (no mocks of either):
 *   1. the Core's profile tools now return success (NOT the unavailable error);
 *   2. the change is persisted to SOUL.md in a form the PersonaPromptLoader
 *      actually loads + splices ("You are <new name>." / the personality);
 *   3. the PersonaPromptLoader picks up the change on its next load();
 *   4. the managed block is idempotent and never clobbers onboarding content.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildOpenAgentProfileBackend,
  renderProfileBlock,
  spliceProfileBlock,
  PROFILE_BLOCK_START,
  PROFILE_BLOCK_END,
} from '../agent-profile-backend.ts'
import {
  buildAgentSettingsBackend,
  SETTINGS_BACKEND_UNAVAILABLE_ERROR,
  type AgentSettingsTelegram,
} from '@neutronai/agent-settings'
import { PersonaPromptLoader } from '@neutronai/gateway/wiring/persona-loader.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

/** Open a migrated per-instance ProjectDb on disk (the agent-settings test pattern). */
function openMigratedDb(dir: string): ProjectDb {
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  return ProjectDb.open(dbPath)
}

let ownerHome: string
const personaPath = (name: string): string => join(ownerHome, 'persona', name)
const readSoul = (): string => readFileSync(personaPath('SOUL.md'), 'utf8')
const readStore = (): { agent_name: string | null; agent_personality: string | null } =>
  JSON.parse(readFileSync(personaPath('agent-profile.json'), 'utf8'))

beforeEach(() => {
  ownerHome = mkdtempSync(join(tmpdir(), 'open-agent-profile-'))
})
afterEach(() => {
  rmSync(ownerHome, { recursive: true, force: true })
})

const noopTelegram: AgentSettingsTelegram = {
  async sendConfirmation() {},
  async renameTopic() {},
  async archiveTopic() {},
}

describe('buildOpenAgentProfileBackend — pure render/splice helpers', () => {
  test('renderProfileBlock returns empty when neither field set', () => {
    expect(renderProfileBlock({ agent_name: null, agent_personality: null })).toBe('')
    expect(renderProfileBlock({ agent_name: '  ', agent_personality: '' })).toBe('')
  })

  test('renderProfileBlock emits name + personality with override line', () => {
    const block = renderProfileBlock({
      agent_name: 'Nova',
      agent_personality: 'calm strategist — precise, warm, no hype',
    })
    expect(block.startsWith(PROFILE_BLOCK_START)).toBe(true)
    expect(block.endsWith(PROFILE_BLOCK_END)).toBe(true)
    expect(block).toContain('You are Nova.')
    expect(block).toContain('Your personality: calm strategist — precise, warm, no hype')
    expect(block).toContain('authoritative and override')
  })

  test('spliceProfileBlock prepends above an onboarding body and preserves it', () => {
    const body = '# SOUL.md\n\n_You are OldName. Voice below._\n\n## Archetypal Blend\n\nstuff\n'
    const block = renderProfileBlock({ agent_name: 'Nova', agent_personality: null })
    const out = spliceProfileBlock(body, block)
    expect(out.indexOf(PROFILE_BLOCK_START)).toBeLessThan(out.indexOf('# SOUL.md'))
    expect(out).toContain('## Archetypal Blend')
    expect(out).toContain('stuff')
  })

  test('spliceProfileBlock replaces a prior managed block (idempotent, single block)', () => {
    const body = '# SOUL.md\n\nonboarding content\n'
    const first = spliceProfileBlock(body, renderProfileBlock({ agent_name: 'A', agent_personality: null }))
    const second = spliceProfileBlock(first, renderProfileBlock({ agent_name: 'B', agent_personality: null }))
    // Exactly one managed block, with the latest name only.
    expect(second.split(PROFILE_BLOCK_START).length - 1).toBe(1)
    expect(second).toContain('You are B.')
    expect(second).not.toContain('You are A.')
    expect(second).toContain('onboarding content')
  })

  test('spliceProfileBlock with empty block strips a prior managed block', () => {
    const body = '# SOUL.md\n\nkeep me\n'
    const withBlock = spliceProfileBlock(body, renderProfileBlock({ agent_name: 'A', agent_personality: null }))
    const stripped = spliceProfileBlock(withBlock, '')
    expect(stripped).not.toContain(PROFILE_BLOCK_START)
    expect(stripped).toContain('keep me')
  })
})

describe('buildOpenAgentProfileBackend — persistence', () => {
  test('available is true (Open can always write its persona files)', () => {
    const backend = buildOpenAgentProfileBackend({ owner_home: ownerHome })
    expect(backend.available).toBe(true)
  })

  test('get() falls back to NEUTRON_AGENT_NAME when no store exists', async () => {
    const backend = buildOpenAgentProfileBackend({
      owner_home: ownerHome,
      env: { NEUTRON_AGENT_NAME: 'Atlas' } as NodeJS.ProcessEnv,
    })
    expect(await backend.get()).toEqual({ agent_name: 'Atlas', agent_personality: null })
  })

  test('setAgentName persists to json + writes SOUL.md opener; get() round-trips', async () => {
    let reloads = 0
    const backend = buildOpenAgentProfileBackend({
      owner_home: ownerHome,
      onProfileChange: () => {
        reloads++
      },
    })
    await backend.setAgentName('Nova')
    expect(readStore().agent_name).toBe('Nova')
    expect(readSoul()).toContain('You are Nova.')
    expect(reloads).toBe(1)
    expect((await backend.get()).agent_name).toBe('Nova')
  })

  test('setAgentPersonality persists to SOUL.md + get() round-trips for partial updates', async () => {
    const backend = buildOpenAgentProfileBackend({ owner_home: ownerHome })
    await backend.setAgentPersonality('calm strategist — precise, warm')
    expect(readSoul()).toContain('Your personality: calm strategist — precise, warm')
    expect((await backend.get()).agent_personality).toBe('calm strategist — precise, warm')
    // A later name update keeps the personality in the same SOUL.md block.
    await backend.setAgentName('Nova')
    const soul = readSoul()
    expect(soul).toContain('You are Nova.')
    expect(soul).toContain('Your personality: calm strategist — precise, warm')
    expect(soul.split(PROFILE_BLOCK_START).length - 1).toBe(1)
  })

  test('concurrent name + personality updates do NOT lose a field (serialized)', async () => {
    const backend = buildOpenAgentProfileBackend({ owner_home: ownerHome })
    // Simulate an agent issuing both tools in the same turn.
    await Promise.all([
      backend.setAgentName('Nova'),
      backend.setAgentPersonality('calm strategist — precise, warm'),
    ])
    const store = readStore()
    expect(store.agent_name).toBe('Nova')
    expect(store.agent_personality).toBe('calm strategist — precise, warm')
    const soul = readSoul()
    expect(soul).toContain('You are Nova.')
    expect(soul).toContain('Your personality: calm strategist — precise, warm')
    expect(soul.split(PROFILE_BLOCK_START).length - 1).toBe(1)
  })

  test('rejects a symlinked persona/ directory instead of writing through it', async () => {
    const { symlinkSync, mkdtempSync } = await import('node:fs')
    // Point <owner_home>/persona at an outside dir via symlink.
    const outside = mkdtempSync(join(tmpdir(), 'open-agent-profile-escape-'))
    symlinkSync(outside, join(ownerHome, 'persona'))
    const backend = buildOpenAgentProfileBackend({ owner_home: ownerHome })
    await expect(backend.setAgentName('Nova')).rejects.toThrow(/persona directory rejected: symlink/)
    rmSync(outside, { recursive: true, force: true })
  })

  test('preserves an existing onboarding-authored SOUL.md body', async () => {
    mkdirSync(join(ownerHome, 'persona'), { recursive: true })
    writeFileSync(
      personaPath('SOUL.md'),
      '# SOUL.md\n\n_You are OldName. Voice below._\n\n## Operating Principles\n\n1. Truth first.\n',
      'utf8',
    )
    const backend = buildOpenAgentProfileBackend({ owner_home: ownerHome })
    await backend.setAgentName('Nova')
    const soul = readSoul()
    expect(soul).toContain('## Operating Principles')
    expect(soul).toContain('1. Truth first.')
    expect(soul).toContain('You are Nova.')
    // Managed block precedes the onboarding header.
    expect(soul.indexOf(PROFILE_BLOCK_START)).toBeLessThan(soul.indexOf('# SOUL.md'))
  })
})

describe('Open profile backend ⇄ agent-settings Core (the real broken-promise repro)', () => {
  test('CONTROL: the available:false no-op still returns the unavailable error', async () => {
    const db = openMigratedDb(ownerHome)
    const settings = buildAgentSettingsBackend({
      projectDb: db,
      telegram: noopTelegram,
      profile: {
        available: false,
        async get() {
          return { agent_name: null, agent_personality: null }
        },
        async setAgentName() {},
        async setAgentPersonality() {},
      },
    })
    const res = await settings.updateAgentName('Nova')
    expect(res.success).toBe(false)
    expect(res.error).toBe(SETTINGS_BACKEND_UNAVAILABLE_ERROR)
    db.close()
  })

  test('FIX: Open profile makes update_agent_name + update_personality succeed and persist', async () => {
    const db = openMigratedDb(ownerHome)

    const loader = new PersonaPromptLoader({ owner_home: ownerHome })
    const profile = buildOpenAgentProfileBackend({
      owner_home: ownerHome,
      onProfileChange: () => loader.invalidate('SOUL.md'),
    })
    const settings = buildAgentSettingsBackend({
      projectDb: db,
      telegram: noopTelegram,
      profile,
    })

    const nameRes = await settings.updateAgentName('Nova')
    expect(nameRes.success).toBe(true)
    expect(nameRes.error).toBeUndefined()
    expect(nameRes.agent_name).toBe('Nova')

    const persRes = await settings.updatePersonality({
      new_archetype: 'calm strategist',
      new_description: 'precise, warm, no hype',
    })
    expect(persRes.success).toBe(true)
    expect(persRes.error).toBeUndefined()

    // The PersonaPromptLoader (the live per-turn read path) now surfaces both.
    const persona = await loader.load()
    expect(persona).toContain('<persona_file name="SOUL.md">')
    expect(persona).toContain('You are Nova.')
    expect(persona).toContain('calm strategist')
    expect(persona).toContain('precise, warm, no hype')
    db.close()
  })

  test('FIX: a SUBSEQUENT turn reflects a renamed agent (loader re-reads the rewrite)', async () => {
    const db = openMigratedDb(ownerHome)

    const loader = new PersonaPromptLoader({ owner_home: ownerHome })
    const profile = buildOpenAgentProfileBackend({
      owner_home: ownerHome,
      onProfileChange: () => loader.invalidate('SOUL.md'),
    })
    const settings = buildAgentSettingsBackend({ projectDb: db, telegram: noopTelegram, profile })

    await settings.updateAgentName('Nova')
    expect(await loader.load()).toContain('You are Nova.')

    // Owner asks again to rename — the next turn must reflect the NEW name.
    await settings.updateAgentName('Sage')
    const next = await loader.load()
    expect(next).toContain('You are Sage.')
    expect(next).not.toContain('You are Nova.')
    db.close()
  })
})
