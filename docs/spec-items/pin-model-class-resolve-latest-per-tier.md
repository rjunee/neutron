---
title: Pin the model class and resolve the latest version per tier
group: platform
status: done
cutover: false
priority: P1
---

# Pin model classes (#548)

Neutron's default Anthropic selections name Claude Code model classes, not
numbered model versions. Claude Code resolves each class when it starts a model
process. Explicit environment overrides may still select an exact model.

## Acceptance

- [x] The default best, planning, mid-tier, and fast selections are respectively
  `opus`, `fable`, `sonnet`, and `haiku`; no default pins a numbered version.
- [x] Boot configuration exposes those same defaults without drifting from the
  runtime registry.
- [x] Every default class resolves through the existing strict pricing lookup,
  while explicit numbered model rows remain available.
- [x] Environment overrides continue to pass through unchanged.

Verify with `bun test runtime/__tests__/models.test.ts
runtime/__tests__/pricing-covers-defaults.test.ts
config/__tests__/bootconfig-defaults.test.ts
gateway/__tests__/model-defaults-drift.test.ts trident/ported-fixes.test.ts`.
