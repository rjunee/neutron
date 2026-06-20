/**
 * @neutronai/onboarding — final-handoff prompt builders (2026-05-28 sprint).
 *
 * The post-onboarding handoff message the user sees in the General topic
 * after `wow_fired → completed`. Replaces the prior "engine just stops
 * emitting" silence Sam flagged in his 2026-05-28 walkthrough.
 *
 * Four shapes:
 *
 *   1. INITIAL handoff — 3-button + freeform prompt:
 *        [A] Get the mobile app
 *        [B] Connect a Telegram bot
 *        [C] Skip for now
 *      Telegram-signup variant collapses to 2 buttons (no Telegram-bot
 *      CTA — they're already on Telegram).
 *
 *   2. MOBILE-APP follow-up — surfaces the MOBILE_APP_URL install page
 *      (the `/mobile` Add-to-Home-Screen walk-through — ISSUES #208)
 *      plus a single "Done" affordance. The prompt is informational;
 *      tapping Done silently acks.
 *
 *   3. TELEGRAM-BIND follow-up — surfaces the per-instance
 *      `https://t.me/<bot>?start=bind_<token>` deep link + a Done
 *      affordance. The bot-side `/start bind_<token>` handler is a
 *      follow-up sprint — see ISSUES.md.
 *
 *   4. SKIP follow-up — short "you can come back to this later" ack so
 *      the chat surface registers a final agent line and then goes
 *      quiet. (ISSUES #208: the copy must not promise a settings
 *      surface — none exists — nor a chat interaction, since freeform
 *      on shape 'skip' routes to null.)
 *
 * The phase stays at `completed` across every button tap; the engine
 * rotates `active_prompt_id` between the initial and follow-up shapes
 * but never advances the phase enum.
 */

import type { PhasePromptSpec } from './phase-prompts.ts'
import { MOBILE_APP_URL, buildTelegramBindDeepLink } from './final-handoff-config.ts'

export const FINAL_HANDOFF_MOBILE_APP_CHOICE = 'final-mobile-app'
export const FINAL_HANDOFF_TELEGRAM_BIND_CHOICE = 'final-telegram-bind'
export const FINAL_HANDOFF_SKIP_CHOICE = 'final-skip'
export const FINAL_HANDOFF_DONE_CHOICE = 'final-done'

/**
 * Metadata tag set on every final-handoff prompt the engine emits.
 * Callers in `engine.ts` use this tag to distinguish a final-handoff
 * button tap from any other inbound on a `completed` row (e.g. a stale
 * pre-handoff prompt left over from a back-compat run).
 */
export const FINAL_HANDOFF_METADATA_TAG = 'final_handoff'

/**
 * Sub-shape discriminator stamped on `metadata.final_handoff_shape` so
 * the engine can route a button tap to the correct handler without
 * re-deriving the shape from the choice value alone.
 */
export type FinalHandoffShape = 'initial' | 'mobile-app' | 'telegram-bind' | 'skip'

export interface BuildFinalHandoffPromptSpecInput {
  /**
   * 'app-socket' (web chat) → 3 buttons. 'telegram' → 2 buttons (no
   * Telegram-bot CTA). The engine forwards `channel_kind` from the
   * inbound directly.
   */
  channel_kind: 'app-socket' | 'telegram'
  /**
   * The user's first name when known. Used to soften the opening
   * sentence; absent → fall back to "You're all set."
   */
  user_first_name: string | null
  /**
   * Confirmed project names from `phase_state.primary_projects_confirmed`.
   * Surfaces in the body as a comma-separated inline list. When empty
   * (skip path or an owner whose projects_proposed confirm landed empty)
   * the body uses the no-projects variant.
   */
  project_names: ReadonlyArray<string>
}

/**
 * Build the initial 3-button (web) / 2-button (telegram) handoff
 * prompt. Phase is `completed` (terminal); the engine emits this
 * prompt directly without going through the auto-skip walker.
 */
