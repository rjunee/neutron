/**
 * @neutronai/gateway — composable module-graph loader.
 *
 * Each module exports
 * `{ name, deps?, init(ctx), shutdown? }`; the loader does a topological
 * sort over `deps`, instantiates in order at boot, calls `shutdown` in
 * reverse order at graceful drain.
 *
 * Strict invariants:
 *
 *   - Every module declares a unique `name`. Duplicate registration is a
 *     boot error (loud over silent shadowing).
 *   - Every dependency in `deps` MUST be registered before `compose()`.
 *     Missing dep → loud error.
 *   - Cycles → loud error with the cycle reported.
 *
 * The loader is intentionally minimal — feature-flagging, lifecycle
 * priority, retry-on-init, etc. are NOT included. P1 S4 boot is ~15
 * modules; the simple shape is enough.
 */

export interface ModuleContext {
  /** The composed module-graph itself, exposed so a module can look up siblings. */
  graph: ModuleGraph
  /** Per-instance config bag. Instance-scoped, populated by the boot shell. */
  config: Readonly<Record<string, unknown>>
}

export interface GatewayModule<T = unknown> {
  name: string
  deps?: ReadonlyArray<string>
  init: (ctx: ModuleContext) => T | Promise<T>
  shutdown?: (instance: T) => void | Promise<void>
}

export interface ModuleGraph {
  /** Look up a module's instance by name. Throws if not yet initialised. */
  get<T>(name: string): T
  /** Snapshot of every initialised module name. */
  names(): string[]
}

interface CompiledModule {
  name: string
  deps: string[]
  init: GatewayModule['init']
  shutdown?: GatewayModule['shutdown']
  instance: unknown
  /**
   * Argus r1 MINOR (M1) fix: separate readiness sentinel. Previously
   * the compose loop wrote `init()`'s return into `instance`; the get()
   * gate was `instance === undefined → not yet initialised`. That
   * conflated "init has not run" with "init returned undefined" — a
   * legitimate side-effect-only module that returned undefined would
   * forever look unready. Track readiness as its own boolean so the
   * sentinel is unambiguous.
   */
  initialised: boolean
}

export class GatewayModuleGraph implements ModuleGraph {
  private readonly modules = new Map<string, CompiledModule>()
  private order: string[] = []
  private composed = false
  private readonly config: Readonly<Record<string, unknown>>

  constructor(config: Record<string, unknown> = {}) {
    this.config = Object.freeze({ ...config })
  }

  register<T>(module: GatewayModule<T>): void {
    if (this.composed) {
      throw new Error('module-graph: cannot register after compose() has run')
    }
    if (this.modules.has(module.name)) {
      throw new Error(`module-graph: '${module.name}' already registered`)
    }
    const compiled: CompiledModule = {
      name: module.name,
      deps: [...(module.deps ?? [])],
      init: module.init,
      instance: undefined,
      initialised: false,
    }
    if (module.shutdown !== undefined) {
      compiled.shutdown = module.shutdown as GatewayModule['shutdown']
    }
    this.modules.set(module.name, compiled)
  }

  /**
   * Sort + initialise every registered module in dependency order. After
   * `compose()` returns, `get(name)` is callable on every module.
   */
  async compose(): Promise<ModuleGraph> {
    if (this.composed) throw new Error('module-graph: compose() already called')
    this.order = topoSort(this.modules)
    const ctx: ModuleContext = { graph: this, config: this.config }
    for (const name of this.order) {
      const m = this.modules.get(name)
      if (!m) throw new Error(`module-graph: lookup miss for '${name}'`)
      m.instance = await m.init(ctx)
      // Flip the sentinel only AFTER init completes — a module that
      // calls `graph.get(self)` mid-init still sees the not-yet-ready
      // error rather than reading its own (possibly-undefined) handle.
      m.initialised = true
    }
    this.composed = true
    return this
  }

  /**
   * Tear down in reverse-init order. Each module's `shutdown` runs
   * independently; failures are logged + swallowed so a partial-shutdown
   * doesn't leave later modules un-stopped.
   */
  async shutdown(): Promise<void> {
    for (const name of [...this.order].reverse()) {
      const m = this.modules.get(name)
      if (!m || !m.shutdown) continue
      try {
        await m.shutdown(m.instance)
      } catch (err) {
        console.error(`module-graph: ${name}.shutdown failed:`, err)
      }
    }
  }

  get<T>(name: string): T {
    const m = this.modules.get(name)
    if (!m) throw new Error(`module-graph: unknown module '${name}'`)
    // The dedicated `initialised` boolean is the authoritative readiness
    // signal — see CompiledModule's M1 comment. We deliberately do NOT
    // gate on `this.composed` here so a downstream module's init can
    // read an already-initialized upstream dep mid-compose; if a module
    // asks for a name whose init hasn't run yet, `initialised` is still
    // false and we throw the clear error below.
    if (!m.initialised) {
      throw new Error(`module-graph: '${name}' not yet initialised`)
    }
    return m.instance as T
  }

  names(): string[] {
    return [...this.order]
  }
}

function topoSort(modules: Map<string, CompiledModule>): string[] {
  // Validate deps existence first (loud over silent miss).
  for (const m of modules.values()) {
    for (const dep of m.deps) {
      if (!modules.has(dep)) {
        throw new Error(`module-graph: '${m.name}' depends on unknown module '${dep}'`)
      }
    }
  }
  const order: string[] = []
  const seen = new Set<string>()
  const visiting = new Set<string>()
  const visit = (name: string, path: string[]): void => {
    if (seen.has(name)) return
    if (visiting.has(name)) {
      const cycle = [...path, name].join(' → ')
      throw new Error(`module-graph: dependency cycle detected: ${cycle}`)
    }
    visiting.add(name)
    const m = modules.get(name)
    if (!m) throw new Error(`module-graph: lookup miss for '${name}'`)
    for (const dep of m.deps) {
      visit(dep, [...path, name])
    }
    visiting.delete(name)
    seen.add(name)
    order.push(name)
  }
  // Visit in alphabetical name order so the resulting topo order is
  // deterministic across runs (same boot order on every restart).
  for (const name of [...modules.keys()].sort()) {
    visit(name, [])
  }
  return order
}
