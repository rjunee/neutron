/**
 * THE REACHABILITY GATE, half two — WHICH `/`-COMMANDS THE OWNER MUST BE ABLE TO
 * TYPE.
 *
 * The other half is `landing/chat-react/__tests__/reachability-inventory.ts` (the
 * app shell's affordances). The two are described together in
 * `docs/SYSTEM-OVERVIEW.md` § Reachability gate. Read that file's header for why
 * this class of gate exists at all — the short version is that a command can be
 * written, unit-tested and merged green while the composed product never reaches
 * it, which is exactly what happened to `/code`: it was built, tested, and left
 * out of the composer's filter chain, so every `/code` the owner typed went to the
 * model instead of starting a build.
 *
 * A command's filter is not the product. The CHAIN is the product. So this half
 * of the gate boots the real instance and types the command.
 */

export interface ChatCommandCapability {
  /** Stable id, used in failure output. */
  readonly id: string
  /** The command word, e.g. `/status`. */
  readonly command: string
  /** What the owner uses it for. */
  readonly can: string
  /** The sentence printed when the composed chain no longer claims it. */
  readonly broken: string
  /**
   * The exact message body the probe sends. Chosen to be READ-ONLY and safe on a
   * fresh instance — a probe must never mutate the owner's data to prove a path
   * works. Where a command has a help or list sub-command, that is what we send.
   */
  readonly probe: string
  /**
   * The factory in `gateway/boot-chat-command-filters.ts` that provides this
   * command. The completeness gate matches the gateway's exported factories
   * against this field, so a NEW filter with no inventory entry fails the build
   * instead of shipping unreachable.
   */
  readonly filter: string
}

/**
 * The commands the composed chain must claim.
 *
 * MEMBERSHIP RULE — a command belongs here only if a fresh instance with NO
 * third-party credentials claims it deterministically. A command whose filter
 * declines until an integration is connected would make this gate fire on a
 * perfectly healthy box, and a gate that cries wolf is worse than no gate. Those
 * are listed in {@link CHAT_COMMAND_EXCLUSIONS} with the reason rather than
 * quietly dropped.
 */
export const CHAT_COMMANDS: readonly ChatCommandCapability[] = [
  {
    id: 'status',
    command: '/status',
    can: 'Ask the instance what it is doing right now',
    broken:
      'Typing /status in chat no longer answers — the status snapshot is gone and the message is sent to the model instead.',
    probe: '/status',
    filter: 'buildStatusChatCommandFilter',
  },
  {
    id: 'reset',
    command: '/reset',
    can: 'Clear the conversation and start fresh',
    broken:
      'Typing /reset in chat no longer clears the conversation — the message is sent to the model instead.',
    probe: '/reset',
    filter: 'buildResetChatCommandFilter',
  },
  {
    id: 'code',
    command: '/code',
    can: 'Start a build from chat',
    broken:
      'Typing /code in chat no longer starts a build — the message is sent to the model instead.',
    probe: '/code help',
    filter: 'buildTridentCodeChatCommandFilter',
  },
]

/**
 * Filters that EXIST in the product and are deliberately not probed, each with
 * the reason.
 *
 * This list is load-bearing rather than housekeeping: the completeness gate
 * accepts a factory as accounted-for only if it is probed above OR excluded here,
 * so a new command cannot slip through unclassified — and an exclusion is a
 * decision someone made on purpose, with its cost written down next to it.
 */
export const CHAT_COMMAND_EXCLUSIONS: ReadonlyArray<{
  readonly filter: string
  readonly why: string
}> = [
  {
    filter: 'buildChainedChatCommandFilter',
    why: 'The chain combinator itself. It claims no command of its own — it is the thing every probe above runs THROUGH, so the probes already prove it is composed.',
  },
  {
    filter: 'buildRemindersChatCommandFilter',
    why: 'NOT PROBED, and this is a real coverage gap rather than a design choice. `/remind` is claimed only when `parseAndExecuteRemindCommand` returns a response, so the claim depends on the parse succeeding — which makes "the chain did not claim it" ambiguous between "the filter is unwired" and "that phrasing did not parse". Probing it needs a phrasing proven stable against the parser first; until then a red here would not be trustworthy, so it stays out. See docs/SYSTEM-OVERVIEW.md § Reachability gate.',
  },
  {
    filter: 'buildCalendarChatCommandFilter',
    why: 'NOT PROBED, and this is a real coverage gap rather than a design choice. `/cal` dispatches into the calendar Core, which on a box with no Google credentials answers over a path this gate has not proven to be deterministic. A probe that is only reliable on a connected box would fire on healthy fresh installs. See docs/SYSTEM-OVERVIEW.md § Reachability gate.',
  },
]
