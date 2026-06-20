/**
 * @neutronai/app — project-scoped notes tab (P5.3 placeholder).
 *
 * The Notes Core ships its agent surface (chat tool-calls) in
 * cores/free/notes; the dedicated in-app UI lands in a later P5.x
 * sprint. This file exists so that the launcher's default Notes tile
 * (DEFAULT_LAUNCHER_SEED in gateway/http/project-launcher-store.ts)
 * resolves to a real route via expo-router rather than falling through
 * to an unmatched-route screen when tapped from the Apps grid.
 */

import { StyleSheet, Text, View } from 'react-native';

export default function NotesTab() {
  return (
    <View style={styles.container}>
      <View style={styles.intro}>
        <Text style={styles.title}>Notes</Text>
        <Text style={styles.subtitle}>
          Notes Core UI — coming in P5.x. Use the Notes Core via chat for now.
        </Text>
      </View>

      <Text style={styles.footnote}>
        Coming in P5.x — notes tab. The Notes Core agent surface is already wired through chat.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  intro: { gap: 6, marginBottom: 16 },
  title: { color: '#fafafa', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#9a9a9a', fontSize: 13, lineHeight: 18 },
  footnote: {
    color: '#5a5a5a',
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 'auto',
  },
});
