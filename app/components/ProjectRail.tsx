/**
 * @neutronai/app — mobile project RAIL (M1 UX REDESIGN PR-6).
 *
 * The Telegram-folder-style project switcher that seats on the LEFT edge of the
 * project workspace (`app/app/projects/[id]/_layout.tsx`). The mobile counterpart
 * of PR-3's desktop rail. Per Ryan's signed-off design each entry is the project
 * EMOJI with the project NAME directly BELOW it (not emoji-only) plus a corner
 * work-activity dot — so it reads like Telegram's folder rail.
 *
 * Data:
 *   - the project SET + names/emoji come from the HTTP list (`fetchProjects`),
 *   - the per-project `activity` (dot) is overlaid live from the app-ws
 *     `projects_changed` frame (PR-1 #180) via `projects-rail-live.ts`.
 * The dot-choice logic is the pure `railDotKind` (unit-tested); this component
 * is presentation only. Styling reads exclusively from `theme.ts` tokens.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { SPACING, THEME, TYPOGRAPHY } from '../lib/composer-constants';
import { PHASE } from '../lib/theme';
import {
  railDotKind,
  type ProjectActivity,
  type RailDotKind,
  type RailProjectView,
} from '../lib/project-rail-view';

// The id the General (catch-all) topic uses; it never shows an activity dot.
// Defined in the PURE view module so unit tests can assert it (ISSUES #403);
// re-exported here so existing importers are unaffected.
import { GENERAL_PROJECT_ID } from '../lib/project-rail-view';
export { GENERAL_PROJECT_ID };

/** The live rail overlay for one project — `activity` drives the dot. */
export interface RailOverlayEntry {
  activity: ProjectActivity;
  live_runs: number;
}

export interface ProjectRailProps {
  /** The project SET, already ordered (most-recent-first) by the caller. */
  projects: readonly RailProjectView[];
  /** Live `activity`/`live_runs` overlay keyed by project id (may be empty). */
  overlay: ReadonlyMap<string, RailOverlayEntry>;
  /** The id of the project whose workspace is open (highlighted). */
  activeProjectId: string;
  onSelect: (projectId: string) => void;
  onCreate: () => void;
  /**
   * Open the Activity Inspector for a scope (SPEC § WAVE 3.5) — fired by the
   * clickable activity dot on each rail row. Optional so the existing rail render
   * tests construct unchanged; absent ⇒ the dot renders but does nothing.
   */
  onOpenActivity?: (projectId: string) => void;
  /** Test seam — overrides the async reduce-motion probe. */
  reduceMotionOverride?: boolean;
}

