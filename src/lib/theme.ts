// The appearance choice. Dark is the default, including when nothing is stored yet.
// System follows the device. The boot script and `applyDocumentTheme` stay in step:
// both read `data-theme` and toggle the `dark` class the color tokens hang on.

export const THEMES = ['system', 'dark', 'light'] as const

export type ThemeName = (typeof THEMES)[number]

export function isThemeName(value: unknown): value is ThemeName {
  return value === 'system' || value === 'dark' || value === 'light'
}

export function isDarkTheme(theme: ThemeName, prefersDark: boolean) {
  return theme === 'dark' || (theme === 'system' && prefersDark)
}

/** Cookie the boot script reads. The settings file stays the stored choice. */
export const THEME_COOKIE = 'busyboy-theme'

/** Runs before paint. The document starts dark; this applies a saved light or system choice. */
export const THEME_BOOT = `(function(){
  var root = document.documentElement;
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var match = document.cookie.match(/(?:^|; )busyboy-theme=([^;]*)/);
  var stored = match ? decodeURIComponent(match[1]) : '';
  if (stored === 'light' || stored === 'dark' || stored === 'system') root.dataset.theme = stored;
  else if (!root.dataset.theme) root.dataset.theme = 'dark';
  function apply(){
    var theme = root.dataset.theme || 'dark';
    var dark = theme === 'dark' || (theme === 'system' && media.matches);
    root.classList.toggle('dark', dark);
  }
  apply();
  media.addEventListener('change', apply);
})();`

function themeFromCookie() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`))
  if (!match?.[1]) return null
  try {
    const value = decodeURIComponent(match[1])
    return isThemeName(value) ? value : null
  } catch {
    return null
  }
}

/** Applies the saved theme. The cookie wins, so a reload keeps what Settings stored. */
export function applyDocumentTheme() {
  const root = document.documentElement
  const theme = themeFromCookie() ?? (isThemeName(root.dataset.theme) ? root.dataset.theme : 'dark')
  const dark = isDarkTheme(theme, window.matchMedia('(prefers-color-scheme: dark)').matches)
  // Skip a no-op write: a mutation observer watches this attribute, and setting the same value
  // again would deliver another notification.
  if (root.dataset.theme !== theme) root.dataset.theme = theme
  if (root.classList.contains('dark') !== dark) root.classList.toggle('dark', dark)
}

/** Remembers the choice in the cookie the boot script reads on the next load. */
export function rememberTheme(theme: ThemeName) {
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=34560000; SameSite=Lax`
  document.documentElement.dataset.theme = theme
  applyDocumentTheme()
}
