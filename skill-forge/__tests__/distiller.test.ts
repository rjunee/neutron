import { expect, test } from 'bun:test'

import {
  deriveTriggers,
  distillSkill,
  renderSkillMarkdown,
  renderSkillPack,
  slugify,
} from '../distiller.ts'
import type { CompletedWorkflow, SkillDraft } from '../types.ts'

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

test('deriveTriggers strips a run of trailing dots (regex parity)', () => {
  // Reimplemented from `/\.+$/` to a linear scan; result is unchanged.
  expect(deriveTriggers('Scrape a tweet...')).toContain('scrape a tweet')
  expect(deriveTriggers('do it.')).toContain('do it')
  // Interior dots are preserved — only a trailing run is stripped.
  expect(deriveTriggers('ship v1.2')).toContain('ship v1.2')
})

test('deriveTriggers completes in <50ms on adversarial dot input', () => {
  // `'.'.repeat(n) + 'x'` is the pathological case for the old `/\.+$/`:
  // `\.+` matches every dot, `$` fails on the trailing `x`, and the engine
  // restarts at every offset — O(n²). The linear scan finds no trailing run.
  const evil = '.'.repeat(500_000) + 'x'
  const t0 = performance.now()
  const triggers = deriveTriggers(evil)
  const elapsed = performance.now() - t0
  expect(triggers[0]).toBe(evil.toLowerCase())
  expect(elapsed).toBeLessThan(50)
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

test('renderSkillPack emits valid frontmatter (name + description block scalar)', () => {
  const pack = renderSkillPack(distillSkill(workflow))
  expect(pack.startsWith('---\n')).toBe(true)
  expect(pack).toContain('name: scrape-a-tweet-and-file-it-to-the-brief')
  expect(pack).toContain('description: |')
  // The body follows the frontmatter.
  expect(pack).toContain('# scrape-a-tweet-and-file-it-to-the-brief')
})

test('renderSkillPack indents EVERY physical line of a multiline description (Codex P2)', () => {
  // A user-approved proposal may carry an embedded-newline whatItDoes / trigger.
  const draft: SkillDraft = {
    name: 'multi-line-skill',
    triggers: ['line one\nline two'],
    whatItDoes: 'First paragraph.\nSecond paragraph.',
    artifacts: [],
    steps: [{ action: 'do_thing' }],
  }
  const pack = renderSkillPack(draft)
  const lines = pack.split('\n')
  const start = lines.indexOf('description: |')
  expect(start).toBeGreaterThan(-1)
  // Every line of the block scalar (until the closing `---`) is indented ≥2 spaces.
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line === '---') break
    if (line.length === 0) continue // blank lines are valid inside a block scalar
    expect(line.startsWith('  ')).toBe(true)
  }
  // Both physical lines of the multiline content survived, indented.
  expect(pack).toContain('  Second paragraph.')
  expect(pack).toContain('  line two')
})
