#!/usr/bin/env python3
"""Generate the mobile app's icon assets from the landing/favicon.svg atom mark.

Ryan, on installing the APK (2026-07-30): "make the app icon the same as our
favicon. What is this weird icon you made". The shipped icons were teal
concentric rings with a satellite dot — a drawing nothing in this repo produces,
sharing neither the geometry nor the palette of the ⚛ mark the web wears. These
are now RASTER MIRRORS of `landing/favicon.svg`, rendered from the one shared
geometry in `scripts/lib/atom_mark.py`, so the app icon and the browser tab can
no longer disagree about what Neutron looks like.

Run this whenever `landing/favicon.svg` changes:

    python3 scripts/gen-app-icons.py

Requires Pillow (dev-only; not a runtime dependency of the server).

WHAT EACH FILE IS FOR (`app/app.json`):
  icon.png                     iOS/legacy launcher icon. FULL-BLEED and opaque:
                               iOS rejects alpha and applies its own corner mask,
                               so baking the SVG's rounded tile in would round it
                               twice.
  android-icon-background.png  adaptive-icon BACKGROUND layer — the flat tile.
  android-icon-foreground.png  adaptive-icon FOREGROUND layer — the mark alone on
                               transparency, inset to the 66/108 safe circle so no
                               OEM mask shape can clip an orbit.
  android-icon-monochrome.png  themed-icon layer (Android 13+). The system tints
                               it, so it is a WHITE silhouette on transparency;
                               same safe-zone inset.
  splash-icon.png              splash mark, on transparency over the configured
                               `splash.backgroundColor`.
  favicon.png                  the Expo web build's tab icon — the rounded tile,
                               exactly as landing/favicon.svg draws it.
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.atom_mark import (  # noqa: E402
    ACCENT,
    ANDROID_SAFE_FRACTION,
    BG,
    CORNER_RADIUS,
    MARK_EXTENT,
    VIEWBOX,
    WHITE,
    render_atom,
)

IMAGES = ROOT / "app" / "assets" / "images"

ICON_PX = 1024
SPLASH_PX = 1024
FAVICON_PX = 48

#: How much to shrink the mark so its full painted extent fits the Android
#: adaptive-icon safe circle. Natural extent is MARK_EXTENT/VIEWBOX of the layer.
SAFE_SCALE = ANDROID_SAFE_FRACTION / (MARK_EXTENT / VIEWBOX)


def write(image, name: str) -> None:
    path = IMAGES / name
    image.save(path, format="PNG")
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes, {image.size[0]}px)")


def main() -> None:
    # iOS / legacy launcher: opaque square, no baked corners, mark at its natural
    # proportions (the OS mask crops less than Android's, so no inset is needed).
    write(render_atom(ICON_PX, background=BG), "icon.png")

    # Android adaptive: a flat tile behind, the mark inset into the safe circle
    # in front. Both layers are the same 1024px canvas the 108dp layer maps to.
    write(Image.new("RGBA", (ICON_PX, ICON_PX), BG), "android-icon-background.png")
    write(
        render_atom(ICON_PX, mark_scale=SAFE_SCALE),
        "android-icon-foreground.png",
    )
    write(
        render_atom(ICON_PX, accent=WHITE, mark_scale=SAFE_SCALE),
        "android-icon-monochrome.png",
    )

    # Splash: the mark alone, over `splash.backgroundColor`.
    write(render_atom(SPLASH_PX, accent=ACCENT), "splash-icon.png")

    # Expo web tab icon: the rounded tile, i.e. landing/favicon.svg verbatim.
    write(
        render_atom(FAVICON_PX, background=BG, corner_radius=CORNER_RADIUS, supersample=16),
        "favicon.png",
    )


if __name__ == "__main__":
    main()