export function buildFinalHandoffPromptSpec(
  input: BuildFinalHandoffPromptSpecInput,
): PhasePromptSpec {
  const project_list = input.project_names.filter((n) => n.trim().length > 0)
  const count = project_list.length
  // #309 fix #3 (2026-06-19, owner live-dogfood) — do NOT lead with a
  // premature "You're all set." The brief (wow action 01) fires moments
  // before this guide; the old greeting declared "all set" while the
  // brief's own closing question was still hanging, so the two messages
  // talked over each other. The brief no longer poses a dangling question,
  // and this guide opens as a calm hand-off into action rather than a
  // triumphant terminal receipt. The closing invite below
  // ("What's something I can help you with right now?") is what the owner
  // likes — it stays.
  const greeting =
    typeof input.user_first_name === 'string' && input.user_first_name.length > 0
      ? `Everything's ready, ${input.user_first_name}.`
      : "Everything's ready."
  // Items 7 + 9 (2026-06-19, owner live-dogfood) — the final General
  // message used to RE-LIST every project (duplicating the wow guide
  // message #1 that already walked the week-ahead / projects-on-deck /
  // overnight queue) and then offered a "Connect a Telegram bot" CTA
  // (Telegram is not built yet) plus a "Skip for now" dead-end. Replace
  // with a SHORT close that (a) points the user LEFT to start interacting
  // — without re-enumerating the projects — and (b) ends with an
  // ACTIONABLE invite that pulls them into real work, so the General
  // topic doesn't dead-end on "you're all set." The mobile-app affordance
  // is preserved (the only remaining button); Telegram + Skip are gone.
  const projects_sentence =
    count === 0
      ? 'This General topic is for anything not tied to a specific project, and you can spin up new projects from the sidebar whenever you want.'
      : 'Your projects are on the left. Click into each one and start chatting there; each is already loaded with what I learned about it during setup. This General topic is for anything not tied to a specific project.'
  // Keep the "tweak later" promise but condensed — no project re-list.
  const tweak_paragraph =
    count === 0
      ? 'Anything you want to change about how I work, what you call me, my personality, just ask.'
      : 'Want to delete, rename, or merge a project, or change how I work? Just ask ("rename Foo to Bar", "drop the Yard project", "merge X into Y").'
  // Item 9 — close with an actionable invite, not a receipt.
  const invite = "What's something I can help you with right now?"
  const body = `${greeting} ${projects_sentence}\n\n${tweak_paragraph}\n\n${invite}`
  // Item 7 — mobile-app is the ONLY remaining affordance (Telegram + Skip
  // removed). On the Telegram channel the user is already mobile, so even
  // that is dropped and the close is buttons-free (they answer the invite
  // by typing).
  const options =
    input.channel_kind === 'telegram'
      ? []
      : [
          {
            label: 'A',
            body: 'Get the mobile app',
            value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
          },
        ]
  return {
    phase: 'completed',
    body,
    options,
    allow_freeform: true,
    next_phase_on_default: 'completed',
    metadata: {
      [FINAL_HANDOFF_METADATA_TAG]: true,
      final_handoff_shape: 'initial' satisfies FinalHandoffShape,
      final_handoff_channel: input.channel_kind,
    },
  }
}

/**
 * Build the mobile-app follow-up prompt. Surfaces MOBILE_APP_URL plus a
 * Done affordance the user taps once they have Neutron on their phone
 * (or decided to come back to it later).
 *
 * ISSUES #208 honesty fix — the previous copy claimed "grab the iOS /
 * Android apps", but no native app is published (the Expo app in `app/`
 * has no store binding yet). The `/mobile` page the URL now resolves to
 * walks the user through the install path that exists TODAY (phone-
 * browser + Add to Home Screen) and renders store links as coming-soon
 * placeholders, so this copy points at the page without over-claiming.
 *
 * Open-surface honesty fix (Argus PR #15, 2026-06-13) — `mobileAppUrl`
 * defaults to the env-derived `MOBILE_APP_URL`, which is the EMPTY STRING
 * on a self-hosted Open install that hasn't set `NEUTRON_WEB_APP_BASE`.
 * With no page to point at, the follow-up would render a bare "Open that
 * link on your phone" with NO link above it — the repo-forbidden
 * phase-prompt-lies-to-user pattern. So when the resolved URL is empty we
 * return `null`: the caller (`consumeFinalHandoffChoice`) treats a null
 * spec as "suppress the follow-up entirely" and emits nothing. The URL is
 * a parameter (not read straight from the module constant) so the engine
 * can inject a configured value and tests can exercise BOTH the populated
 * and empty branches despite `MOBILE_APP_URL` being frozen at module load.
 */
export function buildFinalHandoffMobileAppFollowupPromptSpec(
  mobileAppUrl: string = MOBILE_APP_URL,
): PhasePromptSpec | null {
  const url = mobileAppUrl.trim()
  if (url.length === 0) return null
  const body =
    `${url}\n\n` +
    'Open that link on your phone — it walks you through putting Neutron on your home screen so it opens like an app. ' +
    'Native iOS / Android apps are in the works, and the same page will link them the moment they ship. ' +
    'If you would rather just stay on the web for now, tap Done — you can always come back to this later.'
  return {
    phase: 'completed',
    body,
    options: [
      {
        label: 'A',
        body: 'Done',
        value: FINAL_HANDOFF_DONE_CHOICE,
      },
    ],
    allow_freeform: true,
    next_phase_on_default: 'completed',
    metadata: {
      [FINAL_HANDOFF_METADATA_TAG]: true,
      final_handoff_shape: 'mobile-app' satisfies FinalHandoffShape,
      final_handoff_mobile_app_url: url,
    },
  }
}

export interface BuildFinalHandoffTelegramBindFollowupPromptSpecInput {
  bot_username: string
  bind_token: string
}

