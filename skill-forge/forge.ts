/**
 * @neutronai/skill-forge — the runtime orchestrator.
 *
 * Wires the pieces into the propose-then-approve lifecycle:
 *
 *   onWorkflowCompleted(wf)
 *     → auditWorkflow (gate 1: is it skill-worthy?)
 *     → dedupe by signature (no re-nag while pending/approved)
 *     → distill a draft + persist a PENDING proposal
 *     → notify the user with the proposal message
 *     → return the proposal (NOTHING written to disk yet)
 *
 *   approve(id, edits?)   → distill (with edits) → register the skill file
 *                           under skills/conventions/ → mark approved
 *   decline(id)           → mark declined; NOTHING is created
 *
 * The gate is hard: `onWorkflowCompleted` NEVER writes a skill. A skill file
 * only ever appears via `approve`. That is the "GATED — never auto-creates
 * silently" guarantee.
 */

import { auditWorkflow } from './detector.ts'
import { distillSkill } from './distiller.ts'
import { composeProposalMessage } from './proposal-message.ts'
import type { SkillForgeProposalsStore } from './proposals-store.ts'
import { registerSkillFile } from './registrar.ts'
import { workflowSignature } from './signature.ts'
import type {
  CompletedWorkflow,
  ProposalEdits,
  ProposalRecord,
} from './types.ts'

/**
 * Delivers a proposal message to the user. Implementations bridge to whatever
 * channel surface is live (Telegram inline buttons, app socket, etc.) — Skill
 * Forge stays transport-agnostic. Failures are caught by the orchestrator so a
 * delivery hiccup never loses the persisted proposal.
 */
export interface ProposalNotifier {
  notify(proposal: ProposalRecord, message: string): Promise<void>
}

export interface ApproveResult {
  proposal: ProposalRecord
  /** Absolute path of the registered skill markdown. */
  skill_path: string
}

export class SkillForge {
  private readonly store: SkillForgeProposalsStore
  private readonly notifier: ProposalNotifier
  /** `<owner_data_dir>/skills` — where the conventions loader reads from. */
  private readonly skillsDir: string

  constructor(opts: {
    store: SkillForgeProposalsStore
    notifier: ProposalNotifier
    skillsDir: string
  }) {
    this.store = opts.store
    this.notifier = opts.notifier
    this.skillsDir = opts.skillsDir
  }

  /**
   * Audit a completed workflow and, if worthy + not already proposed, surface
   * a PENDING proposal. Returns the proposal, or `null` when nothing was
   * proposed (not worthy, or a duplicate). Writes no skill.
   */
  async onWorkflowCompleted(workflow: CompletedWorkflow): Promise<ProposalRecord | null> {
    const audit = auditWorkflow(workflow)
    if (!audit.worthy) return null

    const signature = workflowSignature(workflow)
    const existing = await this.store.getActiveBySignature(signature)
    if (existing !== null) return null

    const draft = distillSkill(workflow)
    const proposal = await this.store.create({
      workflow_signature: signature,
      project_slug: workflow.project_slug,
      topic_id: workflow.topic_id ?? null,
      proposed_name: draft.name,
      triggers: draft.triggers,
      what_it_does: draft.whatItDoes,
      artifacts: draft.artifacts,
      workflow,
    })

    try {
      await this.notifier.notify(proposal, composeProposalMessage(proposal))
    } catch (err) {
      // The proposal is already persisted (pending); a delivery failure must
      // not lose it. Log and move on — it surfaces in `listPending()`.
      console.warn(
        `[skill-forge] proposal ${proposal.id} persisted but notify failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    return proposal
  }

  /**
   * Approve a pending proposal: distill (optionally with user edits), write the
   * skill file under `skills/conventions/`, and mark the row approved.
   */
  async approve(id: string, edits?: ProposalEdits): Promise<ApproveResult> {
    const proposal = await this.store.get(id)
    if (proposal === null) throw new Error(`skill-forge.approve: unknown proposal ${id}`)
    if (proposal.status !== 'pending') {
      throw new Error(`skill-forge.approve: proposal ${id} is ${proposal.status}, not pending`)
    }
    const draft = distillSkill(proposal.workflow, edits)
    const { path } = await registerSkillFile({ skillsDir: this.skillsDir, draft })
    const approved = await this.store.markApproved(id, path)
    return { proposal: approved, skill_path: path }
  }

  /** Decline a pending proposal. Creates nothing. */
  async decline(id: string): Promise<ProposalRecord> {
    const proposal = await this.store.get(id)
    if (proposal === null) throw new Error(`skill-forge.decline: unknown proposal ${id}`)
    if (proposal.status !== 'pending') {
      throw new Error(`skill-forge.decline: proposal ${id} is ${proposal.status}, not pending`)
    }
    return this.store.markDeclined(id)
  }
}
