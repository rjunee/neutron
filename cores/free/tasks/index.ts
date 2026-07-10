/**
 * @neutronai/tasks-core — public barrel.
 *
 * Tier 1 free Tasks Core. Wraps the canonical `tasks/` substrate
 * (`tasks/store.ts` via `buildSubstrateTaskStoreBackend`) and surfaces:
 *
 *   - **6 MCP tools** (`tasks_create` / `tasks_list` / `tasks_update` /
 *     `tasks_complete` / `tasks_delete` / `tasks_pick_next`).
 *   - **Chat-command surface** (`/task <body>` / `/task done <id>` /
 *     `/task list [project]` / `/task focus [project]`).
 *   - **LLM-driven pick-next** (`PickNextService`) — one most important
 *     task + owner-voice rationale + up to N runner-up alternatives.
 *   - **P5.3 launcher tile** (`launcher_icon` UI component) with
 *     `primary_action='open_app_tab'` + long-press menu (capture /
 *     browse / pick-next).
 *   - **App tab** (`app_tab` UI component) pointing at the existing
 *     P5.4 tasks tab at `/projects/<project_id>/tasks`.
 *
 * Bundled into the public OSS repo at `cores/free/tasks/` per the
 * locked 2-tier Cores model (see
 * `docs/research/neutron-cores-marketplace-split-2026-05-17.md`).
 *
 * Cross-refs:
 * - docs/plans/tasks-core-tier1-brief.md (S1 sprint brief)
 * - SPEC.md § Phases→Steps (Tier 1 Cores buildout; TODO(K10): root SPEC.md not yet in this repo)
 * - cores/sdk/SDK-CONTRACT.md (the API surface this Core consumes)
 * - cores/runtime (install / capability gate / audit log)
 * - tasks/store.ts (the canonical substrate this Core wraps)
 */

export const __MODULE__ = '@neutronai/tasks-core' as const

export {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  READ_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
  type TasksToolName,
} from './src/manifest.ts'

export {
  CORE_TASK_SOURCE_TAG,
  DEFAULT_PICK_NEXT_CANDIDATE_LIMIT,
  PICK_NEXT_CANDIDATE_LIMIT_CAP,
  TaskNotFoundError,
  buildInMemoryTaskStore,
  buildSubstrateTaskStoreBackend,
  type SubstrateTaskStoreBackendOptions,
  type TaskCreateInput,
  type TaskListInput,
  type TaskPickNextCandidatesInput,
  type TaskRow,
  type TaskStatus,
  type TaskStore,
  type TaskUpdateFields,
} from './src/backend.ts'

export {
  buildTools,
  type BuiltTools,
  type TasksCompleteInput,
  type TasksCompleteOutput,
  type TasksCreateInput,
  type TasksCreateOutput,
  type TasksDeleteInput,
  type TasksDeleteOutput,
  type TasksListInput,
  type TasksListOutput,
  type TasksUpdateInput,
  type TasksUpdateOutput,
  type ToolDeps,
} from './src/tools.ts'

export {
  PICK_NEXT_PROMPT_TEMPLATE,
  buildPickNextService,
  buildStubPickNextLlmClient,
  type PickNextDeps,
  type PickNextInput,
  type PickNextLlmClient,
  type PickNextResult,
  type PickNextService,
} from './src/pick-next.ts'

export {
  buildExtraTools,
  type BuiltExtraTools,
  type ExtraToolDeps,
  type TasksPickNextInput,
  type TasksPickNextOutput,
} from './src/mcp-tools-extra.ts'

export {
  TASK_COMMAND_PREFIX,
  executeTaskCommand,
  parseTaskCommand,
  type ExecuteTaskCommandContext,
  type TaskCommand,
  type TaskCommandButton,
  type TaskCommandErrorCode,
  type TaskCommandResponse,
} from './src/chat-commands.ts'

export { LAUNCHER_ICON, type LauncherIconMeta } from './src/ui/launcher-icon.ts'
export { APP_TAB_META, type AppTabMeta } from './src/ui/app-tab-surface.ts'

// ── X2: typed Core module contract ──────────────────────────────────────
// The ONE declaration the install composer (`gateway/cores/install-bundled.ts`)
// reads instead of duck-typing barrel exports + a hardcoded backend-key table.
// `backendKey` is the `ToolDeps` key a bare backend primitive maps onto; when
// the backend factory returns an already-shaped object it is passed through
// verbatim. Conformance: cores/runtime/__tests__/define-core-conformance.test.ts.
import { defineCore } from '@neutronai/cores-sdk'
import { CORE_SLUG as CORE_SLUG_X2, TOOL_NAMES as TOOL_NAMES_X2 } from './src/manifest.ts'
import { buildTools as buildTools_X2 } from './src/tools.ts'
import { buildExtraTools as buildExtraTools_X2 } from './src/mcp-tools-extra.ts'

export const core = defineCore({
  slug: CORE_SLUG_X2,
  backendKey: 'store',
  toolNames: TOOL_NAMES_X2,
  buildTools: buildTools_X2,
  buildExtraTools: buildExtraTools_X2,
})
