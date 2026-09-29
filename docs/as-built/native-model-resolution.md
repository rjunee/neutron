## 2026-09-29 — Resolve native model aliases through a bounded local command

The standalone native model resolver obtains a concrete model ID from a
host-owned disposable CLI process. It does not infer the ID from model prose,
copy an alias table, or read a worker transcript. The caller supplies the pinned
executable digest, complete environment, working directory, settings JSON,
settings-source order and a configuration/account epoch. The resolver snapshots
those inputs, checks the executable before and after, disables tools, MCP and
hooks, and runs the native local `/model` command in a fresh nonpersistent
session. This is metadata discovery, not another LLM-dispatch backend.

Only a session-matching typed startup frame followed by a successful zero-turn,
zero-API-time, zero-cost result can produce a resolution. Provider messages,
tool calls, malformed/foreign/duplicate frames, partial output, a failed exit,
executable drift, oversized output and expired deadlines preserve UNKNOWN.
Output contains no environment, settings, transcript content or credential
values. Native `apiKeySource` is retained only as diagnostic metadata; complete
auth evidence explicitly remains UNKNOWN. The native startup frame does not
attest every helper, descriptor, socket or settings-based authentication route.

A disposable installed-CLI experiment produced concrete startup metadata and a
successful local result with zero API milliseconds and zero turns. A separate
bounded inference returned the same model in provider response metadata.
Initialization without a user/command frame did not expose the resolved model.
Accepting `--max-turns 0` did not establish a safe no-inference protocol. The
resolver therefore sends only the validated local command and requires the
zero-inference result; it does not kill immediately on seeing startup metadata.
Native startup housekeeping may still perform network I/O.

Verification: 31 subprocess tests pass, including successful alternate-family
resolution, both directions of the concrete-model guard, and a mutation removing
the zero-turn check. Root and Trident TypeScript checks pass. The real standalone resolver also completed against the
installed CLI with a resolved model and UNKNOWN auth evidence. This module is
not yet launch/capacity integration: its caller must preserve profile parity,
pin the resolved model in the actual new native launch, and obtain independent
auth admission. It cannot upgrade a running parent or attest the model/account
used by an existing child.
