// Server sessions are checked again when an already open operations tab is resumed.
(function () {
  if (location.hostname.endsWith('github.io')) {
    location.replace('https://chungnam-inline-pages.vercel.app/' + (location.pathname.includes('/judge/') ? 'judge/' : 'app/') + location.search);
    return;
  }
  async function checkSession() {
    if (document.hidden) return;
    try {
      var response = await fetch('/judge-auth/session/', { cache: 'no-store' });
      if (response.status === 401) location.reload();
    } catch (_) { /* An authenticated judge can keep recording while offline. */ }
  }
  window.addEventListener('pageshow', checkSession);
  document.addEventListener('visibilitychange', checkSession);
})();
