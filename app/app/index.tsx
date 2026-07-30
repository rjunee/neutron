/**
 * @neutronai/app — root entry (P5.2; LOGIN-FIRST since 2026-07-25).
 *
 * P5.1 mounted the chat surface directly at `/`. P5.2 introduces the
 * project view shell — chat is now scoped to a project at
 * `/projects/<id>/chat`. The top-level entry redirects:
 *
 *   - no server configured → /login   (the app has to DISCOVER, or be told,
 *                                      where its instance lives first)
 *   - no session           → /login
 *   - both                 → a CHAT route (SPEC § Decisions Log 2026-07-27)
 *
 * THE ENTRY IS A CHAT ROUTE, NEVER A LIST. Ryan, on device: *"I don't want this
 * screen shown. It should just open into the general chat with the rail on the
 * left. Delete this screen completely."* and *"I want the app to open on the
 * chat screen. Most recent project. Or general."* `/projects` (the list screen)
 * is DELETED, so this redirect resolves the most-recently-active project's chat
 * and falls back to General — the no-project scope, which needs no fetch and
 * always exists. The choice is `resolveEntryRoute` in `lib/entry-route.ts`, a
 * pure+testable module rather than a literal here: this decision was recorded on
 * 2026-07-27 and the code went unchanged for two days because nothing could
 * assert it.
 *
 * WHY THE SERVER CHECK LIVES HERE. Until 2026-07-25 an unconfigured
 * install never reached the router at all: `app/app/_layout.tsx` rendered
 * the typed-URL "Connect to your Neutron" gate INSTEAD of the `<Stack>`
 * (ISSUES #385). Login-first deletes that gate — the app opens on `/login`
 * and learns its address from `/v1/route` after authenticating
 * (`lib/identity-client.ts`). This redirect is what preserves the #385
 * invariant the gate used to enforce: no screen that issues gateway
 * requests may mount while `configured === false`. `/login` itself issues
 * none, so it is the safe place to hold.
 *
 * `configured` is read through `loadAppConfig()` on every render rather
 * than memoised for a lifetime: the whole tree is re-keyed on the
 * server-config epoch by `app/app/_layout.tsx`, so this component remounts
 * when discovery (or the self-host form) commits a server, and the next
 * read sees it.
 *
 * BOTH HOLD CONDITIONS LIVE IN `shouldHoldOnLogin` (lib/auth-helpers.ts), not
 * inline here, so the sprint's headline guarantee — an unconfigured install opens
 * on login — is covered by an executable assertion instead of by matching this
 * file's source text. The signed-out half of it goes through
 * `shouldRedirectToLogin`, never through a
 * bare `user === null`. The session provider starts at `status: 'hydrating'`
 * with `user` transiently null even for a signed-in install, so a bare null
 * check bounces to /login on every cold start and the owner sees a login
 * flash before being pulled back (Argus BLOCKER on PR #13; `settings.tsx` and
 * `integrations.tsx` already route through the shared guard).
 *
 * IT ALSO RENEWS. The bearer login-first persists is short-lived, so this is
 * where an aged-out session is silently refreshed and re-routed
 * (`renewInstanceSession`) before any gateway-calling screen mounts. Without
 * it, "sign in once" would decay into "retype your password every day" — the
 * clock would undo the discovery. Only a credential the identity service
 * actively REFUSED sends the owner back to /login; a network failure leaves
 * the existing session alone and retries next launch.
 */

import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { shouldHoldOnLogin } from '../lib/auth-helpers';
import { loadAppConfig } from '../lib/config';
import { resolveEntryRoute } from '../lib/entry-route';
import { renewInstanceSession } from '../lib/identity-client';
import { useAuthSession } from '../lib/session';
import { tokenStorage } from '../lib/token-storage';

