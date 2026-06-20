> ⚠️ **Pre-release — not recommended for production use yet. Watch / star this repo to be notified when it's ready.**

# Neutron

> **An agent harness for Claude Code.** Neutron orchestrates long-lived Claude
> Code sessions and gives them what a raw CLI session lacks on its own:
> persistent memory, projects, scheduled and autonomous jobs, reminders, and an
> always-on web interface (plus a mobile app). You run it yourself, on your own
> machine, backed by your own Claude subscription.

Neutron is a **self-hosted agent harness**. Claude Code does the thinking;
Neutron is everything *around* the thinking — it spawns and supervises your
Claude Code sessions, routes each turn to the right one, and wraps them in
durable state so your agent remembers you, works on a schedule, runs jobs while
you sleep, and is reachable from anywhere. Its job is **orchestration, not
inference**: persistent memory, projects, scheduled + autonomous work, reminders,
and the surfaces you reach it through.

The **primary interface is the bundled web app** (with a mobile app), served at
`http://127.0.0.1:7800/chat`. A **Telegram bot is an optional add-on** —
convenient for reaching your agent from your phone, but never required;
everything works through the web interface with no Telegram setup at all.

It interviews you when you first start it, builds a persistent memory of who you
are and what you're working on, and gets more useful the longer you use it. Your
data lives in plain files and a SQLite database on your own disk — nothing is
sent anywhere except the Claude Code sessions you authorize.

**License:** Apache License 2.0 (see [`LICENSE`](LICENSE)).

> **Status: pre-release.** The architecture described below is real and runs,
> but it is **not ready for general use** — expect rough edges, breaking changes,
> and incomplete pieces. `bun run start` boots the full single-owner harness (it
> opens the SQLite database, runs migrations, brings up the substrate machinery,
> and serves the in-chat onboarding interview + web chat at
> `http://127.0.0.1:7800/chat`, with `/healthz` for liveness), but please don't
> depend on it yet. Watch the repo for the first release.

---

## The one idea that explains everything: the agent *is* a Claude Code process

This is the single design decision the rest of the system hangs off.

Neutron does **not** call the Anthropic API directly. Every model "turn" — a
chat reply, an onboarding classification, a research synthesis — is dispatched
into a real **`claude` CLI process** (Claude Code, Anthropic's official agent
CLI) that Neutron spawns and supervises as a child process. Claude Code is the
**substrate**. Neutron's job is everything *around* judgment — channels, state,
scheduling, memory, buttons — and when judgment is needed it hands the turn to a
spawned Claude Code session that already brings the full agentic harness (tools,
file access, transcripts, resumability) for free.

Two consequences matter to you as a self-hoster:

- **You bring your own Claude.** Run `claude setup-token` locally, paste the
  result into onboarding, and Neutron attaches *your* Claude subscription. A
  long-lived interactive Claude Code session runs under your own subscription,
  billed as exactly what it is. An API-key fallback is also supported.
- **The model relationship is owned by the `claude` binary**, which holds every
  header, OAuth refresh, and signature. Neutron only feeds a turn in and takes
  one reply out — it never holds your credentials in its own HTTP client.

### The substrate is swappable

"The agent is a Claude Code process" describes the *default* backend, not a
lock-in. The runtime talks to a formal **substrate interface**
(`runtime/substrate.ts`: `Substrate.start(spec) → SessionHandle` plus an `Event`
stream), and backends are adapters under `runtime/adapters/<kind>/`:

- Claude Code is one adapter (`runtime/adapters/claude-code/`).
- Non-Anthropic adapters already conform (an OpenAI Responses-API backend and a
  Codex-CLI backend) — proof the seam is real, not theoretical.
- A new backend — your own GPU box serving open weights via vLLM, another
  vendor's API, a local inference server — is just a new adapter implementing
  `Substrate`. No core rewrite. This all lives in `runtime/`, which ships here,
  so bring-your-own-model is a first-class self-host capability.

