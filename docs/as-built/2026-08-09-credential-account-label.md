# Naming the account behind a reading (2026-08-09)

The usage series has carried an `account_label` column since it was created, null on
every row. This is the reader that fills it — the Open half of the owner-approved
per-account breakdown.

## The sidecar

`<same dir as .credentials.json>/.credentials.meta.json`:

```json
{ "label": "acct-2", "fingerprint": "<12 hex — call credentialFingerprint>" }
```

Written by whatever swaps the credential — a hosting layer, a shell script, a
self-hoster's cron. Same reasoning as reading `.credentials.json` itself: requiring
an HTTP call would mean the rotator has to know this instance's port, bearer token
and readiness to deliver one string.

**A writer MUST create it mode 0600**, like the credentials file it sits beside. This
was previously stated as an observed fact in the security note below and required of
nobody, which is how a security argument turns into a wish: the reader cannot make a
writer do it, so the requirement has to live here, in the contract, or it does not
exist. The reader deliberately does NOT enforce it — refusing a loosely-permissioned
sidecar would drop the label silently, and a silent drop is the one failure mode this
whole feature is arranged to avoid.

**The fingerprint has exactly one definition, and it is the function** —
`credentialFingerprint` in `open/credential-label.ts`. A writer must call it
(Managed's rotator imports it through `vendor/neutron`), never reimplement it from a
description here. See the closing note: this line previously spelled the algorithm
out, and spelling it out is the drift.

## ⚠️ The fingerprint is the whole design

The label is used ONLY when its fingerprint matches the token actually resolved.

**A missing label is harmless** — it renders "active credential", which is true. **A
STALE label is not.** A sidecar left behind by a previous swap would attach the old
account's name to the new account's reading, producing a graph that looks right,
reads right, and sends the owner to move quota away from an account that was never
under load. A mismatch degrades to null, silently and deliberately.

It also means a writer cannot half-succeed: install a token without updating the
sidecar and labels stop appearing rather than going stale invisibly.

## Resolved WITH the credential, never separately

`resolveActiveCredential` returns `{ token, account_label }` from ONE call. If those
came from two calls, a swap landing between them would pair one account's reading
with another's name — the bug the fingerprint exists to catch, reintroduced at a
different layer. A test asserts the label reader is asked about the same token that
was resolved, and nothing else.

The default label reader deliberately does NOT inherit `deps.readFile`. Otherwise a
test could pass by feeding the credentials blob to the label parser, and the seam
would look isolated while sharing one source.

## The mutant that survived first

Dropping the fingerprint check fails a test immediately. But making the MONITOR
persist `account_label: null` while the resolver kept working correctly passed
everything — the "resolved but never carried" shape, one layer along from "built but
never wired". Now `usage-sample-persistence.test.ts` asserts the label arrives at
the sink AND lands on the row, and that mutant dies.

## Not in this change

Nothing writes a sidecar yet. Until something does, every label is null and the
behaviour is exactly what shipped before — which is the point of landing the reader
first: the writer can appear without a second deploy of this code.

---

## The fingerprint is scrypt, not SHA-256 — CodeQL was right

`credentialFingerprint` hashed the live OAuth token with a bare SHA-256, and CodeQL's
`js/insufficient-password-hash` failed the PR on it. Open's `main` ruleset requires that
check, so the PR could not merge.

**The finding is correct in form.** The input is a credential, and a bare digest of a
credential is one dictionary away from being reversible. It is not exploitable *here*:
these tokens are long and random, the sidecar is *required* to be mode 0600 beside the
credentials file it describes (§ The sidecar — a requirement on writers, not something this
reader can check), and anyone who can read it can already read the token itself. But that
is a property held up by three surrounding facts, each of which a later change could
quietly remove — one of them by a writer simply not honouring a contract — and it is a
strictly worse thing to depend on than a correct primitive.

Arguing it down was the alternative, and it would have left a permanently red REQUIRED
check on a public repo. A standing red gate trains everyone to merge past it, and it hides
whatever fails behind it — the lesson `SPEC.md` already records from the Managed
`Typecheck` step that masked a completely dead roadmap gate for days.

So: `scryptSync(token, FIXED_SALT, 6)` at `N=4096, r=8, p=1`. Output shape is unchanged
(12 hex), so the sidecar format and every test assertion still hold.

**The salt is fixed, and that is doing less than a salt usually does.** A random per-write
salt is right when you STORE the digest and verify against it later. Here two independent
processes must reach the SAME 12 characters from the same token sharing nothing but the
token, so a random salt is impossible. It buys domain separation and nothing more, and the
docblock says exactly that rather than implying per-write uniqueness.

**Cost was chosen against the call pattern, not copied from a password-storage example.**
This runs once per usage reading, a minute apart, and `N=4096` is far above a bare SHA-256
per guess.

It is **not** "invisible on the tick", which is what both this section and the code docblock
originally claimed while also attributing a ~100 ms figure to the default `N`. Both halves
were wrong. MEASURED under bun 1.3.9, `scryptSync` at these parameters: **~73 ms
steady-state, ~280 ms on the first call**, synchronously, on the event loop. The default
`N=16384` is ~534 ms; `N=1024` (~5 ms) is the setting that would actually cost "a few
milliseconds".

What bounds the cost today is WHERE it is paid, not how small it is: the fingerprint is
reached only after a sidecar has been found, read, parsed and found to carry a plausible
label, so a box with no sidecar — every box, until something writes one — never calls it.
The stall becomes real on the first tick after a writer ships, and it arrives **without this
file changing**. Whoever lands that writer decides then whether to lower `N` or memoise per
token, on these numbers rather than on a comment that said there was nothing to weigh.

📌 **A cross-process contract described in prose will drift, and the drift is silent.** The
file header spelled out "first 12 hex of sha256(token)" — a writer trusting that line would
now produce a digest this reader rejects, and the only symptom is that labels quietly stop
appearing. The header now points at the function as the single definition and says that
Managed's rotator should IMPORT it through `vendor/neutron` rather than reimplement it.
That also removes the duplicated-KDF-constants hazard the writer half would otherwise
carry.

**And it drifted a second time, in this document, in the same change that recorded the
lesson.** The code header was corrected while § The sidecar above still printed
`sha256(token)` — and that section, not the header, is where a rotator author looks for
the format. The stale line therefore survived in the more load-bearing of the two places.
Fixing the code and leaving the doc is not half a fix; for a contract whose only consumer
is an external writer, the doc *is* the interface. Both now point at the function, and the
plan doc's Tier-1 contract (`docs/plans/2026-08-09-model-usage-dashboard.md`) has been
corrected too — it still described a bare `{"label": "acct-2"}` with no fingerprint at
all, which the reader rejects.