export default function RootRedirect() {
  const router = useRouter();
  const { user, status, setUser, clear } = useAuthSession();
  const config = loadAppConfig();
  const configured = config.configured;
  // Renewal is a launch-time action, not a per-render one.
  const renewAttempted = useRef(false);

  useEffect(() => {
    // Hold the spinner while auth is still hydrating — see the header.
    if (status !== 'ready') return;
    if (shouldHoldOnLogin({ configured, status, user })) {
      router.replace('/login');
      return;
    }
    if (user === null) return; // unreachable given the guard; keeps TS honest.

    let cancelled = false;
    /**
     * Open on a CHAT route. `resolveEntryRoute` never throws and never returns a
     * non-chat route — an offline launch lands on General rather than stranding
     * the owner on this spinner.
     */
    const enterApp = async (token: string): Promise<void> => {
      const route = await resolveEntryRoute({ base_url: config.base_url, token });
      if (cancelled) return;
      router.replace(route as Parameters<typeof router.replace>[0]);
    };

    if (renewAttempted.current) {
      void enterApp(user.token);
      return () => {
        cancelled = true;
      };
    }
    renewAttempted.current = true;
    void (async () => {
      const outcome = await renewSession(user.token, config.auth_base_url);
      if (cancelled) return;
      if (outcome === 'sign_in_required') {
        clear();
        router.replace('/login');
        return;
      }
      if (outcome !== null) setUser({ ...user, token: outcome });
      // Enter with the FRESH bearer when one was minted — the list fetch that
      // picks the project is authenticated, and the old token may be spent.
      await enterApp(outcome ?? user.token);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clear,
    config.auth_base_url,
    config.base_url,
    configured,
    router,
    setUser,
    status,
    user,
  ]);

  return (
    <View style={styles.container}>
      <ActivityIndicator color="#cfcfcf" />
    </View>
  );
}

/**
 * Renew if needed. Returns the NEW bearer, `'sign_in_required'` when the
 * identity service refused the credential, or `null` for "nothing to do" —
 * which deliberately covers every transient failure, so being offline at
 * launch never signs anyone out.
 */
async function renewSession(
  token: string,
  auth_base_url: string,
): Promise<string | 'sign_in_required' | null> {
  try {
    const store = tokenStorage();
    const session = await store.getIdentitySession();
    // No identity session persisted = a self-hosted install signed in with a
    // pasted token. Those don't expire on a schedule and there is nothing to
    // refresh against, so leave it entirely alone.
    if (session === null) return null;
    const outcome = await renewInstanceSession({
      auth_base_url,
      token,
      session,
      now_ms: Date.now(),
    });
    if (outcome.kind === 'renewed') {
      // THE REFRESH TOKEN IS WRITTEN FIRST, AND THE TWO WRITES ARE SEQUENTIAL.
      // These used to run in a `Promise.all`, where a partial write could land
      // the NEW bearer next to the OLD refresh token — and that old token is
      // already revoked, so the next launch would replay it, trip the service's
      // reuse detection, and sign the owner out for good. In this order the only
      // partial outcome is a fresh refresh token beside a still-valid older
      // bearer, which the very next launch simply renews again.
      await store.setIdentitySession({ ...session, refresh_token: outcome.refresh_token });
      await store.setToken(outcome.token);
      return outcome.token;
    }
    // Nothing was spent, so nothing rotated and there is nothing to save.
    if (outcome.kind === 'not_needed') return null;
    // A ROTATION CAN ARRIVE ON A FAILURE TOO. When the refresh succeeded and the
    // route hop then failed, the token we presented is revoked and its
    // replacement comes back on the outcome — persist it before returning or the
    // next launch replays the revoked one. Deliberately BEFORE the
    // sign_in_required branch: that path clears storage, but if the write is
    // skipped and the clear is later interrupted the stale token survives.
    if (outcome.rotated_refresh_token !== undefined) {
      await store.setIdentitySession({
        ...session,
        refresh_token: outcome.rotated_refresh_token,
      });
    }
    if (outcome.kind === 'sign_in_required') {
      console.warn(`[identity] session cannot be renewed (${outcome.reason}); signing out`);
      return 'sign_in_required';
    }
    console.warn(`[identity] session renewal deferred (${outcome.reason})`);
    return null;
  } catch (err) {
    // Never let a renewal fault block entry — the existing token may be fine.
    console.warn('[identity] session renewal failed', err);
    return null;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
