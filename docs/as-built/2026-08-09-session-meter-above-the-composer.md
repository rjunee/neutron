# The session meter moved above the message input

**Landed:** 2026-08-09 · **ISSUES:** #519 (first bullet) · **Surface:** mobile only

## The request

> "Can you move the hairline session status bar to instead be on the top of the
> message input box, rather than at the top of the screen?"

## The consequence the issue called out, and honouring it

The meter was not merely *sitting* at the top — it **was the tab band's bottom
seam**. `ProjectTabBar`'s own comment said so: *"The band no longer draws its own
bottom hairline: `UsageMeter` renders as the band's last child and IS that seam …
One line, one owner."*

So moving it without restoring that hairline would have left the band with no edge
at all. The narrow band draws its own again. **The wide sidebar needed nothing** —
its visible boundary is the RIGHT border, which never depended on the meter.

## Where it lives now

`ComposerDock` renders it above the published composer node. That is the one place
both facts are in scope: the composer is published from deep inside `<Slot/>` and
knows nothing about usage, while the dock is rendered by the shell, which already
holds the reading. `usage` is optional there, so the test harness's bare
`<ComposerDock/>` keeps composing — and an absent reading renders **nothing**
rather than an "unknown" hairline, which would put a stray line above the input on
every such mount.

`ProjectTabBar` no longer takes a `usage` prop at all: one owner, or the hairline
doubles up.

## Coverage

The old test asserted the *opposite* — that the band renders the meter as its own
edge. It is **inverted rather than deleted**, so the move is visible in the history,
and the recorded consequence gets its own case: the band must paint a bottom
hairline. The call-site guard moved with the meter — it used to require every
`<ProjectTabBar>` to be handed a reading (a forgotten call site once shipped the
wide branch with no meter); it now requires the dock to carry it and the tab bar
NOT to.

Two mutants, killing different tests: removing the band's restored border reds the
hairline case; removing the dock's meter reds the driven dock case.

Two of my own mistakes are recorded in the file, because both are recurring shapes:
reading `band.style.borderBottomColor` returns the empty string under RNW (styles
compile to atomic CSS classes — `getComputedStyle` is what answers), and my
one-owner assertion was an unbounded `/<ProjectTabBar[\s\S]*?usage=/` that matched
through to the dock's own `usage=` and failed on correct code.

**Web is NOT done.** The request said web + mobile; this is the mobile half.
