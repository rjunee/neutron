/**
 * L2 (2026-07) — seam guard for the `contracts/` leaf extraction.
 *
 * Every symbol below was moved VERBATIM out of a higher-band package into a
 * node-free `contracts/` leaf (or, for `OutboundSink`, `trident/outbound-sink.ts`
 * — see that file's header for why it isn't in `contracts/`), with the old
 * site kept as an `export … from` shim (test-policy §2.2 barrel rule). This
 * is a type-level seam with mostly no runtime values to assert against
 * directly (`tsc` compiling the repo already proves every barrel resolves —
 * see `scripts/ci/typecheck-all.sh`), so the guard here is textual:
 *
 *   1. Each leaf file still defines the symbols it's supposed to own.
 *   2. Each old site still re-exports (not re-declares) those symbols.
 *   3. The specific consumers that were FLIPPED to cut a critic-layering.md
 *      §2.1 DAG edge (#1, #7, #9, #10, #11) import from the new leaf, not
 *      the old cross-package path — a regression here silently re-opens the
 *      edge the whole unit exists to cut.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

function read(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf8')
}

describe('contracts/ leaf: symbols defined + old sites shim through', () => {
  test('onboarding-phase.ts owns OnboardingPhase + ALL_PHASES; phase.ts re-exports', () => {
    const leaf = read('contracts/onboarding-phase.ts')
    const oldSite = read('onboarding/interview/phase.ts')
    expect(leaf).toContain('export type OnboardingPhase =')
    expect(leaf).toContain('export const ALL_PHASES')
    expect(oldSite).not.toContain('export type OnboardingPhase =')
    expect(oldSite).not.toContain('export const ALL_PHASES')
    expect(oldSite).toContain("from '@neutronai/contracts/onboarding-phase.ts'")
  })

  test('agent-engagement.ts owns the mode vocabulary; connect/agent-engagement.ts re-exports', () => {
    const leaf = read('contracts/agent-engagement.ts')
    const oldSite = read('connect/agent-engagement.ts')
    expect(leaf).toContain('export type AgentEngagementMode =')
    expect(leaf).toContain('export const ALL_AGENT_ENGAGEMENT_MODES')
    expect(leaf).toContain('export const DEFAULT_AGENT_ENGAGEMENT_MODE')
    expect(leaf).toContain('export function isAgentEngagementMode')
    expect(oldSite).not.toContain('export type AgentEngagementMode =')
    expect(oldSite).not.toContain('export const DEFAULT_AGENT_ENGAGEMENT_MODE')
    expect(oldSite).toContain("from '@neutronai/contracts/agent-engagement.ts'")
  })

  test('llm-call.ts owns LlmCallFn; phase-spec-resolver.ts re-exports', () => {
    const leaf = read('contracts/llm-call.ts')
    const oldSite = read('onboarding/interview/phase-spec-resolver.ts')
    expect(leaf).toContain('export type LlmCallFn =')
    expect(oldSite).not.toContain('export type LlmCallFn =')
    expect(oldSite).toContain("from '@neutronai/contracts/llm-call.ts'")
  })

  test('handoff-config.ts owns MOBILE_APP_URL + TELEGRAM_BIND_TOKEN_TTL_MS; final-handoff-config.ts re-exports', () => {
    const leaf = read('contracts/handoff-config.ts')
    const oldSite = read('onboarding/interview/final-handoff-config.ts')
    expect(leaf).toContain('export const MOBILE_APP_URL')
    expect(leaf).toContain('export const TELEGRAM_BIND_TOKEN_TTL_MS')
    expect(oldSite).not.toContain("WEB_APP_BASE = (process.env")
    expect(oldSite).not.toContain('export const TELEGRAM_BIND_TOKEN_TTL_MS =')
    expect(oldSite).toContain("from '@neutronai/contracts/handoff-config.ts'")
  })

  test('mcp-tool-resolver.ts owns McpToolResolver; mcp-shim.ts re-exports', () => {
    const leaf = read('contracts/mcp-tool-resolver.ts')
    const oldSite = read('runtime/adapters/openai-responses/mcp-shim.ts')
    expect(leaf).toContain('export interface McpToolResolver')
    expect(oldSite).not.toContain('export interface McpToolResolver')
    expect(oldSite).toContain("from '@neutronai/contracts/mcp-tool-resolver.ts'")
  })

  test('chat-command-filter.ts owns ChatCommandFilter[Result]; app-ws-surface.ts re-exports', () => {
    const leaf = read('contracts/chat-command-filter.ts')
    const oldSite = read('gateway/http/app-ws-surface.ts')
    expect(leaf).toContain('export interface ChatCommandFilter {')
    expect(leaf).toContain('export interface ChatCommandFilterResult {')
    expect(oldSite).not.toContain('export interface ChatCommandFilter {')
    expect(oldSite).not.toContain('export interface ChatCommandFilterResult {')
    expect(oldSite).toContain("from '@neutronai/contracts/chat-command-filter.ts'")
  })

  test('trident/outbound-sink.ts is the ONE OutboundSink declaration; both old sites shim to it', () => {
    const leaf = read('trident/outbound-sink.ts')
    const tridentOld = read('trident/delivery.ts')
    const gatewayOld = read('gateway/proactive/sink.ts')
    expect(leaf).toContain('export interface OutboundSink {')
    // Neither old site re-declares the interface anymore.
    expect(tridentOld).not.toContain('export interface OutboundSink {')
    expect(gatewayOld).not.toContain('export interface OutboundSink {')
    expect(tridentOld).toContain("from './outbound-sink.ts'")
    expect(gatewayOld).toContain("from '@neutronai/trident/outbound-sink.ts'")
  })
})

describe('critic-layering.md §2.1 DAG cuts #1, #7, #9, #10, #11: consumers flipped off the old cross-band path', () => {
  test('edge #1 (runtime → onboarding, OnboardingPhase): platform-adapter[.ts|-local.ts] import from contracts/', () => {
    for (const f of ['runtime/platform-adapter.ts', 'runtime/platform-adapter-local.ts']) {
      const src = read(f)
      expect(src).toContain("import type { OnboardingPhase } from '@neutronai/contracts/onboarding-phase.ts'")
      expect(src).not.toContain("from '../onboarding/interview/phase.ts'")
    }
  })

  test('edge #7 (landing → onboarding, MOBILE_APP_URL): landing/server.ts imports from contracts/', () => {
    const src = read('landing/server.ts')
    expect(src).toContain("export { MOBILE_APP_URL } from '@neutronai/contracts/handoff-config.ts'")
    expect(src).not.toContain("from '../onboarding/interview/final-handoff-config.ts'")
  })

  test('edge #9 (cores/free/agent-settings → onboarding, TELEGRAM_BIND_TOKEN_TTL_MS): backend.ts imports from contracts/', () => {
    const src = read('cores/free/agent-settings/src/backend.ts')
    expect(src).toContain(
      "import { TELEGRAM_BIND_TOKEN_TTL_MS } from '@neutronai/contracts/handoff-config.ts'",
    )
    // No IMPORT of the old onboarding path (a doc-comment mention of the
    // sibling `buildTelegramBindDeepLink` helper's home is fine).
    expect(src).not.toContain("from '../../../../onboarding")
  })

  test('edge #10 (tasks → onboarding, LlmCallFn): prioritize-llm.ts imports from contracts/', () => {
    const src = read('tasks/prioritize-llm.ts')
    expect(src).toContain("import type { LlmCallFn } from '@neutronai/contracts/llm-call.ts'")
    expect(src).not.toContain('phase-spec-resolver.ts')
  })

  test('edge #11 (mcp → runtime, McpToolResolver): mcp/server.ts imports from contracts/', () => {
    const src = read('mcp/server.ts')
    expect(src).toContain("import type { McpToolResolver } from '@neutronai/contracts/mcp-tool-resolver.ts'")
    expect(src).not.toContain('runtime/adapters/openai-responses/mcp-shim.ts')
  })
})
