/**
 * @neutronai/app — dependency-free clipboard helper (M2.4).
 *
 * The invite flow needs a "Copy link" affordance. The app does not
 * depend on `expo-clipboard`, so we use the Web Clipboard API
 * (`navigator.clipboard.writeText`) which covers the web + mobile-web
 * targets where copy-to-send is the primary path. On native (no
 * `navigator.clipboard`) this resolves `false`; the UI still renders
 * the link as selectable text so the user can long-press → copy
 * manually. Returns whether the programmatic copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const nav = (
      globalThis as {
        navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } };
      }
    ).navigator;
    if (nav?.clipboard?.writeText !== undefined) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through — best-effort
  }
  return false;
}
