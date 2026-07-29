import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assembleSystemPrompt } from './system-prompt.ts'

describe('system-prompt assembler', () => {
  test('persona + role + context files concatenate in locked order', async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-asm-'))
    try {
      writeFileSync(join(ownerHome, 'CLAUDE.md'), 'CLAUDE_BODY')
      writeFileSync(join(ownerHome, 'USER.md'), 'USER_BODY')
      const out = await assembleSystemPrompt({
        base_persona: 'PERSONA_BODY',
        agent_kind: 'forge',
        owner_home: ownerHome,
        instance_fragments: [],
        channel: 'telegram',
        active_skills: [],
      })
      const personaIdx = out.indexOf('PERSONA_BODY')
      const roleIdx = out.indexOf('<role>forge</role>')
      const claudeIdx = out.indexOf('CLAUDE_BODY')
      const userIdx = out.indexOf('USER_BODY')
      expect(personaIdx).toBeGreaterThanOrEqual(0)
      expect(roleIdx).toBeGreaterThan(personaIdx)
      expect(claudeIdx).toBeGreaterThan(roleIdx)
      expect(userIdx).toBeGreaterThan(claudeIdx)
    } finally {
      rmSync(ownerHome, { recursive: true, force: true })
    }
  })

  test('absent context files are silently skipped', async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-asm-'))
    try {
      const out = await assembleSystemPrompt({
        base_persona: 'P',
        agent_kind: 'atlas',
        owner_home: ownerHome,
        instance_fragments: [],
        channel: 'telegram',
        active_skills: [],
      })
      expect(out).not.toContain('<context_file')
    } finally {
      rmSync(ownerHome, { recursive: true, force: true })
    }
  })

  test('platform hints are emitted under <platform_hints> when channel matches', async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-asm-'))
    try {
      const out = await assembleSystemPrompt({
        base_persona: 'P',
        agent_kind: 'forge',
        owner_home: ownerHome,
        instance_fragments: [],
        channel: 'email',
        active_skills: [],
      })
      expect(out).toContain('<platform_hints channel="email">')
      expect(out).toContain('em-dashes')
    } finally {
      rmSync(ownerHome, { recursive: true, force: true })
    }
  })

  test('skill block emits XML with compact-home paths', async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-asm-'))
    try {
      const out = await assembleSystemPrompt({
        base_persona: 'P',
        agent_kind: 'forge',
        owner_home: ownerHome,
        instance_fragments: [],
        channel: 'cli',
        active_skills: [
          { name: 'remind', description: 'Manage reminders', path: '/home/user/.claude/skills/remind' },
        ],
      })
      expect(out).toContain('<available_skills>')
      // HOME compaction depends on env; either form is acceptable.
      expect(out).toMatch(/<location>(~|\/home\/user)/)
      expect(out).toContain('<name>remind</name>')
    } finally {
      rmSync(ownerHome, { recursive: true, force: true })
    }
  })

  test('memory pointers + heartbeat blocks emit when supplied', async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-asm-'))
    try {
      const out = await assembleSystemPrompt({
        base_persona: 'P',
        agent_kind: 'forge',
        owner_home: ownerHome,
        instance_fragments: [],
        channel: 'web',
        active_skills: [],
        memory_pointers: 'POINTER_BODY',
        heartbeat: 'HEARTBEAT_BODY',
      })
      expect(out).toContain('<memory_pointers>\nPOINTER_BODY\n</memory_pointers>')
      expect(out).toContain('<heartbeat>\nHEARTBEAT_BODY\n</heartbeat>')
    } finally {
      rmSync(ownerHome, { recursive: true, force: true })
    }
  })
})
