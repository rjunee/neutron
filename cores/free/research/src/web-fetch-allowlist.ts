/**
 * @neutronai/research-core — default web-fetch allow-list.
 *
 * Per docs/plans/research-core-tier1-brief.md § 5.
 *
 * Public sources commonly cited in research briefs. Each entry is a
 * domain suffix pattern; a fetched URL's hostname matches when it
 * either equals the pattern, OR is a sub-domain of the pattern.
 *
 * The allow-list is configurable per-instance; v1 ships these defaults
 * + a documented override path (the manifest's `linked_sources[]`
 * config block — overrides land in a follow-up SDK addition).
 */

export const DEFAULT_WEB_FETCH_ALLOWLIST: readonly string[] = [
  // Core encyclopedia + reference
  'wikipedia.org',
  // Government + academic
  'gov',
  'edu',
  // Tech / engineering primary sources
  'github.com',
  'gitlab.com',
  'arxiv.org',
  'aclanthology.org',
  'rfc-editor.org',
  'ietf.org',
  'w3.org',
  'mozilla.org',
  'whatwg.org',
  // Cloud + vendor docs
  'cloud.google.com',
  'aws.amazon.com',
  'docs.aws.amazon.com',
  'azure.microsoft.com',
  'learn.microsoft.com',
  'developer.apple.com',
  'developer.mozilla.org',
  // Stackoverflow + community
  'stackoverflow.com',
  'news.ycombinator.com',
  'lwn.net',
  // News (major outlets — heuristic only; reader cross-references)
  'nytimes.com',
  'washingtonpost.com',
  'reuters.com',
  'apnews.com',
  'bbc.co.uk',
  'bbc.com',
  // Open-source ecosystem
  'npmjs.com',
  'pypi.org',
  'crates.io',
  'rubygems.org',
  // Standards bodies
  'iso.org',
  'nist.gov',
]

/**
 * Block-list of domains that look like RFC-1918 / loopback / link-local
 * via DNS-rebinding tricks (e.g. `10.0.0.1.xip.io`, `localhost.<attacker>`).
 * Hostnames matching these patterns are rejected even if they would
 * otherwise match an allow-list entry.
 */
export const HOSTNAME_BLOCKLIST: readonly RegExp[] = [
  /^localhost$/i,
  /^localhost\./i,
  /\.localhost$/i,
  /^0\.0\.0\.0$/,
  /\.xip\.io$/i,
  /\.nip\.io$/i,
  /\.sslip\.io$/i,
]

/** Default body size cap (5 MB). */
export const DEFAULT_FETCH_MAX_BYTES = 5 * 1024 * 1024
/** Default request timeout (30 s). */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000
