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

/** The id the General (catch-all) topic uses; it never shows an activity dot. */
export const GENERAL_PROJECT_ID = 'general';

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
}: {
  project: RailProjectView;
  overlay: RailOverlayEntry | undefined;
  isActive: boolean;
  reduceMotion: boolean;
  onSelect: (id: string) => void;
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
        if (!isActive) onSelect(project.id);
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
        {dot !== null ? <ActivityDot kind={dot} reduceMotion={reduceMotion} /> : null}
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
  reduceMotionOverride,
}: ProjectRailProps) {
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
  dot: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    // Ring that separates the dot from the emoji (rail bg = surface).
    borderWidth: 2,
    borderColor: THEME.surface,
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
