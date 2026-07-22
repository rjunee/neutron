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
 *
 * A NON-image attachment (e.g. a PDF, newly uploadable in M2) does NOT render
 * as an `<Image>` at all — it renders as a tappable file chip
 * ({@link AuthedAttachmentFile}), mirroring the web client's `AttachmentImage`
 * file-chip branch (`landing/chat-react/ChatApp.tsx`). Without this a document
 * painted as a broken image with no openable affordance (Argus r2 BLOCKER #1).
 */

import { useEffect, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type StyleProp,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import {
  attachmentBasename,
  isImageAttachmentUrl,
  resolveAttachmentSource,
  type AttachmentAuthCtx,
} from '../lib/attachment-url';
import { THEME, TYPOGRAPHY } from '../lib/theme';

export interface AuthedAttachmentImageProps {
  url: string;
  auth: AttachmentAuthCtx | null;
  style?: StyleProp<ImageStyle>;
}

/**
 * Pure dispatcher — deliberately calls NO hooks. It branches on the attachment
 * type and delegates to a hook-owning leaf, rather than early-returning ABOVE a
 * hook block in a single component. That structure matters: if this one
 * component owned the hooks AND early-returned for non-image URLs, a same-
 * instance re-render whose `url` flips image↔non-image (user sends an image then
 * a PDF and React/list-virtualization recycles the instance) would change the
 * hook count between renders — a rules-of-hooks violation that crashes at
 * runtime with "Rendered more/fewer hooks than expected". By branching to
 * DIFFERENT component types here, a url flip swaps the rendered type, so React
 * unmounts the old leaf and mounts a fresh one instead of reusing an instance
 * whose hook count changed. (Argus r3 MAJOR.)
 */
export function AuthedAttachmentImage({ url, auth, style }: AuthedAttachmentImageProps) {
  // A non-image attachment (PDF, …) renders as a downloadable file chip, never
  // an <Image> — otherwise the document paints as a broken thumbnail.
  if (!isImageAttachmentUrl(url)) {
    return <AuthedAttachmentFile url={url} auth={auth} />;
  }
  return <AuthedAttachmentImageView url={url} auth={auth} style={style} />;
}

/**
 * Hook-owning leaf for the image path. Only ever mounted with an image URL (the
 * dispatcher guarantees it), so its hook count is stable across every render of
 * a given instance — the invariant the rules of hooks require.
 */
export function AuthedAttachmentImageView({ url, auth, style }: AuthedAttachmentImageProps) {
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

/**
 * A NON-image attachment (PDF, …) rendered as a tappable file chip — the mobile
 * analogue of the web client's `<a download>` file chip. Mirrors the web
 * behavior as closely as React-Native allows:
 *   - non-authed URLs (`data:`/external `https:`) open directly;
 *   - our bearer-authed `/api/app/upload/…` URLs can't open by URL (the GET
 *     honors only `Authorization: Bearer`, no query/cookie token), so we fetch
 *     the blob WITH the bearer, then open it: on RN-web via an object URL in a
 *     new tab (exactly like the web client), on native by persisting the bytes
 *     to a cache file and handing it to the OS share/preview sheet (Quick Look
 *     on iOS, the share intent on Android). Preview fidelity on native depends
 *     on the OS viewer, but the filename affordance + open attempt always
 *     render — a document never paints as a broken image.
 *
 * NOTE — native must NOT hand a `data:`/`file:` URL to `WebBrowser`: iOS
 * SFSafariViewController and Android Chrome Custom Tabs reject non-http(s)
 * INITIAL urls, so the open fails silently (Argus r2 BLOCKER). The write-to-
 * cache + `Sharing.shareAsync` path below is the correct native affordance.
 */
export function AuthedAttachmentFile({
  url,
  auth,
}: {
  url: string;
  auth: AttachmentAuthCtx | null;
}) {
  const name = attachmentBasename(url);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    // On web the browser only honors `window.open()` while the click's user
    // activation is still live. The authed path below `await`s a fetch + blob
    // first, and by then Safari (and Chrome) treat a fresh `window.open()` as an
    // unrequested popup and BLOCK it — so we must open the tab SYNCHRONOUSLY here,
    // inside the gesture, and navigate it once the blob is ready. The pre-fix code
    // called `window.open` post-fetch AND ignored its null return, so a blocked
    // popup failed silently (Argus r1 MAJOR). A null handle now surfaces failure.
    const webWin: Window | null =
      Platform.OS === 'web' ? (globalThis.open?.('', '_blank') ?? null) : null;
    try {
      if (Platform.OS === 'web' && webWin === null) {
        // Browser blocked the popup before we even fetched — don't fail silently.
        throw new Error('attachment popup blocked');
      }
      const source = resolveAttachmentSource(url, auth);
      const bearer = source.headers?.Authorization;
      if (bearer === undefined) {
        // Non-authed (data:/external https:) — open the URL directly.
        if (webWin !== null) webWin.location.href = source.uri;
        else await WebBrowser.openBrowserAsync(source.uri);
        return;
      }
      const res = await fetch(source.uri, {
        method: 'GET',
        headers: { Authorization: bearer },
      });
      if (!res.ok) throw new Error(`attachment fetch failed (status ${res.status})`);
      const blob = await res.blob();
      if (webWin !== null) {
        const obj = URL.createObjectURL(blob);
        // The already-open tab keeps its src alive; revoke on a delay so the leak
        // is bounded.
        webWin.location.href = obj;
        setTimeout(() => URL.revokeObjectURL(obj), 60_000);
        return;
      }
      // Native: SFSafariViewController (iOS) / Chrome Custom Tabs (Android)
      // reject `data:` and `file:` as an initial URL, so the blob can't go to
      // WebBrowser. Persist the authed bytes to a cache file and hand the file
      // to the OS share/preview sheet, which every native document viewer
      // understands.
      const base64 = dataUrlToBase64(await blobToDataUrl(blob));
      const fileUri = `${FileSystem.cacheDirectory ?? ''}${cacheFilename(name)}`;
      await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: 'base64' });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, blob.type ? { mimeType: blob.type } : undefined);
      } else {
        // Fallback for the rare platform where sharing is unavailable (some
        // emulators): a file:// URL at least reaches the system handler.
        await WebBrowser.openBrowserAsync(fileUri);
      }
    } catch {
      // Close the blank tab we optimistically opened so a failure doesn't strand
      // an empty about:blank window.
      webWin?.close();
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`Open attachment ${name}`}
      style={({ pressed }) => [styles.fileChip, pressed && styles.fileChipPressed]}
    >
      <Text style={styles.fileChipText} numberOfLines={1}>
        📎 {failed ? `${name} — couldn't open` : busy ? `${name}…` : name}
      </Text>
    </Pressable>
  );
}

/** Strip the `data:<mime>;base64,` prefix, leaving the bare base64 payload. */
function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** A filesystem-safe cache filename derived from the attachment basename. */
function cacheFilename(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '');
  return safe.length > 0 ? safe : 'attachment';
}

/** Read a Blob as a base64 `data:` URL (RN provides a `FileReader` global). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('FileReader returned non-string result'));
    };
    reader.readAsDataURL(blob);
  });
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
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: THEME.surface_raised,
  },
  fileChipPressed: {
    opacity: 0.6,
  },
  fileChipText: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
  },
});
