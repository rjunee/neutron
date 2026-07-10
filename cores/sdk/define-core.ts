/**
 * @neutronai/cores-sdk — `defineCore()`, the ONE typed Core-module factory.
 *
 * Refactor X2 (typed Core module contract). Before this, the install
 * composer (`gateway/cores/install-bundled.ts`) discovered a Core's
 * runtime surface by DUCK-TYPING undeclared barrel exports — it probed
 * `mod.buildTools` / `mod.buildExtraTools` with `typeof … === 'function'`
 * and mapped the backend deps key from a hardcoded, drift-prone
 * `BACKEND_KEY_BY_SLUG` table (which by X2 had two dead rows — `notes`,
 * `dtc_analytics` — and was silently MISSING `scraping_core`, saved only
 * by an `?? 'backend'` fallback). Nothing tied a Core's actual exports to
 * its manifest, so a manifest tool with no matching handler degraded into
 * a silent throw-stub (ISSUE #330).
 *
 * `defineCore()` is the typed seam that closes that gap. A Core's barrel
 * declares — in ONE place, checked by the compiler and the conformance
 * sweep — its slug, the deps key its backend maps onto, the exact set of
 * tool names its manifest promises, and its `buildTools` (+ optional
 * `buildExtraTools`) factories. The install composer consumes the typed
 * `CoreModule` instead of guessing, and the conformance test
 * (`cores/runtime/__tests__/define-core-conformance.test.ts`) proves every
 * bundled Core's exported contract matches its on-disk manifest and that
 * none under-implements it.
 *
 * Band note: `cores/sdk` is a contracts-band LEAF (see
 * `.dependency-cruiser.cjs` `L.contracts`). It must not import the
 * platform-band `@neutronai/tools`, so `ToolCallContext` below is a
 * STRUCTURAL mirror of `tools/registry.ts`'s `ToolCallContext` — the
 * gateway passes the registry's context in verbatim (the shapes are
 * field-for-field identical; a compile-time mutual-assignability guard in
 * `gateway/__tests__/cores-under-implementation-hardfail.test.ts` — the only
 * band that may import both — fails tsc if either side drifts).
 */

/**
 * Per-call context the ToolRegistry hands a Core tool handler at dispatch
 * time. STRUCTURAL mirror of `@neutronai/tools` `ToolCallContext` — cores
 * type their handlers against this without reaching up into the platform
 * band. Threaded into every Core handler by the install composer's
 * `wrapHandler` (X2 plumbing; consumed by X6). Handlers that ignore it
 * (today's 1-arg shape) stay assignable.
 */
export interface ToolCallContext {
  /** Owner/instance boundary — constant on a single-owner Open box. */
  project_slug: string
  /** The ACTIVE project of the composing turn, or NULL for the General
   *  surface / cron-spawned / system calls. */
  project_id: string | null
  /** Topic the call originated from. NULL for cron-spawned / system. */
  topic_id: string | null
  call_id: string
  /** Speaker user_id for group-project turns. NULL for solo / system. */
  speaker_user_id: string | null
}

/**
 * A Core tool handler as the runtime sees it. `args` is the (schema-
 * validated upstream) tool input; `ctx` is the per-call
 * {@link ToolCallContext} threaded from the registry. The rest-arg shape
 * keeps every Core's precisely-typed handler (`(input: FooInput) =>
 * Promise<FooOutput>`) assignable to this erased contract while ALSO
 * letting a handler opt in to the second `ctx` argument (X6). The
 * conformance sweep enforces the actual `name → handler` coverage against
 * the manifest.
 */
export type CoreToolHandler = (...args: any[]) => Promise<unknown>

/** The erased factory the install composer invokes: deps in, `name →
 *  handler` map out. Each Core's `defineCore()` call preserves the precise
 *  deps + tool-map types at the authoring site; the stored `CoreModule`
 *  erases to this so a single consumer can drive all Cores uniformly. */
export type CoreToolFactory = (
  deps: Record<string, unknown>,
) => Record<string, CoreToolHandler>

/**
 * The typed contract a Core barrel exports as `export const core =
 * defineCore({ … })`. The install composer reads THIS instead of
 * duck-typing undeclared exports.
 */