/**
 * Build the Telegram-bind follow-up prompt. Surfaces the per-instance
 * `t.me/<bot>?start=bind_<token>` deep link. The bot-side handler that
 * actually consumes the token (`/start bind_<token>`) is a follow-up
 * sprint — see ISSUES.md "Telegram-bot bind-listener".
 */
export function buildFinalHandoffTelegramBindFollowupPromptSpec(
  input: BuildFinalHandoffTelegramBindFollowupPromptSpecInput,
): PhasePromptSpec {
  const link = buildTelegramBindDeepLink({
    bot_username: input.bot_username,
    bind_token: input.bind_token,
  })
  const body =
    `${link}\n\n` +
    'Open the link, tap Start inside Telegram, and the bot will bind itself to your workspace. ' +
    'Once it is connected you can chat with the same agent from anywhere Telegram works. ' +
    'Tap Done when you are back.'
  return {
    phase: 'completed',
    body,
    options: [
      {
        label: 'A',
        body: 'Done',
        value: FINAL_HANDOFF_DONE_CHOICE,
      },
    ],
    allow_freeform: true,
    next_phase_on_default: 'completed',
    metadata: {
      [FINAL_HANDOFF_METADATA_TAG]: true,
      final_handoff_shape: 'telegram-bind' satisfies FinalHandoffShape,
      final_handoff_telegram_bind_link: link,
    },
  }
}

/**
 * Build the skip-ack follow-up prompt. Sent when the user taps
 * `[C] Skip for now` on the initial handoff. Phase stays at `completed`
 * and the active_prompt_id is rotated to this row so a stray re-tap on
 * the initial buttons is non-destructive.
 */
export function buildFinalHandoffSkipFollowupPromptSpec(): PhasePromptSpec {
  // NOTE: this copy must NOT promise a chat interaction —
  // `routeFinalHandoffFreeform` returns null for shape 'skip', so a
  // typed "ok put Neutron on my phone" after skipping gets no follow-up.
  const body =
    'Cool — you can always come back to the mobile setup or Telegram connect later. ' +
    'For now, click a project on the left and let us dig in.'
  return {
    phase: 'completed',
    body,
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'completed',
    metadata: {
      [FINAL_HANDOFF_METADATA_TAG]: true,
      final_handoff_shape: 'skip' satisfies FinalHandoffShape,
    },
  }
}

/**
 * Map a freeform reply on a final-handoff prompt to a concrete choice
 * value. Pure keyword heuristic — covers the obvious shapes
 * ("mobile" / "app" / "iOS" / "skip" / "later" / "telegram" / "bot")
 * and returns `null` for anything ambiguous so the engine can transcript-
 * append the reply without firing a follow-up.
 *
 * Shape-aware: when the user is sitting on the `mobile-app` or
 * `telegram-bind` follow-up, the only meaningful freeform reply is
 * "done" / "ok" / "thanks" which routes to the Done handler. The initial
 * shape's keyword set covers all three handlers.
 */
export function routeFinalHandoffFreeform(
  text: string,
  shape: FinalHandoffShape,
): string | null {
  const t = text.trim().toLowerCase()
  if (t.length === 0) return null
  if (shape === 'mobile-app' || shape === 'telegram-bind') {
    if (/(^|\b)(done|ok|okay|thanks|got it|gotcha|installed|sure)(\b|$)/.test(t)) {
      return FINAL_HANDOFF_DONE_CHOICE
    }
    if (/(^|\b)(skip|nevermind|never mind|cancel|back)(\b|$)/.test(t)) {
      return FINAL_HANDOFF_DONE_CHOICE
    }
    return null
  }
  if (shape === 'skip') return null
  // shape === 'initial'
  // Order matters — `telegram` should match before `mobile` so a reply
  // like "the telegram one" doesn't accidentally trip the mobile branch
  // via a stray substring.
  if (/(^|\b)(telegram|tg bot|connect.*bot|set.*up.*bot|t\.me|tg)(\b|$)/.test(t)) {
    return FINAL_HANDOFF_TELEGRAM_BIND_CHOICE
  }
  if (/(^|\b)(mobile|app|ios|android|phone|download|play store|app store)(\b|$)/.test(t)) {
    return FINAL_HANDOFF_MOBILE_APP_CHOICE
  }
  if (/(^|\b)(skip|later|not now|nope|no thanks|no thank you|nah|maybe later|i'?ll do this later|do this later)(\b|$)/.test(t)) {
    return FINAL_HANDOFF_SKIP_CHOICE
  }
  return null
}

function renderProjectInlineList(names: ReadonlyArray<string>): string {
  const trimmed = names.map((n) => n.trim()).filter((n) => n.length > 0)
  if (trimmed.length === 0) return ''
  if (trimmed.length === 1) return trimmed[0]!
  if (trimmed.length === 2) return `${trimmed[0]} and ${trimmed[1]}`
  return `${trimmed.slice(0, -1).join(', ')}, and ${trimmed[trimmed.length - 1]}`
}
