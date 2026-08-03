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
   * The exported factory function that provides this command, wherever in the
   * repo it lives. The completeness gate scans every non-test source for filter
   * factories and matches them against this field, so a NEW filter with no
   * inventory entry fails the build instead of shipping unreachable.
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
 *
 * Every filter factory in the repo must land in exactly one of three places:
 * here (probed), {@link CHAT_COMMANDS_KNOWN_UNREACHABLE} (probed, and asserted
 * BROKEN), or {@link CHAT_COMMAND_EXCLUSIONS} (not probed, with the reason and
 * the cost). `reachability-inventory-complete.test.ts` enforces that.
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
    id: 'remind',
    command: '/remind',
    can: 'Schedule a nudge from chat',
    broken:
      'Typing /remind in chat no longer schedules anything — the message is sent to the model instead.',
    // BARE `/remind`, deliberately. The old exclusion was right that a
    // phrasing-dependent probe is untrustworthy: a reminder body has to survive
    // `parseAndExecuteRemindCommand`, so a red would be ambiguous between "the
    // filter is unwired" and "that phrasing stopped parsing". The bare command
    // has no phrasing to get wrong — `chat-commands.ts:208` returns
    // `{kind:'help'}` for it, and `executeRemindCommand:681` answers that as its
    // FIRST branch, before touching the backend. So a red here can only mean the
    // filter is unreachable, which is the one thing this gate is for.
    probe: '/remind',
    filter: 'buildRemindersChatCommandFilter',
  },
  {
    id: 'cal',
    command: '/cal',
    can: "Read and write the owner's calendar from chat",
    broken:
      'Typing /cal in chat no longer reaches the calendar — the message is sent to the model instead.',
    // BARE `/cal`, for the credential half of the same problem. The old exclusion
    // was right that dispatching into the calendar Core is not deterministic
    // without Google credentials — but `parseCalCommand:117` returns
    // `{kind:'help'}` for an empty body and `executeCalCommand:135` answers it
    // with a static string WITHOUT touching `ctx.client`. So this probe is
    // identical on a connected box and a fresh install, which is exactly the
    // property the exclusion said was missing. Same technique `/code help`
    // already uses above.
    probe: '/cal',
    filter: 'buildCalendarChatCommandFilter',
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
  {
    id: 'skills',
    command: '/skills',
    can: 'Review, approve and decline the skills the instance proposes for itself',
    broken:
      'Typing /skills in chat no longer lists or approves Skill Forge proposals — the message is sent to the model instead, so a proposal can never be accepted.',
    // `help` short-circuits in `executeSkillForgeCommand`
    // (skill-forge/command.ts:108) before the backend is touched, so the claim
    // does not depend on any proposal existing.
    probe: '/skills help',
    filter: 'buildSkillForgeChatCommandFilter',
  },
  {
    id: 'email',
    command: '/email',
    can: 'Triage, search and summarise the inbox from chat',
    broken:
      'Typing /email in chat no longer reaches the email Core — the message is sent to the model, which will answer about email in general rather than reading the inbox.',
    // `/email help` returns the cheatsheet (cores/free/email/src/chat-commands.ts:193)
    // without a Google call. The one thing it does touch is
    // `EmailProjectCacheResolver.resolve` (chat-bridge.ts:86), which opens a
    // local sqlite cache under `owner_home` — no credential, no network.
    probe: '/email help',
    filter: 'createEmailChatCommandFilter',
  },
  {
    id: 'research',
    command: '/research',
    can: 'Capture, list and run research from chat',
    broken:
      'Typing /research in chat no longer reaches the research Core — the message is sent to the model, so nothing is captured and nothing is stored.',
    // `help` short-circuits in `executeResearchCommand`
    // (cores/free/research/src/chat-commands.ts:114) before the project backend
    // is resolved.
    probe: '/research help',
    filter: 'createResearchChatCommandFilter',
  },
]

/**
 * Commands whose filter EXISTS in the product and is reachable by NOBODY.
 *
 * This list is the opposite assertion from {@link CHAT_COMMANDS}, and it exists
 * so that a known gap cannot be parked in {@link CHAT_COMMAND_EXCLUSIONS} and
 * quietly forgotten. An exclusion says "this gate does not look here". An entry
 * here says "this gate looked, and the command is broken today, on purpose,
 * with the following cost" — and it is pinned by a real probe at a real socket,
 * so the day someone wires the filter the gate goes RED and tells them to
 * promote the entry into a probe. A gap that self-clears is a gap; a gap in a
 * skip list is a permission slip.
 */
export interface KnownUnreachableChatCommand {
  readonly id: string
  readonly command: string
  /** The exported factory that exists but reaches no composed chain. */
  readonly filter: string
  /** The body typed at the socket. Must be safe on a fresh instance. */
  readonly probe: string
  /** Why it is unwired, with the evidence. */
  readonly why: string
  /** What the owner cannot do because of it. Not softened. */
  readonly cost: string
}

