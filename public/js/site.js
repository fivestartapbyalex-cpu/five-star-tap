import { api, $, ICON } from './core.js';

/* ---------- nav ---------- */

const toggle = $('#nav-toggle');
const links = $('#nav-links');
const mobile = matchMedia('(max-width: 780px)');

toggle.innerHTML = ICON.menu;

function syncNav() {
  if (mobile.matches) {
    links.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  } else {
    links.hidden = false;
  }
}
mobile.addEventListener('change', syncNav);
syncNav();

toggle.addEventListener('click', () => {
  const open = links.hidden;
  links.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
});

// Close the menu after jumping to a section.
links.addEventListener('click', (ev) => {
  if (ev.target.tagName === 'A' && mobile.matches) syncNav();
});

/* ---------- reveal on scroll ---------- */

const reveals = [...document.querySelectorAll('.reveal')];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// The hiding rule is scoped to .js-reveal, so if this script never runs the
// page renders fully instead of staying blank.
if (!reduced && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('js-reveal');

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

  reveals.forEach(node => observer.observe(node));

  // A background tab never fires the observer. Don't let that leave anything
  // permanently invisible: sweep once the tab is actually looked at.
  const sweep = () => {
    for (const node of reveals) {
      if (node.classList.contains('in')) continue;
      const r = node.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) {
        node.classList.add('in');
        observer.unobserve(node);
      }
    }
  };
  addEventListener('load', sweep);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sweep(); });
}

/* ---------- smooth in-page links ---------- */

for (const link of document.querySelectorAll('a[href^="#"]')) {
  link.addEventListener('click', (ev) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    ev.preventDefault();
    target.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
    history.replaceState(null, '', link.getAttribute('href'));
  });
}

/* ---------- contact form ---------- */

const form = $('#inquiry-form');
const errBox = $('#form-error');
const okBox = $('#form-ok');
const submit = $('#f-submit');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errBox.hidden = true;
  okBox.hidden = true;

  const body = {
    name: $('#f-name').value.trim(),
    business: $('#f-business').value.trim(),
    email: $('#f-email').value.trim(),
    phone: $('#f-phone').value.trim(),
    message: $('#f-message').value.trim(),
    website: $('#f-website').value,   // honeypot
  };

  if (!body.name || !body.email || !body.message) {
    errBox.textContent = 'Please fill in your name, email and a short message.';
    errBox.hidden = false;
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Sending…';
  try {
    await api('/api/inquiry', { method: 'POST', body });
    form.reset();
    okBox.textContent = 'Thank you — that has come through. We will be in touch shortly.';
    okBox.hidden = false;
    submit.textContent = 'Sent';
  } catch (e) {
    errBox.textContent = e.message;
    errBox.hidden = false;
    submit.disabled = false;
    submit.textContent = 'Send inquiry';
  }
});

/* ---------- misc ---------- */

$('#year').textContent = String(new Date().getFullYear());
