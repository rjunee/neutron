import { expect, test } from 'bun:test'

import { deriveTriggers, distillSkill, renderSkillMarkdown, slugify } from '../distiller.ts'
import type { CompletedWorkflow } from '../types.ts'

const workflow: CompletedWorkflow = {
  project_slug: 'p',
  intent: 'Scrape a Tweet and file it to the brief',
  steps: [
    { action: 'tx-scrape', summary: 'fetch the tweet' },
    { action: 'doc_write', summary: 'append to the brief' },
  ],
  artifacts: ['Projects/x/brief.md'],
  succeeded: true,
}

test('slugify produces a kebab-case, filesystem-safe slug', () => {
  expect(slugify('Scrape a Tweet & file it!')).toBe('scrape-a-tweet-file-it')
  expect(slugify('   ')).toBe('forged-skill')
})

test('deriveTriggers includes the intent verbatim (lower-cased)', () => {
  const t = deriveTriggers('Scrape a Tweet')
  expect(t).toContain('scrape a tweet')
})

test('distill derives name/triggers/artifacts/steps from the workflow', () => {
  const draft = distillSkill(workflow)
  expect(draft.name).toBe('scrape-a-tweet-and-file-it-to-the-brief')
  expect(draft.triggers.length).toBeGreaterThan(0)
  expect(draft.artifacts).toEqual(['Projects/x/brief.md'])
  expect(draft.steps.map((s) => s.action)).toEqual(['tx-scrape', 'doc_write'])
})

test('user edits override name/triggers/summary', () => {
  const draft = distillSkill(workflow, {
    name: 'Tweet Filer',
    triggers: ['file this tweet'],
    whatItDoes: 'Files a tweet.',
  })
  expect(draft.name).toBe('tweet-filer')
  expect(draft.triggers).toEqual(['file this tweet'])
  expect(draft.whatItDoes).toBe('Files a tweet.')
})

test('rendered markdown carries name, triggers, procedure and artifacts', () => {
  const md = renderSkillMarkdown(distillSkill(workflow))
  expect(md).toContain('# scrape-a-tweet-and-file-it-to-the-brief')
  expect(md).toContain('ALWAYS use this skill')
  expect(md).toContain('tx-scrape')
  expect(md).toContain('## Artifacts')
  expect(md).toContain('Projects/x/brief.md')
})
