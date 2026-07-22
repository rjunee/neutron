/**
 * @neutronai/reminders — the ENGINE-shipped bundled read-only rituals (plan task 7).
 *
 * Spec of record: `docs/plans/executor-mode-reminders-2026-07-20.md` — plan task 7
 * + the deepened build order (lines 42-52: read-only rituals ship first, Layer 1
 * `--tools` default-deny alone contains them) + design §2a/B2. This module ships
 * three GENERIC read-only example rituals (`morning-brief`, `evening-wrap`,
 * `daily-delta`) as ENGINE seeds so a fresh Neutron install has working ritual
 * examples out of the box. `daily-delta` is the time-anchored survivor of Q2's
 * split-by-tier (overturn 2): backlink repair + correction-promotion moved into
 * CORE MEMORY, but a daily memory delta has no in-memory trigger, so it stays a
 * scheduled read-only ritual (design deepened header, "Ryan's Q2, split by tier").
 *
 * USER-DATA principle (CLAUDE.md — "Ryan's ritual CONTENT is user data via import,
 * never hardcoded"): what ships here is a GENERIC, instance-agnostic template that
 * reads only the `Projects/<slug>/STATUS.md` files on disk — NOT Ryan's Vajra ritual prompts (those
 * arrive via import as OWNER data). The bundled templates are the ENGINE default; the
 * owner's own ritual content is layered on top by import and NEVER overwritten.
 *
 * Copy-if-absent semantics: {@link seedBundledRituals} materializes each template
 * into `<owner_home>/rituals/<id>.md` ONLY when that file does not already exist.
 * From the first seed on, `<owner_home>/rituals/<id>.md` is OWNER DATA — an
 * owner-edited (or pre-existing / imported) file is NEVER clobbered. This is why the
 * approval check ({@link createRitualApprovalCheck}) re-verifies the LIVE prompt
 * bytes at every fire: an owner edit drops approval by design, so a seeded template
 * the owner later rewrites cannot fire under a stale approval.
 *
 * Approval is NEVER granted here. Registration ({@link registerBundledRituals})
 * makes the defs KNOWN to the registry; it does NOT approve them. The defs stay
 * UNAPPROVED until the owner's affirmative task-8 act — so a bundled ritual that is
 * seeded + registered at boot still lands a durable `code_ritual_runs`
 * 'skipped'/'unapproved' row if the tick tries to fire it (proven in the T7 tests).
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RitualDef, RitualRegistry } from './rituals.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Absolute path to the in-repo directory holding the bundled ritual TEMPLATES
 * (`<id>.md`). Module-dir resolved (the `reminders/prompt-path.ts` pattern), so it
 * points at the files inside the installed package regardless of cwd.
 */
export const BUNDLED_RITUAL_TEMPLATES_DIR: string = join(HERE, 'rituals')

/**
 * The three ENGINE-shipped read-only ritual defs. Surface is EXACTLY
 * `['Read','Glob','Grep']` (no Bash/Write — Layer 1 `--tools` default-deny contains
 * these; the `GATED_WRITE_TOOLS` fire-time gate never trips), egress 'none' (no web
 * tools), scope 'instance' (rooted at owner_home — morning-brief legitimately reads
 * across every project, and the read-only surface grants no write authority at the
 * wider root). `silent: false` — all post their digest.
 *
 * Frozen so a caller cannot mutate a def before/after registration.
 */
export const BUNDLED_RITUAL_DEFS: readonly RitualDef[] = Object.freeze([
  Object.freeze({
    id: 'morning-brief',
    description:
      "Reads every project's STATUS.md and docs in this instance and posts a short start-of-day brief of priorities and blockers. Read-only: no shell, no writes, no network.",
    scope: 'instance',
    tool_surface: Object.freeze(['Read', 'Glob', 'Grep']),
    egress: 'none',
    silent: false,
  }),
  Object.freeze({
    id: 'evening-wrap',
    description:
      "Reads every project's STATUS.md and docs and posts a short end-of-day wrap: state, in-flight work, tomorrow's first move. Read-only: no shell, no writes, no network.",
    scope: 'instance',
    tool_surface: Object.freeze(['Read', 'Glob', 'Grep']),
    egress: 'none',
    silent: false,
  }),
  Object.freeze({
    id: 'daily-delta',
    description:
      'Reads the memory layer (entities index, corrections log, diary) and posts a short daily delta of what changed in the last day. Read-only: no shell, no writes, no network.',
    scope: 'instance',
    tool_surface: Object.freeze(['Read', 'Glob', 'Grep']),
    egress: 'none',
    silent: false,
  }),
]) as readonly RitualDef[]

/** Absolute path to the in-repo TEMPLATE for a bundled ritual id. */
export function bundledTemplatePathFor(id: string): string {
  return join(BUNDLED_RITUAL_TEMPLATES_DIR, `${id}.md`)
}

/**
 * Materialize the bundled ritual templates into `opts.rituals_dir` COPY-IF-ABSENT.
 *
 * For each bundled def: if `<rituals_dir>/<id>.md` does NOT exist, copy the in-repo
 * template there and record the id under `seeded`; if it already exists (owner data
 * from a prior seed / owner edit / import), leave it untouched and record it under
 * `kept`. An existing file is NEVER overwritten.
 *
 * BOOT SAFETY: this runs at composition boot, so it NEVER throws. The `mkdir` and
 * each per-file copy are wrapped in try/catch → `opts.log?` + continue. A failed
 * seed surfaces LATER as a durable `missing_prompt` fire-time skip (the designed
 * fail-closed backstop in `validateRitualFire`), never as a boot crash.
 */
export function seedBundledRituals(opts: {
  rituals_dir: string
  log?: (msg: string) => void
}): { seeded: string[]; kept: string[] } {
  const { rituals_dir, log } = opts
  const seeded: string[] = []
  const kept: string[] = []

  try {
    mkdirSync(rituals_dir, { recursive: true })
  } catch (err) {
    log?.(`seedBundledRituals: mkdir ${rituals_dir} failed: ${(err as Error).message}`)
    // Nothing more to do — every copy below would fail too; return empty.
    return { seeded, kept }
  }

  for (const def of BUNDLED_RITUAL_DEFS) {
    const dest = join(rituals_dir, `${def.id}.md`)
    try {
      if (existsSync(dest)) {
        kept.push(def.id)
        continue
      }
      copyFileSync(bundledTemplatePathFor(def.id), dest)
      seeded.push(def.id)
    } catch (err) {
      log?.(`seedBundledRituals: copy ${def.id} → ${dest} failed: ${(err as Error).message}`)
      // continue — a failed copy surfaces as a durable missing_prompt skip at fire.
    }
  }

  return { seeded, kept }
}

/**
 * Register every bundled def into `registry`. This makes the defs KNOWN — it does
 * NOT approve them (approval lives in a separate record reached via the injected
 * `RitualApprovalCheck`, granted only by the owner's task-8 act). MAY throw on a
 * programming error (invalid/duplicate def), which the static defs above make
 * unreachable in practice — the T7 unit tests pin their shape.
 */
export function registerBundledRituals(registry: RitualRegistry): void {
  for (const def of BUNDLED_RITUAL_DEFS) {
    registry.register(def)
  }
}
