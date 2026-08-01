/**
 * `gateway/transcription/resolve-transcriber.ts` — which ASR backend runs.
 *
 * THE PRODUCT DECISION THESE TESTS PIN: the owner's SETTING decides, and
 * nothing else does. There is no precedence between the backends in either
 * direction — the earlier "local wins over the hosted API, unconditionally"
 * rule is deleted, because it made an OpenAI key unreachable on a box with
 * local Whisper installed.
 *
 * This file is written to FAIL LOUDLY if any tiebreaker creeps back in. The
 * cases below are chosen so that the obvious wrong implementations each break
 * at least one of them:
 *
 *   - "local wins when installed"   → breaks `chose openai … while local is installed`
 *   - "openai wins when keyed"      → breaks `chose local … while a key is set`
 *   - "fall back to the other one"  → breaks the two `never substitutes` cases
 *   - "guess when unchosen"         → breaks `both configured, nothing chosen`
 *
 * The last is the subtle one. An unchosen box with BOTH backends configured is
 * an open question, and answering it silently is exactly the behaviour being
 * removed; it must resolve to `none` / `unchosen` so the Settings surfaces can
 * ask. An unchosen box with only ONE configured backend has no question to
 * answer, so it just works — that is what keeps every existing self-hoster
 * running untouched.
 */

import { describe, expect, test } from 'bun:test'

import { resolveTranscriber } from '../resolve-transcriber.ts'
import type { WhisperInstall } from '../whisper-install.ts'

const INSTALLED: WhisperInstall = {
  binary: '/data/whisper/bin/whisper-cli',
  lib_dir: '/data/whisper/bin',
  model: '/data/whisper/models/ggml-base.bin',
  model_id: 'base',
}

const noLocal = () => null
const withLocal = () => INSTALLED
const KEY = 'sk-test-not-a-real-key'

/** Every case supplies all four axes explicitly — no defaults to hide behind. */
function resolve(opts: {
  choice: 'local' | 'openai' | null
  local: boolean
  key: string | null
  ffmpeg?: boolean
}) {
  return resolveTranscriber({
    env: {},
    neutron_home: '/data',
    choice: opts.choice,
    openai_api_key: opts.key,
    resolve_local: opts.local ? withLocal : noLocal,
    which: () => ((opts.ffmpeg ?? true) ? '/usr/bin/ffmpeg' : null),
  })
}

describe('the setting decides — with both backends configured', () => {
  test('chose openai, while local IS installed → openai (no local precedence)', () => {
    const r = resolve({ choice: 'openai', local: true, key: KEY })
    expect(r.kind).toBe('openai')
    expect(r.client).not.toBeNull()
  })

  test('chose local, while a key IS set → local (no key precedence)', () => {
    const r = resolve({ choice: 'local', local: true, key: KEY })
    expect(r.kind).toBe('local')
    expect(r.model_id).toBe('base')
  })
})

describe('the setting decides — with only one backend configured', () => {
  test('chose openai, no local install → still openai', () => {
    expect(resolve({ choice: 'openai', local: false, key: KEY }).kind).toBe('openai')
  })

  test('chose local, no key → still local', () => {
    expect(resolve({ choice: 'local', local: true, key: null }).kind).toBe('local')
  })
})

describe('a chosen backend that cannot run is NEVER substituted', () => {
  test('chose local but it is not installed → none, even though a key would work', () => {
    const r = resolve({ choice: 'local', local: false, key: KEY })
    expect(r.kind).toBe('none')
    expect(r.reason).toBe('local_not_installed')
    expect(r.client).toBeNull()
  })

  test('chose openai but no key → none, even though local is installed', () => {
    const r = resolve({ choice: 'openai', local: true, key: null })
    expect(r.kind).toBe('none')
    expect(r.reason).toBe('openai_key_missing')
    expect(r.client).toBeNull()
  })

  test('a whitespace-only key is not a key', () => {
    const r = resolve({ choice: 'openai', local: false, key: '   ' })
    expect(r.kind).toBe('none')
    expect(r.reason).toBe('openai_key_missing')
  })
})

describe('no choice made yet', () => {
  test('BOTH configured → none / unchosen — the question is asked, not guessed', () => {
    const r = resolve({ choice: null, local: true, key: KEY })
    expect(r.kind).toBe('none')
    expect(r.reason).toBe('unchosen')
    expect(r.client).toBeNull()
  })

  test('only local configured → local, with no setting to visit', () => {
    const r = resolve({ choice: null, local: true, key: null })
    expect(r.kind).toBe('local')
  })

  test('only a key configured → openai, with no setting to visit', () => {
    const r = resolve({ choice: null, local: false, key: KEY })
    expect(r.kind).toBe('openai')
  })

  test('neither configured → none / unconfigured, with a null client', () => {
    const r = resolve({ choice: null, local: false, key: null })
    expect(r.kind).toBe('none')
    expect(r.reason).toBe('unconfigured')
    expect(r.client).toBeNull()
  })
})

describe('the env var is a key SOURCE, never a choice', () => {
  test('OPENAI_API_KEY in the environment does not by itself select openai', () => {
    // The caller (`OpenAiKeyStore`) is what reads the environment; this function
    // is handed a key or `null`. Passing the env through while resolving a key
    // of `null` must not resurrect the old `env['OPENAI_API_KEY']` read — if it
    // did, this box would report openai instead of local.
    const r = resolveTranscriber({
      env: { OPENAI_API_KEY: KEY },
      neutron_home: '/data',
      choice: null,
      openai_api_key: null,
      resolve_local: withLocal,
      which: () => '/usr/bin/ffmpeg',
    })
    expect(r.kind).toBe('local')
  })
})

describe('local backend details survive the rewrite', () => {
  test('local WITHOUT ffmpeg still runs, but warns about the m4a gap', () => {
    // iOS Safari records m4a and whisper.cpp cannot decode it. Local is still
    // the right backend for every other container — degrade with a warning,
    // never quietly switch to a paid service the owner did not choose.
    const r = resolve({ choice: 'local', local: true, key: KEY, ffmpeg: false })
    expect(r.kind).toBe('local')
    expect(r.warning).toContain('ffmpeg')
    expect(r.warning).toContain('m4a')
  })

  test('local WITH ffmpeg reports no warning', () => {
    expect(resolve({ choice: 'local', local: true, key: null, ffmpeg: true }).warning).toBeUndefined()
  })
})
