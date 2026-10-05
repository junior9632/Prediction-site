/* GoalPredict — admin login */
'use strict';
(function () {
  const { API, icons } = App;
  const $ = (s) => document.querySelector(s);

  document.addEventListener('DOMContentLoaded', () => {
    $('#alertIcon').innerHTML = icons.info;
    const form = $('#loginForm');
    const alert = $('#loginAlert');

    API.get('/auth/me')
      .then((me) => {
        if (me && me.type === 'admin') window.location.replace('/admin.html');
      })
      .catch(() => {});

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const btn = $('#submitBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Signing in…';
      alert.classList.add('hidden');
      try {
        await API.post('/auth/admin/login', { login: $('#login').value.trim(), password: $('#password').value });
        window.location.replace('/admin.html');
      } catch (err) {
        alert.className = 'alert error';
        $('#loginAlertText').textContent = err.message || 'Login failed';
        alert.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    });
  });
})();
