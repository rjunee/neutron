/**
 * THE OWNER CAN SET A BUILD PHASE'S MODEL FROM HIS PHONE — by pressing the chips.
 *
 * THE CHAIN THIS COMPLETES. The phase vocabulary, the workflow argument and the
 * router were built first; then the store, the per-launch resolver and the HTTP
 * surface; and until this screen existed there was still no way for a human to set
 * anything. Each of those layers was correct on its own the whole time, which is why
 * the tests here are about REACHING the endpoint rather than about validation — the
 * server already rejects a bad set whole and has its own tests for that.
 *
 * WHY IT PRESSES THINGS. A source check confirms a component mentions a handler; it
 * cannot tell a rendered-and-wired chip from a rendered-and-inert one, and this repo
 * has shipped that exact bug. Every assertion goes through the real screen.
 *
 * THE TWO BEHAVIOURS MOST WORTH PINNING are the ones a reasonable implementation gets
 * wrong: choosing a value that EQUALS the default must CLEAR the override rather than
 * pin it (otherwise the owner freezes a phase against a future default change they
 * never intended), and a REJECTED save must keep the local edits so a typo can be
 * corrected in place instead of being thrown away.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';

import {
  installNativeHarness,
  setHarnessPlatform,
  resetHarnessGlobals,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { mountScreen } = await import('./support/mount');
const { AuthSessionProvider } = await import('../lib/session');

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

/** A payload shaped like the real surface's, trimmed to three phases. */
function payload(
  overrides: Record<string, unknown> = {},
  rejected: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    phases: [
      {
        key: 'build',
        label: 'Build',
        description: 'Writes the code and the tests, and re-writes them against findings.',
        group: 'claude',
        // TWO executors: the Claude builder it defaults to, and the codex one.
        groups: ['claude', 'codex'],
        effort_supported: true,
        default: { model: 'opus', effort: 'high' },
      },
      {
        key: 'synthesis',
        label: 'Synthesis / arbitration',
        description: 'Merges every reviewer’s verdict into one and decides what blocks a merge.',
        group: 'claude',
        groups: ['claude'],
        effort_supported: true,
        default: { model: 'fable', effort: 'high' },
      },
      {
        // The cross-model row: a different executor, and no effort control of its own.
        key: 'review_codex',
        label: 'Cross-model review (Codex)',
        description: 'A second opinion from a GPT model, run through the Codex CLI.',
        group: 'codex',
        groups: ['codex'],
        effort_supported: false,
        default: { model: 'sol', effort: 'high' },
      },
    ],
    model_tiers: [
      { tier: 'fable', provider: 'anthropic', model_id: 'claude-fable-5', group: 'claude', effort_supported: true, available: true, unavailable_reason: null },
      { tier: 'opus', provider: 'anthropic', model_id: 'claude-opus-5', group: 'claude', effort_supported: true, available: true, unavailable_reason: null },
      { tier: 'sonnet', provider: 'anthropic', model_id: 'claude-sonnet-4-6', group: 'claude', effort_supported: true, available: true, unavailable_reason: null },
      { tier: 'fast', provider: 'anthropic', model_id: 'claude-haiku-4-5', group: 'claude', effort_supported: true, available: true, unavailable_reason: null },
      { tier: 'sol', provider: 'openai', model_id: 'gpt-5.6-sol', group: 'codex', effort_supported: false, available: true, unavailable_reason: null },
      { tier: 'terra', provider: 'openai', model_id: 'gpt-5.6-terra', group: 'codex', effort_supported: false, available: true, unavailable_reason: null },
      // UNAVAILABLE on purpose: no codex credential (or no codex CLI) on this
      // install, which is a DIFFERENT answer from "this step cannot reach codex".
      { tier: 'luna', provider: 'openai', model_id: 'gpt-5.6-luna', group: 'codex', effort_supported: false, available: false, unavailable_reason: 'needs a Codex connection' },
      // THE THIRD EXECUTOR, which this lane did not wire. It stays in the fixture so
      // the greying rule is exercised against a group that is still unreachable from
      // every row here — "claude or codex" would look correct without it.
      { tier: 'k3', provider: 'moonshot', model_id: 'kimi-k3', group: 'kimi', effort_supported: false, available: false, unavailable_reason: 'needs a Kimi key' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: {
      build: { model: 'opus', effort: 'high' },
      synthesis: { model: 'fable', effort: 'high' },
      review_codex: { model: 'sol', effort: 'high' },
    },
    overrides,
    rejected,
  };
}

interface Sent {
  method: string;
  body: unknown;
}
let sent: Sent[] = [];
let getPayload: Record<string, unknown> = payload();
/** When set, PUT answers with this status + body instead of echoing. */
let putFailure: { status: number; body: unknown } | null = null;

function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    sent.push({ method, body });
    const json = (v: unknown, status = 200): Response =>
      new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'PUT') {
      if (putFailure !== null) return json(putFailure.body, putFailure.status);
      const over = (body as { overrides?: Record<string, unknown> })?.overrides ?? {};
      return json(payload(over));
    }
    return json(getPayload);
  };
}

