/**
 * @neutronai/app — the flush-on-authenticated-launch hook.
 *
 * The persisted queue only pays off if something actually drains it, and the
 * ONLY moment a report from a failed launch can be delivered is the first
 * moment a later launch holds a bearer. This renders nothing; it exists to sit
 * inside `AuthSessionProvider` and fire exactly once per (user, server) pair.
 *
 * Deliberately silent: a failed flush leaves the queue intact for the next
 * launch and says nothing to the user. Diagnostics is a passive observer — it
 * must never interrupt someone who is trying to use the app.
 */

import { useEffect, useRef } from 'react';

import { loadAppConfig } from '../lib/config';
import {
  flushDiagnostics,
  setDiagnosticsOrigin,
  setDiagnosticsSecrets,
} from '../lib/diagnostics';
import { useAuthSession } from '../lib/session';

export function DiagnosticsSync(): null {
  const { user } = useAuthSession();
  const flushedFor = useRef<string | null>(null);

  useEffect(() => {
    if (user === null) return;
    const config = loadAppConfig();
    if (!config.configured) return;
    // Register the live bearer as an exact redaction needle FIRST, so any event
    // recorded from here on is scrubbed of it even before a flush happens, and
    // bind new reports to THIS gateway so a server change cannot send them to
    // the wrong instance.
    setDiagnosticsSecrets([user.token]);
    setDiagnosticsOrigin(config.gateway_base_url);
    const key = `${config.gateway_base_url}::${user.id}`;
    if (flushedFor.current === key) return;
    flushedFor.current = key;
    void flushDiagnostics({ base_url: config.gateway_base_url, token: user.token }).catch(
      () => undefined,
    );
  }, [user]);

  return null;
}
