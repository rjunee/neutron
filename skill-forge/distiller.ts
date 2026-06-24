/**
 * @neutronai/skill-forge — distiller.
 *
 * Turns a CompletedWorkflow (optionally with user edits) into a SkillDraft and
 * renders the convention markdown that gets written to
 * `<owner_data_dir>/skills/conventions/<name>.md`. Fully deterministic — the
 * skill is DISTILLED from the recorded workflow, never hand-authored and never
 * a network/LLM round-trip (so it is reproducible and testable on a
 * memory-bound box). User edits (name / triggers / summary) are merged on top.
 */

import type {
  CompletedWorkflow,
  ProposalEdits,
  SkillDraft,
  WorkflowStep,
} from './types.ts'

/** kebab-case a free-text intent into a stable, filesystem-safe slug. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'forged-skill'
}

/**
 * Derive trigger phrases from the workflow intent. Conservative + deterministic:
 * the intent itself plus a couple of natural imperative paraphrases. The user
 * can always edit these on approve.
 */
export function deriveTriggers(intent: string): string[] {
  const cleaned = intent.trim().replace(/\.+$/, '')
  const lower = cleaned.toLowerCase()
  const triggers = [lower, `do the ${lower} workflow`, `run ${lower} again`]
  // Dedupe while preserving order.
  return [...new Set(triggers)].filter((t) => t.length > 0)
}

/** Distill a SkillDraft from a workflow, applying optional user edits. */
export function distillSkill(
  workflow: CompletedWorkflow,
  edits?: ProposalEdits,
): SkillDraft {
  const name = edits?.name !== undefined ? slugify(edits.name) : slugify(workflow.intent)
  const triggers =
    edits?.triggers !== undefined && edits.triggers.length > 0
      ? edits.triggers
      : deriveTriggers(workflow.intent)
  const whatItDoes =
    edits?.whatItDoes !== undefined && edits.whatItDoes.trim().length > 0
      ? edits.whatItDoes.trim()
      : defaultWhatItDoes(workflow)
  return {
    name,
    triggers,
    whatItDoes,
    artifacts: [...workflow.artifacts],
    steps: workflow.steps.map((s) => ({ ...s })),
  }
}

function defaultWhatItDoes(workflow: CompletedWorkflow): string {
  const verbs = workflow.steps.map((s) => s.action).join(' → ')
  return `${capitalize(workflow.intent.trim())} The workflow runs: ${verbs}.`
}

function capitalize(s: string): string {
  if (s.length === 0) return s
  const out = s.charAt(0).toUpperCase() + s.slice(1)
  return /[.!?]$/.test(out) ? out : `${out}.`
}

/**
 * Render the convention markdown the skills-loader splices into every LLM
 * turn. Shape mirrors the hand-written `skills/conventions/*.md` files: a
 * title, an explicit "ALWAYS use when…" trigger block (the resolver), a
 * what-it-does paragraph, a numbered procedure, and the artifacts it touches.
 */
export function renderSkillMarkdown(draft: SkillDraft): string {
  const lines: string[] = []
  lines.push(`# ${draft.name}`)
  lines.push('')
  lines.push(
    '> Auto-distilled by Skill Forge from a completed workflow. Edit freely.',
  )
  lines.push('')
  lines.push('ALWAYS use this skill whenever the user says ANY of these phrases or anything similar:')
  for (const t of draft.triggers) lines.push(`- "${t}"`)
  lines.push('')
  lines.push('## What it does')
  lines.push('')
  lines.push(draft.whatItDoes)
  lines.push('')
  lines.push('## Procedure')
  lines.push('')
  draft.steps.forEach((step: WorkflowStep, i: number) => {
    const detail = step.summary !== undefined && step.summary.length > 0 ? ` — ${step.summary}` : ''
    lines.push(`${i + 1}. \`${step.action}\`${detail}`)
  })
  if (draft.artifacts.length > 0) {
    lines.push('')
    lines.push('## Artifacts')
    lines.push('')
    for (const a of draft.artifacts) lines.push(`- ${a}`)
  }
  lines.push('')
  return lines.join('\n')
}
