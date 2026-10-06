import { isHostDarkColors } from './host.js';
import { getPreference, setPreference } from './preferences.js';
import { getDomPort } from '../ports/DomPort.js';

export const THEME_STORAGE_KEY = 'image-toolbox-theme';
export const THEME_VERSION_KEY = 'image-toolbox-theme-version';
export const THEME_VERSION = 'neutral-teal-light-default-v1';

export const THEME_CHOICES = {
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark',
};

const VALID_THEME_CHOICES = new Set(Object.values(THEME_CHOICES));
let systemThemeListenerBound = false;

export function initTheme() {
  applyThemeChoice(getThemeChoice(), false);
  bindSystemThemeListener();
}

export function getThemeChoice() {
  const savedVersion = getPreference(THEME_VERSION_KEY);
  let savedTheme = getPreference(THEME_STORAGE_KEY);

  if (savedVersion !== THEME_VERSION) {
    savedTheme = THEME_CHOICES.LIGHT;
    setPreference(THEME_STORAGE_KEY, savedTheme);
    setPreference(THEME_VERSION_KEY, THEME_VERSION);
  } else if (!VALID_THEME_CHOICES.has(savedTheme)) {
    savedTheme = THEME_CHOICES.LIGHT;
  }

  return savedTheme;
}

export function applyThemeChoice(choice, persist = true) {
  const themeChoice = VALID_THEME_CHOICES.has(choice) ? choice : THEME_CHOICES.LIGHT;

  if (persist) {
    setPreference(THEME_STORAGE_KEY, themeChoice);
    setPreference(THEME_VERSION_KEY, THEME_VERSION);
  }

  const root = getDomPort()?.getDocumentElement?.();
  root?.setAttribute?.('data-theme-preference', themeChoice);
  root?.setAttribute?.('data-theme', resolveTheme(themeChoice));
}

function resolveTheme(choice) {
  if (choice === THEME_CHOICES.SYSTEM) {
    return getSystemTheme();
  }

  return choice;
}

function getSystemTheme() {
  const hostDark = isHostDarkColors();
  if (hostDark !== null) {
    return hostDark ? THEME_CHOICES.DARK : THEME_CHOICES.LIGHT;
  }

  const mediaQuery = getDomPort()?.matchMedia?.('(prefers-color-scheme: dark)');
  if (mediaQuery) {
    return mediaQuery.matches ? THEME_CHOICES.DARK : THEME_CHOICES.LIGHT;
  }

  return THEME_CHOICES.LIGHT;
}

function bindSystemThemeListener() {
  if (systemThemeListenerBound) return;

  const mediaQuery = getDomPort()?.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mediaQuery) return;

  const handleChange = () => {
    if (getThemeChoice() === THEME_CHOICES.SYSTEM) {
      applyThemeChoice(THEME_CHOICES.SYSTEM, false);
    }
  };

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', handleChange);
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(handleChange);
  }

  systemThemeListenerBound = true;
}
