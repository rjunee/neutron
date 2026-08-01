/**
 * @neutronai/app — presentation logic for the Settings screen's "Local voice
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

/** What is transcribing voice notes on this server right now. */
export function describeBackend(status: VoiceTranscriptionStatus): string {
  if (status.backend === 'local') {
    const model = status.model_id ?? 'installed';
    const size = status.installed_bytes > 0 ? ` (${formatBytes(status.installed_bytes)} on disk)` : '';
    return `Running on your server — ${model} model${size}`;
  }
  if (status.backend === 'openai') return 'Using hosted OpenAI transcription (an API key is set)';
  return 'Voice notes are not transcribed on this server';
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