/** The corner activity dot. Pulses (work) under motion; static otherwise. */
function ActivityDot({ kind, reduceMotion }: { kind: RailDotKind; reduceMotion: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (kind !== 'work' || reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.4,
          duration: RAIL_PULSE_MS / 2,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: RAIL_PULSE_MS / 2,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [kind, reduceMotion, opacity]);

  // FIX #335 — the pulsing `work` dot uses the building blue (`PHASE.build.fg`),
  // matching the Work-list building dot exactly; `attention` stays a static amber.
  //
  // IDLE PAINTS NOTHING. WAVE 3.5 drew a quiet hollow ring at rest so the dot
  // would always be there to tap; on a 72px rail that meant a grey circle on
  // EVERY row, which read as eight pieces of state at a moment when nothing was
  // happening anywhere. The owner, on device: "remove that ugly grey hollow
  // circle on every project in the rail. the pulsing dot should only show up if
  // there's activity, otherwise nothing shows."
  //
  // What is superseded is only the PAINT. The affordance is untouched, which is
  // the whole subtlety of this change: `railDotKind` still returns `idle`, the
  // active row still wraps this in the `dotPress` Pressable, and the corner still
  // occupies a DOT-sized (transparent) box. So the Activity Inspector's touch
  // target keeps exactly the geometry it had — invisible but tappable, which is
  // what an advanced affordance is supposed to feel like — and a row's layout
  // does not shift the moment activity starts or stops, because only the colour
  // ever appears and disappears.
  //
  // Deliberate divergence from the web rail's `.car-rail-dot-idle`, which still
  // draws its resting ring: the complaint is specific to the narrow phone rail.
  // Treat a future web change as its own decision, not as drift to "fix".
  if (kind === 'idle') {
    return <Animated.View testID="rail-dot-none" style={styles.dotSlot} />;
  }
  const color = kind === 'attention' ? THEME.attention : PHASE.build.fg;
  return (
    <Animated.View
      testID={`rail-dot-${kind}`}
      style={[styles.dot, { backgroundColor: color, opacity }]}
    />
  );
}

function RailItem({
  project,
  overlay,
  isActive,
  reduceMotion,
  onSelect,
  onOpenActivity,
}: {
  project: RailProjectView;
  overlay: RailOverlayEntry | undefined;
  isActive: boolean;
  reduceMotion: boolean;
  onSelect: (id: string) => void;
  /** Open the Activity Inspector for this scope (the dot's action, SPEC § WAVE 3.5). */
  onOpenActivity: (id: string) => void;
}) {
  const isGeneral = project.id === GENERAL_PROJECT_ID;
  const dot = railDotKind(overlay?.activity, isGeneral);
  const hasUnread = project.unread_count > 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={`Open ${project.name}${hasUnread ? ', unread' : ''}`}
      testID={`rail-item-${project.id}`}
      onPress={() => {
        // ISSUES #401 — ALWAYS notify, even when this entry is already active.
        // Suppressing the call made the FIRST rail entry unopenable: it is the
        // active selection on mount, so its tap was a no-op and the only way to
        // load its chat was leaving the tab and coming back. The caller decides
        // whether that means "navigate" or "already here" — the rail must not
        // silently swallow a deliberate tap.
        onSelect(project.id);
      }}
      style={({ pressed }) => [
        styles.item,
        isActive && styles.itemActive,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.glyphWrap}>
        <Text style={styles.emoji} numberOfLines={1}>
          {project.emoji}
        </Text>
        {/* CLICKABLE ACTIVITY DOT — the Activity Inspector's entry point (SPEC §
            WAVE 3.5; Ryan-locked: no new icon, the EXISTING dot becomes the
            affordance) — but ONLY on the row the owner is already standing in.
            A nested Pressable with a generous `hitSlop` is right for reaching a
            10px target and wrong for a rail whose rows are ~44px tall: the slop
            around eight dots covered most of the column, and RN gives the deeper
            Pressable priority inside it, so aiming at a project opened the
            inspector instead of switching to it. Ryan on device: "the indicator
            light being tappable is too easy to misclick when trying to switch to
            another project… make it only work if the project is currently
            active." So an INACTIVE row's dot is a plain painted glyph with no
            touch responder at all — every pixel of that row belongs to the switch
            — and the ACTIVE row keeps the full affordance, slop included, because
            there is nothing to mis-navigate to from the row you are on. */}
        {isActive ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show activity for ${project.name}`}
            testID={`rail-dot-press-${project.id}`}
            hitSlop={10}
            onPress={() => onOpenActivity(project.id)}
            style={styles.dotPress}
          >
            <ActivityDot kind={dot} reduceMotion={reduceMotion} />
          </Pressable>
        ) : (
          <View style={styles.dotInert}>
            <ActivityDot kind={dot} reduceMotion={reduceMotion} />
          </View>
        )}
      </View>
      <Text
        style={[styles.name, isActive && styles.nameActive, hasUnread && styles.nameUnread]}
        numberOfLines={1}
      >
        {project.name}
      </Text>
    </Pressable>
  );
}

export function ProjectRail({
  projects,
  overlay,
  activeProjectId,
  onSelect,
  onCreate,
  onOpenActivity,
  reduceMotionOverride,
}: ProjectRailProps) {
  // No-op default so a rail rendered without the inspector wired still shows a dot
  // that does nothing, rather than throwing on tap.
  const openActivity = onOpenActivity ?? ((): void => {});
  const [reduceMotion, setReduceMotion] = useState(reduceMotionOverride ?? false);
  useEffect(() => {
    if (reduceMotionOverride !== undefined) return;
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((rm) => {
        if (!cancelled) setReduceMotion(rm);
      })
      .catch(() => {
        if (!cancelled) setReduceMotion(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reduceMotionOverride]);

  return (
    <View style={styles.rail} testID="project-rail">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.railContent}
      >
        {projects.map((project) => (
          <RailItem
            key={`${project.origin_instance}:${project.id}`}
            project={project}
            overlay={overlay.get(project.id)}
            isActive={project.id === activeProjectId}
            reduceMotion={reduceMotion}
            onSelect={onSelect}
            onOpenActivity={openActivity}
          />
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a project"
          testID="rail-create"
          onPress={onCreate}
          style={({ pressed }) => [styles.item, styles.createItem, pressed && styles.pressed]}
        >
          <Text style={styles.createGlyph}>+</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const RAIL_WIDTH = 72;
const RAIL_PULSE_MS = 2400;
const GLYPH = 44;
const DOT = 10;

const styles = StyleSheet.create({
  rail: {
    width: RAIL_WIDTH,
    backgroundColor: THEME.surface,
    borderRightWidth: 1,
    borderRightColor: THEME.hairline,
  },
  railContent: {
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    gap: SPACING.xs,
  },
  item: {
    width: RAIL_WIDTH - SPACING.sm,
    alignItems: 'center',
    paddingVertical: SPACING.xs,
    borderRadius: SPACING.md,
    gap: 2,
  },
  itemActive: {
    backgroundColor: THEME.surface_raised,
  },
  pressed: { opacity: 0.7 },
  glyphWrap: {
    width: GLYPH,
    height: GLYPH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 24,
    lineHeight: 30,
    textAlign: 'center',
  },
  /**
   * SPEC § WAVE 3.5 — the corner offset moved OFF the dot and ONTO its `dotPress`
   * wrapper, so the tappable Pressable is what sits in the corner and the dot
   * paints inside it. Same rendered geometry as before (a DOT-sized circle at
   * right:2/bottom:2 of `glyphWrap`); the wrapper is what carries `hitSlop`.
   */
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    // Ring that separates the dot from the emoji (rail bg = surface).
    borderWidth: 2,
    borderColor: THEME.surface,
  },
  /**
   * The idle corner: a DOT-sized hole in the paint. No fill, no border, no
   * opacity trick — nothing renders. It exists ONLY to hold the box open, so
   * `dotPress` keeps its 10px target (plus `hitSlop`) while nothing is drawn and
   * the row does not twitch when a dot lights up. Anything visible here — a
   * dimmed ring, a low-opacity dot — is the exact thing that was removed.
   */
  dotSlot: {
    width: DOT,
    height: DOT,
  },
  dotPress: {
    position: 'absolute',
    right: 2,
    bottom: 2,
  },
  /**
   * The same corner slot, INERT — what a non-active row's dot paints into. Same
   * geometry as `dotPress` so the rail looks identical; `pointerEvents: 'none'`
   * hands every touch straight through to the row's own Pressable, which is the
   * whole point (a dot you cannot mis-tap on the way to switching projects).
   */
  dotInert: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    pointerEvents: 'none',
  },
  name: {
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '500',
    color: THEME.text_muted,
    textAlign: 'center',
    maxWidth: RAIL_WIDTH - SPACING.xs,
  },
  nameActive: {
    color: THEME.text_primary,
  },
  nameUnread: {
    fontWeight: '700',
    color: THEME.text_secondary,
  },
  createItem: {
    marginTop: SPACING.xs,
  },
  createGlyph: {
    fontSize: 26,
    lineHeight: GLYPH,
    color: THEME.text_muted,
    height: GLYPH,
    textAlign: 'center',
  },
});