### How a server talks to a CLI (the spawn-and-stdio model)

A terminal CLI has no HTTP API, so how does a long-running server hold a
conversation with one? Neutron runs a **persistent interactive REPL**:

- **One warm REPL per conversation.** A pool of long-lived interactive `claude`
  processes is kept keyed by `(instance, user, project, credential)`. The same
  process serves turn after turn, so conversation context lives *in* the
  process — no re-feeding history every turn.
- **The PTY is not the data path.** `claude` needs a real terminal to boot, so
  each REPL runs on a pseudo-terminal — but turn data never travels as
  keystrokes or screen-scraping. The gateway injects each turn through a small
  per-session loopback MCP server (the **dev-channel**); the REPL answers by
  calling that server's `reply(text)` tool, which resolves the in-flight turn as
  exactly one completion. A `Stop` hook guarantees one reply per turn.
- **Self-healing.** A registry records each session's resumable id and pid; a
  watchdog detects wedged or crashed REPLs and respawns them with `--resume`
  (context preserved), guarded against double-spawns and orphan duplication.

The runtime picture for one install: **one Bun gateway process** (deterministic
mechanics) supervising **a small pool of warm `claude` REPL children**
(judgment), talking over localhost MCP plumbing.

---

## Quickstart (self-host)

`bun run start` boots the **full product**: it opens your SQLite database, runs
migrations, brings up the substrate machinery, and serves the in-chat onboarding
interview + web chat at `http://127.0.0.1:7800/chat` (with `/healthz` for
liveness). On first visit the onboarding interview asks who you are, optionally
imports your ChatGPT/Claude/Gemini history, generates your agent's persona,
connects your Claude subscription, and opens your first projects.

Prerequisites:

