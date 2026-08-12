/**
 * THE REACHABILITY GATE, half one — WHAT THE OWNER MUST BE ABLE TO DO IN THE APP.
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * Every regression that has reached the owner in a green build had the same
 * shape: **a part worked, and the product could not reach it.**
 *
 *   - a voice recorder that worked, mounted by a host screen that never handed it
 *     its props, so the mic answered every press with "not available yet";
 *   - a usage meter that worked, absent from the wide layout because the wide
 *     branch never passed `usage` — and no test had ever rendered a wide layout;
 *   - a `/code` command that worked and was unit-tested, never added to the
 *     composed filter chain, so every `/code` the owner typed went to the model;
 *   - a voice player that worked and rewound at the end, and looped anyway,
 *     because the test asserted the rewind and the buggy build rewound too.
 *
 * A unit test asserts that a PART works. Nothing asserted that the PRODUCT still
 * reaches it. This file is that missing assertion, written as data: one entry per
 * thing the owner must be able to do, in the owner's words, with the sentence to
 * print when it stops being true.
 *
 * THE OTHER HALF is `open/__tests__/reachability-inventory.ts` — the chat
 * commands, which are a server-composition property and get probed against a real
 * running instance rather than a mounted tree. Same idea, different seam. Both are
 * described together in `docs/SYSTEM-OVERVIEW.md` § Reachability gate.
 *
 * WHY THIS LIVES UNDER `landing/` RATHER THAN A TOP-LEVEL `tests/` FOLDER: React
 * resolves inside the `landing` workspace and nowhere else, so a shell mount can
 * only run from here. Each half of the gate is colocated with the surface it
 * probes; the SYSTEM-OVERVIEW section is what holds them together conceptually.
 *
 * WRITING A `broken:` SENTENCE. It is read by the owner, not by whoever wrote the
 * code. Say what they can no longer DO. "Voice notes cannot be sent" — not
 * "expected 200, got 500", not "VoiceRecorderOverlay did not render".
 */

/**
 * The layouts the product actually ships. Both are probed for EVERY affordance,
 * because a layout that no test ever renders is a layout where anything can be
 * missing and nothing notices — which is exactly how the usage meter shipped
 * absent from the wide sidebar.
 */
export const LAYOUTS = {
  narrow: { name: 'narrow', width: 390, desktop: false },
  wide: { name: 'wide', width: 1440, desktop: true },
} as const

export type LayoutName = keyof typeof LAYOUTS

export interface ShellAffordance {
  readonly id: string
  /** What the owner does with it. */
  readonly can: string
  /** The sentence printed when it is not reachable. */
  readonly broken: string
  /**
   * Reachability probe. Returns true when the owner can actually get at the
   * control. Presence alone is not always reachability — see `withDraft` below.
   */
  readonly reachable: (root: HTMLElement) => boolean
  /**
   * Probe the shell AFTER a draft has been typed into the composer rather than at
   * rest. A Send button that renders but never leaves its disabled state is
   * exactly as broken as one that does not render, and only this phase sees it.
   */
  readonly withDraft?: boolean
  /**
   * Probe the shell AFTER the Admin surface has been opened from the header menu,
   * rather than at rest. The things you ADJUST live behind that menu rather than
   * in the tab band (`ProjectShell`'s `MENU_TARGETS`), so an affordance that lives
   * on the Admin surface is not in the tree until the owner has taken the two
   * steps a real one takes to get there — and those two steps are part of what is
   * being asserted.
   */
  readonly inAdmin?: boolean
  /**
   * Layouts where this affordance is deliberately absent, WITH the reason. Almost
   * everything has none: the default expectation is that the owner can do the
   * same things at every window size, and an exception has to be argued for in
   * writing. The parity check reads this field — an affordance that vanishes from
   * a layout without an entry here fails the gate.
   */
  readonly absentIn?: ReadonlyArray<{ readonly layout: LayoutName; readonly why: string }>
}

const present = (root: HTMLElement, selector: string): boolean =>
  root.querySelector(selector) !== null

