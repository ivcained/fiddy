// The shell bootstrap: runs in <head>, before the document paints, as a plain
// same-origin script.
//
// It lives in its own file rather than inline in index.html so the served shell
// needs no 'unsafe-inline' in script-src: the client's CSP is `script-src 'self'`
// and this file is 'self'. Anything moved back inline widens the CSP again.
//
// It must be a CLASSIC script (no type="module", no defer): a module script is
// deferred, and a deferred bootstrap runs after the body is parsed — which is
// exactly the light flash this file exists to prevent.
(function () {
  var STORAGE_KEY = 'user-saved-theme';
  // Fiddy is a dark client: an unset preference resolves to dark, not to the OS,
  // so the shell never flashes the fork's light ground.
  var DEFAULT_THEME = 'dark';

  var root = document.documentElement;
  try {
    var stored = localStorage.getItem(STORAGE_KEY);
    var userSavedTheme = stored || DEFAULT_THEME;

    var effective = userSavedTheme;
    if (userSavedTheme === 'system') {
      var prefersDark = window.matchMedia(
        '(prefers-color-scheme: dark)',
      ).matches;
      effective = prefersDark ? 'dark' : 'light';
    }

    root.classList.toggle('dark', effective === 'dark');
    root.classList.toggle('light', effective === 'light');
    root.setAttribute('data-theme', userSavedTheme);
  } catch (e) {
    // Fallback if localStorage is unavailable
    var fallbackDark = window.matchMedia(
      '(prefers-color-scheme: dark)',
    ).matches;
    root.classList.toggle('dark', fallbackDark);
    root.classList.toggle('light', !fallbackDark);
  }
})();
