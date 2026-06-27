/**
 * agent-skills.test.ts — P1-5 native SKILL.md discovery (lift audit § P1-5).
 *
 * Asserts the spawned live agent's project skills dir is provisioned with the
 * bundled native `SKILL.md` packs (so the REPL discovers + invokes them via the
 * built-in `Skill` mechanism), that the bundle actually ships the CLAUDE.md-
 * mandated + previously-unreachable packs, and that provisioning never clobbers a
 * forged pack already present in the dir.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUNDLED_SKILLS_DIR,
  provisionAgentSkills,
  resolveAgentSkillsDir,
} from '../agent-skills.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-skills-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

test('resolveAgentSkillsDir is the project-level <cwd>/.claude/skills the REPL discovers', () => {
  expect(resolveAgentSkillsDir('/home/owner')).toBe('/home/owner/.claude/skills')
})

test('the bundled skills dir ships the mandated + previously-unreachable native packs', () => {
  // These are the packs the audit calls out: `impeccable` (CLAUDE.md-mandated
  // design path) + `agent-browser` were WHOLLY unreachable; `remind` is the
  // lifted-mechanism replacement for the hardcoded chat-commands time parser.
  for (const pack of ['impeccable', 'agent-browser', 'remind']) {
    expect(existsSync(join(BUNDLED_SKILLS_DIR, pack, 'SKILL.md'))).toBe(true)
  }
})

test('provisionAgentSkills materializes the bundled SKILL.md packs into the agent skills dir', () => {
  const skillsDir = resolveAgentSkillsDir(tmp)
  const result = provisionAgentSkills({ skillsDir })

  expect(result.skillsDir).toBe(skillsDir)
  // The key packs are discoverable on disk after provisioning.
  for (const pack of ['impeccable', 'agent-browser', 'remind']) {
    expect(result.bundled).toContain(pack)
    expect(result.present).toContain(pack)
    const skillMd = join(skillsDir, pack, 'SKILL.md')
    expect(existsSync(skillMd)).toBe(true)
    // A real SKILL.md with frontmatter — the shape Claude Code's loader reads.
    expect(readFileSync(skillMd, 'utf8').startsWith('---')).toBe(true)
  }
})

test('provisioning is idempotent and never deletes a forged (non-bundled) pack', () => {
  const skillsDir = resolveAgentSkillsDir(tmp)

  // A forged skill already present (as skill-forge would write it).
  const forgedDir = join(skillsDir, 'file-a-tweet')
  mkdirSync(forgedDir, { recursive: true })
  writeFileSync(join(forgedDir, 'SKILL.md'), '---\nname: file-a-tweet\n---\nbody\n')

  const first = provisionAgentSkills({ skillsDir })
  expect(first.present).toContain('file-a-tweet')
  expect(first.present).toContain('impeccable')

  // Second pass: bundled packs still present, forged pack untouched.
  const second = provisionAgentSkills({ skillsDir })
  expect(second.present).toContain('file-a-tweet')
  expect(second.present).toContain('impeccable')
  expect(readFileSync(join(forgedDir, 'SKILL.md'), 'utf8')).toContain('name: file-a-tweet')
})
