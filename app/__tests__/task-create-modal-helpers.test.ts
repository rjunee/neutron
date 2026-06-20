/**
 * @neutronai/app — TaskCreateModal helper unit tests (P5.4).
 *
 * Covers `normalizeDueDate` — the only pure helper exported from the
 * modal (consumed by both TaskCreateModal and TaskEditModal). The
 * modal's render itself stays under the agent-browser smoke per the
 * project's "no RN-component mounting in bun-test" pattern.
 */

import { describe, expect, it } from 'bun:test';

import { normalizeDueDate } from '../lib/task-formatters';

describe('normalizeDueDate', () => {
  it('appends a midnight UTC suffix to bare YYYY-MM-DD', () => {
    expect(normalizeDueDate('2026-05-21')).toBe('2026-05-21T00:00:00.000Z');
  });

  it('passes through full ISO-8601 strings untouched', () => {
    expect(normalizeDueDate('2026-05-21T14:30:00.000Z')).toBe('2026-05-21T14:30:00.000Z');
  });

  it('passes through gibberish so the gateway can reject with 400', () => {
    expect(normalizeDueDate('tomorrow')).toBe('tomorrow');
  });
});