/**
 * The app shell's owner-facing affordances.
 *
 * Each probe is written against the shipped `car-*` class vocabulary rather than
 * against component internals, so it keeps holding through a refactor and fails
 * only when the OWNER's path changes.
 */
export const SHELL_AFFORDANCES: readonly ShellAffordance[] = [
  {
    id: 'compose',
    can: 'Type a message',
    broken: 'You cannot type a message — the chat composer is not there.',
    reachable: (root) => present(root, '.car-input'),
  },
  {
    id: 'send',
    can: 'Send a message',
    broken: 'You cannot send a message — the send control is missing from the composer.',
    reachable: (root) => present(root, 'button.car-send'),
  },
  {
    id: 'send-usable',
    can: 'Actually send, once something is typed',
    broken: 'The send control never becomes usable — a typed message cannot be sent.',
    withDraft: true,
    reachable: (root) => {
      const btn = root.querySelector('button.car-send') as HTMLButtonElement | null
      return btn !== null && !btn.disabled
    },
  },
  {
    id: 'attach',
    can: 'Attach a file to a message',
    broken: 'You cannot attach a file — the attach control is missing from the composer.',
    reachable: (root) => present(root, '.car-attach-btn') && present(root, '.car-file-input'),
  },
  {
    id: 'projects',
    can: 'See and switch between projects',
    broken: 'You cannot switch projects — the project rail is not rendered.',
    reachable: (root) => present(root, '.car-rail') && present(root, '.car-rail-item'),
  },
  {
    id: 'tabs',
    can: 'Move between the tabs of a project',
    broken: 'You cannot move between tabs — the tab bar rendered no tabs.',
    reachable: (root) => root.querySelectorAll('button[role="tab"]').length > 0,
  },
  {
    id: 'usage',
    can: 'See how much of the usage window is left',
    // THE ONE THAT SHIPPED BROKEN. The meter's ROOT renders unconditionally — it
    // is the window chrome the divider always was — so "is the element there" is
    // not the question. The question is whether a host still hands it a reading:
    // when the wide branch stopped passing `usage`, the root kept rendering, the
    // "unknown" default drew the plain divider, and the omission looked like a
    // design choice from every angle except the one where you needed the number.
    // So the probe demands a MEASURED meter, which is the thing that disappeared.
    broken:
      'You cannot see how much of your usage window is left — the meter is drawing a blank divider even though the server reported a reading.',
    reachable: (root) =>
      present(root, '.car-usage[data-available="true"]') && present(root, '.car-usage-fill'),
  },
  {
    id: 'github-connect',
    can: 'Connect GitHub, so a build can push and open a pull request',
    // #551 — THE ONE THAT WAS NEVER REACHABLE AT ALL. The device-flow surface,
    // its route slot and its composition were all merged, tested and green: the
    // backend tests passed, the route resolved, and a composition-coverage test
    // asserted the slot was mounted. No client on any surface called it, so the
    // only way a human could start the flow was to have a terminal on the
    // machine — and the agent, hitting the same wall, recommended exactly that.
    // Every automated signal said it worked. This is the signal that did not.
    broken:
      'You cannot connect GitHub — Admin has no control to start it, so a build still has nowhere to push and no way to open a pull request.',
    inAdmin: true,
    // Enabled, not merely present: a Connect button stuck disabled is the same
    // dead end as a missing one.
    reachable: (root) => {
      const btn = root.querySelector('button.cint-github-connect') as HTMLButtonElement | null
      return btn !== null && !btn.disabled
    },
  },
  {
    id: 'theme',
    can: 'Switch between light and dark',
    broken: 'You cannot change the theme — the theme control is not rendered.',
    reachable: (root) => present(root, '.car-theme-toggle'),
    absentIn: [
      {
        layout: 'narrow',
        why: 'Deliberate (#350/#360): the stacked narrow band has no room for the toggle, so its narrow home is the labelled control under Admin → Appearance. Desktop has the room and gets it back inline.',
      },
    ],
  },
]
