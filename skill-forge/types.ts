/**
 * @neutronai/skill-forge — types.
 *
 * Skill Forge audits a *completed multi-step workflow* and, when it looks
 * skill-worthy, proposes turning it into a saved, re-invokable skill. These
 * are the shared shapes: the recorded workflow, the distilled skill draft, and
 * the persisted proposal row.
 */

/** One step the agent took while executing the workflow. */
export interface WorkflowStep {
  /**
   * Stable identifier of the action — a tool name, a slash-command, or a
   * sub-phase label (e.g. `doc_search`, `tasks.create`, `forge-fix`). Used
   * for both display and the dedupe signature, so it must be normalized
   * (lower-case, no volatile args).
   */
  action: string
  /** Human-readable one-liner of what the step did (optional). */
  summary?: string
}

/**
 * A completed multi-step workflow handed to Skill Forge for audit. This is the
 * generic shape; adapters (e.g. `completedWorkflowFromTridentRun`) map a
 * concrete runtime run into it.
 */
export interface CompletedWorkflow {
  /** The project the workflow ran in. */
  project_slug: string
  /** The topic the workflow ran in (where the proposal should surface). */
  topic_id?: string
  /**
   * The user-facing intent / goal of the workflow in their own words, when
   * known (e.g. "scrape a tweet and file it to the brief"). Seeds the skill
   * name + description.
   */
  intent: string
  /** Ordered steps the agent executed. */
  steps: WorkflowStep[]
  /**
   * Artifacts the workflow produced or durably touched — file paths, doc
   * slugs, PR urls, table names. Surfaced verbatim in the proposal.
   */
  artifacts: string[]
  /** Whether the workflow completed successfully. Only successes are skillified. */
  succeeded: boolean
}

/**
 * The distilled, ready-to-register skill — derived from a CompletedWorkflow
 * (optionally with user edits) WITHOUT hand-authoring.
 */
export interface SkillDraft {
  /** kebab-case slug; also the `conventions/<name>.md` filename. */
  name: string
  /** Trigger phrases ("ALWAYS use when…") the resolver matches on. */
  triggers: string[]
  /** One-paragraph summary of what the skill does. */
  whatItDoes: string
  /** Artifact descriptions carried into the skill body. */
  artifacts: string[]
  /** Ordered procedure steps distilled from the workflow. */
  steps: WorkflowStep[]
}

/** Edits a user may apply when approving a proposal. All optional. */
export interface ProposalEdits {
  name?: string
  triggers?: string[]
  whatItDoes?: string
}

export type ProposalStatus = 'pending' | 'approved' | 'declined'

/** A persisted Skill Forge proposal row (decoded). */
export interface ProposalRecord {
  id: string
  workflow_signature: string
  project_slug: string
  topic_id: string | null
  proposed_name: string
  triggers: string[]
  what_it_does: string
  artifacts: string[]
  /** The snapshotted source workflow (for re-distillation on approve). */
  workflow: CompletedWorkflow
  status: ProposalStatus
  skill_path: string | null
  created_at: number
  decided_at: number | null
}
