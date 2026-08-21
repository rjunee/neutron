/**
 * Mobile Work Board render coverage for durable brief-integrity alerts.
 *
 * Pure helper tests cannot prove that `WorkBoardRow` actually emits the alert
 * node or selects the subdued alert style. These cases mount the real RN rows
 * through the device-shaped harness and pin both the live and completed paths.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import {
  installNativeHarness,
  resetHarnessGlobals,
  setHarnessPlatform,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { mountScreen } = await import('./support/mount');
const { WorkBoardCompletedRow, WorkBoardRow } = await import('../components/WorkBoardRow');
const { PHASE, THEME } = await import('../lib/theme');

type WorkBoardItem = import('../lib/work-board-client').WorkBoardItem;

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

const ALERT = 'CODEX_BUILD_BRIEF_PART_CORRUPT: recovered after one bridge retry. DEFERRED.';

function normalizeColor(value: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex !== null) {
    const n = Number.parseInt(hex[1] as string, 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  const rgb = /rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i.exec(value);
  if (rgb !== null) {
    return `${Math.round(Number(rgb[1]))},${Math.round(Number(rgb[2]))},${Math.round(Number(rgb[3]))}`;
  }
  return value;
}

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'alerted',
    title: 'Recovered build',
    status: 'in_progress',
    sort_order: 1,
    design_doc_ref: null,
    inline_active: false,
    linked_run_id: 'run-alerted',
    created_at: '2026-08-18T00:00:00Z',
    updated_at: '2026-08-18T00:01:00Z',
    completed_at: null,
    run_progress: {
      run_id: 'run-alerted',
      phase_label: 'building',
      step_label: 'building',
      round: 1,
      started_at: '2026-08-18T00:00:00Z',
      last_advanced_at: '2026-08-18T00:01:00Z',
      elapsed_ms: 60000,
      stalled: false,
      stalled_ms: null,
      pr: null,
      verdict: null,
      failure_reason: null,
      brief_alert: ALERT,
    },
    ...over,
  };
}

describe('WorkBoardRow brief alerts (mobile)', () => {
  it('renders a surviving alert on a live row with the non-failure tone', async () => {
    const screen = await mountScreen(createElement(WorkBoardRow, {
      item: item(),
      busy: false,
      index: 0,
      laneCount: 1,
      onAdvance: () => {},
      onRename: () => {},
      onReorderTo: () => {},
      onDelete: () => {},
    }));

    const alert = screen.byTestId('work-board-run-notice-alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toBe(ALERT);
    expect(normalizeColor(getComputedStyle(alert!).color)).toBe(normalizeColor(THEME.text_muted));
    expect(screen.byTestId('work-board-run-notice-failure')).toBeNull();
    screen.unmount();
  });

  it('uses the failure tone only for an actual terminal failure reason', async () => {
    const failed = item({
      status: 'failed',
      run_progress: {
        ...item().run_progress!,
        phase_label: 'failed',
        step_label: 'failed',
        failure_reason: 'publish failed',
      },
    });
    const screen = await mountScreen(createElement(WorkBoardRow, {
      item: failed,
      busy: false,
      index: 0,
      laneCount: 1,
      onAdvance: () => {},
      onRename: () => {},
      onReorderTo: () => {},
      onDelete: () => {},
    }));

    const failure = screen.byTestId('work-board-run-notice-failure');
    expect(failure?.textContent).toBe('publish failed');
    expect(normalizeColor(getComputedStyle(failure!).color)).toBe(normalizeColor(PHASE.failed.fg));
    expect(screen.byTestId('work-board-run-notice-alert')).toBeNull();
    screen.unmount();
  });

  it('keeps the recovered alert on the completed history row', async () => {
    const done = item({
      status: 'done',
      completed_at: '2026-08-18T00:03:00Z',
      run_progress: {
        ...item().run_progress!,
        phase_label: 'merged',
        step_label: 'done',
        last_advanced_at: '2026-08-18T00:03:00Z',
      },
    });
    const screen = await mountScreen(createElement(WorkBoardCompletedRow, {
      item: done,
      busy: false,
      onDelete: () => {},
    }));

    expect(screen.byTestId('work-board-completed-brief-alert')?.textContent).toBe(ALERT);
    expect(screen.text()).toContain('Merged');
    screen.unmount();
  });
});
