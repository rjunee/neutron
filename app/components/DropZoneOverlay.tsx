/**
 * @neutronai/app — full-surface drop-zone overlay used during ChatGPT /
 * Claude ZIP drag-and-drop on web.
 *
 * Rendered above the chat surface (above the FlatList, below the
 * composer's keyboard layer) while a drag is in progress AND the active
 * onboarding phase carries an `upload_affordance`. Outside those two
 * gates the overlay stays mounted but invisible + non-interactive so the
 * page-level dragenter listener can flip it on instantly without a
 * mount transition.
 *
 * Design: a single tinted scrim with a dashed border + one short
 * instructional line. No gradient, no spring, no bounce — opacity-only
 * fade at MOTION.fast so the affordance feels responsive without
 * visually shouting over the conversation underneath.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { MOTION, SPACING, TYPOGRAPHY, type NeutronTheme } from '../lib/theme';
import { useThemedStyles } from '../lib/theme-context';

export interface DropZoneOverlayProps {
  /** When false, the overlay is rendered at opacity 0 + pointerEvents none. */
  visible: boolean;
  /** Optional inline file label (e.g. 'chatgpt-export.zip'). */
  filename?: string;
  /** Optional source label ('ChatGPT' / 'Claude' / 'ChatGPT or Claude'). */
  source_label?: string;
}

export function DropZoneOverlay({ visible, filename, source_label }: DropZoneOverlayProps) {
  const styles = useThemedStyles(makeStyles);
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, {
      toValue: visible ? 1 : 0,
      duration: MOTION.fast,
      useNativeDriver: true,
    }).start();
  }, [visible, fade]);

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.overlay, { opacity: fade }]}
      accessibilityLabel="Drop file to upload"
      accessibilityRole="alert"
    >
      <View style={styles.frame}>
        <Text style={styles.title}>
          Drop your {source_label ?? 'export ZIP'} here
        </Text>
        {filename !== undefined ? (
          <Text style={styles.filename} numberOfLines={1}>
            {filename}
          </Text>
        ) : null}
        <Text style={styles.hint}>Release to upload.</Text>
      </View>
    </Animated.View>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.scrim,
      justifyContent: 'center',
      alignItems: 'center',
      padding: SPACING.xl,
      zIndex: 50,
    },
    frame: {
      width: '100%',
      maxWidth: 480,
      borderRadius: 14,
      borderWidth: 2,
      borderStyle: 'dashed',
      borderColor: theme.accent,
      backgroundColor: theme.surface,
      paddingHorizontal: SPACING.xl,
      paddingVertical: SPACING.xl,
      alignItems: 'center',
      gap: SPACING.sm,
    },
    title: {
      ...TYPOGRAPHY.h3,
      color: theme.text_primary,
      textAlign: 'center',
    },
    filename: {
      ...TYPOGRAPHY.body_small,
      color: theme.text_secondary,
      textAlign: 'center',
    },
    hint: {
      ...TYPOGRAPHY.caption,
      color: theme.text_muted,
      textAlign: 'center',
    },
  });
