/**
 * @neutronai/app — pure focus-row-formatters unit tests (P5.6).
 *
 * Mirrors task-row-formatters tests. Runs under bun:test without RN
 * because the formatters import only from theme + the FocusClient
 * types — no react-native at module load.
 */

import { describe, expect, it } from 'bun:test';

import type { FocusBucket, FocusItem } from '../lib/focus-client';
import {
  bucketDotColor,
  dueChipKind,
  formatDueRelative,
  isInstanceLevel,
  kindChipLabel,
  PROJECT_CHIP_MAX_CHARS,
  priorityChipKind,
  projectChipLabel,
  INSTANCE_CHIP_LABEL,
} from '../lib/focus-row-formatters';
import { THEME } from '../lib/theme';

function makeItem(extra: Partial<FocusItem> = {}): FocusItem {
  return {
    kind: 'task',
    id: 'tsk_1',
    project_id: 'acme',
    title: 'demo',
    due_at: null,
    priority: null,
    bucket: 'today',
    source: 'tasks',
    origin_source: null,
    focus_score: null,
    ...extra,
  };
}

describe('formatDueRelative', () => {
  const now = Date.parse('2026-05-20T12:00:00Z');

  it('returns empty string for null input', () => {
    expect(formatDueRelative(null, now)).toBe('');
  });

  it('returns empty string for unparseable input', () => {
    expect(formatDueRelative('not-an-iso', now)).toBe('');
  });

  it('overdue by minutes renders Xm overdue', () => {
    const iso = new Date(now - 5 * 60 * 1000).toISOString();
    expect(formatDueRelative(iso, now)).toBe('5m overdue');
  });

  it('overdue by hours renders Xh overdue', () => {
    const iso = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    expect(formatDueRelative(iso, now)).toBe('3h overdue');
  });

  it('overdue by days renders Xd overdue', () => {
    const iso = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatDueRelative(iso, now)).toBe('2d overdue');
  });

  it('due in minutes renders due in Xm', () => {
    const iso = new Date(now + 30 * 60 * 1000).toISOString();
    expect(formatDueRelative(iso, now)).toBe('due in 30m');
  });

  it('due in hours renders due in Xh', () => {
    const iso = new Date(now + 4 * 60 * 60 * 1000).toISOString();
    expect(formatDueRelative(iso, now)).toBe('due in 4h');
  });

  it('due in days renders due in Xd', () => {
    const iso = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatDueRelative(iso, now)).toBe('due in 3d');
  });
});

describe('kindChipLabel', () => {
  it('renders Task for task rows', () => {
    expect(kindChipLabel({ kind: 'task' })).toBe('Task');
  });
  it('renders Reminder for reminder rows', () => {
    expect(kindChipLabel({ kind: 'reminder' })).toBe('Reminder');
  });
});

describe('projectChipLabel + isInstanceLevel', () => {
  it('returns Instance for empty project_id', () => {
    expect(projectChipLabel({ project_id: '' })).toBe(INSTANCE_CHIP_LABEL);
    expect(isInstanceLevel({ project_id: '' })).toBe(true);
  });

  it('returns the raw project_id when short enough', () => {
    expect(projectChipLabel({ project_id: 'acme' })).toBe('acme');
    expect(isInstanceLevel({ project_id: 'acme' })).toBe(false);
  });

  it('truncates long project_ids with an ellipsis', () => {
    const long = 'a'.repeat(PROJECT_CHIP_MAX_CHARS + 8);
    const label = projectChipLabel({ project_id: long });
    expect(label.length).toBe(PROJECT_CHIP_MAX_CHARS);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('bucketDotColor', () => {
  const cases: Array<[FocusBucket, string]> = [
    ['overdue', THEME.danger],
    ['today', THEME.warning],
    ['soon', THEME.text_muted],
  ];
  for (const [bucket, color] of cases) {
    it(`maps ${bucket} → ${color}`, () => {
      expect(bucketDotColor(bucket)).toBe(color);
    });
  }
});

describe('priorityChipKind', () => {
  it('returns null for null priority', () => {
    expect(priorityChipKind(null)).toBeNull();
  });
  it('maps 0 → p0', () => {
    expect(priorityChipKind(0)).toBe('p0');
  });
  it('maps 1 → p1', () => {
    expect(priorityChipKind(1)).toBe('p1');
  });
  it('maps 2 → p2', () => {
    expect(priorityChipKind(2)).toBe('p2');
  });
  it('maps 3 → p3', () => {
    expect(priorityChipKind(3)).toBe('p3');
  });
  it('clamps values >3 to p3 ramp', () => {
    expect(priorityChipKind(99)).toBe('p3');
  });
});

describe('dueChipKind', () => {
  it('maps bucket overdue → overdue chip', () => {
    expect(dueChipKind('overdue')).toBe('overdue');
  });
  it('maps bucket today → today chip', () => {
    expect(dueChipKind('today')).toBe('today');
  });
  it('maps bucket soon → soon chip', () => {
    expect(dueChipKind('soon')).toBe('soon');
  });
});

describe('integration smoke', () => {
  it('renders a full chip set for a task row', () => {
    const it1 = makeItem({
      kind: 'task',
      priority: 1,
      due_at: new Date(Date.parse('2026-05-20T13:00:00Z')).toISOString(),
      bucket: 'today',
    });
    const now = Date.parse('2026-05-20T12:00:00Z');
    expect(kindChipLabel(it1)).toBe('Task');
    expect(projectChipLabel(it1)).toBe('acme');
    expect(isInstanceLevel(it1)).toBe(false);
    expect(priorityChipKind(it1.priority)).toBe('p1');
    expect(dueChipKind(it1.bucket)).toBe('today');
    expect(formatDueRelative(it1.due_at, now)).toBe('due in 1h');
    expect(bucketDotColor(it1.bucket)).toBe(THEME.warning);
  });

  it('renders the instance-level register for a project-less reminder', () => {
    const it1 = makeItem({ kind: 'reminder', project_id: '', bucket: 'overdue' });
    expect(kindChipLabel(it1)).toBe('Reminder');
    expect(projectChipLabel(it1)).toBe(INSTANCE_CHIP_LABEL);
    expect(isInstanceLevel(it1)).toBe(true);
    expect(bucketDotColor(it1.bucket)).toBe(THEME.danger);
  });
});
