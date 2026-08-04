/**
 * @neutronai/app — presentation logic for the Settings screen's "Voice
 * transcription" card.
 *
 * The app suite mounts no React Native components, so every decision the card
 * makes that could be WRONG lives here as a pure function and is tested
 * directly: what the status line says, whether a job is still running, how far
 * along it is, and — the one that matters most — whether the Install control can
 * actually do anything on this server. A control that looks live and silently
 * does nothing is the worst outcome available, so `installBlocker` returns the
 * reason to show INSTEAD of a working button rather than letting the screen
 * guess.
 *
 * Copy is deliberately server-sourced wherever the server knows better: model
 * labels, notes and measured timings all come from the catalog
 * (`gateway/transcription/whisper-catalog.ts`) rather than being restated here,
 * so the phone cannot drift into advertising a model as "better" when the
 * measured numbers say it is slower than the recording itself.
 */

import type {
  TranscriptionBackendChoice,
  VoiceTranscriptionStatus,
  WhisperInstallPhase,
  WhisperJob,
  WhisperModelOption,
} from './voice-transcription-client';
import { VoiceTranscriptionClientError } from './voice-transcription-client';

/** Human-readable byte size (`142 MB`, `1.6 GB`). Mirrors the web helper. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** True while the server still has work in flight for this job. */
export function isJobRunning(phase: WhisperInstallPhase | null): boolean {
  return phase !== null && phase !== 'idle' && phase !== 'done' && phase !== 'failed';
}

/** One line describing a running job, for the progress row. */
export function describeJob(job: WhisperJob): string {
  switch (job.phase) {
    case 'checking_disk':
      return 'Checking disk space…';
    case 'downloading_binary':
      return `Downloading whisper.cpp — ${formatBytes(job.received_bytes)} of ${formatBytes(job.total_bytes)}`;
    case 'extracting_binary':
      return 'Unpacking whisper.cpp…';
    case 'downloading_model':
      return `Downloading the model — ${formatBytes(job.received_bytes)} of ${formatBytes(job.total_bytes)}`;
    case 'verifying':
      return 'Verifying checksum…';
    case 'done':
      return 'Installed.';
    case 'failed':
      return job.error?.message ?? 'Install failed.';
    default:
      return 'Starting…';
  }
}

/** 0-1 completion, or null when the total is not yet known. */
export function jobFraction(job: WhisperJob): number | null {
  if (job.phase === 'done') return 1;
  if (job.total_bytes <= 0) return null;
  return Math.min(1, job.received_bytes / job.total_bytes);
}

/**
 * What is transcribing voice notes on this server RIGHT NOW.
 *
 * The single most important line on the card. The complaint that started this
 * work was not knowing which backend was in use, so this states the live answer
 * — and when nothing is running, says exactly which of the four situations it
 * is rather than one generic "not transcribing".
 */
export function describeBackend(status: VoiceTranscriptionStatus): string {
  if (status.backend === 'local') {
    const model = status.model_id ?? 'installed';
    const size = status.installed_bytes > 0 ? ` (${formatBytes(status.installed_bytes)} on disk)` : '';
    return `Transcribing on this server — ${model} model${size}`;
  }
  if (status.backend === 'openai') return 'Transcribing with the OpenAI API';
  switch (status.backend_reason) {
    case 'unchosen':
      return 'Nothing is transcribing — both options are set up, so pick the one you want';
    case 'local_not_installed':
      return 'Nothing is transcribing — you chose this server, but whisper.cpp is not installed yet';
    case 'openai_key_missing':
      return 'Nothing is transcribing — you chose OpenAI, but no API key is saved';
    default:
      return 'Nothing is transcribing — set up one of the options below';
  }
}

/**
 * True when the owner's choice is not what is actually running.
 *
 * The server NEVER substitutes the other backend, so this is always a "your
 * choice cannot run yet" state, never a silent swap. Surfaced as a warning next
 * to the selected option, which is the place someone would look.
 */
export function choiceIsStalled(status: VoiceTranscriptionStatus): boolean {
  return status.choice !== null && status.backend !== status.choice;
}

/**
 * Why an option cannot serve a voice note yet, or null when it can.
 *
 * Answers it for EITHER option, whether or not it is the selected one, so the
 * cost of switching is visible before the tap rather than after it.
 */
export function backendBlocker(
  status: VoiceTranscriptionStatus,
  backend: TranscriptionBackendChoice,
): string | null {
  if (backend === 'local') {
    return status.local_available ? null : 'Not installed yet — install a model below.';
  }
  return status.openai_key.present ? null : 'No API key saved yet — add one below.';
}

