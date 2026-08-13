/**
 * @neutronai/app — CODE-GEN settings: which model and effort run each build phase.
 *
 * Reached as: chat header ☰ → Settings → Code generation. A registered route nothing
 * pushes is the ISSUES #385 defect, so the nav row in `settings.tsx` is part of this
 * feature, not decoration.
 *
 * ── The phase list is SERVER-SUPPLIED ───────────────────────────────────────
 * Labels, descriptions, defaults and the legal values all arrive in the payload. This
 * screen knows the SHAPE of a phase and nothing about the pipeline, so a phase added
 * to the engine appears here without an app release.
 *
 * ── Choosing the default means "no override" ────────────────────────────────
 * Picking a value equal to the phase's default REMOVES the entry rather than pinning
 * it. Storing `opus` for a phase already defaulting to `opus` would freeze it against
 * a future change to that default — the owner would have pinned something they only
 * meant to leave alone. It also makes "reset" fall out for free: choose the default.
 *
 * ── A rejected save changes nothing, and says everything ────────────────────
 * The server validates the whole set and rejects it entire, naming every problem. The
 * banner shows that verbatim: the owner is the only one who can fix a bad value, and
 * a generic "save failed" hides which row was wrong. On rejection the local edits are
 * KEPT so they can be corrected — discarding them would punish the owner for a typo.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { loadAppConfig } from '../lib/config';
import {
  PhaseModelsClient,
  applyRowEdit,
  effectiveRow,
  type PhaseModelsPayload,
  type PhaseOverride,
} from '../lib/phase-models-client';
import { useAuthSession } from '../lib/session';
import { THEME } from '../lib/theme';

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : 'something went wrong';
}

export default function CodeGenSettingsScreen() {
  const router = useRouter();
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);

  const client = useMemo(() => {
    if (user === null) return null;
    return new PhaseModelsClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const [payload, setPayload] = useState<PhaseModelsPayload | null>(null);
  const [overrides, setOverrides] = useState<Record<string, PhaseOverride>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (client === null) return;
    setLoading(true);
    setError(null);
    try {
      const next = await client.load();
      setPayload(next);
      setOverrides(next.overrides);
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = useCallback(
    (phaseKey: string, patch: { model?: string; effort?: string }) => {
      if (payload === null) return;
      const phase = payload.phases.find((p) => p.key === phaseKey);
      if (phase === undefined) return;
      setOverrides((prev) => applyRowEdit(prev, phase, patch));
      // A pending edit invalidates the "Saved" confirmation — leaving it up would
      // tell the owner their newest change is already stored.
      setSaved(false);
    },
    [payload],
  );

  const save = useCallback(async () => {
    if (client === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await client.save(overrides);
      setPayload(next);
      setOverrides(next.overrides);
      setSaved(true);
    } catch (err) {
      // The local edits are KEPT so a rejected value can be corrected in place.
      setError(formatErr(err));
    } finally {
      setSaving(false);
    }
  }, [client, overrides, saving]);

  if (user === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          testID="codegen-back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerBack, pressed && styles.pressed]}
        >
          <Text style={styles.headerIcon}>←</Text>
        </Pressable>
        <View>
          <Text style={styles.headerOverline}>Settings</Text>
          <Text style={styles.headerTitle}>Code generation</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.muted}>
          Which model runs each part of a build, and how hard it thinks. Changes apply to
          the next build — nothing restarts.
        </Text>

        {error !== null ? (
          <Text style={styles.bannerError} testID="codegen-error">
            {error}
          </Text>
        ) : null}
        {saved && error === null ? (
          <Text style={styles.bannerOk} testID="codegen-saved">
            Saved
          </Text>
        ) : null}

        {loading ? (
          <ActivityIndicator color={THEME.text_secondary} testID="codegen-loading" />
        ) : payload === null ? (
          <Text style={styles.muted}>Couldn&apos;t load the build settings.</Text>
        ) : (
          <>
            {payload.phases.map((phase) => {
              const row = effectiveRow(phase, overrides);
              return (
                <View key={phase.key} style={styles.phase} testID={`phase-${phase.key}`}>
                  <View style={styles.phaseHead}>
                    <Text style={styles.phaseTitle}>{phase.label}</Text>
                    {row.overridden ? (
                      <Text style={styles.tag} testID={`phase-${phase.key}-changed`}>
                        changed
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.phaseDesc}>{phase.description}</Text>

                  <Text style={styles.optionLabel}>Model</Text>
                  <View style={styles.chips}>
                    {payload.model_tiers.map((tier) => (
                      <Pressable
                        key={tier}
                        accessibilityRole="button"
                        accessibilityState={{ selected: row.model === tier }}
                        accessibilityLabel={`${phase.label} model ${tier}`}
                        testID={`phase-${phase.key}-model-${tier}`}
                        onPress={() => edit(phase.key, { model: tier })}
                        style={({ pressed }) => [
                          styles.chip,
                          row.model === tier && styles.chipOn,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={[styles.chipText, row.model === tier && styles.chipTextOn]}>
                          {tier}
                          {phase.default.model === tier ? ' ·' : ''}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  <Text style={styles.optionLabel}>Effort</Text>
                  <View style={styles.chips}>
                    {payload.efforts.map((eff) => (
                      <Pressable
                        key={eff}
                        accessibilityRole="button"
                        accessibilityState={{ selected: row.effort === eff }}
                        accessibilityLabel={`${phase.label} effort ${eff}`}
                        testID={`phase-${phase.key}-effort-${eff}`}
                        onPress={() => edit(phase.key, { effort: eff })}
                        style={({ pressed }) => [
                          styles.chip,
                          row.effort === eff && styles.chipOn,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={[styles.chipText, row.effort === eff && styles.chipTextOn]}>
                          {eff}
                          {phase.default.effort === eff ? ' ·' : ''}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              );
            })}

            <Text style={styles.footnote}>
              A dot marks the default. Choosing it clears the override, so the phase keeps
              following the default if that ever changes.
            </Text>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save build settings"
              testID="codegen-save"
              disabled={saving}
              onPress={() => void save()}
              style={({ pressed }) => [
                styles.primaryBtn,
                saving && styles.btnDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background, paddingTop: 48 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  headerBack: { padding: 4 },
  headerIcon: { color: THEME.text_primary, fontSize: 20 },
  headerOverline: { color: THEME.text_muted, fontSize: 11, textTransform: 'uppercase' },
  headerTitle: { color: THEME.text_primary, fontSize: 18, fontWeight: '700' },
  scroll: { padding: 16, gap: 16, paddingBottom: 48 },
  muted: { color: THEME.text_muted, fontSize: 13, lineHeight: 18 },
  footnote: { color: THEME.text_muted, fontSize: 11, lineHeight: 15 },
  bannerError: {
    color: THEME.danger,
    fontSize: 12,
    lineHeight: 17,
    backgroundColor: THEME.surface_raised,
    borderRadius: 8,
    padding: 10,
  },
  bannerOk: { color: THEME.text_secondary, fontSize: 12 },
  phase: {
    gap: 8,
    padding: 12,
    borderRadius: 10,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  phaseHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  phaseTitle: { color: THEME.text_primary, fontSize: 15, fontWeight: '600' },
  tag: { color: THEME.warning, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  phaseDesc: { color: THEME.text_muted, fontSize: 12, lineHeight: 16 },
  optionLabel: { color: THEME.text_secondary, fontSize: 11, textTransform: 'uppercase' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  chipOn: { backgroundColor: THEME.text_primary, borderColor: THEME.text_primary },
  chipText: { color: THEME.text_secondary, fontSize: 12 },
  chipTextOn: { color: THEME.background, fontWeight: '600' },
  primaryBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: THEME.accent,
  },
  primaryBtnText: { color: THEME.background, fontSize: 14, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },
});
