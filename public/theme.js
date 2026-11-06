// Loaded before first paint so a saved theme applies without a flash.
// No saved choice means the page follows the operating system preference.
(() => {
  const key = 'release-explorer-theme';
  const themes = ['system', 'light', 'dark'];
  const root = document.documentElement;

  const saved = () => {
    try {
      const value = localStorage.getItem(key);
      return themes.includes(value) ? value : 'system';
    } catch {
      return 'system';
    }
  };

  const apply = (theme) => {
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
    }
  };

  apply(saved());

  document.addEventListener('DOMContentLoaded', () => {
    apply(saved());
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.addEventListener('click', () => {
        const theme = button.dataset.themeChoice;
        try {
          if (theme === 'system') localStorage.removeItem(key);
          else localStorage.setItem(key, theme);
        } catch {
          // Storage can be blocked; the choice still applies to this page.
        }
        apply(theme);
      });
    }
  });

  // Keep other open tabs in step with the latest choice.
  window.addEventListener('storage', (event) => {
    if (event.key === key) apply(saved());
  });
})();
