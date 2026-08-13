# A bundled icon pack for project icons — what it actually costs

**Status:** research, no code. Written 2026-08-10 because the owner's P2 list asks for "a
bundled icon pack for project icons, replacing emoji" and flagged that it *needs real
research: licence, coverage, bundle size — must be verified, not recalled.* Every number
below was read from a primary source this session; where sources disagree, the
disagreement is reported rather than resolved by picking one.

## The finding, first

**This is not one decision, it is two, and they cost wildly different amounts.**

* **Web is cheap.** `lucide-react` is pure React + inline SVG. No native dependency, no
  new build artifact, nothing to install on a device.
* **Mobile is not.** `lucide-react-native` peer-depends on **`react-native-svg`**, which
  is a native module. The app does not have it. Adding it means a **new EAS build, not an
  OTA** — so the owner has to install a new binary from the build page before he sees a
  single icon, and the change cannot ride the fast path that every other mobile fix this
  week has used.

That asymmetry is the whole shape of the decision, and it is invisible from the package
page.

## What exists today

**Nothing.** The app has no icon library of any kind:

* `react-native-svg` — absent from `app/package.json` (checked directly).
* `@expo/vector-icons` — not installed, not a direct dependency, not imported anywhere.
* Expo SDK `~54.0.33`.
* Project icons render as emoji: `app/components/LauncherItem.tsx` branches on
  `icon.kind === 'emoji'`, with a comment at `:104` already reserving the work for "the
  icon-library sprint".

Two existing docblocks (`app/components/InputComposer.tsx:251`,
`app/components/ProjectRail.tsx:290`) record the same absence, each saying it was
"re-checked" against `app/package.json`. I verified independently rather than trusting
them, and they are correct — worth noting because it means the constraint has already
been hit twice by people drawing icons by hand.

## Licence — clean, with one obligation people forget

Lucide is **ISC**, plus **MIT** for the icons derived from Feather. ISC grants
"permission to use, copy, modify, and/or distribute this software for any purpose with or
without fee", and both licences require that the copyright notice and permission notice
"appear in all copies" / "be included in all copies or substantial portions".

So: compatible with this repo's Apache-2.0, no copyleft, no share-alike, no attribution
in the UI. **But the notice must ship with the distribution** — that is an obligation on
the mobile binary and the web bundle, not just on the repo, and it is the part that gets
skipped. See the bundle-size section, where it turns out this obligation is *already*
being discharged in the most expensive possible way.

## Coverage — enough, but the exact count is unsettled

Sources disagree and I am not going to pretend otherwise:

| Source | Count |
|---|---|
| lucide.dev (official) | 1,768 |
| proicons.com | 1,744 |
| allsvgicons.com | "1,500+" |

Any of those is far more than enough to give every project a distinct icon. Treat the
count as "≈1,700, verify at adoption time" rather than a number to quote.

## Bundle size — measured, and there is a live landmine

Read from the npm registry this session, both at version **1.31.0**:

| Package | Unpacked | Files | Peer deps |
|---|---|---|---|
| `lucide-react-native` | **23.69 MB** | 9,131 | `react`, `react-native`, `react-native-svg` |
| `lucide-react` | **29.78 MB** | 4,090 | `react` |

Those are *installed* sizes, not shipped sizes — what reaches a bundle depends entirely on
import style, and that is where the problem is:

1. **Metro does not tree-shake barrel imports.** Lucide's own React Native guidance says
   so outright and tells you to import per-icon modules instead:
   `import Camera from 'lucide-react-native/icons/camera'`. Each icon is its own file, so
   the bundler includes only what is named. Expo SDK 52+ has an experimental tree-shaking
   pass, but it declines to expand a star export that pulls in ambiguous exports — which
   is exactly the barrel case. **A barrel import here plausibly ships all ~1,700 icons.**

2. **Open upstream issue [#3744](https://github.com/lucide-icons/lucide/issues/3744)
   (filed 2025-10-30, still open):** an Expo *web* export via Metro adds **~13,000 lines
   of repeated licence text** to the production bundle — apparently one copy of the notice
   per icon included. No fix and no workaround offered in the thread. The reporter also
   observed tree-shaking failing to drop unused icons, independently of Lucide's own docs.

**Point 2 matters more here than it would elsewhere.** There is already an unexplained
mobile export size change on record (2.6 MB → 4.36 MB, with dev-vs-production ruled out
byte-for-byte). Adopting a dependency whose known open bug is *unbounded duplicated text
in the bundle* would make that number harder to reason about at exactly the moment we are
trying to explain it. `scripts/eas-update.sh` prints the size on every publish, so a jump
would at least be visible — but "visible" is not "attributable".

## What I would do

**Split it.**

* **Web first, on its own.** `lucide-react` with per-icon imports. No native dependency,
  no new binary, reversible, and it proves out the icon *set* and the picker UI against
  real project icons before any mobile cost is incurred.
* **Mobile deliberately second, and priced honestly.** It needs `react-native-svg`, a new
  EAS build, and the owner installing that build. Bundle the native dependency with other
  work that already requires a build (there is an EAS-fingerprint item open — `ISSUES.md`
  #513/#518) rather than spending a build on icons alone.
* **Per-icon imports from day one, enforced.** Not a convention — a lint rule. A barrel
  import is a silent regression that only shows up as a bundle-size number nobody can
  attribute, which is precisely the situation we are already in.
* **Vendor the notice once, deliberately.** Whatever upstream does about #3744, this repo
  should ship one copy of the ISC + MIT notices in the licence manifest rather than rely on
  a bundler emitting 1,700.

## Open question for the owner

Emoji today are **owner-chosen per project** and carry meaning he assigned. An icon pack
replaces a set he picked with a set someone else drew, so migration is a product question
before it is a technical one: does an existing project keep its emoji until he changes it,
or does it get mapped onto a default icon? A silent remap would rewrite choices he made.
Nothing here should be built until that is answered.

## Sources

* [License – Lucide](https://lucide.dev/license) · [lucide/LICENSE on GitHub](https://github.com/lucide-icons/lucide/blob/main/LICENSE)
* [Lucide Icons (official)](https://lucide.dev/) · [proIcons — Lucide](https://proicons.com/icon-collections/lucide-icons/) · [All SVG Icons — Lucide](https://allsvgicons.com/pack/lucide/)
* [Optimizations — React Native, Lucide](https://lucide.dev/guide/react-native/advanced/optimizations) · [Lucide for React Native](https://lucide.dev/guide/react-native/) · [Lucide React Native package](https://lucide.dev/guide/packages/lucide-react-native)
* [Tree shaking and code removal — Expo docs](https://docs.expo.dev/guides/tree-shaking/)
* [lucide-icons/lucide#3744 — repeated licence text in Expo web bundle](https://github.com/lucide-icons/lucide/issues/3744) · [lucide-icons/lucide#1559 — import icon as a separate module](https://github.com/lucide-icons/lucide/issues/1559)
* [lucide-react-native on npm](https://www.npmjs.com/package/lucide-react-native) (sizes read from the registry metadata for `1.31.0`)
