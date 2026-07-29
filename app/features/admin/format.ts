/**
 * @neutronai/app — admin screen formatting utilities.
 *
 * Shared error and data formatting helpers used across admin panes.
 */

import { AdminClientError } from '../../lib/admin-client';
import { CoresClientError } from '../../lib/cores-client';
import { AdminPersonalityClientError } from '../../lib/admin-personality-client';

export function formatError(err: unknown): string {
  if (err instanceof AdminClientError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function formatCoresError(err: unknown): string {
  if (err instanceof CoresClientError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function formatPersonaError(err: unknown): string {
  if (err instanceof AdminPersonalityClientError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelative(ts_ms: number, now: number): string {
  const delta = Math.max(0, now - ts_ms);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function formatIso(iso: string | null, now: number): string {
  if (iso === null) return 'never';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return formatRelative(ts, now);
}

export function formatNext(iso: string | null, now: number): string {
  if (iso === null) return 'not scheduled';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const delta = Math.max(0, ts - now);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'in <1m';
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min - hr * 60;
  if (hr < 24) return `in ${hr}h ${remMin}m`;
  const days = Math.floor(hr / 24);
  return `in ${days}d`;
}
