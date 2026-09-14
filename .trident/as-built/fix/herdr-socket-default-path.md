## 2026-09-14 — the gateway is never under a pane, so an unset socket var is not evidence

`resolveSocketPath` refused whenever `HERDR_SOCKET_PATH` was unset, on the reasoning
stated in its own message: *"herdr injects this into every managed pane, so an empty
value means we are not running under one."*

That inference is sound for a pane and wrong for the process that matters most. The
gateway runs as a system service. It is **never** under a pane, and it is the process
that has to reach herdr in order to host a REPL at all.

### What it cost, measured

Deploying `a353cfa2` made herdr the default REPL host (`spawn.ts:126`,
`boot-adoption.ts:788` — `options.ptyHost ?? herdrHost`). Every turn then failed in
about 56 ms:

```
[live-agent-turn] event=turn_failed project=juno elapsed_ms=56
  error="cc-llm-call: herdr: no socket path — set HERDR_SOCKET_PATH or pass socketPath."
```

herdr was running and its socket was reachable the entire time — `herdrPing` against
the live socket from the same machine, as the same user, returned
`{"type":"pong","version":"0.8.2","protocol":20}`. The only thing missing was a string
the process could have derived itself. The owner saw *"I hit a problem answering that"*
in the web app.

### The change

Explicit beats env beats default, each step a deliberate statement rather than a
fallback chain:

- an `opts.socketPath` a caller passes means it;
- an injected `HERDR_SOCKET_ENV` means herdr placed us;
- otherwise look where herdr puts its socket — `$XDG_CONFIG_HOME/herdr/herdr.sock`,
  else `$HOME/.config/herdr/herdr.sock`.

**The refusal moved from the env var to the socket.** That is the whole point: absence
of an env var is evidence of nothing, while absence of a socket is the condition a
caller can act on. The message now names the path actually tried, so an operator can
check it. Where no home can be derived at all there is no default to try, and that is a
separate message rather than the same one.

An EMPTY env var falls through to the default rather than being treated as a path —
previously it was refused, and connecting to `""` would have been worse.

### Verification

- Seven cases, both directions: explicit wins; env used; empty env falls through;
  unset + socket present resolves (the production regression); nothing present refuses
  and names the path; no home refuses differently; and the base-selection table
  (`XDG_CONFIG_HOME` over `HOME`, empty `XDG_CONFIG_HOME` ignored, neither → undefined).
- Resolution is recorded through an injected `connect` that never connects, so the test
  observes the decision rather than the I/O.
- MUTATION: reinstating the pre-fix refusal (patch landed at line 213, printed and
  diffed before the run) reds 4 of 7, including the production case; restored, 7/0.
- Whole `persistent/` directory: 1531 tests, 0 fail. `runtime` typecheck clean.

### The residual, stated rather than closed

This is a DEFAULT, not discovery. A herdr whose socket lives somewhere non-standard
still needs the env var, and this change does not detect that case — it reports the one
path it tried. Deploy configuration naming the socket explicitly remains valid and now
remains optional rather than load-bearing.
