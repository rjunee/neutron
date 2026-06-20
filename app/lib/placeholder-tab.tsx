/**
 * @neutronai/app — shared placeholder helper (P5.0).
 *
 * Per `docs/plans/P5.0-app-scaffolding-sprint-brief.md` § 4.6 / § 5.2:
 * "Each tab body uses `<PlaceholderTab name="Chat" landsIn="P5.1" />`
 * to keep the surface uniform."
 *
 * The P5.0 scaffolding sprint left most per-project tabs occupied by
 * the richer bodies that P5.1–P7.5 already shipped, so this helper
 * isn't bolted into every tab. It stays in tree as the canonical
 * "not-yet-populated" stand-in for any *new* tab a future sprint
 * lights up — and for the manual smoke screens documented in the
 * brief's verification gate (mounted directly in an Expo Go session
 * by an engineer who needs a visual fixture without standing up the
 * full WS-backed surface).
 */

import { StyleSheet, Text, View } from 'react-native';

import { THEME } from './theme';

export interface PlaceholderTabProps {
  name: string;
  landsIn: string;
  description?: string;
}

export default function PlaceholderTab({
  name,
  landsIn,
  description,
}: PlaceholderTabProps) {
  return (
    <View style={styles.container} accessibilityRole="summary">
      <Text style={styles.overline}>Not yet populated</Text>
      <Text style={styles.title}>{name}</Text>
      <Text style={styles.subtitle}>Lands in {landsIn}.</Text>
      {description !== undefined ? (
        <Text style={styles.body}>{description}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
    paddingHorizontal: 32,
    paddingTop: 64,
    gap: 8,
  },
  overline: {
    color: THEME.text_muted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: THEME.text_primary,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  subtitle: {
    color: THEME.text_secondary,
    fontSize: 15,
    marginTop: 4,
  },
  body: {
    color: THEME.text_muted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 12,
  },
});
