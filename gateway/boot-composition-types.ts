/**
 * gateway/boot-composition-types.ts — the composition-seam types shared
 * between the Open boot shell (`gateway/index.ts`) and any external
 * composer (the Managed production composer dynamic-imported via the
 * `NEUTRON_GRAPH_COMPOSER_MODULE` env seam).
 *
 * Split out of the former monolithic `gateway/boot-helpers.ts` (C2
 * refactor). These are pure type contracts — no runtime code — so they
 * carry zero import cost and keep the boot shell / composer agreeing on
 * the exact shapes. This module MUST NEVER import `gateway/index.ts`.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
// Connect API types come from `runtime/connect-handlers.ts` as
// structural aliases; the Managed concrete types in `connect/api/`
// structurally satisfy them. Keeps this helper module off the
// Managed-tier import edge.
import type {
  ConnectAuthContext,
  ProjectRef,
} from '@neutronai/runtime/connect-handlers.ts'
import type { CompositionInput } from './composition.ts'

/**
 * Optional per-boot composition hook — production callers pass a function
 * that returns the modules + supplied dependencies (notifier shims, topic
 * handler, etc.). When omitted, boot only opens the DB + sends READY=1 +
 * starts the watchdog tick — same shape as Sprint 4 — so the boot shell
 * stays minimal in dev.
 *
 * The hook receives the live `ProjectDb` + the resolved `project_slug` and
 * returns a `CompositionInput` that has its dispatcher / notifier shims
 * wired. The shape lets the test harness (and S5+ production) compose a
 * graph without changing the boot shell.
 */
export type GraphComposer = (input: { db: ProjectDb; project_slug: string }) =>
  | CompositionInput
  | Promise<CompositionInput>

/**
 * The HTTP handler signature shared by the default healthz stub and the
 * production composition's wired surfaces (connect API, identity
 * callback, channels webhook).
 */
export type HttpHandler = (req: Request) => Response | Promise<Response>

/**
 * Per-instance `list_projects` resolver: returns the real ProjectRef[]
 * surfaced via `GET /connect/v1/projects`. The default scans the
 * local `topics` table for distinct non-null `project_id`s — the only
 * place per-instance project metadata exists in P1 (the dedicated projects
 * table lands in P3 alongside Cores). Each row maps to a ProjectRef
 * owned by THIS instance. Open is single-owner, so the resolver is
 * always `kind:'solo'`; the Managed composer wraps this for its
 * workspace-instances (where the surface advertises `kind:'group'`).
 *
 * Tests inject a fake to assert the wired path is reached without
 * standing up a real per-instance DB with seed topics.
 */
export type ListProjectsResolver = (
  ctx: ConnectAuthContext,
  deps: { db: ProjectDb; project_slug: string },
) => Promise<ProjectRef[]>
