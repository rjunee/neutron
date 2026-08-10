# Naming the account behind a reading (2026-08-09)

The usage series has carried an `account_label` column since it was created, null on
every row. This is the reader that fills it — the Open half of the owner-approved
per-account breakdown.

## The sidecar

`<same dir as .credentials.json>/.credentials.meta.json`:

```json
{ "label": "acct-2", "fingerprint": "<first 12 hex of sha256(token)>" }
```

Written by whatever swaps the credential — a hosting layer, a shell script, a
self-hoster's cron. Same reasoning as reading `.credentials.json` itself: requiring
an HTTP call would mean the rotator has to know this instance's port, bearer token
and readiness to deliver one string.

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
these tokens are long and random, the sidecar is mode 0600 beside the credentials file it
describes, and anyone who can read it can already read the token itself. But that is a
property held up by three surrounding facts, each of which a later change could quietly
remove — and it is a strictly worse thing to depend on than a correct primitive.

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
This runs once per usage reading, a minute apart. `N=4096` is far above a bare SHA-256 per
guess and invisible on the tick; the default `N=16384` would burn ~100 ms of CPU every
minute forever to render a label.

📌 **A cross-process contract described in prose will drift, and the drift is silent.** The
file header spelled out "first 12 hex of sha256(token)" — a writer trusting that line would
now produce a digest this reader rejects, and the only symptom is that labels quietly stop
appearing. The header now points at the function as the single definition and says that
Managed's rotator should IMPORT it through `vendor/neutron` rather than reimplement it.
That also removes the duplicated-KDF-constants hazard the writer half would otherwise
carry.
