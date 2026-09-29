## 2026-09-29 — Project native messaging grant and measured launch inputs

Default project chat and project prewarm now request the same explicit
`SendMessage` grant alongside `Agent`. General and reminder defaults retain their
existing surface; explicit caller tool lists, including empty lists, stay exact.
This supports native same-model work under SPEC.md's 2026-09-11 decision without
changing review, admission, or merge gates.

Fresh project launches measure the selected executable's real path, SHA-256 and
CLI version, preserve the configured launcher argv for restart adoption, and bind
the exact argv and tool grant to the session and child generation after spawn.
Executable identity changes or launcher symlink retargeting invalidate the
observation. A consuming adoption test proves a `claude` launcher pointing to
`claude.exe` remains adoptable without weakening foreign-binary refusal.
Stable file identities
reuse the version/hash measurement; version probes have a five-second limit.
Missing observations do not prevent ordinary chat.

This is host-observed launch-input evidence, not a live catalog, proof of an
executed process image, tool invocation, or account consumption. The trusted
host accessor supplies an immutable observation for the original signed dispatch
receipt producer. That durable receipt integration belongs to the consuming
continuation change; this in-memory observation alone cannot support restart
continuation. Existing adopted parents are never assigned a new observation.

Verification exercises project cold/warm grants, General, a project named
`general`, explicit caller restrictions, measured executable replacement, and
the production spawn boundary with disposable CLI/terminal fixtures. The focused
chat, reminder parity, argv, tool-bridge and observation suites passed, as did
root and Trident TypeScript checks. Semantic mutations removing the project
grant, broadening it to General/explicit restrictions, accepting replaced
executables, and suppressing valid observations each failed their controls.

No live parent was driven and no account A/B proof was performed. This change
does not establish that same-child continuation works in production or satisfy
the unattended-merge acceptance gate by itself.
