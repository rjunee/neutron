export interface GateFinding {
  severity?: unknown
  title?: unknown
  evidence?: unknown
  file?: unknown
  symbol?: unknown
  rule?: unknown
  line?: unknown
  kind?: unknown
  advisory?: unknown
}

const NON_BLOCKING_SEVERITIES = new Set(['minor', 'nit'])
const ADVISORY_FINDING_KEY = 'advisory'
const LANE_FINDING_KIND = 'lane'

function isNonBlockingFinding(f: any) {
  if (!f || typeof f !== 'object') return false
  // OWN PROPERTY ONLY, so this predicate and `stripAdvisoryMarkers` ask the SAME
  // question. The strip tests `Object.hasOwn`; this used to test the VALUE through the
  // prototype chain, so a finding whose prototype carried `advisory: true` read as
  // non-blocking here and had nothing for the strip to remove. No path in this file
  // produces such an object today (every finding that reaches these gates is a
  // `JSON.parse` product, and `JSON.parse` cannot set a prototype), so this closes a
  // shape, not a live hole — but the two readers of one marker disagreeing about what
  // "has the marker" means is exactly the drift the shared predicate exists to prevent.
  if (Object.hasOwn(f, ADVISORY_FINDING_KEY) && f[ADVISORY_FINDING_KEY] === true) return true
  return NON_BLOCKING_SEVERITIES.has(f.severity)
}

function isCodeWorkFinding(f: any) {
  if (f && f.kind === LANE_FINDING_KIND) return false
  if (isNonBlockingFinding(f)) return false
  return true
}

export function eligibleFixFindings(findings: unknown) {
  if (!Array.isArray(findings)) return null
  return findings.filter(isCodeWorkFinding)
}

export function redactProbeText(text: unknown) {
  return String(text)
    .replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
}
