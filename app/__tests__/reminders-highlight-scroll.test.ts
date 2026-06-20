/**
 * @neutronai/app — reminders deep-link highlight + scroll tests (ISSUE #38).
 *
 * Companion to `chat-deep-link-navigator.test.ts` (PR #276 ISSUE #18 —
 * Tasks deep-link). RN components do not mount under bun-test in this
 * repo (see the comment in `citation-chip-row.test.ts`); the wiring is
 * verified by source-text pins on:
 *
 *   - `app/app/projects/[id]/reminders.tsx` — reads `reminder_id` from
 *     `useLocalSearchParams` and threads `highlightReminderId` into
 *     `<ReminderList>`.
 *   - `app/components/ReminderList.tsx` — accepts `highlightReminderId`,
 *     measures per-row Y offset via `onLayout`, scrolls to the matching
 *     row via `scrollRef.scrollTo`, and renders an accent border on
 *     the highlighted row.
 *
 * The Tasks-side reference pattern (TaskList highlight + scroll) was
 * landed in PR #276 ISSUE #18 fix; these tests mirror that pattern
 * one-for-one. If a future refactor drops any of the load-bearing
 * substrings the deep-link UX breaks silently — the source pins surface
 * the regression here.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REMINDERS_ROUTE_SRC = readFileSync(
  join(import.meta.dir, '..', 'app', 'projects', '[id]', 'reminders.tsx'),
  'utf8',
);

const REMINDER_LIST_SRC = readFileSync(
  join(import.meta.dir, '..', 'components', 'ReminderList.tsx'),
  'utf8',
);

const REMINDER_STATE_SRC = readFileSync(
  join(import.meta.dir, '..', 'lib', 'reminder-state.tsx'),
  'utf8',
);

const REMINDERS_CLIENT_SRC = readFileSync(
  join(import.meta.dir, '..', 'lib', 'reminders-client.ts'),
  'utf8',
);

describe('reminders route — reminder_id deep-link param (ISSUE #38)', () => {
  it('reads `reminder_id` from useLocalSearchParams alongside `id`', () => {
    // The typed shape must declare both fields so Expo Router decodes
    // the query string into `reminder_id`. Pre-fix the route only
    // declared `{ id: string }` and the query param was dropped on tap.
    expect(REMINDERS_ROUTE_SRC).toMatch(
      /useLocalSearchParams<\{\s*id:\s*string;\s*reminder_id\?:\s*string\s*\}>\(\)/,
    );
  });

  it('coerces an empty / non-string `reminder_id` to null', () => {
    // Mirrors the Tasks pattern — only forward a non-empty string so
    // a stale query param can't drive the highlight effect.
    expect(REMINDER_LIST_SRC.length).toBeGreaterThan(0);
    expect(REMINDERS_ROUTE_SRC).toContain(
      "typeof reminder_id === 'string' && reminder_id.length > 0 ? reminder_id : null",
    );
  });

  it('threads `highlightReminderId` into <ReminderList>', () => {
    // The composer must pass the resolved value through to the list so
    // the highlight + scroll effect fires.
    expect(REMINDERS_ROUTE_SRC).toMatch(
      /<ReminderList[\s\S]*?highlightReminderId=\{highlightReminderId\}/,
    );
  });

  it('forwards `highlightReminderId` through RemindersTabBody props', () => {
    // The body component must accept the prop so a refactor that
    // collapses the body back into the default export still has the
    // value in scope.
    expect(REMINDERS_ROUTE_SRC).toMatch(
      /RemindersTabBody\(\{\s*highlightReminderId\s*\}:\s*\{\s*highlightReminderId:\s*string\s*\|\s*null\s*\}\)/,
    );
  });
});

describe('<ReminderList> — highlight + scroll wiring (ISSUE #38)', () => {
  it('declares `highlightReminderId?: string | null` on the props interface', () => {
    expect(REMINDER_LIST_SRC).toMatch(
      /highlightReminderId\?:\s*string\s*\|\s*null/,
    );
  });

  it('measures per-row Y offset via onLayout', () => {
    // Source-pin the per-row layout-measurement pattern so a future
    // refactor that drops the Map<string, number> ref regresses here.
    expect(REMINDER_LIST_SRC).toContain('useRef<Map<string, number>>');
    expect(REMINDER_LIST_SRC).toContain('rowYRef.current.set(entry.id');
    expect(REMINDER_LIST_SRC).toContain('e.nativeEvent.layout.y');
  });

  it('scrolls the ScrollView to the measured offset when highlightReminderId changes', () => {
    // Pin the scrollTo call shape. `Math.max(0, y - SPACING.lg)`
    // matches the Tasks-side leading margin so the highlighted row
    // isn't flush with the top edge of the viewport.
    expect(REMINDER_LIST_SRC).toMatch(/scrollRef\.current\?\.scrollTo\(/);
    expect(REMINDER_LIST_SRC).toContain('Math.max(0, y - SPACING.lg)');
    expect(REMINDER_LIST_SRC).toContain('animated: true');
  });

  it('rebuilds the scroll target when the visible (post-filter) list changes', () => {
    // The effect dep array must include `visible` (the post-filter
    // bucketing) so switching filters while a deep-link param is set
    // still scrolls to the matching row. The pure source-text pin lets
    // the bun-test runtime catch a regression without mounting RN.
    expect(REMINDER_LIST_SRC).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[highlightReminderId,\s*visible\]\)/,
    );
  });

  it('renders an accent border wrapper on the highlighted row', () => {
    // The highlighted-row wrap must use the dedicated style so the
    // visual cue lands. Source-pin both the conditional and the style
    // shape (border + raised surface).
    expect(REMINDER_LIST_SRC).toMatch(/isHighlighted\s*=\s*highlightReminderId\s*===\s*entry\.id/);
    expect(REMINDER_LIST_SRC).toMatch(/isHighlighted\s*\?\s*styles\.highlightedWrap\s*:\s*undefined/);
    expect(REMINDER_LIST_SRC).toMatch(
      /highlightedWrap:\s*\{[\s\S]*?borderColor:\s*THEME\.text_secondary[\s\S]*?backgroundColor:\s*THEME\.surface_raised[\s\S]*?\}/,
    );
  });

  it('exposes a testID for the highlighted row (companion to PR #276 tasks pattern)', () => {
    // Same naming convention as `tasks-row-<id>-highlighted` so a
    // future RN-test runner that does mount real components can locate
    // the highlighted row deterministically.
    expect(REMINDER_LIST_SRC).toContain('reminders-row-${entry.id}-highlighted');
  });
});

describe('default behaviour — non-deep-link entry (regression guard)', () => {
  it('treats highlightReminderId as null by default', () => {
    // Default prop value pin — the deep-link wiring must NOT regress
    // the plain "tap the Reminders tab" entry point.
    expect(REMINDER_LIST_SRC).toContain('highlightReminderId = null');
  });
});

describe('include_id wiring — survives `markFired`-before-push race (Codex P2)', () => {
  // Codex flagged: the tick loop calls `markFired` BEFORE the push
  // dispatcher fans out, so a one-shot reminder is `status='fired'` by
  // the time the user taps the notification. The reminders tab fetches
  // `?status=pending` only — so the row would be absent from the list
  // and the highlight effect would no-op. Fix: thread the highlight id
  // into `?include_id=<rid>` so the server widens the response to
  // include the specific row even when its status is no longer pending.

  it('route passes `highlightReminderId` to <ReminderStateProvider> AND <RemindersTabBody>', () => {
    // Single source of truth for the deep-link id — same value drives
    // BOTH the fetch widening AND the visual highlight.
    expect(REMINDERS_ROUTE_SRC).toMatch(
      /<ReminderStateProvider[\s\S]*?highlightReminderId=\{highlightReminderId\}[\s\S]*?>/,
    );
    expect(REMINDERS_ROUTE_SRC).toMatch(
      /<RemindersTabBody\s+highlightReminderId=\{highlightReminderId\}/,
    );
  });

  it('provider declares `highlightReminderId?: string | null` prop', () => {
    expect(REMINDER_STATE_SRC).toMatch(
      /highlightReminderId\?:\s*string\s*\|\s*null/,
    );
  });

  it('provider threads `highlightReminderId` into `client.list(projectId, {include_id})`', () => {
    // Source-pin the call shape so a future refactor that drops the
    // include_id argument regresses here. This is the seam that lets
    // a `status='fired'` row survive into the list after the tick loop
    // has already advanced its status.
    expect(REMINDER_STATE_SRC).toMatch(
      /client\.list\(projectId,\s*\{\s*include_id:\s*highlightReminderId,?\s*\}\)/,
    );
  });

  it('provider re-fetches when `highlightReminderId` changes', () => {
    // The fetch callback's dep array must include `highlightReminderId`
    // so a deep-link tap that lands while the route is already
    // mounted triggers a re-fetch with the new include_id. Without
    // this dep, navigating from `/projects/p1/reminders` to
    // `/projects/p1/reminders?reminder_id=r1` would not re-fetch.
    expect(REMINDER_STATE_SRC).toMatch(
      /\}, \[client, projectId, highlightReminderId\]\);/,
    );
  });

  it('client exposes an optional `include_id` opt on `.list()`', () => {
    // Source-pin the signature shape (uses .includes — bun-test regex
    // `\s` handling is picky with multi-line TS arg lists).
    expect(REMINDERS_CLIENT_SRC).toContain('async list(');
    expect(REMINDERS_CLIENT_SRC).toContain('project_id: string,');
    expect(REMINDERS_CLIENT_SRC).toContain(
      'opts?: { include_id?: string | null }',
    );
  });

  it('client appends `&include_id=<encoded>` when set and a non-empty string', () => {
    // URL composition pin — must url-encode the value AND skip the
    // param entirely when null/empty (so the default-fetch case stays
    // byte-identical to the pre-#38 request shape).
    expect(REMINDERS_CLIENT_SRC).toContain(
      "`&include_id=${encodeURIComponent(include_id)}`",
    );
    expect(REMINDERS_CLIENT_SRC).toContain(
      "typeof opts?.include_id === 'string' && opts.include_id.length > 0",
    );
  });
});
