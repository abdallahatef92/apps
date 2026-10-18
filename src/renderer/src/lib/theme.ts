/**
 * Layout themes. Each theme is a token block in styles.css selected by
 * `data-theme` on <html>; values and validation notes live in docs/themes.md.
 * The choice is a per-viewer convenience kept in localStorage.
 */
export type ThemeId = 'crypto' | 'technical' | 'finance' | 'prof';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  mode: 'dark' | 'light';
  description: string;
}

export const THEMES: ThemeInfo[] = [
  { id: 'crypto', label: 'Control room', mode: 'dark',
    description: 'Vivid blue on navy; blue = on track, orange = over' },
  { id: 'technical', label: 'Technical', mode: 'dark',
    description: 'Teal/cyan on slate, engineering register' },
  { id: 'finance', label: 'Finance', mode: 'light',
    description: 'Trust-first, high-contrast blue on white' },
  { id: 'prof', label: 'Professional', mode: 'light',
    description: 'Understated indigo, prints well' },
];

const STORAGE_KEY = 'ci.theme';
const DEFAULT_THEME: ThemeId = 'crypto';

function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

/** The stored theme, or `crypto` when nothing (or something unknown) is stored. */
export function getTheme(): ThemeId {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Switch the document to a theme and remember the choice. */
export function applyTheme(id: ThemeId): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    /* storage unavailable — the theme still applies for this session */
  }
}
