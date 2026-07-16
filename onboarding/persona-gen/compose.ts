/**
 * @neutronai/onboarding — persona compose orchestrator (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.6 + § 4.8. Runs the full persona-
 * file generation loop:
 *
 *   1. Generate SOUL.md / USER.md / priority-map.md from interview state.
 *   2. Cringe-check each file. If `flags >= threshold`, regenerate (LLM
 *      pass with explicit "remove the flagged patterns" injection).
 *   3. Cap regen attempts at 3 per file. Cap-exceeded → throw
 *      `PersonaError{code:'cringe_cap_exceeded'}`.
 *   4. Apply user line-edits via `applyEdit` (re-runs cringe-check on the
 *      modified file).
 *   5. Commit the draft to disk + Git on `commit(...)`.
 *
 * Substrate dependence: the regen step calls a substrate-shaped
 * `regenerate(file, prior_content, flagged_reasons)`. Pure-function
 * generation lives in `soul.ts` / `user.ts` / `priority-map.ts`. This
 * module's concern is the cringe-check loop + persistence.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { BlendedArchetype } from '../archetypes/compose.ts'
import { composeFromFreeText } from '../archetypes/compose.ts'
import type { ArchetypeLibrary } from '../archetypes/library.ts'
import { generateSoulMd, type InterviewSignals } from './soul.ts'
import { generateUserMd, type UserFacts } from './user.ts'
import { generatePriorityMapMd, type PriorityMapInput } from './priority-map.ts'
import type { CringeChecker, PersonaFile } from './cringe-check.ts'

export type PersonaErrorCode =
  | 'compose_failed'
  | 'cringe_cap_exceeded'
  | 'edit_invalid'
  | 'commit_failed'

export class PersonaError extends Error {
  override readonly name = 'PersonaError'
  constructor(
    readonly code: PersonaErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface PersonaDraft {
  owner_slug: string
  draft_id: string
  soul_md: string
  user_md: string
  priority_map_md: string
  cringe_check_flags: { soul: number; user: number; priority_map: number }
  regen_attempts: { soul: number; user: number; priority_map: number }
  status: 'draft' | 'committed' | 'manual_review'
}

export interface ComposeInput {
  owner_slug: string
  /**
   * P2 v2 § 7.1 — pre-computed archetype blend. Optional: when omitted,
   * the composer derives the blend at synthesis time from
   * `signals.agent_personality` via `composeFromFreeText`, using the
   * `archetypes` library on `PersonaComposerDeps` to match curated
   * archetype mentions. Callers may still pre-stash a blend (e.g. from
   * a migration-0025-affected `phase_state.archetype_blend`) and the
   * composer honors it without re-deriving.
   */
  archetype_blend?: BlendedArchetype
  signals: InterviewSignals
  user_facts: UserFacts
  priority_map: PriorityMapInput
  /**
   * T1 (2026-05-13) — user-supplied hint captured on the
   * `persona_reviewed` Restart sub-flow. When set, the composer
   * threads it into the generators so the redraft reflects the
   * change the user asked for. Empty / undefined means "no hint" and
   * the generators behave identically to the first-pass compose.
   */
  regen_hint?: string
}

export interface PersonaRegenerator {
  regenerate(input: {
    file: PersonaFile
    prior_content: string
    reasons: ReadonlyArray<string>
    archetype_blend: BlendedArchetype
    signals: InterviewSignals
    user_facts: UserFacts
    priority_map: PriorityMapInput
  }): Promise<string>
}

export interface PersonaComposerDeps {
  cringeChecker: CringeChecker
  /** Optional substrate that produces a de-cringed regen draft. When absent,
   *  the composer falls back to programmatic stripping (replace em-dashes,
   *  remove flagged corporate filler) so tests + offline runs make progress. */
  regenerator?: PersonaRegenerator
  /** Override default 3-attempt cap. */
  regenCap?: number
  /** Filesystem writer + git commit hooks; tests inject. */
  fsWriter?: { write(path: string, content: string): Promise<void> }
  gitCommit?: (paths: ReadonlyArray<string>, message: string) => Promise<{ sha: string }>
  /** Instance home dir resolver; defaults to <cwd>/data/<owner_slug>/persona. */
  ownerHomeFor?: (owner_slug: string) => string
  now?: () => number
  /**
   * P2 v2 § 0 locked decision #9 + § 7.1 — curated archetype library
   * consumed at synthesis time. When provided, `compose()` derives the
   * `BlendedArchetype` from `signals.agent_personality` via
   * `composeFromFreeText({ library: archetypes })`, so curated mentions
   * ("Sherlock Holmes meets Marcus Aurelius") land curated voice / comm
   * / decision fragments. When omitted, `composeFromFreeText` returns a
   * pure free-text blend driven by the personality phrase itself —
   * curated matching is opt-in via this dep. The library lives on
   * PersonaComposer (NOT InterviewEngineDeps) so the engine's
   * personality_offered phase stays string-only per spec § 3.9.
   */
  archetypes?: ArchetypeLibrary
}

