/**
 * @neutronai/gateway/transcription — the local-Whisper ASSET CATALOG.
 *
 * The exact artifacts "Install local Whisper" downloads: one whisper.cpp
 * release build (the `whisper-cli` binary + its ggml shared libraries) and one
 * ggml model weight file. Both are PINNED by version AND by SHA-256, so:
 *
 *   - a half-downloaded or corrupted file can NEVER be promoted into place
 *     (the installer hashes the stream and only renames on an exact match), and
 *   - an upstream re-tag can never silently change what a Neutron box runs.
 *
 * Sizes are the exact `Content-Length` of each artifact, so the UI can render a
 * real "142 MB of 462 MB" progress bar and refuse up front when the disk cannot
 * hold it — not a spinner that stalls for four minutes.
 *
 * PROVENANCE (all values captured from the live endpoints 2026-07-31):
 *   - binaries: github.com/ggml-org/whisper.cpp releases, tag v1.9.1 (MIT).
 *     SHA-256 computed over the downloaded tarballs.
 *   - models: huggingface.co/ggerganov/whisper.cpp (the canonical ggml
 *     conversions). HF serves each file's SHA-256 as its `x-linked-etag`
 *     (git-LFS oid), which is what is pinned here.
 */

/** Upstream whisper.cpp release this build pins to. */
export const WHISPER_CPP_VERSION = 'v1.9.1'

const RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}`
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export interface WhisperBinaryAsset {
  /** `${process.platform}-${process.arch}` this tarball serves. */
  platform_key: string
  url: string
  sha256: string
  size_bytes: number
}

/**
 * Prebuilt `whisper-cli` tarballs, by platform.
 *
 * ONLY Linux is covered: upstream v1.9.1 publishes Ubuntu x64/arm64 CLI builds,
 * but ships macOS as an `xcframework` (libraries for app embedding, NOT a
 * runnable CLI). macOS self-hosters therefore install the binary through
 * Homebrew (`brew install whisper-cpp`, formula version 1.9.1 — the same
 * upstream release) and Neutron picks it up off PATH; only the model is
 * downloaded. `binaryAssetFor` returning `null` is that case, not an error.
 */
export const WHISPER_BINARY_ASSETS: readonly WhisperBinaryAsset[] = [
  {
    platform_key: 'linux-x64',
    url: `${RELEASE_BASE}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5',
    size_bytes: 9_379_235,
  },
  {
    platform_key: 'linux-arm64',
    url: `${RELEASE_BASE}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: 'e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3',
    size_bytes: 4_555_819,
  },
]

/** The prebuilt tarball for a platform, or `null` when none is published. */
export function binaryAssetFor(platform: string, arch: string): WhisperBinaryAsset | null {
  const key = `${platform}-${arch}`
  return WHISPER_BINARY_ASSETS.find((a) => a.platform_key === key) ?? null
}

export interface WhisperModelAsset {
  /** Stable id used in the API + on disk (`ggml-<id>.bin`). */
  id: string
  /** Human label for the settings picker. */
  label: string
  url: string
  sha256: string
  size_bytes: number
  /**
   * MEASURED wall-clock on the reference box (8-core AMD EPYC-Milan @2.4 GHz,
   * AVX2, no GPU, `-t 4`, multilingual auto-detect) for a 30-SECOND note. This
   * is the number the settings UI shows, because "how long until my voice note
   * turns into text" is the only question a user is actually asking.
   */
  sec_per_30s_note: number
  /** Approximate peak RSS of the transcription subprocess, MB (measured). */
  peak_rss_mb: number
  /** One line of guidance for the picker. */
  note: string
}

/**
 * The models offered in Settings, cheapest first.
 *
 * Every entry is multilingual (auto language detection). English-only `.en`
 * variants are marginally better on English at the same size, but Neutron Open
 * is self-hosted worldwide and a silent English-only default would mis-transcribe
 * a non-English owner's first voice note — a bad failure to ship by default.
 *
 * THE TIMINGS BELOW ARE MEASURED, NOT ESTIMATED. Reference box: 8-core AMD
 * EPYC-Milan @2.4 GHz, AVX2, no GPU, whisper.cpp v1.9.1, `-t 4`, `-l auto`,
 * default beam search, while the machine was carrying its normal production
 * load. Same audio, same flags, three runs, best time taken.
 *
 * WHY THERE IS NO `large-v3` AND NO QUANTIZED BUILD HERE — both were measured
 * and both lost:
 *
 *   - `large-v3` (f16, 3.1 GB) took 69.8 s for a 33-second note and peaked at
 *     3.97 GB RSS. `large-v3-turbo` beats it on every axis at half the size,
 *     so plain large-v3 has no case.
 *   - Q5 quantization was SLOWER than the f16 weights it shrinks, on this CPU,
 *     in both large variants: turbo-q5_0 63.6 s vs turbo f16 50.0 s;
 *     large-v3-q5_0 84.3 s vs large-v3 f16 69.8 s (33-second note). The disk
 *     saving is real, the runtime cost is worse, so offering it would be a trap.
 *   - `medium` (1.5 GB) sits between `small` and `large-v3-turbo` on speed and
 *     below turbo on accuracy — dominated, so it is not offered either.
 */
export const WHISPER_MODELS: readonly WhisperModelAsset[] = [
  {
    id: 'base',
    label: 'Base — fast (recommended)',
    url: `${MODEL_BASE}/ggml-base.bin`,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    size_bytes: 147_951_465,
    sec_per_30s_note: 3.8,
    peak_rss_mb: 343,
    note: 'A 30-second note is text in about 4 seconds. Handles clear speech well; less reliable on proper nouns and strong accents.',
  },
  {
    id: 'small',
    label: 'Small — more accurate',
    url: `${MODEL_BASE}/ggml-small.bin`,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    size_bytes: 487_601_967,
    sec_per_30s_note: 12.4,
    peak_rss_mb: 813,
    note: 'Better punctuation and proper nouns, but roughly three times slower — a 30-second note takes about 12 seconds.',
  },
  {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo — most accurate, slower than real time',
    url: `${MODEL_BASE}/ggml-large-v3-turbo.bin`,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    size_bytes: 1_624_555_275,
    sec_per_30s_note: 50.0,
    peak_rss_mb: 1_862,
    note: 'Best quality available on CPU, but transcription takes LONGER THAN THE RECORDING: a 30-second note needs about 50 seconds and 1.9 GB of RAM. Only worth it with a GPU or a machine that is otherwise idle.',
  },
]

/**
 * The default the settings UI preselects.
 *
 * `base`, on measured latency. Transcription runs INSIDE the upload request —
 * the note is not usable until it returns — so the model choice is felt directly
 * as how long the owner waits after speaking. Four seconds for a 30-second note
 * is a working feature; the fifty seconds `large-v3-turbo` needs is not, whatever
 * its word-error rate says. Accuracy is one dropdown away for anyone who wants
 * to trade for it.
 */
export const DEFAULT_WHISPER_MODEL_ID = 'base'

export function modelAssetFor(id: string): WhisperModelAsset | null {
  return WHISPER_MODELS.find((m) => m.id === id) ?? null
}
