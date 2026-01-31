import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "dark" | "light" | "system";
export type Accent = "teal" | "blue" | "violet" | "rose" | "amber" | "slate";

type ThemeProviderProps = {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  defaultAccent?: Accent;
  accentStorageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

function isTheme(value: string | null): value is Theme {
  return value === "dark" || value === "light" || value === "system";
}

function isAccent(value: string | null): value is Accent {
  return (
    value === "teal" ||
    value === "blue" ||
    value === "violet" ||
    value === "rose" ||
    value === "amber" ||
    value === "slate"
  );
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  defaultAccent = "teal",
  accentStorageKey = "vite-ui-accent",
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(storageKey) ?? sessionStorage.getItem(storageKey);
      if (isTheme(stored)) return stored;
    } catch {
      // ignore
    }
    return defaultTheme;
  });

  const [accent, setAccentState] = useState<Accent>(() => {
    try {
      const stored =
        localStorage.getItem(accentStorageKey) ?? sessionStorage.getItem(accentStorageKey);
      if (isAccent(stored)) return stored;
    } catch {
      // ignore
    }
    return defaultAccent;
  });

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    if (theme === "system") {
      const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
        ? "dark"
        : "light";
      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme);
  }, [theme]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.dataset.accent = accent;
  }, [accent]);

  const value = useMemo<ThemeProviderState>(
    () => ({
      theme,
      setTheme: (next) => {
        try {
          localStorage.setItem(storageKey, next);
        } catch {
          try {
            sessionStorage.setItem(storageKey, next);
          } catch {
            // ignore
          }
        }
        setThemeState(next);
      },
      accent,
      setAccent: (next) => {
        try {
          localStorage.setItem(accentStorageKey, next);
        } catch {
          try {
            sessionStorage.setItem(accentStorageKey, next);
          } catch {
            // ignore
          }
        }
        setAccentState(next);
      },
    }),
    [accent, accentStorageKey, storageKey, theme],
  );

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export function useTheme(): ThemeProviderState {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