export interface LineEdit {
  /** 1-indexed line in the current draft. */
  line: number
  /** Replacement text; empty string deletes the line. */
  replacement: string
}

export interface ApplyEditInput {
  draft: PersonaDraft
  file: PersonaFile
  edit: LineEdit
}

export class PersonaComposer {
  private readonly deps: PersonaComposerDeps
  private readonly regenCap: number
  private readonly now: () => number

  constructor(deps: PersonaComposerDeps) {
    this.deps = deps
    this.regenCap = deps.regenCap ?? 3
    this.now = deps.now ?? ((): number => Date.now())
  }

  async compose(input: ComposeInput): Promise<PersonaDraft> {
    const draft_id = randomUUID()
    // P2 v2 § 7.1 — derive the blend at synthesis time from the
    // free-text `agent_personality` captured at `personality_offered`,
    // matching curated archetype mentions via `this.deps.archetypes`.
    // Callers that already computed a blend (e.g. a pre-stashed
    // migration-0025 `archetype_blend`) pass `input.archetype_blend`
    // and the helper short-circuits.
    const archetype_blend: BlendedArchetype = this.deriveArchetypeBlend(input)
    // Thread the user's restart hint (when set) into the SOUL generator
    // as an additional signal so the redraft reflects the change the
    // user asked for. The hint also gets fed through to the
    // regenerator's `signals` payload so any LLM-backed regen sees it.
    const signals_with_hint: InterviewSignals =
      typeof input.regen_hint === 'string' && input.regen_hint.length > 0
        ? { ...input.signals, regen_hint: input.regen_hint }
        : input.signals
    const drafts: Record<PersonaFile, string> = {
      soul: generateSoulMd({ archetype_blend, signals: signals_with_hint }),
      user: generateUserMd(input.user_facts),
      priority_map: generatePriorityMapMd(input.priority_map),
    }
    const flags: Record<PersonaFile, number> = { soul: 0, user: 0, priority_map: 0 }
    const attempts: Record<PersonaFile, number> = { soul: 0, user: 0, priority_map: 0 }

    for (const file of ['soul', 'user', 'priority_map'] as const) {
      let content = drafts[file]
      let cringe = await this.deps.cringeChecker.check({ file, content })
      flags[file] = cringe.flags
      while (cringe.flags >= this.deps.cringeChecker.threshold) {
        if (attempts[file] >= this.regenCap) {
          throw new PersonaError(
            'cringe_cap_exceeded',
            `${file}.md hit cringe-check cap (${this.regenCap}); manual review required`,
          )
        }
        attempts[file] += 1
        try {
          content = await this.regenerate({
            file,
            prior_content: content,
            reasons: cringe.reasons,
            input: { ...input, archetype_blend, signals: signals_with_hint },
          })
        } catch (err) {
          throw new PersonaError(
            'compose_failed',
            `regenerate failed for ${file} on attempt ${attempts[file]}`,
            err,
          )
        }
        cringe = await this.deps.cringeChecker.check({ file, content })
        flags[file] = cringe.flags
      }
      drafts[file] = content
    }

    return {
      owner_slug: input.owner_slug,
      draft_id,
      soul_md: drafts.soul,
      user_md: drafts.user,
      priority_map_md: drafts.priority_map,
      cringe_check_flags: { soul: flags.soul, user: flags.user, priority_map: flags.priority_map },
      regen_attempts: { soul: attempts.soul, user: attempts.user, priority_map: attempts.priority_map },
      status: 'draft',
    }
  }

  /**
   * Apply a line-edit to a single file in the draft. Re-runs cringe-check
   * on the edited file. Throws PersonaError{edit_invalid} when the line
   * number is out of range (1-indexed).
   */
  async applyEdit(input: ApplyEditInput): Promise<PersonaDraft> {
    const original = pickFile(input.draft, input.file)
    const lines = original.split('\n')
    if (input.edit.line < 1 || input.edit.line > lines.length) {
      throw new PersonaError(
        'edit_invalid',
        `line ${input.edit.line} out of range; file has ${lines.length} lines`,
      )
    }
    if (input.edit.replacement.length === 0) {
      lines.splice(input.edit.line - 1, 1)
    } else {
      lines[input.edit.line - 1] = input.edit.replacement
    }
    const next_content = lines.join('\n')
    const cringe = await this.deps.cringeChecker.check({ file: input.file, content: next_content })
    const next: PersonaDraft = {
      ...input.draft,
      cringe_check_flags: { ...input.draft.cringe_check_flags, [input.file]: cringe.flags },
    }
    setFile(next, input.file, next_content)
    return next
  }

