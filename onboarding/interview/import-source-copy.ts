/**
 * @neutronai/onboarding — LIVE import-source copy + deterministic
 * source-token detector (K11a3 extraction).
 *
 * Moved out of `interaction-mode.ts` verbatim (SYMBOL move, no logic
 * changes) — this is the subset of that module which is genuinely LIVE
 * across the import upload-race seam (`engine.ts` `notifyImportUpload` /
 * `notifyImportUploadLocked` and `engine-import-routing.ts`), as opposed to
 * the buttons-only/mixed/freeform interaction-mode classifier, most of
 * which dies in the later K11b1 deletion. Zero-import leaf — every symbol
 * here is pure string logic with no dependency on the rest of the
 * onboarding module graph.
 */

/**
 * Short reassurance line emitted right before the import-source SELECTION
 * buttons are re-rendered when a user types ANY non-upload freeform at
 * `import_upload_pending` (ISSUES #84). Worded for a general "bring back the
 * options" intent — the engine no longer distinguishes an explicit switch
 * from a bare clarification; both route here. Hyphen, not em-dash, per the
 * draft-as-Sam rule.
 */
export const IMPORT_SOURCE_SWITCH_ACK =
  'No problem - pick the service you would like to import from:'

/**
 * Surfaced when a ZIP finishes uploading AFTER the user typed freeform at
 * `import_upload_pending` (which reroutes to the source picker, phase
 * `ai_substrate_offered`) AND the uploaded source no longer matches the
 * source we have on record. We deliberately do NOT silently import the
 * stale file — but we also never drop it with a silent ok:true.
 *
 * COPY HONESTY (Argus r2 BLOCKER): tapping a service routes through
 * `advanceFromAiSubstrateOfferedToUpload`, which re-emits upload
 * instructions for the chosen service — it does NOT consume the ZIP that
 * just landed. So the copy must NOT promise auto-run ("I will run it");
 * the landed file is for the OTHER service and the user has to upload the
 * chosen service's export afresh. We set that expectation plainly.
 * Hyphen, not em-dash, per the draft-as-Sam rule.
 */
export const LATE_UPLOAD_SOURCE_MISMATCH_NOTICE = (
  source: 'chatgpt' | 'claude',
): string =>
  `Got your ${source === 'chatgpt' ? 'ChatGPT' : 'Claude'} upload - but it looks like you were switching services. Tap the service you want above to start its import, then upload that service's export again so I can run it.`

/**
 * Negation cues that turn a source MENTION into a NON-switch ("I don't have a
 * GPT export", "no claude export here"). Kept apostrophe-and-bare so both
 * "don't" and "dont" match after lowercasing.
 */
const NEGATION_TOKENS = new Set([
  "don't",
  'dont',
  'not',
  'no',
  'never',
  "haven't",
  'havent',
  "won't",
  'wont',
  "can't",
  'cant',
  'cannot',
  'without',
  "didn't",
  'didnt',
  "doesn't",
  'doesnt',
])

/**
 * Affirmative "keep / switch" verbs. When one of these follows a CLAUSE
 * BOUNDARY after a negation, the negation does NOT apply to the source — the
 * user opened a fresh clause that re-affirms it ("no, keep chatgpt" / "no,
 * switch to claude").
 *
 * Argus r2 BLOCKER: this set deliberately EXCLUDES direct-object verbs
 * (want / use / do / go / try / pick / choose / prefer / change / rather).
 * Those are exactly the verbs people put DIRECTLY AFTER a negation to DECLINE
 * a named source — "I don't want claude" / "don't use gpt" / "never use
 * chatgpt". Treating them as affirmations re-opened the ISSUES #98 dead-end:
 * the decline recorded a bogus switch-intent, which then REFUSED the user's
 * own legitimate upload of the staged source. Only evidence-backed
 * keep/switch verbs survive (Argus r2 MINOR: trim the speculative 14-entry
 * list).
 */
const AFFIRM_VERBS = new Set([
  'keep',
  'stick',
  'stay',
  'leave',
  'switch',
  'instead',
])

/**
 * Clause-boundary tokens (comma / "but" / "actually"). The negation override
 * fires ONLY when an {@link AFFIRM_VERBS} verb sits AFTER one of these between
 * the negation and the source mention — i.e. the affirm clearly begins a new
 * "keep the current one" clause ("no, keep X"), NOT a continuation of the
 * negation ("don't keep X", which still declines X). Conservative by design
 * (Argus r2 BLOCKER): a missed switch is harmless (the user just taps the
 * button); a false affirm refuses a real upload.
 */
const CLAUSE_BOUNDARIES = new Set([',', 'but', 'actually'])