- [Bun](https://bun.sh) (the runtime and package manager) — the installer offers
  to bootstrap it for you via Bun's official installer if it is missing.
- The [`claude`](https://docs.claude.com/en/docs/claude-code) CLI, authenticated
  with `claude setup-token` (or an Anthropic API key) — Neutron spawns `claude`
  as its LLM substrate. The installer detects your auth state: when run in an
  interactive terminal it runs `claude setup-token` for you (it opens a browser),
  captures the token, and writes it to your `.env`. When piped non-interactively
  (the `curl … | sh -s -- --yes` one-liner has no terminal for the browser
  sign-in) it can't complete that step, so it prints the exact command to run
  afterward and tells you auth is still required. You can also paste a token
  during onboarding in chat.
- The `gbrain` memory binary on `PATH` (optional; memory degrades fail-soft if
  absent — see [Memory](#memory-how-it-learns-you))
- A Telegram bot token from [@BotFather](https://t.me/BotFather) — optional; the
  bundled web chat works with no Telegram setup

### Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/rjunee/neutron/main/install.sh | sh -s -- --yes
```

The installer bootstraps Bun if it is missing, clones the repo into
`$HOME/neutron/core` (the **code** directory, alongside your `$HOME/neutron/data`
**data** directory), installs dependencies, writes a default `.env`, runs
migrations, installs a boot/crash system service + the `neutron` CLI, schedules
data backups, and **auto-starts the server** — ending with the working chat URL.
Because this one-liner is piped (no terminal for the browser sign-in), it does
**not** complete `claude setup-token` — it tells you auth is still required and
prints the exact command to run: `claude setup-token` (then add the printed
`CLAUDE_CODE_OAUTH_TOKEN=…` to your `.env` and run `neutron restart`), or set
`ANTHROPIC_API_KEY` in `.env`. Run the installer from an interactive terminal
(the manual path below) to have it connect your account for you. Opt-outs:
`--no-start`, `--no-service`, `--no-backup`, `--no-open`.

### Install (manual)

Clone it yourself and run the installer in place — it detects the checkout and
skips the clone:

```bash
git clone https://github.com/rjunee/neutron.git && cd neutron
sh install.sh          # installs, starts the service, prints the URL
```

Or do the same steps by hand. Use `$HOME`, not `~`, for paths in `.env` (Bun
does not expand a leading tilde):

```bash
bun install
cp .env.example .env       # every value has a default; edit what you need
bun run migrate            # create / migrate $NEUTRON_HOME/project.db (or NEUTRON_DB_PATH)
bun run start              # onboarding + chat at http://127.0.0.1:7800/chat
```

`bun run migrate` with no argument resolves the same database the server opens —
`NEUTRON_DB_PATH` if you set it, otherwise `$NEUTRON_HOME/project.db` — so the
migrate target and the server always agree.

Confirm it's up:

```bash
curl localhost:7800/healthz
# {"status":"ok","uptime_ms":1234}
```

### Controlling the service

The installer puts a `neutron` command on your PATH (`$HOME/.local/bin/neutron`)
that drives the launchd (macOS) / systemd (Linux) service that keeps Neutron
running across reboots and crashes:

```bash
neutron status     # is it running?
neutron restart    # e.g. after adding your Claude token to .env
neutron logs       # tail the server log
neutron stop       # stop it (it still boots next login)
neutron backup     # run a data backup now
neutron url        # print the chat URL
```

### Where your data lives

A single `$HOME/neutron` umbrella holds both halves:

- `$HOME/neutron/core` — the **code** directory (`NEUTRON_SRC_DIR`).
- `$HOME/neutron/data` — your **data** directory (`NEUTRON_HOME`): auth,
  registry, and the project database. This is the directory the git backup
  protects.
- `$HOME/neutron/data/project.db` — the default database (inside `NEUTRON_HOME`)
  when `NEUTRON_DB_PATH` is left unset. Set `NEUTRON_DB_PATH` to pin it elsewhere.

An older flat install (data at `$HOME/neutron`) is migrated into
`$HOME/neutron/data` automatically.

The gateway binds port 7800 (override with `NEUTRON_PORT`) and listens on
loopback only — `127.0.0.1` (override the bind address with `NEUTRON_HOST`).

### Backups

The installer schedules a deterministic, no-LLM git backup of your data dir
every 12 hours (`NEUTRON_BACKUP_INTERVAL` seconds to change). With no remote,
local git history alone is fully recoverable. Set `NEUTRON_BACKUP_REMOTE` to a
git URL to also push offsite on the same schedule.

### Uninstall

`uninstall.sh` stops + removes the service and backup timer, removes the
`neutron` CLI, stops a running gateway, and removes your code + data directories
(and the now-empty `$HOME/neutron` umbrella). It prints each path first and asks
before deleting — pass `--yes` to skip the prompt:

```bash
sh uninstall.sh            # from a checkout
```

> Exposing the gateway beyond `localhost` without configuring authentication is
> not yet safe. The gateway binds loopback (`127.0.0.1`) by default, so it is
> off your LAN out of the box — leave it that way until the auth gate ships
> fail-closed (tracked for the public launch). Only widen the bind (set
> `NEUTRON_HOST=0.0.0.0`) behind a trusted network you control.

---

## Architecture at a glance

The repo is a Bun workspace, grouped into five layers (bottom-up):

```
┌──────────────────────────────────────────────────────────────┐
│  PRODUCT SURFACES   onboarding/  app/  landing/  prompts/      │
├──────────────────────────────────────────────────────────────┤
│  CORES              core-sdk/  cores/sdk  cores/runtime        │
│                     cores/free/{notes,tasks,reminders,         │
│                       calendar,email,research,code-gen,        │
│                       agent-settings}                          │
├──────────────────────────────────────────────────────────────┤
│  MEMORY             gbrain-memory/  scribe/                    │
│                     runtime/entity-writer (privacy gate)       │
├──────────────────────────────────────────────────────────────┤
│  SUBSTRATE/RUNTIME  gateway/ (composition root)                │
│                     runtime/ (dispatcher + CC adapter +        │
│                       credential pool)                         │
│                     persistence/ migrations/ cron/             │
│                     reminders/ tasks/ tools/ mcp/ watchdog/    │
├──────────────────────────────────────────────────────────────┤
│  EDGE/TRANSPORT     channels/ (Telegram + buttons + app-ws)    │
│                     landing/ (web chat server + auth gate)     │
│                     auth/ (secrets + Claude paste-token)       │
│                     connect/ (share projects across instances) │
└──────────────────────────────────────────────────────────────┘
```

**Edge / transport.** `channels/` is the Telegram adapter (Bot API client,
webhook server, inline keyboards) plus the **button primitive** — `ButtonPrompt`
is the one cross-channel envelope for "agent asks, you tap or type", rendered
identically by Telegram, the web chat, and the app. `landing/` is the web chat
surface (a WS-based browser client, the Bun.serve server, the session-cookie
auth gate). `auth/` holds the secrets store and `max-oauth.ts` — the paste-token
client that attaches your Claude subscription.

**Substrate / runtime.** `gateway/` is the composition root: it opens the
database, runs migrations, wires the module graph, and binds the HTTP/WS
surface. `runtime/` is the substrate machinery — the `Substrate`/`Event`
contract, the Claude Code adapter, and the credential pool (threaded into each
spawn's environment, never the parent process). `persistence/` + `migrations/`
are the SQLite layer; `cron/` is an in-process scheduler with timezone math and
missed-fire catch-up (laptop slept through 09:00 → fires once on wake).

**Memory, Cores, product surfaces** — see below.

### One turn, end to end

You type *"what's blocking the launch?"* into Telegram:

```
 Telegram cloud
      │ webhook POST
      ▼
 channels (Telegram adapter) ─── one Bun process: your gateway
      │ normalize → inbound message
      ▼
 ChannelRouter → chat-bridge      (topic → (user, project) routing;
      │                            button taps short-circuit here)
      ▼
 substrate → persistent REPL pool
      │ warm REPL exists? reuse : spawn `claude` on a PTY
      ▼
 ┌─ claude (Claude Code, your subscription) ──────────────────┐
 │  • turn injected via the dev-channel MCP server            │
 │  • agent reads your project files, queries memory (MCP),   │
 │    calls Core tools (capability-gated), maybe sub-agents   │
 │  • answers by calling reply(text); one reply per turn      │
 └────────────────────────────────────────────────────────────┘
      │ reply resolves the turn → one completion event
      ▼
 chat-bridge → Telegram sendMessage
      │
      └─ (parallel, fire-and-forget) scribe extracts entities,
         facts, and relations from the turn → writeEntity →
         privacy gate ✓ → memory page + knowledge-graph edges
```

The gateway never talks to the Anthropic API; the `claude` child owns the model
relationship entirely. Memory is a side effect of talking — the extraction runs
*after* the reply path and can never block or break chat. The web and app paths
are identical from the chat-bridge down; only the edge differs.

---

## Data model

Everything lives under **`NEUTRON_HOME`** — `~/neutron/` by default (never
hardcoded; the location is resolved from the environment):

```
~/neutron/
├── STATUS.md          current state
├── project.db         one SQLite database = all operational state
├── entities/          compiled-truth pages (people / companies / concepts)
├── Memory/            the memory layer
├── Projects/          one folder per project — each a self-contained git repo
│   └── <project>/     (Cores add sidecars: notes/, code/, email/ …)
├── skills/  references/  inbox/
```

Three properties worth internalizing:

1. **One install = one SQLite database + one folder tree.** No shared database,
   no opaque store. Backup is copying the folder.
2. **Projects are plain folders; memory is plain markdown plus a local
   knowledge graph.** What the agent knows about you is inspectable files under
   your home directory — the app's docs viewer renders them directly.
3. **The privacy boundary is load-bearing.** Every durable memory write funnels
   through `writeEntity` → `assertPersistable` (`runtime/entity-writer.ts`),
   which refuses any write whose origin isn't you or an explicitly allowlisted
   collaborator (provenance stamped). On a solo install it's mostly invisible;
   the moment you share projects across instances it's the wall that keeps other
   people's content out of your memory.

---

## Memory: how it learns you

The long-term memory store is **GBrain** ([`github.com/garrytan/gbrain`](https://github.com/garrytan/gbrain),
an external Postgres-native personal-knowledge-graph binary; PGLite for a solo
install), driven over a stdio MCP client. Every entity write is mirrored into
GBrain as pages plus typed knowledge-graph edges, queried by the agent over MCP.

Memory grows as you talk: **`scribe/`** runs a fire-and-forget LLM extraction on
every real turn (entities, facts, typed relations) and writes the results
through the same privacy gate. Onboarding's history-import does the same in bulk
from your exported chat history, so the agent knows you from session one.

> The `gbrain` binary is a host prerequisite. If it's absent, memory degrades
> fail-soft (no crash, but writes are silently dropped) — install it for the
> full experience.

---

## Cores: the extension system

A **Core** is Neutron's plugin unit — a package with a `"neutron"` manifest
block declaring its id, capabilities, tools, secrets, and data namespace. The
contract lives in `core-sdk/` (pure types + schema, published as
[`@neutronai/core-sdk`](https://www.npmjs.com/package/@neutronai/core-sdk)).
`cores/runtime/` owns the install lifecycle (validate manifest → allocate a
per-Core data namespace → walk OAuth secrets if needed → register → start) and
enforces the **capability gate on every tool call**.

Eight free Cores ship bundled in `cores/free/`:

| Core | What it does |
|---|---|
| **notes** | Second-brain capture and recall over per-project SQLite + the knowledge graph |
| **tasks** | A task store with a deterministic focus-score and task↔reminder linking |
| **reminders** | Context-aware, LLM-composed nudges fired by the scheduler |
| **calendar** | Google Calendar |
| **email** | Gmail triage and drafting |
| **research** | A brief-producing research workflow with citation invariants |
| **code-gen** | An autonomous build → review → merge orchestrator, driven by `/code <task>` |
| **agent-settings** | In-chat configuration of your agent |

Design invariant, locked: **the runtime cannot tell a free Core from a paid
one.** No license checks, no entitlement tables, no heartbeats — ever. Whether
you can install a Core is determined purely by whether you can `bun install` it.

---

## Sharing across instances (Neutron Connect)

`connect/` is Neutron's cross-instance collaboration surface — "Slack Connect
for AI agents": a shared project that spans *independently operated* Neutron
instances, with chat and agent context syndicated across the boundary. One
**owner** plus N **collaborators**; the only capability axis is memory scope
(admin / write / read). A meeting-point node mounts the cross-instance API and a
public accept page; collaborators' turns route into the owner's project session
with server-side identity resolution, and activity replicates through a
monotonic per-project event log with a default-deny allowlist. Any instance can
self-host a Connect node, free, forever.

---

## What you need to run it

- **Bun** — runtime and package manager.
- **A Claude subscription** (via `claude setup-token`) **or an Anthropic API
  key** — Neutron runs your turns through the `claude` CLI under your own
  account.
- **Optionally**, a different substrate entirely (your own model behind the
  `Substrate` interface — see [The substrate is swappable](#the-substrate-is-swappable)).
- **A Telegram bot** (from @BotFather) if you want the Telegram surface — it is
  optional; the bundled web chat at `/chat` works with no Telegram setup (see
  [Quickstart](#quickstart-self-host)).
- **The `gbrain` binary** for persistent memory.

---

## Contributing

Issues and pull requests are welcome. Run the suite with `bun test` and
type-check with `bunx tsc --noEmit` before opening a PR. Full contribution
guidelines (DCO, code style, the Core-author guide) are being finalized ahead of
the public launch.
