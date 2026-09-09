import { api, $ } from './core.js';

const form = $('#form');
const err = $('#err');
const submit = $('#submit');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  err.hidden = true;

  const email = $('#email').value.trim();
  const password = $('#password').value;
  if (!email || !password) {
    err.textContent = 'Enter your email and password.';
    err.hidden = false;
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    await api('/api/login', { method: 'POST', body: { email, password } });
    location.href = '/map';
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    $('#password').value = '';
    $('#password').focus();
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});
