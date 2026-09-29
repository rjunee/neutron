/** Render only bounded coverage metadata, never an importer's raw error or paths. */
export function importStatusWarnings(value: unknown, now: number): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['Direct command importer status unavailable. Recent phase coverage is unverified.']
  }
  const status = value as Record<string, unknown>
  const warnings: string[] = []
  if (status.error || typeof status.lastSuccessAt !== 'number' || !Number.isFinite(status.lastSuccessAt) ||
      status.lastSuccessAt < 0 || status.lastSuccessAt > now || now - status.lastSuccessAt > 60_000) {
    warnings.push('Direct command importer is stale or failed. Historical spans remain visible; recent phase coverage may be incomplete.')
  }
  const coverage = status.coverage && typeof status.coverage === 'object' && !Array.isArray(status.coverage)
    ? status.coverage as Record<string, unknown> : {}
  const count = (key: string): number | null => typeof coverage[key] === 'number' &&
    Number.isSafeInteger(coverage[key]) && coverage[key] >= 0 ? coverage[key] : null
  const unbound = count('unbound'), incomplete = count('incomplete')
  if ((status.partial !== undefined && typeof status.partial !== 'boolean') ||
      (status.coverage !== undefined && (status.coverage === null || typeof status.coverage !== 'object' || Array.isArray(status.coverage))) ||
      ['unbound', 'incomplete'].some(key => coverage[key] !== undefined && count(key) === null) ||
      (coverage.scanPartial !== undefined && typeof coverage.scanPartial !== 'boolean')) {
    warnings.push('Direct command importer coverage metadata is invalid. Phase coverage is unverified.')
  }
  // Nonzero counts remain evidence of partial coverage even if a producer's
  // aggregate flag incorrectly says complete. A zero stays zero, never unknown.
  if (status.partial === true || (unbound !== null && unbound > 0) ||
      (incomplete !== null && incomplete > 0) || coverage.scanPartial === true) {
    warnings.push([
      'Direct phase coverage is partial.',
      unbound === null ? 'Unbound observation count unknown.' : `${unbound} observations have no verified PR/phase binding.`,
      incomplete === null ? 'Incomplete source count unknown.' : `${incomplete} registered sources are incomplete.`,
      ...(coverage.scanPartial === true ? ['Source discovery is incomplete.'] : []),
      'Unattributed history remains unknown; no PR ownership or usage is inferred.',
    ].join(' '))
  }
  return warnings
}