let mounted: { unmount(): void } | null = null;

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);
beforeEach(() => {
  if (mounted !== null) {
    mounted.unmount();
    mounted = null;
  }
  document.body.innerHTML = '';
  sent = [];
  getPayload = payload();
  putFailure = null;
  installFetch();
});

async function mountCodegen(): Promise<void> {
  const mod = await import('../app/codegen');
  const Screen = mod.default as () => unknown;
  const screen = await mountScreen(
    createElement(AuthSessionProvider, { initialUser: OWNER }, createElement(Screen as never)),
  );
  mounted = screen as unknown as { unmount(): void };
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function press(id: string): Promise<void> {
  const el = byTestId(id);
  if (el === null) throw new Error(`control '${id}' is not on screen`);
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * Open a row's dropdown, then choose one of its options.
 *
 * Two presses, because that is what the owner does: the table shows one line per
 * step and the options only appear when asked for. A helper that reached the option
 * directly would be testing a menu the screen never opens.
 */
async function choose(phase: string, control: 'model' | 'effort', value: string): Promise<void> {
  await press(`phase-${phase}-${control}`);
  await press(`phase-${phase}-${control}-${value}`);
}

const lastPut = (): Record<string, unknown> | undefined => {
  const put = [...sent].reverse().find((s) => s.method === 'PUT');
  return (put?.body as { overrides?: Record<string, unknown> })?.overrides;
};

describe('the screen renders what the SERVER says the phases are', () => {
  it('loads on mount and shows a row per phase', async () => {
    await mountCodegen();
    expect(sent.some((s) => s.method === 'GET')).toBe(true);
    expect(byTestId('phase-build')).not.toBeNull();
    expect(byTestId('phase-synthesis')).not.toBeNull();
  });

  it('offers exactly the tiers and efforts the payload declared', async () => {
    // No local copy of the vocabulary: a phase or tier added to the engine must
    // appear here without an app release, and one removed must disappear.
    await mountCodegen();
    await press('phase-build-model');
    expect(byTestId('phase-build-model-sonnet')).not.toBeNull();
    expect(byTestId('phase-build-model-nonexistent-tier')).toBeNull();
    await press('phase-build-effort');
    expect(byTestId('phase-build-effort-xhigh')).not.toBeNull();
  });

  it('names the model a tier resolves to, in the control and in every option', async () => {
    // The owner picks a TIER so the setting survives a model change; what they need
    // to see is which model that is TODAY.
    await mountCodegen();
    expect(byTestId('phase-build-model')!.textContent ?? '').toContain('claude-opus-5');
    await press('phase-build-model');
    const fast = byTestId('phase-build-model-fast')!;
    expect(fast.textContent ?? '').toContain('claude-haiku-4-5');
    expect(byTestId('phase-build-model-opus')!.textContent ?? '').toContain('(default)');
  });

  it('shows a tier this install cannot run DISABLED, with the reason, never hidden', async () => {
    await mountCodegen();
    await press('phase-review_codex-model');
    // Listed on the row that could use it, greyed, saying what to go and fix.
    const luna = byTestId('phase-review_codex-model-luna');
    expect(luna).not.toBeNull();
    expect(luna!.textContent ?? '').toContain('needs a Codex connection');
    // …and pressing it changes nothing, which is the half a render check misses.
    await press('phase-review_codex-model-luna');
    expect(byTestId('phase-review_codex-changed')).toBeNull();
    // THE OTHER KIND OF GREYING, on the executor this lane did not wire. "Go and get a
    // Kimi key" would send the owner of a Codex row to fix something that would not
    // help, so the reason has to be the wiring — and it must still say so after the
    // build moved.
    const k3 = byTestId('phase-review_codex-model-k3');
    expect(k3).not.toBeNull();
    expect(k3!.textContent ?? '').toContain('Kimi is not wired for this step yet');
    await press('phase-review_codex-model-k3');
    expect(byTestId('phase-review_codex-changed')).toBeNull();
  });

  it('lets the BUILD row be moved to a codex tier, and the choice actually takes', async () => {
    // The row the whole route exists for. A selectable option that does not change
    // anything is worse than a greyed one, so the assertion is the CHANGED marker —
    // the same half a render check misses in the greying test above.
    await mountCodegen();
    await press('phase-build-model');
    const sol = byTestId('phase-build-model-sol');
    expect(sol).not.toBeNull();
    expect(sol!.textContent ?? '').not.toContain('not wired for this step yet');
    // ONLY WHAT IS WIRED IS UN-GREYED — asserted on the same open picker. The Kimi
    // tier on this row still carries the honest reason: a selectable option that
    // dispatches nowhere is worse than a greyed one, and this lane wired one executor.
    expect(byTestId('phase-build-model-k3')!.textContent ?? '').toContain(
      'Kimi is not wired for this step yet',
    );
    await press('phase-build-model-sol');
    expect(byTestId('phase-build-changed')).not.toBeNull();
    // …while the OTHER kind of greying is unchanged: the synthesis row has only a
    // Claude dispatch, so a codex tier there still says so rather than becoming
    // pickable because a different row was wired.
    await press('phase-synthesis-model');
    expect(byTestId('phase-synthesis-model-sol')!.textContent ?? '').toContain(
      'Codex is not wired for this step yet',
    );
  });

  it('says a CLI step has no effort control instead of offering an inert one', async () => {
    await mountCodegen();
    expect(byTestId('phase-review_codex-effort')).toBeNull();
    expect(byTestId('phase-review_codex-effort-na')!.textContent ?? '').toContain(
      'set by the CLI',
    );
  });

  it('the BUILD row LOSES its effort control the moment it moves to codex, and the PUT drops the effort', async () => {
    // THE BLOCKER THIS PINS, driven the way the owner hits it: set an effort, then
    // move the row to a GPT tier. The cell used to stay live and the stale effort
    // rode along in the PUT, which the server refused — failing the ENTIRE save,
    // including every other row edited in the same pass.
    await mountCodegen();
    await choose('build', 'effort', 'max');
    // The control is live while the row is on its Claude default.
    expect(byTestId('phase-build-effort')).not.toBeNull();
    expect(byTestId('phase-build-effort-na')).toBeNull();

    await choose('build', 'model', 'sol');
    expect(byTestId('phase-build-effort')).toBeNull();
    expect(byTestId('phase-build-effort-na')!.textContent ?? '').toContain('set by the CLI');

    // …and a second row edited in the same pass still reaches the server.
    await choose('synthesis', 'model', 'opus');
    await press('codegen-save');
    expect(lastPut()).toEqual({ build: { model: 'sol' }, synthesis: { model: 'opus' } });
  });

  it('shows a REFUSED stored value struck through, and what is running instead', async () => {
    getPayload = payload({}, { build: { model: 'fable-2' } });
    await mountCodegen();
    const stale = byTestId('phase-build-stale')!;
    expect(stale.textContent ?? '').toContain('fable-2');
    expect(stale.textContent ?? '').toContain('no longer available');
    expect(stale.textContent ?? '').toContain('opus');
  });

  it('marks a phase that already has an override', async () => {
    getPayload = payload({ build: { effort: 'xhigh' } });
    await mountCodegen();
    expect(byTestId('phase-build-changed')).not.toBeNull();
    expect(byTestId('phase-synthesis-changed')).toBeNull();
  });
});

describe('pressing a chip and saving reaches the endpoint', () => {
  it('PUTs the chosen override', async () => {
    await mountCodegen();
    await choose('build', 'effort', 'xhigh');
    await press('codegen-save');
    expect(lastPut()).toEqual({ build: { effort: 'xhigh' } });
  });

  it('sends the COMPLETE set, because the write replaces rather than merges', async () => {
    getPayload = payload({ synthesis: { model: 'opus' } });
    await mountCodegen();
    await choose('build', 'effort', 'max');
    await press('codegen-save');
    // The pre-existing synthesis override must ride along, or saving one row would
    // silently clear every other.
    expect(lastPut()).toEqual({ synthesis: { model: 'opus' }, build: { effort: 'max' } });
  });

  it('CHOOSING THE DEFAULT CLEARS the override rather than pinning it', async () => {
    // The behaviour a reasonable implementation gets wrong. Storing `opus` for a
    // phase already defaulting to `opus` freezes it against a future change to that
    // default — the owner would have pinned something they only meant to leave be.
    getPayload = payload({ build: { model: 'sonnet' } });
    await mountCodegen();
    expect(byTestId('phase-build-changed')).not.toBeNull();
    await choose('build', 'model', 'opus'); // opus IS build's default
    expect(byTestId('phase-build-changed')).toBeNull();
    await press('codegen-save');
    expect(lastPut()).toEqual({});
  });

  it('does not PUT until Save is pressed', async () => {
    // Every chip auto-saving would make a mis-tap a live config change on the next
    // build, with no chance to look at the row first.
    await mountCodegen();
    await choose('build', 'effort', 'low');
    expect(sent.some((s) => s.method === 'PUT')).toBe(false);
  });

  it('confirms a successful save, and the confirmation goes stale on the next edit', async () => {
    await mountCodegen();
    await choose('build', 'effort', 'xhigh');
    await press('codegen-save');
    expect(byTestId('codegen-saved')).not.toBeNull();
    await choose('build', 'effort', 'low');
    // Leaving "Saved" up would tell the owner their newest change is already stored.
    expect(byTestId('codegen-saved')).toBeNull();
  });
});

describe('a rejected save', () => {
  it("shows the server's message VERBATIM, naming every problem", async () => {
    // The server rejects the whole set and lists each fault. A generic "save failed"
    // would hide which row was wrong, and the owner is the only one who can fix it.
    putFailure = {
      status: 400,
      body: {
        code: 'invalid_phase_models',
        message: "phase 'build': 'effort' must be one of: low, medium, high, xhigh, max; unknown phase 'nope'",
      },
    };
    await mountCodegen();
    await choose('build', 'effort', 'xhigh');
    await press('codegen-save');
    const err = byTestId('codegen-error');
    expect(err).not.toBeNull();
    expect(err!.textContent ?? '').toContain('xhigh');
    expect(err!.textContent ?? '').toContain("unknown phase 'nope'");
  });

  it('KEEPS the local edits so the owner can correct them in place', async () => {
    // Discarding the edits on rejection punishes a typo by throwing away the rest of
    // the work — and the owner would have to reconstruct what they had chosen.
    putFailure = { status: 400, body: { code: 'invalid_phase_models', message: 'nope' } };
    await mountCodegen();
    await choose('build', 'effort', 'xhigh');
    await press('codegen-save');
    expect(byTestId('phase-build-changed')).not.toBeNull();
    // And a retry still carries the edit rather than an empty set.
    putFailure = null;
    await press('codegen-save');
    expect(lastPut()).toEqual({ build: { effort: 'xhigh' } });
  });

  it('shows no success confirmation alongside an error', async () => {
    putFailure = { status: 400, body: { code: 'invalid_phase_models', message: 'nope' } };
    await mountCodegen();
    await choose('build', 'effort', 'xhigh');
    await press('codegen-save');
    expect(byTestId('codegen-saved')).toBeNull();
  });

  it('a failed LOAD says so instead of rendering an empty pipeline', async () => {
    // Zero phases rendered as a blank list would read as "this build has no phases",
    // which is a lie the owner cannot act on.
    (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> => {
      throw new Error('server unreachable');
    };
    await mountCodegen();
    expect(byTestId('codegen-error')).not.toBeNull();
    expect(byTestId('phase-build')).toBeNull();
  });
});
