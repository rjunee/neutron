import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';

import {
  isThemePreference,
  readThemePreference,
  resolveTheme,
  setResolvedTheme,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from './theme';
export type { ThemePreference } from './theme';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: DEFAULT_THEME_PREFERENCE,
  resolved: 'dark',
  setPreference: () => undefined,
});

export function AppThemeProvider({ children }: React.PropsWithChildren): React.JSX.Element {
  const systemAppearance = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const resolved = resolveTheme(preference, systemAppearance);
  setResolvedTheme(resolved);

  useEffect(() => {
    let active = true;
    void readThemePreference(AsyncStorage)
      .then((stored) => {
        if (active && isThemePreference(stored)) setPreferenceState(stored);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference): void => {
    setPreferenceState(next);
    void writeThemePreference(AsyncStorage, next);
  }, []);

  return (
    <ThemeContext.Provider key={resolved} value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useAppTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
