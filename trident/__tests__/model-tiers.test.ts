/**
 * THE REGISTRY IS THE ONE PLACE A MODEL LIVES — and these tests are the reason that
 * claim is checkable rather than aspirational.
 *
 * A tier is a promise with three parts: an id that resolves at RUNTIME, a transport
 * that can actually reach it, and (for a subprocess) an env knob the wrapper really
 * reads. Each part fails differently and silently:
 *
 *   • A drifted id — the registry says `gpt-5.6-sol`, the wrapper's own default says
 *     something else — is invisible until someone compares two files. So the wrapper
 *     SOURCES are read here and pinned against the registry.
 *   • A wrapper that does not read the env var named by its tier turns the whole
 *     selector into decoration: the pane saves, the dispatch sets a variable nothing
 *     consults, and the review runs on whatever the CLI felt like. So the wrapper is
 *     grepped for the knob.
 *   • A frozen id — captured at module load instead of resolved on call — shows the
 *     owner the model this process booted with rather than the one their next build
 *     will use. So the watchdog override is flipped and the registry re-read.
 */

import { describe, expect, it } from 'bun:test'

import { setBestModelOverride } from '@neutronai/runtime/models.ts'

import {
  MODEL_TIERS,
  isModelTier,
  modelTier,
  modelTierRegistry,
  tiersAreInterchangeable,
} from '../model-tiers.ts'

const CODEX_WRAPPER = await Bun.file(new URL('../codex-review.sh', import.meta.url)).text()
const CODEX_BUILD = await Bun.file(new URL('../codex-build.sh', import.meta.url)).text()
const WORKFLOW_SRC = await Bun.file(new URL('../inner-workflow.mjs', import.meta.url)).text()

/** A shell script with its whole-line `#` comments removed — the executable half. */
const shellCode = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
const KIMI_REVIEW = await Bun.file(new URL('../kimi-review.ts', import.meta.url)).text()
const KIMI_CLI = await Bun.file(new URL('../kimi-review-cli.ts', import.meta.url)).text()

describe('every tier is complete and resolvable', () => {
  it('resolves each tier to a non-empty id, with no duplicates', () => {
    const registry = modelTierRegistry()
    expect(registry.map((t) => t.tier)).toEqual([...MODEL_TIERS])
    for (const entry of registry) {
      expect(entry.model_id.length).toBeGreaterThan(0)
      expect(isModelTier(entry.tier)).toBe(true)
    }
    expect(new Set(registry.map((t) => t.model_id)).size).toBe(registry.length)
  })

  it('gives an agent tier no wrapper and a cli tier both a wrapper and a knob', () => {
    for (const entry of modelTierRegistry()) {
      if (entry.transport === 'agent') {
        // An "agent" tier with a wrapper would be two dispatch paths for one tier.
        expect({ tier: entry.tier, wrapper: entry.wrapper, env: entry.env_var }).toEqual({
          tier: entry.tier,
          wrapper: null,
          env: null,
        })
        expect(entry.requires).toBeNull()
      } else {
        // A cli tier missing either half cannot be dispatched at all: the workflow
        // would know a model id and have nowhere to put it.
        expect(typeof entry.wrapper).toBe('string')
        expect(typeof entry.env_var).toBe('string')
        expect(entry.requires === 'codex' || entry.requires === 'kimi').toBe(true)
      }
    }
  })

  it('returns null for an unknown or retired tier instead of inventing one', () => {
    expect(modelTier('fable-2')).toBeNull()
    expect(modelTier('gpt-5.6-sol')).toBeNull()
    expect(isModelTier('')).toBe(false)
  })
})