  /**
   * Commit the draft to <owner_home>/persona/SOUL.md, USER.md,
   * priority-map.md. Calls the optional gitCommit hook to record the
   * change in the per-instance Git repo (P7 backup hooks).
   */
  async commit(draft: PersonaDraft): Promise<{ committed_at: number; git_sha: string | null; paths: string[] }> {
    if (draft.status === 'manual_review') {
      throw new PersonaError(
        'commit_failed',
        `draft ${draft.draft_id} marked manual_review; cannot commit until reviewed`,
      )
    }
    const home = this.deps.ownerHomeFor !== undefined
      ? this.deps.ownerHomeFor(draft.owner_slug)
      : join(process.cwd(), 'data', draft.owner_slug, 'persona')
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
    const paths = [
      join(home, 'SOUL.md'),
      join(home, 'USER.md'),
      join(home, 'priority-map.md'),
    ]
    const writer = this.deps.fsWriter ?? defaultWriter()
    try {
      await writer.write(paths[0]!, draft.soul_md)
      await writer.write(paths[1]!, draft.user_md)
      await writer.write(paths[2]!, draft.priority_map_md)
    } catch (err) {
      throw new PersonaError('commit_failed', `failed to write persona files`, err)
    }
    let sha: string | null = null
    if (this.deps.gitCommit !== undefined) {
      try {
        const r = await this.deps.gitCommit(paths, `persona: commit draft ${draft.draft_id}`)
        sha = r.sha
      } catch (err) {
        throw new PersonaError('commit_failed', `git commit failed`, err)
      }
    }
    return { committed_at: this.now(), git_sha: sha, paths }
  }

  private async regenerate(input: {
    file: PersonaFile
    prior_content: string
    reasons: ReadonlyArray<string>
    input: ComposeInput & { archetype_blend: BlendedArchetype }
  }): Promise<string> {
    if (this.deps.regenerator !== undefined) {
      return await this.deps.regenerator.regenerate({
        file: input.file,
        prior_content: input.prior_content,
        reasons: input.reasons,
        archetype_blend: input.input.archetype_blend,
        signals: input.input.signals,
        user_facts: input.input.user_facts,
        priority_map: input.input.priority_map,
      })
    }
    // Fallback: programmatic strip pass — removes em-dashes and a small
    // set of obvious AI tells. Used when no regenerator is wired (e.g.
    // unit tests of the cap behavior). NOT a full regen.
    return programmaticDeCringe(input.prior_content)
  }

  /**
   * P2 v2 § 0 #9 + § 7.1 — derive the BlendedArchetype consumed by
   * `generateSoulMd`. Precedence:
   *   1. `input.archetype_blend` if pre-computed (back-compat: a caller
   *      that already resolved the blend, including pre-stashed v1
   *      `phase_state.archetype_blend` migrated by 0025).
   *   2. Otherwise call `composeFromFreeText(agent_personality)` with
   *      the optional curated library on `deps.archetypes`. Curated
   *      mentions land curated voice fragments; pure prose lands a
   *      free-text blend with the phrase preserved in `voice_md`.
   *   3. When `agent_personality` is absent / blank, return the
   *      free-text "balanced" blend (matches spec § 3.9 "User says
   *      'I don't know — you decide' → driver extracts agent_personality
   *      = 'balanced'").
   */
  private deriveArchetypeBlend(input: ComposeInput): BlendedArchetype {
    if (input.archetype_blend !== undefined) return input.archetype_blend
    const personality = input.signals.agent_personality
    if (typeof personality === 'string' && personality.trim().length > 0) {
      return composeFromFreeText(
        personality,
        this.deps.archetypes !== undefined ? { library: this.deps.archetypes } : {},
      )
    }
    // No personality captured (resumed from a pre-v2 row or test
    // fixture without one) — fall back to the "balanced" free-text
    // blend so `generateSoulMd` still has voice/comm/decision fragments
    // to render.
    return composeFromFreeText('balanced')
  }
}

function programmaticDeCringe(text: string): string {
  return text
    .replace(/—/g, ', ')
    .replace(/–/g, ', ')
    .replace(/\bsynergistic\b/gi, 'aligned')
    .replace(/\bsynergy\b/gi, 'alignment')
    .replace(/\bunlock\s+value\b/gi, 'create value')
    .replace(/\bgame[-\s]?changer\b/gi, 'shift')
    .replace(/\bcutting[-\s]?edge\b/gi, 'current')
    .replace(/\bworld[-\s]?class\b/gi, 'high-quality')
    .replace(/\brevolutionary\b/gi, 'new')
    .replace(/\bseamlessly\b/gi, 'smoothly')
    .replace(/\bdelve\s+into\b/gi, 'go into')
}

function pickFile(draft: PersonaDraft, file: PersonaFile): string {
  switch (file) {
    case 'soul':
      return draft.soul_md
    case 'user':
      return draft.user_md
    case 'priority_map':
      return draft.priority_map_md
  }
}

function setFile(draft: PersonaDraft, file: PersonaFile, content: string): void {
  if (file === 'soul') draft.soul_md = content
  else if (file === 'user') draft.user_md = content
  else draft.priority_map_md = content
}

function defaultWriter(): { write(path: string, content: string): Promise<void> } {
  return {
    async write(path: string, content: string): Promise<void> {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(path, content, 'utf8')
    },
  }
}
