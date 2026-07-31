/**
 * `gateway/transcription/resolve-transcriber.ts` — which ASR backend runs.
 *
 * The precedence rule is a product decision, not an implementation detail:
 * LOCAL WINS OVER THE HOSTED API, unconditionally. Installing local Whisper is
 * a deliberate act whose entire point is that the audio stays on the machine;
 * silently preferring OpenAI afterwards — because some unrelated key is in the
 * environment — would undo that choice and bill for it. These tests pin it.
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

describe('resolveTranscriber', () => {
  test('local installed + NO key → local', () => {
    const r = resolveTranscriber({ env: {}, neutron_home: '/data', resolve_local: withLocal, which: () => '/usr/bin/ffmpeg' })
    expect(r.kind).toBe('local')
    expect(r.model_id).toBe('base')
    expect(r.client).not.toBeNull()
  })

  test('local installed AND a key set → LOCAL STILL WINS', () => {
    const r = resolveTranscriber({
      env: { OPENAI_API_KEY: 'sk-real-key' },
      neutron_home: '/data',
      resolve_local: withLocal,
      which: () => '/usr/bin/ffmpeg',
    })
    expect(r.kind).toBe('local')
  })

  test('no local + a key set → the hosted API is the fallback', () => {
    const r = resolveTranscriber({
      env: { OPENAI_API_KEY: 'sk-real-key' },
      neutron_home: '/data',
      resolve_local: noLocal,
      which: () => null,
    })
    expect(r.kind).toBe('openai')
    expect(r.client).not.toBeNull()
  })

  test('no local + no key → none, with a null client (never a throwing stub)', () => {
    const r = resolveTranscriber({ env: {}, neutron_home: '/data', resolve_local: noLocal, which: () => null })
    expect(r.kind).toBe('none')
    expect(r.client).toBeNull()
  })

  test('a whitespace-only key does not count as a credential', () => {
    const r = resolveTranscriber({
      env: { OPENAI_API_KEY: '   ' },
      neutron_home: '/data',
      resolve_local: noLocal,
      which: () => null,
    })
    expect(r.kind).toBe('none')
  })

  test('local WITHOUT ffmpeg still runs, but warns about the m4a gap', () => {
    // iOS Safari records m4a and whisper.cpp cannot decode it. Local is still
    // the right backend for every other container — degrade with a warning, do
    // not fall back to a paid service the owner did not ask for.
    const r = resolveTranscriber({ env: {}, neutron_home: '/data', resolve_local: withLocal, which: () => null })
    expect(r.kind).toBe('local')
    expect(r.warning).toContain('ffmpeg')
    expect(r.warning).toContain('m4a')
  })

  test('local WITH ffmpeg reports no warning', () => {
    const r = resolveTranscriber({
      env: {},
      neutron_home: '/data',
      resolve_local: withLocal,
      which: () => '/usr/bin/ffmpeg',
    })
    expect(r.warning).toBeUndefined()
  })
})
