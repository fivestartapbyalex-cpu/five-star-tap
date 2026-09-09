import { api, $, el, toast, initials, inkOn, ICON } from './core.js';

/* A spread that stays distinguishable at pin size, in both themes. */
const PALETTE = [
  '#0071e3', '#5e5ce6', '#bf5af2', '#ff2d55', '#ff375f',
  '#ff9500', '#ffcc00', '#34c759', '#00a396', '#30b0c7',
  '#a2845e', '#8e8e93',
];

let me = null;
let users = [];

/* ========================================================================== */

function render() {
  const host = $('#users');
  host.replaceChildren(...users.map(row));
}

function row(user) {
  const inactive = user.active === false;
  return el('div', { class: 'urow' },
    el('span', {
      class: 'avatar avatar-lg',
      style: { background: user.color, color: inkOn(user.color) },
      'aria-hidden': 'true',
    }, initials(user.name)),

    el('div', { class: 'who' },
      el('div', { class: 'n' },
        user.name,
        user.role === 'admin' && el('span', { class: 'tag tag-admin' }, 'Admin'),
        inactive && el('span', { class: 'tag tag-off' }, 'Disabled'),
        user.id === me.id && el('span', { class: 'tag' }, 'You'),
      ),
      el('div', { class: 'e' }, user.email),
    ),

    el('div', { class: 'acts' },
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => openUserModal(user),
      }, 'Edit'),
      user.id !== me.id && el('button', {
        class: 'icon-btn', type: 'button',
        title: 'Delete account', 'aria-label': `Delete ${user.name}`, html: ICON.trash,
        onclick: () => removeUser(user),
      }),
    ),
  );
}

async function removeUser(user) {
  const ok = confirm(
    `Delete ${user.name}?\n\n` +
    'Their locations and notes are kept — the pins simply become unassigned, ' +
    'and you can reassign them from the map.',
  );
  if (!ok) return;
  try {
    const res = await api(`/api/users/${user.id}`, { method: 'DELETE' });
    users = users.filter(u => u.id !== user.id);
    render();
    toast(res.unassigned
      ? `${user.name} deleted · ${res.unassigned} location${res.unassigned === 1 ? '' : 's'} now unassigned`
      : `${user.name} deleted`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ========================================================================== */

function openUserModal(user = null) {
  const editing = !!user;
  let color = user?.color || PALETTE[users.length % PALETTE.length];

  const overlay = $('#overlay');
  const msg = el('div', { class: 'msg msg-error', hidden: true });

  const name = el('input', { type: 'text', value: user?.name || '', placeholder: 'Sam Rivera', maxlength: '80' });
  const email = el('input', { type: 'email', value: user?.email || '', placeholder: 'sam@company.com', autocomplete: 'off' });
  const password = el('input', {
    type: 'text', placeholder: editing ? 'Leave blank to keep the current one' : 'At least 8 characters',
    autocomplete: 'off', spellcheck: 'false',
  });
  const role = el('select', {},
    el('option', { value: 'rep', selected: user?.role !== 'admin' }, 'Sales rep'),
    el('option', { value: 'admin', selected: user?.role === 'admin' }, 'Admin — can manage the team'),
  );
  const active = el('select', {},
    el('option', { value: 'yes', selected: user?.active !== false }, 'Active — can sign in'),
    el('option', { value: 'no', selected: user?.active === false }, 'Disabled — cannot sign in'),
  );

  const swatches = el('div', { class: 'swatches' },
    ...PALETTE.map(hex => el('button', {
      class: 'swatch', type: 'button',
      style: { '--c': hex },
      'aria-pressed': String(hex === color),
      'aria-label': `Color ${hex}`,
      title: hex,
      onclick: (ev) => {
        color = hex;
        [...ev.currentTarget.parentElement.children]
          .forEach(b => b.setAttribute('aria-pressed', String(b === ev.currentTarget)));
      },
    })),
  );

  const save = el('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, editing ? 'Save changes' : 'Create account');

  function close() {
    overlay.hidden = true;
    overlay.replaceChildren();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(ev) { if (ev.key === 'Escape') close(); }

  async function submit() {
    msg.hidden = true;
    const body = {
      name: name.value.trim(),
      email: email.value.trim(),
      color,
      role: role.value,
      active: active.value === 'yes',
    };
    if (!body.name) return fail('Enter a name.');
    if (!body.email) return fail('Enter an email.');
    if (password.value) body.password = password.value;
    if (!editing && !body.password) return fail('Set a starting password — at least 8 characters.');

    save.disabled = true;
    try {
      if (editing) {
        const { user: saved } = await api(`/api/users/${user.id}`, { method: 'PATCH', body });
        users = users.map(u => (u.id === saved.id ? saved : u));
        toast('Account updated');
      } else {
        const { user: created } = await api('/api/users', { method: 'POST', body });
        users.push(created);
        toast(`${created.name} can now sign in`);
      }
      render();
      close();
    } catch (e) {
      save.disabled = false;
      fail(e.message);
    }
  }

  function fail(text) { msg.textContent = text; msg.hidden = false; }

  overlay.replaceChildren(el('div', {
    class: 'modal', role: 'dialog', 'aria-modal': 'true',
    'aria-label': editing ? 'Edit account' : 'New account',
  },
    el('div', { class: 'modal-head' },
      el('h2', {}, editing ? `Edit ${user.name}` : 'Add a rep'),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', html: ICON.close, onclick: close }),
    ),
    el('div', { class: 'modal-body' },
      msg,
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'Name'), name),
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'Email'), email),
      el('label', { class: 'field' },
        el('span', { class: 'label' }, editing ? 'Reset password' : 'Starting password'),
        password,
        el('span', { class: 'hint' }, editing
          ? 'Type a new password here to reset it, then pass it on to them.'
          : 'Send this to them — they can change it once they sign in.'),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'label' }, 'Map color'),
        swatches,
        el('span', { class: 'hint' }, 'Every pin this rep covers shows in this color.'),
      ),
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'Role'), role),
      editing && el('label', { class: 'field' }, el('span', { class: 'label' }, 'Access'), active),
    ),
    el('div', { class: 'modal-foot' },
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      save,
    ),
  ));

  overlay.hidden = false;
  overlay.onclick = ev => { if (ev.target === overlay) close(); };
  document.addEventListener('keydown', onKey);
  setTimeout(() => name.focus(), 0);
}

/* ========================================================================== */

async function boot() {
  const { user } = await api('/api/me');
  if (!user) { location.href = '/signin'; return; }
  if (user.role !== 'admin') { location.href = '/map'; return; }
  me = user;

  ({ users } = await api('/api/users'));
  render();
  $('#new-btn').onclick = () => openUserModal();
}

boot().catch(err => toast(err.message, 'err'));
