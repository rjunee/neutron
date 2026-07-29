/**
 * @neutronai/onboarding — LLM archetype extension (P2 S2).
 *
 * Per § 2.2 ("LLM-generation fallback"): when the user types a non-
 * curated character name, the substrate generates an archetype fragment
 * with the same shape as the curated md files. Cached on disk so the
 * second user picking the same name reuses the fragment.
 *
 * This module contains the substrate-call wrapper. The actual disk cache
 * lives in `library.ts:ArchetypeLibrary.generateExtension` — that's where
 * `cacheDir/<slug>.json` is read/written. This module is pure: parses the
 * substrate response into `{voice_md, comm_md, decision_md}`.
 *
 * Substrate response contract: a markdown document containing three
 * sections marked `## Voice`, `## Communication`, `## Decision`. The
 * extension caller wraps a substrate that complies with the prompt
 * `prompts/onboarding/archetype-suggester.md`.
 */

import { ArchetypeError } from './library.ts'

export interface LlmExtensionInput {
  name: string
}

export interface LlmExtensionParts {
  voice_md: string
  comm_md: string
  decision_md: string
}

export type LlmExtensionFn = (input: LlmExtensionInput) => Promise<string>

/**
 * Wrap a raw substrate call into a parser that returns the 3 sections.
 * The substrate may surface markdown directly; we strip code fences and
 * frontmatter for resilience.
 */
export function buildLlmExtensionParser(fn: LlmExtensionFn): (name: string) => Promise<LlmExtensionParts> {
  return async (name: string): Promise<LlmExtensionParts> => {
    let raw: string
    try {
      raw = await fn({ name })
    } catch (err) {
      throw new ArchetypeError('extension_failed', `substrate call failed for ${name}`, err)
    }
    return parseExtensionMarkdown(raw, name)
  }
}

export function parseExtensionMarkdown(raw: string, name: string): LlmExtensionParts {
  const trimmed = raw.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n```\s*$/i, '')
  const noFm = trimmed.replace(/^---\n[\s\S]*?\n---\n/, '')
  const voice = extractSection(noFm, 'Voice')
  const comm = extractSection(noFm, 'Communication')
  const decision = extractSection(noFm, 'Decision')
  if (voice === null || comm === null || decision === null) {
    throw new ArchetypeError(
      'extension_failed',
      `LLM extension for ${name} missing required Voice / Communication / Decision section`,
    )
  }
  return { voice_md: voice, comm_md: comm, decision_md: decision }
}

/**
 * In-memory cache — useful for tests + when callers don't want disk I/O.
 * The disk cache for the library lives in library.ts; this is the
 * "second-call returns cached output without dispatching" assertion the
 * spec requires.
 */
export class InMemoryExtensionCache {
  private readonly map = new Map<string, LlmExtensionParts>()

  has(name: string): boolean {
    return this.map.has(name.toLowerCase())
  }

  get(name: string): LlmExtensionParts | null {
    return this.map.get(name.toLowerCase()) ?? null
  }

  put(name: string, parts: LlmExtensionParts): void {
    this.map.set(name.toLowerCase(), parts)
  }
}

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i')
  const m = body.match(re)
  if (m === null) return null
  return (m[1] ?? '').trim()
}