describe('the registry and the wrappers cannot drift apart', () => {
  it('every cli tier names a wrapper that EXISTS in the repo', async () => {
    for (const entry of modelTierRegistry()) {
      if (entry.transport !== 'cli') continue
      // Repo-relative, so this resolves from the repo root two levels up.
      const path = new URL(`../../${entry.wrapper}`, import.meta.url)
      expect({ wrapper: entry.wrapper, exists: await Bun.file(path).exists() }).toEqual({
        wrapper: entry.wrapper,
        exists: true,
      })
    }
  })

  it('every cli tier names an env knob its wrapper ACTUALLY READS', () => {
    // The failure this catches is the whole feature being decoration: a dispatch that
    // exports a variable nobody consults, and a review that runs on the CLI default
    // while the pane insists otherwise.
    const sources: Record<string, string> = {
      'trident/codex-review.sh': CODEX_WRAPPER,
      'trident/kimi-review-cli.ts': KIMI_CLI,
    }
    for (const entry of modelTierRegistry()) {
      if (entry.transport !== 'cli') continue
      const src = sources[entry.wrapper!]
      expect({ wrapper: entry.wrapper, known: src !== undefined }).toEqual({
        wrapper: entry.wrapper,
        known: true,
      })
      expect({ tier: entry.tier, reads: src!.includes(entry.env_var!) }).toEqual({
        tier: entry.tier,
        reads: true,
      })
    }
  })

  it("`sol` IS the codex wrapper's own pinned default — one edit retires a model", () => {
    // Two places hold this id: the registry (what the workflow threads) and the
    // wrapper (what a human running it by hand gets). They must be the same string,
    // or the default path and the pane would disagree about which model reviewed.
    expect(modelTier('sol')!.model_id).toBe('gpt-5.6-sol')
    expect(CODEX_WRAPPER).toContain('CODEX_REVIEW_MODEL-gpt-5.6-sol')
  })

  it('keeps the wrapper\'s explicitly-EMPTY-means-CLI-default semantics', () => {
    // `${VAR-x}` substitutes only when UNSET, so an explicit empty value falls back
    // to the CLI's own default. `${VAR:-x}` would silently replace it. The
    // difference is one character and no test would otherwise see it.
    expect(CODEX_WRAPPER).toContain('"${CODEX_REVIEW_MODEL-gpt-5.6-sol}"')
    expect(CODEX_WRAPPER).not.toContain('${CODEX_REVIEW_MODEL:-')
  })

  it('`k3` IS the Kimi reviewer\'s own default model', () => {
    expect(modelTier('k3')!.model_id).toBe('kimi-k3')
    expect(KIMI_REVIEW).toContain("KIMI_DEFAULT_MODEL = 'kimi-k3'")
  })

  it('the BUILD wrapper pins the same `sol` id, on its OWN knob', () => {
    // The codex tiers now have a SECOND consumer: `trident/codex-build.sh` runs the
    // build. Its standing default has to be the same tier the registry calls `sol`,
    // or the pane and a hand invocation disagree about which GPT model built.
    expect(CODEX_BUILD).toContain('"${CODEX_BUILD_MODEL-gpt-5.6-sol}"')
    expect(CODEX_BUILD).not.toContain('${CODEX_BUILD_MODEL:-')

    // A DIFFERENT knob from the reviewer's, deliberately. `CODEX_REVIEW_MODEL` is
    // documented for a direct human review invocation; if the build wrapper read the
    // same name, a box that exports it would silently build on the reviewer's model
    // (and the reverse). Neither wrapper may consult the other's knob — asserted on
    // the CODE, with comment lines stripped, because both headers legitimately
    // explain the distinction by naming both variables.
    expect(shellCode(CODEX_BUILD)).not.toContain('CODEX_REVIEW_MODEL')
    expect(shellCode(CODEX_WRAPPER)).not.toContain('CODEX_BUILD_MODEL')
    // The stripper has to actually strip, or the two assertions above are vacuous.
    expect(shellCode(CODEX_BUILD)).toContain('CODEX_BUILD_MODEL')

    // …and the WORKFLOW sets exactly that name. Without this the wrapper would read
    // a variable nothing writes and every codex build would take the default.
    expect(WORKFLOW_SRC).toContain("CODEX_BUILD_MODEL_ENV = 'CODEX_BUILD_MODEL'")
  })
})

describe('a tier follows the model, not the process it booted in', () => {
  it('re-resolves `opus` after the watchdog adopts a new id', () => {
    const before = modelTier('opus')!.model_id
    try {
      setBestModelOverride('claude-opus-5-next')
      // A frozen literal would still report `before` here, and the pane would tell
      // the owner a model their next build will not use.
      expect(modelTier('opus')!.model_id).toBe('claude-opus-5-next')
    } finally {
      setBestModelOverride(undefined)
    }
    expect(modelTier('opus')!.model_id).toBe(before)
  })
})

describe('interchangeability is about the executor, not taste', () => {
  it('allows a swap within one transport and refuses one across', () => {
    expect(tiersAreInterchangeable('opus', 'sonnet')).toBe(true)
    expect(tiersAreInterchangeable('sol', 'terra')).toBe(true)
    expect(tiersAreInterchangeable('sol', 'luna')).toBe(true)
    // `agent({model})` resolves against Claude Code's own endpoint — a GPT id there
    // reaches nothing.
    expect(tiersAreInterchangeable('opus', 'sol')).toBe(false)
    expect(tiersAreInterchangeable('sol', 'opus')).toBe(false)
    // Both are CLI, but `CODEX_REVIEW_MODEL=kimi-k3` is not a review, it is an error.
    expect(tiersAreInterchangeable('sol', 'k3')).toBe(false)
    expect(tiersAreInterchangeable('k3', 'sol')).toBe(false)
  })

  it('refuses an unknown tier on either side', () => {
    expect(tiersAreInterchangeable('opus', 'fable-2' as never)).toBe(false)
    expect(tiersAreInterchangeable('fable-2' as never, 'opus')).toBe(false)
  })
})
