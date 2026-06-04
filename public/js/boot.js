(function () {
  var html = document.documentElement;
  html.classList.add('booting');

  function show() {
    html.classList.remove('booting');
    html.classList.add('ready');
  }

  // Fallback: nunca deixar a página presa invisível ou sem init
  setTimeout(show, 800);

  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var onLogin = location.pathname === '/login' || location.pathname.endsWith('/login.html');
      if (data.authenticated && onLogin) {
        location.replace('/');
        return;
      }
      if (!data.authenticated && !onLogin) {
        location.replace('/login');
        return;
      }
      show();
    })
    .catch(function () {
      if (location.pathname !== '/login' && !location.pathname.endsWith('/login.html')) {
        location.replace('/login');
      } else {
        show();
      }
    });
})();
