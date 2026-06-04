const EYE_OPEN =
  '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
const EYE_CLOSED =
  '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>' +
  '<path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>' +
  '<line x1="1" y1="1" x2="23" y2="23"/>';

document.getElementById('toggle-pw')?.addEventListener('click', function () {
  const input = document.getElementById('password');
  const icon = document.getElementById('eye-icon');
  if (!input || !icon) return;

  if (input.type === 'password') {
    input.type = 'text';
    icon.innerHTML = EYE_CLOSED;
    this.setAttribute('aria-label', 'Ocultar senha');
    this.title = 'Ocultar senha';
  } else {
    input.type = 'password';
    icon.innerHTML = EYE_OPEN;
    this.setAttribute('aria-label', 'Mostrar senha');
    this.title = 'Mostrar senha';
  }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    if (res.ok) {
      location.replace('/');
      return;
    }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Falha no login.';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
});
