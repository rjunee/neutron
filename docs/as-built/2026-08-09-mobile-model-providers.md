# Codex and Kimi are connectable from a phone

## The gap, stated accurately

The gateway's Codex surface is **explicitly app-scoped** — `/api/app/codex-auth` — and
the **web** client has used it since it was built: `IntegrationsTab` carries the
primary account-wide connect and `SettingsTab` carries a per-project override.

**The mobile app had no client and no screen for it.** So an owner holding only a
phone could not connect the cross-model reviewer at all. The reference deployment
works solely because provisioning wrote the credential onto the filesystem directly,
which is not something a self-hoster can do.

*A carried note of mine said "Codex has a fully-built backend and zero UI". The `app/`
half of that was grep-verified and correct; the general claim was not — the web has
had a full Codex UI all along. Checking before repeating it narrowed the work from
"build the whole thing" to "mirror what one client already does".*

Kimi was reachable in principle — but only by knowing the exact service id and typing
it into a free-text "Service (e.g. openai)" box.

## What changed

A **Model providers** section on the mobile Integrations screen, above *Shared
credentials* so the free-text form reads as the escape hatch it is:

- **Codex** — status with its consequence spelled out, paste `~/.codex/auth.json`,
  disconnect. New `app/lib/codex-credential-client.ts`, global routes only.
- **Kimi K3** — paste a key, remove it, and a status line derived from the shared
  credential list.

## Three decisions

**The Kimi row writes through the SAME store the free-text form uses.** A named row
with its own storage path would mean a key entered here and a key entered there
behaved differently — exactly the split that makes a settings screen untrustworthy.
The row is a labelled affordance over one code path, and its status is *derived* from
the shared list rather than tracked separately, so a key added or removed by either
control is reflected by both.

**The service id is a repeated literal, not an import** — the app bundle is
deliberately free of workspace dependencies. That makes the string load-bearing: a
mismatch would store the key where nothing reads it, the row would look like it
worked, and the reviewer would stay silent. The test asserts the id for that reason.

**Global routes only.** A Codex subscription is one account for the whole instance.
The per-project override stays a web-only advanced control; putting it on a phone
would mean explaining resolution precedence on a 6-inch screen to solve a problem
nobody has.

Status text names the **consequence**, not the state — "reviews run without a second
model family" rather than "not connected" — because an owner cannot be expected to
know what an unconnected Codex costs them.

## Verification

`app/__tests__/model-providers-reachable.test.tsx` — 12 tests that **press the real
controls on the real screen**. A source check confirms a component mentions a handler;
it cannot tell a rendered-and-wired control from a rendered-and-inert one, and this
repo has shipped precisely that bug.

**Four mutants, each caught:** the Connect button rendered but inert (2 tests) · the
Kimi key stored under the wrong service id (1) · the status never fetched on mount
(4) · the Kimi row not deriving its state from the shared list (1).

Also asserted: an empty box sends nothing; an expired credential offers *both* replace
and clear; the paste box is hidden while connected; the server's error is shown
verbatim (pasting a metered API key instead of a subscription bundle is the common
mistake, and the gateway's reply is the only text that says which file to paste); and
an unreachable server shows not-connected **without sending a DELETE** — a failed
status read must never look like a credential to re-enter.

Two harness lessons, both hit here first: **type through the prototype value setter**,
because React tracks the node's value and skips a change it thinks it already has, so
a direct assignment leaves the input looking typed with state unchanged. And
**unmount between tests** — the queries are document-scoped (a `Modal` portals outside
the mounted subtree), so a previous test's leftover DOM is indistinguishable from this
test's, which is what two failures actually were.

Typecheck 51/51 · lint clean · byte-scanned.
