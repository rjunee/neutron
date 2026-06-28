import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'

import { SkillForge, type ProposalNotifier } from '../forge.ts'
import { SkillForgeProposalsStore } from '../proposals-store.ts'
import type { CompletedWorkflow, ProposalRecord } from '../types.ts'

class CapturingNotifier implements ProposalNotifier {
  calls: Array<{ proposal: ProposalRecord; message: string }> = []
  async notify(proposal: ProposalRecord, message: string): Promise<void> {
    this.calls.push({ proposal, message })
  }
}

let tmp: string
let dbPath: string
let db: ProjectDb
let skillsDir: string
let notifier: CapturingNotifier
let forge: SkillForge

const workflow: CompletedWorkflow = {
  project_slug: 'p',
  topic_id: 'chat:thread',
  intent: 'Scrape a tweet and file it to the brief',
  steps: [
    { action: 'tx-scrape', summary: 'fetch the tweet' },
    { action: 'doc_write', summary: 'append to the brief' },
  ],
  artifacts: ['Projects/x/brief.md'],
  succeeded: true,
}

/** Native skill packs present = subdirectories of skillsDir that hold a SKILL.md. */
function listPacks(): string[] {
  if (!existsSync(skillsDir)) return []
  return readdirSync(skillsDir)
    .filter((n) => {
      const p = join(skillsDir, n)
      return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md'))
    })
    .sort()
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skill-forge-'))
  dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
  skillsDir = join(tmp, 'owner-data', 'skills')
  notifier = new CapturingNotifier()
  forge = new SkillForge({
    store: new SkillForgeProposalsStore({ db, now: () => 1000 }),
    notifier,
    skillsDir,
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('a completed multi-step workflow fires a proposal — name, triggers, what, artifacts — and writes NO skill yet', async () => {
  const proposal = await forge.onWorkflowCompleted(workflow)
  expect(proposal).not.toBeNull()

  // Exactly one proposal message delivered.
  expect(notifier.calls.length).toBe(1)
  const { message } = notifier.calls[0]!
  expect(message).toContain('scrape-a-tweet-and-file-it-to-the-brief') // name
  expect(message.toLowerCase()).toContain('scrape a tweet') // a trigger
  expect(message).toContain('Triggers')
  expect(message).toContain('Projects/x/brief.md') // artifact
  expect(message.toLowerCase()).toContain('approve')

  // GATED: nothing written to disk until approval.
  expect(listPacks()).toEqual([])
  expect(proposal!.status).toBe('pending')
})

test('a workflow that is not skill-worthy fires no proposal', async () => {
  const failed = { ...workflow, succeeded: false }
  expect(await forge.onWorkflowCompleted(failed)).toBeNull()
  expect(notifier.calls.length).toBe(0)
})

test('the same workflow is not re-proposed while a proposal is pending', async () => {
  await forge.onWorkflowCompleted(workflow)
  const second = await forge.onWorkflowCompleted(workflow)
  expect(second).toBeNull()
  expect(notifier.calls.length).toBe(1)
})

test('approve distills + registers a native SKILL.md pack that survives a fresh session', async () => {
  const proposal = await forge.onWorkflowCompleted(workflow)
  const { skill_path } = await forge.approve(proposal!.id)

  // A native SKILL.md pack landed: <skillsDir>/<name>/SKILL.md.
  expect(existsSync(skill_path)).toBe(true)
  expect(skill_path).toBe(
    join(skillsDir, 'scrape-a-tweet-and-file-it-to-the-brief', 'SKILL.md'),
  )
  expect(listPacks()).toEqual(['scrape-a-tweet-and-file-it-to-the-brief'])

  // Natively discoverable: the SKILL.md carries the frontmatter Claude Code's
  // skill loader matches on (name + description) plus the procedure body.
  const body = readFileSync(skill_path, 'utf8')
  expect(body.startsWith('---\n')).toBe(true)
  expect(body).toContain('name: scrape-a-tweet-and-file-it-to-the-brief')
  expect(body).toContain('description: |')
  expect(body).toContain('ALWAYS use this skill')

  // Survives a fresh session: it's a plain on-disk file, still there on re-read.
  expect(readFileSync(skill_path, 'utf8')).toBe(body)

  // Proposal row reflects approval.
  const approved = await new SkillForgeProposalsStore({ db }).get(proposal!.id)
  expect(approved?.status).toBe('approved')
  expect(approved?.skill_path).toBe(skill_path)
})

test('approve with edits overrides the distilled name + triggers', async () => {
  const proposal = await forge.onWorkflowCompleted(workflow)
  const { skill_path } = await forge.approve(proposal!.id, {
    name: 'Tweet Filer',
    triggers: ['file this tweet'],
  })
  expect(skill_path).toBe(join(skillsDir, 'tweet-filer', 'SKILL.md'))
  expect(readFileSync(skill_path, 'utf8')).toContain('file this tweet')
})

test('decline creates nothing and marks the proposal declined', async () => {
  const proposal = await forge.onWorkflowCompleted(workflow)
  const declined = await forge.decline(proposal!.id)
  expect(declined.status).toBe('declined')

  // Nothing written; no native skill pack exists.
  expect(listPacks()).toEqual([])

  // A declined workflow CAN be re-proposed on a later run (user may reconsider).
  const reproposed = await forge.onWorkflowCompleted(workflow)
  expect(reproposed).not.toBeNull()
})

test('approving an already-decided proposal throws', async () => {
  const proposal = await forge.onWorkflowCompleted(workflow)
  await forge.approve(proposal!.id)
  await expect(forge.approve(proposal!.id)).rejects.toThrow()
})
