import { createElement, type ReactNode } from 'react';
export const routerCalls: Array<{ kind: 'push' | 'replace'; href: string }> = [];
export function useRouter() {
  return {
    push: (href: string) => { routerCalls.push({ kind: 'push', href }); },
    replace: (href: string) => { routerCalls.push({ kind: 'replace', href }); },
    back: () => {},
  };
}
export function useLocalSearchParams<T>(): T { return {} as T; }
export function usePathname(): string { return '/'; }
export function useSegments(): string[] { return []; }
export function Slot(): ReactNode { return null; }
export function Stack(): ReactNode { return null; }
export function Link({ children }: { children?: ReactNode }) { return createElement('span', null, children); }
export function Redirect(): ReactNode { return null; }
