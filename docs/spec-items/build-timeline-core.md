---
title: Distribute portable PR build observability as a Core after cutover
group: platform
status: open
priority: P2
cutover: false
needs_spec: true
---

# Future build observability Core (#1314)

> **Not buildable yet.** The owner has requested a proper portable Core after
> cutover. Its installation, capability permissions, source adapters, durable
> event contract and UI integration require repository investigation and an owner
> interview before acceptance criteria can be finalized. This item must retain
> `needs_spec` until those questions are answered.

The temporary [diagnostic dashboard](temporary-build-timeline-dashboard.md) is a
separate deliverable. Its standalone Basic auth and deployment configuration do
not prescribe the future Core's identity or distribution model.

`SPEC.md` §2.5 defines a Core as the distribution unit, installed per instance with
portable prompts and mechanics and no host assumptions. The future design must
choose how GitHub permissions and local orchestration sources enter that boundary,
how retention and sensitive provenance are handled, and where an installed Core
renders its timeline. It must preserve actual wall-clock overlap, missing data,
explicit PR linkage and observed token/model provenance across supported harnesses.

No scope, estimate, implementation mechanism or definition of done is inferred
from the temporary service. Investigate the source and UI contracts when this
post-cutover work is promoted into buildable specification.