export const CHAT_COMMANDS_KNOWN_UNREACHABLE: readonly KnownUnreachableChatCommand[] = [
  {
    id: 'scrape',
    command: '/scrape',
    filter: 'createScrapingChatCommandFilter',
    probe: '/scrape',
    why:
      'The scraping Core\'s chat filter is built by `buildProductionScrapingCoreWiring` ' +
      '(cores/free/scraping/src/wiring-production.ts:63), which is exported from the ' +
      'core barrel (cores/free/scraping/index.ts:93) and CALLED BY NOTHING — the ' +
      'composer wires the research Core\'s equivalent (gateway/cores/mount-open-cores.ts:312,397) ' +
      'and never the scraping one. So `/scrape` is not in any chain. This was found by ' +
      'widening this gate; it was invisible while the scan read one hardcoded file.',
    cost:
      'The owner cannot type `/scrape <url>`; it goes to the model, which answers about ' +
      'scraping in general instead of scraping anything. The Apify-backed MCP tools ' +
      '(`scrape_instagram` / `scrape_x`) still work, so the capability is reachable BY THE ' +
      'AGENT and not by the owner — which breaks the agent-native parity ' +
      'docs/SYSTEM-OVERVIEW.md:323 claims for this Core in exactly one direction. Fixing it ' +
      'is a product change (a scraping backend must be threaded to the chain at mount ' +
      'time), so it is pinned here rather than fixed inside a gate PR.',
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
 *
 * AN EXCLUSION IS NOT A PLACE TO PUT A BROKEN COMMAND. "Probing it is awkward" is
 * a reason to be here. "It does not work" is not — that goes in
 * {@link CHAT_COMMANDS_KNOWN_UNREACHABLE}, where a probe pins the breakage and
 * reds when it is fixed. The distinction is the whole difference between a gate
 * and a permission slip: everything in this list is a place the gate has agreed
 * not to look, so each entry has to say what that leaves unwatched.
 */
/**
 * Owner-typed commands this gate STRUCTURALLY CANNOT SEE, and the file that
 * covers each one instead.
 *
 * The three lists above are all keyed on chat-command FILTER FACTORIES, because
 * that is what {@link scanChatCommandFilterFactories} can find and what the
 * probe's `chat_command_result` assertion matches. A command implemented any
 * other way is invisible to every one of them — not excluded, not pinned, just
 * absent, which is the most dangerous of the four states because nothing in this
 * file mentions it at all.
 *
 * `/task` is exactly that shape and it is not an accident of style. It is a
 * RECEIVER WRAPPER (`wrapWithTasksChatRouter`, returning `IncomingEventReceiver`)
 * sitting a layer below the filter chain, and it is there because a
 * `ChatCommandFilterResult` (`contracts/chat-command-filter.ts:35`) carries
 * `text` / `data` / `deep_link` / `error` and has NO FIELD FOR BUTTONS, while
 * the Tasks Core answers `/task` and `/task focus` with button rows the client
 * posts back as `task:done:<id>`. Routed through the filter chain, every one of
 * those buttons would be silently dropped. So the gap in this gate is the price
 * of the command working at all, and the right response is to write the cover
 * down rather than to bend the command into a shape the gate can see.
 *
 * It went unwired for exactly as long as it went unlisted: `wrapWithTasksChatRouter`
 * had zero production callers, `/task` reached the model as prose, and no gate
 * in this repo was looking.
 *
 * The set is PINNED by `reachability-inventory-complete.test.ts`, which asserts
 * both that each named file exists and that the whole set matches — so deleting
 * an entry to quiet something fails just as loudly as adding an unbacked one,
 * and deleting the covering test fails too. An inventory you can empty is not an
 * inventory.
 */
export const CHAT_COMMANDS_COVERED_ELSEWHERE: ReadonlyArray<{
  readonly command: string
  /** Why this gate cannot see it. Must name the mechanism, not the symptom. */
  readonly invisible_because: string
  /** Repo-relative test that DOES drive it at a real socket. Must exist. */
  readonly covered_by: string
}> = [
  {
    command: '/task',
    invisible_because:
      'Implemented as a receiver wrapper (`gateway/cores/tasks-chat-router.ts:109` ' +
      '`wrapWithTasksChatRouter`, returning `IncomingEventReceiver`) rather than a ' +
      'ChatCommandFilter, so the factory scan cannot match it by name or by return type. ' +
      'It also answers with a full `agent_message` envelope rather than a ' +
      '`chat_command_result`, so the probe assertion in `reachability.test.ts` would not ' +
      'recognise a correct answer either. Both differences exist so the Tasks Core can ' +
      'emit BUTTONS, which the filter result shape cannot carry.',
    covered_by: 'open/__tests__/open-task-command-wiring.test.ts',
  },
]

export const CHAT_COMMAND_EXCLUSIONS: ReadonlyArray<{
  readonly filter: string
  readonly why: string
}> = [
  {
    filter: 'buildChainedChatCommandFilter',
    why: 'The chain combinator itself. It claims no command of its own — it is the thing every probe above runs THROUGH, so the probes already prove it is composed.',
  },
  {
    filter: 'buildCalendarChatCommandDispatcher',
    why: 'The INNER half of `/cal` (gateway/cores/calendar-wiring.ts:87) — the object `buildCalendarChatCommandFilter` lazily imports and wraps at gateway/boot-chat-command-filters.ts:233-236, and it claims no command the outer filter does not already carry. It is excluded because it is COVERED, not because it is unprotected: the `/cal` probe above types the command end to end, and since the outer filter does nothing but lazily construct and delegate to this object, unwiring EITHER half now reds that probe. That is a change of kind from the previous note, which recorded this factory as inheriting an exclusion and left `/cal` unprotected at both ends. Note the name is `…Dispatcher`, not `…ChatCommandFilter`: the scan sees it only because it matches on the declared RETURN TYPE as well as the name.',
  },
]
