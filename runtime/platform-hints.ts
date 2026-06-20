/**
 * @neutronai/runtime — channel-specific platform hint fragments.
 *
 * Lifted from Hermes' `prompt_builder.py:PLATFORM_HINTS`. Each hint is a short
 * string fragment the system-prompt assembler concatenates into the final
 * prompt when the active channel matches. Centralised here so the assembler
 * stays oblivious to channel-specific quirks (Telegram length limits, CLI
 * ANSI rules, email signature etiquette, etc.).
 *
 * Add a new hint by:
 *   1. Append the literal name to the `KNOWN_PLATFORM_HINTS` tuple.
 *   2. Add the body to `HINTS`.
 *   3. Wire it into the per-channel selector below.
 *
 * Hints are deliberately small (one to three sentences each). Keep them tight
 * — the assembler concatenates many per turn and the prompt-cache prefix
 * benefits from short, stable text.
 */

/** All channel kinds Neutron's platform layer surfaces. Add a new channel by extending here + the selector. */
export type ChannelKind = 'telegram' | 'cli' | 'email' | 'discord' | 'slack' | 'web'

/**
 * The exhaustive list of named hint fragments. The same naming discipline as
 * `core-sdk` capabilities — adding a new hint REQUIRES extending this tuple
 * so any selector branch that omits it is a compile-time inconsistency.
 */
export const KNOWN_PLATFORM_HINTS = [
  // Telegram
  'telegram_message_format',
  'telegram_length_limit',
  'telegram_topics',
  'telegram_reactions',
  'telegram_inline_keyboards',
  'telegram_threading',
  // CLI / TUI
  'cli_no_emoji_default',
  'cli_terminal_width',
  'cli_ansi_safe',
  'cli_streaming_chunks',
  // Email
  'email_format_html_or_plain',
  'email_subject_required',
  'email_signature_block',
  'email_no_em_dash',
  'email_quoted_reply_context',
  // Discord
  'discord_embed_format',
  'discord_thread_context',
  // Slack
  'slack_block_kit',
  'slack_thread_ts',
  // Web (default — minimal hint set)
  'web_html_safe',
] as const

export type PlatformHintName = (typeof KNOWN_PLATFORM_HINTS)[number]

const HINTS: Record<PlatformHintName, string> = {
  telegram_message_format:
    'Telegram messages do NOT render markdown tables. Use bullet lists with bold labels instead. HTML mode is preferred over Markdown for safe inline formatting.',
  telegram_length_limit:
    'Telegram message bodies have a hard 4096-character limit (UTF-16 code units). When approaching the cap, split into multiple messages on a natural sentence boundary rather than mid-word.',
  telegram_topics:
    'You may be replying inside a forum topic — a sub-thread of a group chat. Respect the topic name as conversational context; do not address other topics unless explicitly asked.',
  telegram_reactions:
    'Use ack / typing reactions for low-information status (e.g. acknowledging receipt) instead of posting filler text.',
  telegram_inline_keyboards:
    'For approval prompts or multi-choice replies, prefer inline keyboards (buttons) over asking the user to type a free-form answer.',
  telegram_threading:
    'When continuing a specific thread of conversation, set reply_to_message_id so the UI threads correctly.',
  cli_no_emoji_default:
    'Default to NO emoji in CLI output unless the user has used emoji in their messages first. Plain ASCII reads cleanest in terminals.',
  cli_terminal_width:
    'Assume terminals are 80–120 columns wide. Wrap long output to fit; never assume the terminal will horizontally scroll cleanly.',
  cli_ansi_safe:
    'ANSI escape codes are OK only when stdout is a TTY. If the caller is capturing output, suppress them.',
  cli_streaming_chunks:
    'Stream tokens to stdout as they arrive — do NOT buffer the full response before printing. The user wants to see progress.',
  email_format_html_or_plain:
    'Default to plain text email. Use HTML only when the user has explicitly requested formatting or when an attached signature requires it.',
  email_subject_required:
    'Always include a Subject line. An empty subject is a deliverability risk and a UX failure.',
  email_signature_block:
    'Respect the owner\'s signature template — never substitute your own block. The signature is part of the user\'s brand voice.',
  email_no_em_dash:
    'Do not use em-dashes (—) when drafting email on the user\'s behalf. Use hyphens (-) instead. Em-dashes are a recognised AI tell and Sam has explicitly banned them in his outgoing mail.',
  email_quoted_reply_context:
    'When replying, preserve the quoted message context above your signature so the recipient has the conversation history inline.',
  discord_embed_format:
    'Discord supports rich embeds (title, description, fields, color). Prefer an embed over a long unstructured message when sharing structured data.',
  discord_thread_context:
    'You may be in a Discord thread (a child of a parent channel). Reply within the thread; do not promote messages back to the parent unless asked.',
  slack_block_kit:
    'Slack supports Block Kit for rich layouts (sections, dividers, buttons, fields). Prefer it over plain text for any structured data.',
  slack_thread_ts:
    'When continuing a Slack thread, include thread_ts so the message threads correctly. Top-level replies break the conversational locality the user expects.',
  web_html_safe:
    'Output that will render in a browser MUST escape user-provided strings. Never inline raw HTML from a tool result without sanitisation.',
}

/**
 * Resolve a hint by name. Returns the body string. Throws if `name` is not in
 * `KNOWN_PLATFORM_HINTS` (compile-time error in TS strict mode; runtime guard
 * for callers that bypass the type check via `as` casts).
 */
export function getPlatformHint(name: PlatformHintName): string {
  const body = HINTS[name]
  if (!body) throw new Error(`getPlatformHint: unknown hint ${JSON.stringify(name)}`)
  return body
}

/**
 * Channel → ordered list of hint names. The assembler concatenates them in
 * order so prompt-cache prefix stability is preserved across turns within the
 * same channel. New channels MUST get an entry — the switch is exhaustive.
 */
export function selectPlatformHints(channel: ChannelKind): PlatformHintName[] {
  switch (channel) {
    case 'telegram':
      return [
        'telegram_message_format',
        'telegram_length_limit',
        'telegram_topics',
        'telegram_reactions',
        'telegram_inline_keyboards',
        'telegram_threading',
      ]
    case 'cli':
      return ['cli_no_emoji_default', 'cli_terminal_width', 'cli_ansi_safe', 'cli_streaming_chunks']
    case 'email':
      return [
        'email_format_html_or_plain',
        'email_subject_required',
        'email_signature_block',
        'email_no_em_dash',
        'email_quoted_reply_context',
      ]
    case 'discord':
      return ['discord_embed_format', 'discord_thread_context']
    case 'slack':
      return ['slack_block_kit', 'slack_thread_ts']
    case 'web':
      return ['web_html_safe']
  }
}
