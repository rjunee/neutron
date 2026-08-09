/**
 * @neutronai/app — THE COMPOSER DOCK: the bottom band of the project shell, and
 * the one place the chat composer is allowed to render.
 *
 * WHY IT EXISTS. The mobile shell is a ROW — the project rail on the left, a
 * column of tab bar + content on the right (`app/app/projects/[id]/_layout.tsx`).
 * The composer was the last child of the chat surface, which lives inside that
 * right-hand column, so the rail ate 72pt off its leading edge and the input read
 * as narrower than the conversation above it. Owner, 2026-07-31: *"would it be
 * possible to have the text entry box take the full width of the screen instead
 * of being shortened by the project rail?"* Every messaging app this is measured
 * against — iMessage, WhatsApp, Telegram — runs the composer edge to edge.
 *
 * WHY NOT JUST MOVE IT LEFT. A negative margin (or a negative `left`) does escape
 * the parent's box visually, and then the escaped strip is DEAD on Android: a
 * ViewGroup does not dispatch touches to a child outside its own bounds, so the
 * left half of the field would draw and refuse to focus. A control that is
 * visible and untappable is worse than one that is merely narrow.
 *
 * SO THE COMPOSER MOVES IN THE TREE, not in the paint. The shell grows a
 * full-width band under the rail row, and the chat surface publishes its composer
 * into that band. The rail and the message list keep the relationship they had
 * with each other, ABOVE it; the rail's ScrollView simply gets shorter, so no
 * rail row is ever covered by the band.
 *
 * WHY A STORE AND NOT PLAIN CONTEXT STATE. The chat surface re-renders on every
 * inbound token, and holding the published element in the shell's own `useState`
 * would re-render the rail (eight animated rows) and the tab bar at that rate.
 * The dock host subscribes to a mutable store instead, so a republish re-renders
 * exactly one component — the band.
 *
 * OWNERSHIP IS TOKEN-KEYED. Two chat surfaces can be mounted for a frame during a
 * route transition; the departing one's cleanup must not blank a band the
 * arriving one has already claimed, so `clear` is a no-op unless the caller still
 * holds the dock.
 *
 * THERE IS NO INLINE FALLBACK. A surface rendered with no dock in scope THROWS,
 * rather than quietly drawing its composer back inside the column — a second
 * placement is exactly the dual code path this repo bans, and the failure it
 * would hide (a composer in the wrong place) is the defect this module exists to
 * fix.
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

import { UsageMeter } from '../components/UsageMeter';
import type { UsagePayload } from './usage-client';

/** The published composer, plus the subscription the band reads it through. */
export interface ComposerDockStore {
  subscribe: (listener: () => void) => () => void;
  /** The currently published band content. `null` when nothing holds the dock. */
  read: () => ReactNode;
  /** Publish (or replace) the band's content on behalf of `owner`. */
  put: (owner: object, node: ReactNode) => void;
  /** Release the dock — ignored unless `owner` still holds it. */
  clear: (owner: object) => void;
}

export function createComposerDockStore(): ComposerDockStore {
  let owner: object | null = null;
  let node: ReactNode = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    // Snapshot: a listener may unsubscribe while this is iterating.
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read() {
      return node;
    },
    put(nextOwner, nextNode) {
      owner = nextOwner;
      node = nextNode;
      emit();
    },
    clear(prevOwner) {
      // A newer surface already took the band — its content stands.
      if (owner !== prevOwner) return;
      owner = null;
      node = null;
      emit();
    },
  };
}

const ComposerDockContext = createContext<ComposerDockStore | null>(null);

function useComposerDockStore(): ComposerDockStore {
  const store = useContext(ComposerDockContext);
  if (store === null) {
    throw new Error(
      'composer dock: no <ComposerDockProvider> above this tree — the composer would have nowhere to render',
    );
  }
  return store;
}

/**
 * Puts a dock in scope. Wrap the whole project shell: the producer (the chat
 * surface, deep inside `<Slot/>`) and the consumer ({@link ComposerDock}) both
 * have to see the same store.
 */
export function ComposerDockProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const store = useMemo(createComposerDockStore, []);
  return <ComposerDockContext.Provider value={store}>{children}</ComposerDockContext.Provider>;
}

/**
 * THE BAND. Render it as the LAST child of the shell's full-width column, below
 * the rail row — that placement is the whole feature, and it is also what makes
 * the docked surface's own bottom edge the WINDOW's bottom edge, which the
 * keyboard-inset measurement depends on (`lib/keyboard-inset.ts`).
 *
 * Empty when nothing is published, which costs a zero-height view. No style: the
 * published composer draws its own background, border and insets, and a second
 * opinion here would fight it.
 */
export function ComposerDock({ usage }: { usage?: UsagePayload }): React.JSX.Element {
  const store = useComposerDockStore();
  const node = useSyncExternalStore(store.subscribe, store.read, store.read);
  return (
    <View testID="composer-dock">
      {/* THE SESSION METER SITS HERE NOW, above the input, at the owner's request:
          "move the hairline session status bar to instead be on the top of the
          message input box, rather than at the top of the screen".

          It is ABOVE the published node rather than inside the composer because the
          composer is published from deep inside `<Slot/>` and does not know about
          usage; the dock is rendered by the shell, which already holds the reading.
          This is a structural addition, not the "second opinion" on the composer's
          own background/border/insets that the note above forbids — the meter draws
          two 1px lines and nothing else.

          `usage` is OPTIONAL so the test harness, which mounts a bare
          `<ComposerDock/>`, keeps composing unchanged. */}
      {usage !== undefined ? <UsageMeter usage={usage} /> : null}
      {node}
    </View>
  );
}

/**
 * Publish `node` into the dock for as long as the calling component is mounted.
 *
 * Republishes on every render — the node is a fresh element each time — which
 * re-renders the band and nothing else.
 */
export function useComposerDock(node: ReactNode): void {
  const store = useComposerDockStore();
  // Identity for this mount. `{}` allocated once; the ref is what survives.
  const owner = useRef<object>({});
  // Deliberately un-deped: the published element is new on every render.
  useLayoutEffect(() => {
    store.put(owner.current, node);
  });
  useLayoutEffect(() => {
    const token = owner.current;
    return () => {
      store.clear(token);
    };
  }, [store]);
}
