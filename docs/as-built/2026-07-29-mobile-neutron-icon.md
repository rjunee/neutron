# Mobile app icons replaced with the real Neutron mark (2026-07-29)

Ryan on device: *"Why is the app logo a weird ^ instead of our neutron logo?"*

**It was the stock Expo template icon.** All six files under `app/assets/images/`
were dated 17 May — the day the app was scaffolded with `create-expo-app` — and
`android-icon-foreground.png` was the blue `create-expo-app` chevron. Nobody had
ever replaced them. Not a regression; a scaffold default that shipped.

**No design work was needed** — the real mark already existed as `landing/logo.svg`
and is the established brand: the same atom is the web favicon (`landing/favicon.svg`)
and the chat rail header (`ChatApp.tsx AtomMark()`). Dark ground `#0b0e14`, teal
`#6fe3d4` concentric orbits, centre nucleus, one electron.

All six regenerated from that source (rendered via `qlmanage`, resized with `sips`
— neither `rsvg-convert` nor ImageMagick is present on this machine):

- `icon.png` 1024² — **full-bleed square, rounded corners deliberately REMOVED.**
  `landing/logo.svg` carries `rx="96"` for web use, but iOS and Android both apply
  their own mask; a pre-rounded source leaves dark wedges in the corners.
- `android-icon-foreground.png` 512² — mark only on transparent, **scaled 0.62** so
  the outer orbit spans ~58% of the canvas and sits inside Android's inner-66%
  adaptive-icon safe zone. At the source's own scale the orbit spans ~69% and would
  be clipped by circular masking.
- `android-icon-background.png` 512² — flat `#0b0e14`, full bleed.
- `android-icon-monochrome.png` 432² — themed-icon silhouette. **Opacity variation
  dropped and strokes thickened**: Android tints this layer flat, so the source's
  0.55/0.85 orbit opacities would render as muddy banding.
- `splash-icon.png` 1024² — mark on transparent at 0.78; `app.json` already sets the
  splash background to `#000000`, so it composites correctly.
- `favicon.png` 48².

`app.json` needed **no change** — its paths already pointed at these filenames, so
replacing the bytes was sufficient.

**Not yet verified on-device.** These reach a device via an OTA update on the
`preview` channel; per the done-means-served bar this closes when Ryan sees the atom
on his home screen. Note the icon itself is part of the native shell on some
platforms, so a full rebuild may be required rather than an OTA — flagged rather
than assumed.
