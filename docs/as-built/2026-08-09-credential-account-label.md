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
