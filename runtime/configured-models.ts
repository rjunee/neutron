/** Shared configuration for review seats and project chat. Credentials are environment references. */
export const BUILTIN_MODEL_TIERS = ['none', 'fable', 'opus', 'sonnet', 'fast', 'sol', 'terra', 'luna', 'k3'] as const
export interface ConfiguredModel {
  tier: string
  provider: string
  model: string
  endpoint: string
  credential: string
}
export function configuredModels(env: Readonly<Record<string, string | undefined>>): ConfiguredModel[] {
  const raw = env['NEUTRON_REVIEW_SEATS']
  if (raw === undefined) return []
  let rows: unknown
  try { rows = JSON.parse(raw) } catch { throw new Error('review seats: invalid NEUTRON_REVIEW_SEATS JSON') }
  if (!Array.isArray(rows)) throw new Error('review seats: expected an array')
  const seen = new Set<string>(BUILTIN_MODEL_TIERS)
  return rows.map((row: unknown, index) => {
    const seat = row as Record<string, unknown> | null
    const name = typeof seat?.['model'] === 'string' ? seat['model'] : `row ${index}`
    const refuse = (): never => { throw new Error(`review seat ${name}: invalid or duplicate configuration`) }
    if (!seat || typeof seat !== 'object' || Array.isArray(seat)) return refuse()
    for (const field of ['tier', 'provider', 'model', 'endpoint', 'credential']) {
      if (typeof seat[field] !== 'string' || !seat[field].trim() || /[\x00-\x1f\x7f]/.test(seat[field])) return refuse()
    }
    const { tier, provider, model, endpoint, credential } = seat as {
      tier: string; provider: string; model: string; endpoint: string; credential: string
    }
    if (seen.has(tier) || !/^[A-Z_][A-Z0-9_]*$/.test(credential)) return refuse()
    try {
      const url = new URL(endpoint)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return refuse()
    } catch { return refuse() }
    seen.add(tier)
    return { tier, provider, model, endpoint, credential }
  })
}

/** Explicit project routes override the inherited harness choice. Unknown tiers
 * remain selected so dispatch refuses them by name instead of choosing Claude.
 */
export function projectModelTier(env: Readonly<Record<string, string | undefined>>, projectId?: string): string | undefined {
  const raw = env['NEUTRON_PROJECT_MODELS']
  if (raw === undefined) return undefined
  let routes: unknown
  try { routes = JSON.parse(raw) } catch { throw new Error('invalid NEUTRON_PROJECT_MODELS JSON') }
  if (!routes || typeof routes !== 'object' || Array.isArray(routes) ||
      Object.values(routes).some((tier) => typeof tier !== 'string' || !tier.trim())) {
    throw new Error('invalid NEUTRON_PROJECT_MODELS configuration')
  }
  return projectId !== undefined && Object.hasOwn(routes, projectId)
    ? (routes as Record<string, string>)[projectId] : undefined
}