/** Where the active OpenAI key came from, or null when there is none. */
export function describeKeySource(status: VoiceTranscriptionStatus): string | null {
  const key = status.openai_key;
  if (!key.present) return null;
  if (key.source === 'environment') {
    // Worth spelling out: someone who never typed a key here, and cannot delete
    // it from here either, otherwise has no way to understand where it is from.
    return 'Using OPENAI_API_KEY from the server environment. To change it here, save a key below; to remove it, edit the server.';
  }
  if (key.source === 'shared') {
    // Same reasoning as `environment`: the key was never typed HERE and DELETE
    // here will not remove it, so naming where it actually lives is the only
    // honest answer.
    return 'Using your OpenAI key from Integrations — the same key that powers semantic memory. Save a key below only if you want transcription billed to a separate one.';
  }
  return key.saved_at !== null ? `Key saved ${formatSavedAt(key.saved_at)}.` : 'Key saved.';
}

/**
 * The honest one-line case for each option.
 *
 * Neither is "the good one". The measured per-model timings in the catalog were
 * taken on a CPU-only server (`gateway/transcription/whisper-catalog.ts` — 8-core
 * EPYC, AVX2, explicitly "no GPU"), which is what makes the large models slow
 * THERE; the same models on GPU-accelerated hardware are far quicker. So the
 * copy attributes the slowness to the hardware, which is where it belongs,
 * rather than to local transcription as such.
 */
export function describeBackendOption(backend: TranscriptionBackendChoice): string {
  if (backend === 'local') {
    return (
      'Runs on your own server with whisper.cpp. No API key, nothing billed per minute, and the ' +
      'audio never leaves the machine. Speed is down to the hardware: the timings below were ' +
      'measured on a server with no GPU, where the large models take longer than the recording ' +
      'itself. On a GPU-accelerated machine they are much faster.'
    );
  }
  return (
    'Sends the audio to OpenAI. Large-model accuracy in a few seconds whatever your server is, ' +
    'so it does not slow down on a CPU-only box. Needs an API key, is billed per minute of ' +
    'audio, and the recording leaves your machine.'
  );
}

/** `2026-08-01T04:12:09.000Z` → `1 Aug 2026`. Date only — the exact second is noise. */
function formatSavedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'previously';
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export type StatusFailure =
  | { kind: 'unsupported'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'error'; message: string };

/**
 * Turn a failed status load into copy the owner can act on.
 *
 * A 404 is the interesting one: it means the server is older than this surface,
 * NOT that the feature is broken. Reporting that as a generic error would send
 * someone hunting a bug that is really a server upgrade.
 */
export function describeStatusFailure(err: unknown): StatusFailure {
  if (err instanceof VoiceTranscriptionClientError) {
    if (err.status === 404) {
      return {
        kind: 'unsupported',
        message:
          'This Neutron server does not have the local-transcription API yet. Update the server, then reopen this screen.',
      };
    }
    if (err.status === 401 || err.status === 403) {
      return { kind: 'unauthorized', message: 'Your session was rejected. Sign out and back in.' };
    }
    return { kind: 'error', message: err.message };
  }
  return { kind: 'error', message: err instanceof Error ? err.message : 'Could not reach the server.' };
}

/**
 * Why the Install control cannot work here, or null when it can.
 *
 * The only blocking case is a server platform with no prebuilt whisper.cpp
 * (macOS ships an xcframework, not a runnable CLI) that has no binary on PATH
 * either. The fix is a package-manager command ON THE SERVER, which the phone
 * cannot run — so the card shows this instead of a button that would fail with
 * `unsupported_platform` after the fact.
 */
export function installBlocker(status: VoiceTranscriptionStatus): string | null {
  if (status.installed) return null;
  if (status.binary_downloadable || status.binary_present) return null;
  return (
    'Your server has no prebuilt whisper.cpp build and none installed. Install it on the server first ' +
    '(on macOS: brew install whisper-cpp), then reopen this screen. That step cannot be done from the phone.'
  );
}

/**
 * The row's title.
 *
 * The catalog's own label for the default already ends in "(recommended)", so
 * appending a marker unconditionally rendered "Base — fast (recommended) ·
 * recommended" on the device. Mark the default ONLY when its label does not
 * already say so — server copy wins, the client just fills the gap.
 */
export function modelTitle(model: WhisperModelOption, is_default: boolean): string {
  if (!is_default) return model.label;
  if (/recommended/i.test(model.label)) return model.label;
  return `${model.label} · recommended`;
}

/** Measured, not marketed: size, wall-clock per 30-second note, RAM. */
export function describeModel(model: WhisperModelOption): string {
  return `${formatBytes(model.size_bytes)} download · ~${formatSeconds(model.sec_per_30s_note)} per 30-second note · ${model.peak_rss_mb} MB RAM`;
}

/**
 * True when transcription takes LONGER than the recording it is transcribing.
 * The card marks these rather than letting "most accurate" read as "best".
 */
export function isSlowerThanRealTime(model: WhisperModelOption): boolean {
  return model.sec_per_30s_note > 30;
}

function formatSeconds(sec: number): string {
  return Number.isInteger(sec) ? `${sec}s` : `${sec.toFixed(1)}s`;
}
