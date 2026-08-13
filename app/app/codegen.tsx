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
  panelIsSingleFamily,
  rejectedModel,
  slotIsOff,
  tierChoices,
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
  /**
   * Which dropdown is open, as `<phase key>:<model|effort>`.
   *
   * ONE at a time, and closed by default — the whole point of the table is that a
   * step's current model is readable without unfolding anything. React Native has no
   * `<select>`, so a dropdown here is a button that reveals its options; keeping the
   * open one in state (rather than per-row) is what makes opening a second close the
   * first instead of stacking two lists down the screen.
   */
  const [openMenu, setOpenMenu] = useState<string | null>(null);
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
      // Choosing closes the menu, the way a real dropdown does.
      setOpenMenu(null);
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
          Which model runs each step of a build, and how hard it thinks. One setting for
          every project on this install — which model you can run is a property of your
          subscriptions, not of the thing being built. Changes apply to the next build —
          nothing restarts.
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
            {/* ONE ROW PER STEP: name · model · effort. The two controls are
                dropdowns — closed, a row reads as one line the owner can scan; open,
                it lists every tier with the model it resolves to today. */}
            {/* ISSUES #566 — BOTH CROSS-MODEL SEATS OFF IS A KNOWING OPT-OUT, AND THE
                PANE SAYS SO. It is a legitimate configuration, so this is a note and
                not an error — but a panel of Claude reviewers only is a panel with one
                set of blind spots, and a pane that stayed silent would let the owner go
                on believing a second model family is checking the work. */}
            {panelIsSingleFamily(payload.phases, overrides, payload.none_value) ? (
              <Text style={styles.stale} testID="codegen-single-family">
                Both cross-model reviews are off — every reviewer on the panel is a
                Claude model, so their agreement is weaker evidence than the seat count
                suggests.
              </Text>
            ) : null}
            {payload.phases.map((phase) => {
              const row = effectiveRow(phase, overrides);
              const off = slotIsOff(phase, overrides, payload.none_value);
              const choices = tierChoices(phase, payload.model_tiers);
              const dead = rejectedModel(phase, payload.rejected);
              const chosen = choices.find((c) => c.tier === row.model);
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
                  {/* The step's one line stays: it is the only thing that says what
                      this row actually does. */}
                  <Text style={styles.phaseDesc}>{phase.description}</Text>
                  {dead !== null ? (
                    // A saved choice that no longer resolves is SHOWN, struck through,
                    // with what is running instead — never silently reverted.
                    <Text style={styles.stale} testID={`phase-${phase.key}-stale`}>
                      <Text style={styles.struck}>{dead}</Text> is no longer available —
                      using {row.model}
                    </Text>
                  ) : null}

                  <View style={styles.controls}>
                    <View style={styles.control}>
                      <Text style={styles.optionLabel}>Model</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${phase.label} model`}
                        testID={`phase-${phase.key}-model`}
                        onPress={() =>
                          setOpenMenu((cur) =>
                            cur === `${phase.key}:model` ? null : `${phase.key}:model`,
                          )
                        }
                        style={({ pressed }) => [styles.dropdown, pressed && styles.pressed]}
                      >
                        {/* Closed, the control already answers "which model is that" —
                            the tier AND what it resolves to right now. */}
                        <Text style={styles.dropdownText}>
                          {off ? 'none — this review is off' : row.model}
                          {!off && chosen !== undefined ? ` · ${chosen.model_id}` : ''}
                        </Text>
                      </Pressable>
                    </View>
                    <View style={styles.control}>
                      <Text style={styles.optionLabel}>Effort</Text>
                      {phase.effort_supported ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${phase.label} effort`}
                          testID={`phase-${phase.key}-effort`}
                          onPress={() =>
                            setOpenMenu((cur) =>
                              cur === `${phase.key}:effort` ? null : `${phase.key}:effort`,
                            )
                          }
                          style={({ pressed }) => [styles.dropdown, pressed && styles.pressed]}
                        >
                          <Text style={styles.dropdownText}>{row.effort}</Text>
                        </Pressable>
                      ) : (
                        // Disabled with the reason, not blank: an empty cell reads as
                        // a missing feature and an enabled one would change nothing.
                        <Text style={styles.na} testID={`phase-${phase.key}-effort-na`}>
                          set by the CLI
                        </Text>
                      )}
                    </View>
                  </View>

                  {openMenu === `${phase.key}:model` ? (
                    <View style={styles.menu} testID={`phase-${phase.key}-model-menu`}>
                      {/* NONE, and ONLY on a cross-model review slot. Turning a build
                          step off would be a run with no builder; turning a Claude
                          reviewer off would silently shrink the merge gate. Turning a
                          cross-model seat off is a choice the owner is allowed to make,
                          and the label says what it costs rather than reading as a
                          neutral "unset". */}
                      {phase.allows_none ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ selected: off }}
                          accessibilityLabel={`${phase.label} model none`}
                          testID={`phase-${phase.key}-model-none`}
                          onPress={() => edit(phase.key, { model: payload.none_value })}
                          style={({ pressed }) => [
                            styles.menuItem,
                            off && styles.menuItemOn,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text style={styles.menuText}>
                            none — run no reviewer in this seat
                          </Text>
                        </Pressable>
                      ) : null}
                      {choices.map((c) => (
                        // NEVER HIDDEN, only disabled with the reason: an option the
                        // owner cannot see is one they cannot ask about.
                        <Pressable
                          key={c.tier}
                          accessibilityRole="button"
                          accessibilityState={{
                            selected: row.model === c.tier,
                            disabled: !c.selectable,
                          }}
                          accessibilityLabel={`${phase.label} model ${c.tier}`}
                          disabled={!c.selectable}
                          testID={`phase-${phase.key}-model-${c.tier}`}
                          onPress={() => edit(phase.key, { model: c.tier })}
                          style={({ pressed }) => [
                            styles.menuItem,
                            !off && row.model === c.tier && styles.menuItemOn,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text
                            style={[styles.menuText, !c.selectable && styles.menuTextOff]}
                          >
                            {c.tier} · {c.model_id}
                            {phase.default.model === c.tier ? ' (default)' : ''}
                            {c.reason !== null ? ` — ${c.reason}` : ''}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}

                  {openMenu === `${phase.key}:effort` ? (
                    <View style={styles.menu} testID={`phase-${phase.key}-effort-menu`}>
                      {payload.efforts.map((eff) => (
                        <Pressable
                          key={eff}
                          accessibilityRole="button"
                          accessibilityState={{ selected: row.effort === eff }}
                          accessibilityLabel={`${phase.label} effort ${eff}`}
                          testID={`phase-${phase.key}-effort-${eff}`}
                          onPress={() => edit(phase.key, { effort: eff })}
                          style={({ pressed }) => [
                            styles.menuItem,
                            row.effort === eff && styles.menuItemOn,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text style={styles.menuText}>
                            {eff}
                            {phase.default.effort === eff ? ' (default)' : ''}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}

            <Text style={styles.footnote}>
              Each option names the model it resolves to today. Choosing the one marked
              default clears the override, so the step keeps following that default if it
              ever moves.
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
  stale: { color: THEME.danger, fontSize: 12, lineHeight: 16 },
  struck: { textDecorationLine: 'line-through' },
  controls: { flexDirection: 'row', gap: 10 },
  control: { flex: 1, gap: 4 },
  dropdown: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: THEME.hairline,
    backgroundColor: THEME.background,
  },
  dropdownText: { color: THEME.text_primary, fontSize: 12 },
  na: { color: THEME.text_muted, fontSize: 12, paddingVertical: 8 },
  menu: {
    borderWidth: 1,
    borderColor: THEME.hairline,
    borderRadius: 8,
    overflow: 'hidden',
  },
  menuItem: { paddingHorizontal: 10, paddingVertical: 9 },
  menuItemOn: { backgroundColor: THEME.hairline },
  menuText: { color: THEME.text_primary, fontSize: 12 },
  menuTextOff: { color: THEME.text_muted },
  primaryBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: THEME.accent,
  },
  primaryBtnText: { color: THEME.background, fontSize: 14, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },
});