/**
 * True when the source mention at `matchIndex` is governed by a leading
 * negation in the preceding text (so the user is NOT switching to it). The
 * nearest preceding negation cue wins, UNLESS a clause boundary followed by an
 * affirmative keep/switch verb sits between it and the mention — that opens a
 * new clause re-affirming the source ("no, keep X" / "no, switch to X"). A
 * bare affirm with no clause boundary ("don't keep X") stays negated.
 */
function mentionIsNegated(lowerText: string, matchIndex: number): boolean {
  const before = lowerText
    .slice(0, matchIndex)
    // Isolate commas as their own tokens so a clause boundary survives the
    // punctuation strip below (otherwise "waiting," tokenizes as one word).
    .replace(/,/g, ' , ')
    .replace(/[^a-z0-9',\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
  let negIdx = -1
  for (let i = 0; i < before.length; i++) {
    if (NEGATION_TOKENS.has(before[i] as string)) negIdx = i
  }
  if (negIdx === -1) return false
  let sawBoundary = false
  for (let i = negIdx + 1; i < before.length; i++) {
    const w = before[i] as string
    if (CLAUSE_BOUNDARIES.has(w)) {
      sawBoundary = true
      continue
    }
    if (sawBoundary && AFFIRM_VERBS.has(w)) return false
  }
  return true
}

/**
 * Deterministic (no-LLM) source-token detector for the import freeform
 * reroute. Returns the single AI substrate UNAMBIGUOUSLY named in the
 * user's freeform text, or `null` when the text names neither source,
 * BOTH (ambiguous), or names one only under a leading negation.
 *
 * Used to record "switch-intent" when a user types an explicit switch at
 * `import_upload_pending` (ISSUES #98). The reroute to the source picker
 * fires on ANY freeform (ISSUES #84 — the verb-gated detector was retired),
 * so this detector does NOT gate the reroute; it only annotates WHICH source
 * the user named, so a late upload of the ABANDONED source is not
 * auto-honored after the user signalled a move to the other one.
 *
 * Word-boundary matching keeps `gpt` from matching inside other words and
 * `claude` from matching substrings; `openai` / `anthropic` are accepted as
 * the vendor synonyms users actually type.
 *
 * Negation-aware (Argus r1b IMPORTANT): a bare word-boundary match recorded a
 * false switch-intent on incidental/negated mentions ("I don't have a GPT
 * export" while mid-Claude-upload), which then REFUSED the user's own
 * legitimate Claude upload. A source mention governed by a leading negation
 * (don't / no / not / haven't …) is ignored UNLESS a clause boundary + an
 * affirmative keep/switch verb re-affirms it ("no, keep chatgpt"). The override
 * is deliberately CONSERVATIVE (Argus r2 BLOCKER): a negation followed by a
 * direct-object verb ("I don't want claude" / "don't use gpt" / "never use
 * chatgpt") stays negated → null, so a decline of the other service never
 * records a bogus switch-intent that refuses the user's real upload. See
 * {@link mentionIsNegated}.
 */
export function detectImportSourceMention(
  text: string,
): 'chatgpt' | 'claude' | null {
  const t = text.toLowerCase()
  // Scan ALL occurrences of each source, not just the first (Argus r3 +
  // Codex). A source is MENTIONED if ANY of its occurrences is non-negated,
  // so "I dont have the claude export yet, but switch to claude" (the first
  // `claude` is negated, the second affirmed) still records a claude switch.
  // A source whose ONLY occurrence is negated ("I dont want claude") stays
  // unmentioned → null, preserving the r2 conservative-decline behavior.
  const mentionsChatgpt = anyMatchAffirmed(
    t,
    /\bchat\s?gpt\b|\bopenai\b|\bgpt\b/g,
  )
  const mentionsClaude = anyMatchAffirmed(t, /\bclaude\b|\banthropic\b/g)
  if (mentionsChatgpt && !mentionsClaude) return 'chatgpt'
  if (mentionsClaude && !mentionsChatgpt) return 'claude'
  return null
}

/**
 * True when `pattern` (a global regex) has at least one match in `lowerText`
 * that is NOT governed by a leading negation. A source is treated as named
 * when any single occurrence stands un-negated, even if other occurrences of
 * the same source are negated. Returns false when the source is absent or
 * every occurrence is negated. See {@link detectImportSourceMention}.
 */
function anyMatchAffirmed(lowerText: string, pattern: RegExp): boolean {
  for (const m of lowerText.matchAll(pattern)) {
    if (!mentionIsNegated(lowerText, m.index)) return true
  }
  return false
}