export interface CoreModule {
  /** Brand — lets the composer + `isCoreModule()` recognise a genuine
   *  `defineCore()` result across the dynamic-import boundary. */
  readonly __neutronCore: true
  /** Package-derived slug (e.g. `tasks_core`). MUST equal
   *  `packageNameToSlug(package.json#name)` — asserted by conformance. */
  readonly slug: string
  /**
   * The `ToolDeps` key the composer maps a bare backend primitive onto
   * when a Core's backend factory returns an unshaped value (replaces the
   * old `BACKEND_KEY_BY_SLUG` table). A factory that already returns a
   * shaped deps object (`{ store, pickNext }`, `{ client, summarizer }`)
   * is passed through verbatim; this key is the single-primitive fallback.
   */
  readonly backendKey: string
  /** Every tool name the Core's manifest declares. Cross-checked
   *  set-equal against the on-disk manifest by the conformance sweep, so a
   *  manifest tool the Core forgot to implement (or vice-versa) fails the
   *  build rather than degrading to a silent throw-stub at install. */
  readonly toolNames: readonly string[]
  /** Base tool factory. */
  readonly buildTools: CoreToolFactory
  /** Optional second factory returning ADDITIONAL handlers (the
   *  research/reminders/tasks/calendar split-surface pattern). Merged over
   *  `buildTools` output; name collisions keep the `buildTools` handler. */
  readonly buildExtraTools?: CoreToolFactory
}

/** Authoring-site input to {@link defineCore}. Generic over the Core's own
 *  base-factory deps `Deps`, extra-factory deps `DepsExtra`, base tool map
 *  `T`, and extra tool map `E` so the compiler checks each factory against
 *  the Core's real types WITHOUT forcing the named `BuiltTools` interfaces
 *  through a lossy `Record` reshape. `buildTools` and `buildExtraTools` may
 *  declare DIFFERENT deps interfaces (e.g. Tasks' `ExtraToolDeps` requires a
 *  `pickNext` that `ToolDeps` leaves optional); the install composer hands
 *  the same runtime deps bundle to both, and the conformance sweep proves
 *  every manifest tool ends up with a handler. */
export interface DefineCoreInput<
  Deps,
  DepsExtra,
  T extends object,
  E extends object,
> {
  slug: string
  backendKey: string
  toolNames: readonly string[]
  buildTools: (deps: Deps) => T
  buildExtraTools?: (deps: DepsExtra) => E
}

/**
 * Declare a Core's typed module contract. Returns the erased
 * {@link CoreModule} the install composer consumes. Validates the
 * invariants a bundled Core must satisfy at construction (non-empty slug,
 * backend key, and tool-name list) so a malformed contract fails loudly at
 * module load rather than silently at dispatch.
 */
export function defineCore<
  Deps,
  T extends object,
  DepsExtra = Deps,
  E extends object = Record<string, never>,
>(input: DefineCoreInput<Deps, DepsExtra, T, E>): CoreModule {
  if (typeof input.slug !== 'string' || input.slug.length === 0) {
    throw new Error('defineCore: `slug` must be a non-empty string')
  }
  if (typeof input.backendKey !== 'string' || input.backendKey.length === 0) {
    throw new Error(
      `defineCore(${input.slug}): \`backendKey\` must be a non-empty string`,
    )
  }
  if (!Array.isArray(input.toolNames) || input.toolNames.length === 0) {
    throw new Error(
      `defineCore(${input.slug}): \`toolNames\` must be a non-empty array`,
    )
  }
  if (typeof input.buildTools !== 'function') {
    throw new Error(
      `defineCore(${input.slug}): \`buildTools\` must be a function`,
    )
  }
  const mod: CoreModule = {
    __neutronCore: true,
    slug: input.slug,
    backendKey: input.backendKey,
    toolNames: [...input.toolNames],
    buildTools: input.buildTools as unknown as CoreToolFactory,
    ...(input.buildExtraTools !== undefined
      ? {
          buildExtraTools:
            input.buildExtraTools as unknown as CoreToolFactory,
        }
      : {}),
  }
  return mod
}

/**
 * Runtime type-guard: is `value` a genuine {@link CoreModule} produced by
 * {@link defineCore}? Used by the install composer to recognise a Core's
 * typed contract across the dynamic-import boundary and reject a barrel
 * that never adopted `defineCore()`.
 */
export function isCoreModule(value: unknown): value is CoreModule {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<CoreModule>
  return (
    v.__neutronCore === true &&
    typeof v.slug === 'string' &&
    v.slug.length > 0 &&
    typeof v.backendKey === 'string' &&
    v.backendKey.length > 0 &&
    Array.isArray(v.toolNames) &&
    typeof v.buildTools === 'function' &&
    (v.buildExtraTools === undefined || typeof v.buildExtraTools === 'function')
  )
}
