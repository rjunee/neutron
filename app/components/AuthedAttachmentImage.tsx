/**
 * @neutronai/app — bearer-authed attachment image renderer.
 *
 * The gateway returns chat attachments as RELATIVE, bearer-authed URLs
 * (`/api/app/upload/<user>/<hash>.<ext>`). A raw `<Image source={{ uri }}>`
 * neither resolves the host-less path nor sends the bearer, so the user's
 * own sent image renders as a broken thumbnail (the GET 401s — the upload
 * surface honors only `Authorization: Bearer`, no query/cookie token).
 *
 * This component closes that gap, mirroring the web client's
 * `AttachmentImage` (`landing/chat-react/ChatApp.tsx`):
 *   - native (iOS/Android): RN `<Image>` honors `source.headers`, so we
 *     render the resolved absolute URL with the bearer attached directly.
 *   - RN-web: `<img>` ignores `source.headers`, so we fetch the blob WITH
 *     the bearer and render the resulting object URL (revoked on unmount /
 *     src change), exactly like the web client.
 *
 * Non-authed URLs (`data:`/`blob:`/`file:`/external `https:`) and a missing
 * session both fall through to a plain `<Image>` with no header.
 */

import { useEffect, useState } from 'react';
import { Image, Platform, StyleSheet, Text, View, type ImageStyle, type StyleProp } from 'react-native';

import { resolveAttachmentSource, type AttachmentAuthCtx } from '../lib/attachment-url';
import { THEME, TYPOGRAPHY } from '../lib/theme';

export interface AuthedAttachmentImageProps {
  url: string;
  auth: AttachmentAuthCtx | null;
  style?: StyleProp<ImageStyle>;
}

export function AuthedAttachmentImage({ url, auth, style }: AuthedAttachmentImageProps) {
  const source = resolveAttachmentSource(url, auth);
  // RN-web's <img> drops source.headers — fetch the blob with the bearer
  // instead. Native honors headers, so it renders the source directly.
  const needsWebFetch = Platform.OS === 'web' && source.headers !== undefined;
  const [webUri, setWebUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const bearer = source.headers?.Authorization;

  useEffect(() => {
    if (!needsWebFetch || bearer === undefined) return;
    let active = true;
    let created: string | null = null;
    const ac = new AbortController();
    fetch(source.uri, { method: 'GET', headers: { Authorization: bearer }, signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`attachment fetch failed (status ${res.status})`);
        const blob = await res.blob();
        const obj = URL.createObjectURL(blob);
        if (active) {
          created = obj;
          setWebUri(obj);
        } else {
          URL.revokeObjectURL(obj);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      ac.abort();
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [needsWebFetch, source.uri, bearer]);

  if (failed) {
    return (
      <View style={[style, styles.fallback]}>
        <Text style={styles.fallbackText}>📎 image unavailable</Text>
      </View>
    );
  }

  if (needsWebFetch) {
    if (webUri === null) {
      return (
        <View style={[style, styles.fallback]}>
          <Text style={styles.fallbackText}>Loading image…</Text>
        </View>
      );
    }
    return (
      <Image
        source={{ uri: webUri }}
        style={style}
        accessibilityIgnoresInvertColors
      />
    );
  }

  return (
    <Image
      source={source}
      style={style}
      accessibilityIgnoresInvertColors
      onError={() => setFailed(true)}
    />
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface_raised,
  },
  fallbackText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.caption.fontSize,
  },
});
