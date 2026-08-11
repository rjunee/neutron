/**
 * @neutronai/app — MCP SERVERS settings: the programs the assistant may start.
 *
 * Reached as: chat header ☰ → Settings → MCP servers. A registered route nothing
 * pushes is the ISSUES #385 defect, so the nav row in `settings.tsx` is part of this
 * feature, not decoration (guarded by `__tests__/mcp-servers-reachable.test.tsx`).
 *
 * ── INSTALLING IS NOT APPROVING ─────────────────────────────────────────────
 * Adding a server records what the owner wants and shows him exactly what it would
 * do. It does not start anything. Approve is a separate press, on a body of text the
 * SERVER rendered, and until it happens the server is not in the assistant's session
 * at all. That separation is the whole security model: an installed MCP server is a
 * subprocess with the owner's permissions, and the owner is the only gate.
 *
 * ── THE PROMPT IS DISPLAYED VERBATIM ────────────────────────────────────────
 * `grant_prompt` arrives from the server, already naming the command, every argument
 * and the NAMES of the environment variables. This screen does not rebuild, summarise
 * or truncate it. A prompt assembled on the device could describe something other
 * than what the server would run — the failure that makes a gate worse than none.
 *
 * ── VALUES ARE WRITE-ONLY ───────────────────────────────────────────────────
 * Environment values are typed here and sent once. Nothing returns them, so no field
 * on this screen can show a secret, and re-saving a server means re-entering them —
 * which is stated in the form rather than left to be discovered.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { loadAppConfig } from '../lib/config';
import {
  McpServersClient,
  McpServersClientError,
  parseEnvLines,
  serverSummary,
  splitCommandLine,
  type McpServerRow,
  type McpServersPayload,
} from '../lib/mcp-servers-client';
import { useAuthSession } from '../lib/session';
import { THEME } from '../lib/theme';

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : 'something went wrong';
}

export default function McpServersScreen() {
  const router = useRouter();
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);

  const client = useMemo(() => {
    if (user === null) return null;
    return new McpServersClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const [payload, setPayload] = useState<McpServersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [commandLine, setCommandLine] = useState('');
  const [envText, setEnvText] = useState('');

  const load = useCallback(async () => {
    if (client === null) return;
    setLoading(true);
    setError(null);
    try {
      setPayload(await client.load());
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run one mutation, replacing the whole payload from its reply. */
  const mutate = useCallback(
    async (call: () => Promise<McpServersPayload>, after?: () => void): Promise<void> => {
      if (client === null || busy) return;
      setBusy(true);
      setError(null);
      try {
        setPayload(await call());
        after?.();
      } catch (err) {
        // The draft is KEPT on failure so a rejected command can be corrected in
        // place rather than retyped.
        setError(formatErr(err));
        // A REFUSED DECISION CARRIES THE CURRENT LIST — apply it. Otherwise the screen
        // keeps rendering the prompt that was refused for being stale, next to a
        // message saying it was stale, and the only way out is a manual reload.
        if (err instanceof McpServersClientError && err.servers !== null) {
          const servers = err.servers;
          setPayload((prev) => (prev === null ? prev : { ...prev, servers }));
        }
      } finally {
        setBusy(false);
      }
    },
    [client, busy],
  );

  const add = useCallback(async () => {
    if (client === null) return;
    const { command, args } = splitCommandLine(commandLine);
    const { env, errors } = parseEnvLines(envText);
    // A LINE HE MEANT AS A VARIABLE IS NOT DROPPED. Refuse the whole save and say which
    // line is wrong, rather than installing a server missing a variable it needs — the
    // reply would then list only the names that saved, and the absent one reads as a
    // display quirk instead of the reason nothing works.
    if (errors.length > 0) {
      setError(errors.join('; '));
      return;
    }
    await mutate(
      () =>
        client.install({
          name: name.trim().toLowerCase(),
          command,
          args,
          env,
        }),
      () => {
        setName('');
        setCommandLine('');
        setEnvText('');
      },
    );
  }, [client, mutate, name, commandLine, envText]);

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
          testID="mcp-back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerBack, pressed && styles.pressed]}
        >
          <Text style={styles.headerIcon}>←</Text>
        </Pressable>
        <View>
          <Text style={styles.headerOverline}>Settings</Text>
          <Text style={styles.headerTitle}>MCP servers</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.muted}>
          Extra tools for your assistant, each one a program on this machine. Adding a
          server does not start it — you approve it here first, and the request below
          shows exactly what it would run. One set serves every project, and an approved
          server is attached when your assistant next starts a Claude session.
        </Text>

        {error !== null ? (
          <Text style={styles.bannerError} testID="mcp-error">
            {error}
          </Text>
        ) : null}

        {loading ? (
          <ActivityIndicator color={THEME.text_secondary} testID="mcp-loading" />
        ) : payload === null ? (
          <Text style={styles.muted}>Couldn&apos;t load your MCP servers.</Text>
        ) : (
          <>
            {payload.servers.length === 0 ? (
              <Text style={styles.muted} testID="mcp-empty">
                Nothing installed yet.
              </Text>
            ) : null}

            {payload.servers.map((row: McpServerRow) => {
              const summary = serverSummary(row);
              return (
                <View key={row.name} style={styles.card} testID={`mcp-${row.name}`}>
                  <View style={styles.cardHead}>
                    <Text style={styles.cardTitle}>{row.name}</Text>
                    {/* "approved", NOT "running" — and the same word the web settings
                        surface uses for this same field, the two being held to parity by
                        `mcp-servers-client-parity.test.ts`. `active` means the next Claude
                        session will ATTACH this server (approved for this exact spec, with
                        its secrets present); `mcpServers` is read once at startup, so
                        nothing is running between turns. The status line directly below
                        says "starts it with its next session", and this badge contradicted
                        it — overstating the wiring is the one failure this feature exists to
                        avoid, and it is why `McpServerStatus.active`'s own docblock spells
                        out that it is not a claim about a process. */}
                    {row.active ? (
                      <Text style={styles.tagOk} testID={`mcp-${row.name}-active`}>
                        approved
                      </Text>
                    ) : null}
                    {summary.needs_owner ? (
                      <Text style={styles.tagWarn} testID={`mcp-${row.name}-attention`}>
                        needs you
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.status} testID={`mcp-${row.name}-status`}>
                    {summary.label}
                  </Text>
                  {/* ONE LINE PER ARGV ENTRY. A space-joined command line renders
                      `{command:'a b'}` and `{command:'a',args:['b']}` identically
                      though they run different programs — see `renderMcpServerGrant`.
                      The row summary must not be less honest than the prompt. */}
                  <Text style={styles.mono} testID={`mcp-${row.name}-command`}>
                    {row.command}
                  </Text>
                  {row.args.map((arg, i) => (
                    <Text
                      key={`${row.name}-arg-${String(i)}`}
                      style={styles.monoArg}
                      testID={`mcp-${row.name}-arg-${String(i)}`}
                    >
                      {`arg ${String(i + 1)}  ${arg}`}
                    </Text>
                  ))}
                  {row.env_names.length > 0 ? (
                    <Text style={styles.footnote}>Variables: {row.env_names.join(', ')}</Text>
                  ) : null}

                  {row.approval !== 'approved' ? (
                    // The server's own words, verbatim — see the file header.
                    <Text style={styles.grant} testID={`mcp-${row.name}-grant`}>
                      {row.grant_prompt}
                    </Text>
                  ) : null}

                  <View style={styles.cardActions}>
                    {row.approval !== 'approved' ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Approve ${row.name}`}
                        testID={`mcp-${row.name}-approve`}
                        disabled={busy}
                        onPress={() => {
                          if (client !== null) {
                            void mutate(() =>
                              client.decide(row.name, 'approve', row.grant_hash),
                            );
                          }
                        }}
                        style={({ pressed }) => [
                          styles.primaryBtn,
                          busy && styles.btnDisabled,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={styles.primaryBtnText}>Approve</Text>
                      </Pressable>
                    ) : null}
                    {row.approval === 'pending' ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Deny ${row.name}`}
                        testID={`mcp-${row.name}-deny`}
                        disabled={busy}
                        onPress={() => {
                          if (client !== null) {
                            void mutate(() => client.decide(row.name, 'deny', row.grant_hash));
                          }
                        }}
                        style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
                      >
                        <Text style={styles.secondaryBtnText}>Deny</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${row.name}`}
                      testID={`mcp-${row.name}-remove`}
                      disabled={busy}
                      onPress={() => {
                        if (client !== null) void mutate(() => client.remove(row.name));
                      }}
                      style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
                    >
                      <Text style={styles.dangerBtnText}>Remove</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}

            <View style={styles.card} testID="mcp-form">
              <Text style={styles.cardTitle}>Add a server</Text>
              <Text style={styles.label}>Name</Text>
              <TextInput
                testID="mcp-form-name"
                value={name}
                onChangeText={setName}
                placeholder="example-server"
                placeholderTextColor={THEME.text_muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <Text style={styles.label}>Command</Text>
              <TextInput
                testID="mcp-form-command"
                value={commandLine}
                onChangeText={setCommandLine}
                placeholder="/usr/local/bin/example-mcp --stdio"
                placeholderTextColor={THEME.text_muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <Text style={styles.label}>Environment variables</Text>
              <TextInput
                testID="mcp-form-env"
                value={envText}
                onChangeText={setEnvText}
                placeholder={'EXAMPLE_API_KEY=…\nEXAMPLE_REGION=…'}
                placeholderTextColor={THEME.text_muted}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                style={[styles.input, styles.inputMulti]}
              />
              <Text style={styles.footnote}>
                One NAME=value per line. Values are stored encrypted and never shown again,
                so re-saving a server means re-entering them.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add MCP server"
                testID="mcp-form-save"
                disabled={busy}
                onPress={() => void add()}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  busy && styles.btnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryBtnText}>{busy ? 'Saving…' : 'Add'}</Text>
              </Pressable>
            </View>
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
  card: {
    gap: 8,
    padding: 12,
    borderRadius: 10,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { color: THEME.text_primary, fontSize: 15, fontWeight: '600' },
  tagOk: { color: THEME.text_secondary, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  tagWarn: { color: THEME.warning, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  status: { color: THEME.text_secondary, fontSize: 12 },
  mono: { color: THEME.text_primary, fontSize: 12, fontFamily: 'Menlo' },
  monoArg: { color: THEME.text_secondary, fontSize: 11, fontFamily: 'Menlo', paddingLeft: 10 },
  grant: {
    color: THEME.text_secondary,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Menlo',
    backgroundColor: THEME.background,
    borderRadius: 8,
    padding: 10,
  },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  label: { color: THEME.text_secondary, fontSize: 11, textTransform: 'uppercase' },
  input: {
    color: THEME.text_primary,
    fontSize: 13,
    borderWidth: 1,
    borderColor: THEME.hairline,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  inputMulti: { minHeight: 72, textAlignVertical: 'top' },
  primaryBtn: {
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: THEME.accent,
  },
  primaryBtnText: { color: THEME.background, fontSize: 13, fontWeight: '700' },
  secondaryBtn: {
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  secondaryBtnText: { color: THEME.text_secondary, fontSize: 13, fontWeight: '600' },
  dangerBtn: {
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  dangerBtnText: { color: THEME.danger, fontSize: 13, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
});
