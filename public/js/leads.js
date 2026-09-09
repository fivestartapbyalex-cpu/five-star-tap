import { api, $, el, toast, timeAgo, ICON } from './core.js';

let inquiries = [];
let showHandled = false;

function visible() {
  return inquiries.filter(e => showHandled || !e.handled);
}

function render() {
  const open = inquiries.filter(e => !e.handled).length;
  $('#count').textContent = open ? `${open} new` : 'all clear';
  $('#filter-btn').setAttribute('aria-pressed', String(showHandled));
  $('#filter-btn').textContent = showHandled ? 'Hide handled' : 'Show handled';

  const rows = visible();
  const host = $('#list');

  if (!rows.length) {
    host.replaceChildren(el('div', { class: 'empty' },
      el('div', { html: ICON.users }),
      el('div', { class: 't' }, inquiries.length ? 'Nothing outstanding' : 'No inquiries yet'),
      el('div', { class: 'd' }, inquiries.length
        ? 'Everything sent in has been marked handled.'
        : 'Messages sent through the website contact form land here.'),
    ));
    return;
  }
  host.replaceChildren(...rows.map(row));
}

function row(e) {
  const node = el('div', {
    class: 'urow',
    style: { alignItems: 'flex-start', opacity: e.handled ? '.55' : '1' },
  },
    el('div', { class: 'who' },
      el('div', { class: 'n' },
        e.business || e.name,
        e.handled && el('span', { class: 'tag' }, 'Handled'),
      ),
      el('div', { class: 'e', style: { whiteSpace: 'normal' } },
        e.business ? `${e.name} · ` : '',
        el('a', { href: `mailto:${e.email}` }, e.email),
        e.phone ? ' · ' : '',
        e.phone ? el('a', { href: `tel:${e.phone.replace(/[^\d+]/g, '')}` }, e.phone) : null,
      ),
      el('p', {
        style: {
          marginTop: '9px', fontSize: '13.5px', lineHeight: '1.55',
          color: 'var(--text-2)', whiteSpace: 'pre-wrap',
        },
      }, e.message),
      el('div', { style: { marginTop: '9px', fontSize: '11.5px', color: 'var(--faint)' } },
        timeAgo(e.createdAt)),
    ),

    el('div', { class: 'acts' },
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => {
          try {
            const { inquiry } = await api(`/api/inquiries/${e.id}`, {
              method: 'PATCH', body: { handled: !e.handled },
            });
            Object.assign(e, inquiry);
            render();
          } catch (err) { toast(err.message, 'err'); }
        },
      }, e.handled ? 'Reopen' : 'Mark handled'),
      el('button', {
        class: 'icon-btn', type: 'button',
        title: 'Delete', 'aria-label': `Delete inquiry from ${e.name}`, html: ICON.trash,
        onclick: async () => {
          if (!confirm(`Delete the inquiry from ${e.name}? This cannot be undone.`)) return;
          try {
            await api(`/api/inquiries/${e.id}`, { method: 'DELETE' });
            inquiries = inquiries.filter(x => x.id !== e.id);
            render();
          } catch (err) { toast(err.message, 'err'); }
        },
      }),
    ),
  );
  return node;
}

async function boot() {
  const { user } = await api('/api/me');
  if (!user) { location.href = '/signin'; return; }
  if (user.role !== 'admin') { location.href = '/map'; return; }

  ({ inquiries } = await api('/api/inquiries'));
  render();

  $('#filter-btn').onclick = () => { showHandled = !showHandled; render(); };
}

boot().catch(err => toast(err.message, 'err'));
