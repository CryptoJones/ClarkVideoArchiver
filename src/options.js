/* global Helper, api */

/* ------------------------------ setup guide ------------------------------ */

const tabs = [...document.querySelectorAll('nav.tabs button')];

function showTab(name) {
  for (const btn of tabs) {
    const active = btn.dataset.tab === name;
    btn.setAttribute('aria-selected', String(active));
    document.getElementById(`tab-${btn.dataset.tab}`).hidden = !active;
  }
}

for (const btn of tabs) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
}

// Every command in the guide gets a copy button, so nothing has to be
// retyped by hand from a page the user cannot select cleanly.
for (const btn of document.querySelectorAll('button.copy')) {
  btn.addEventListener('click', async () => {
    const code = btn.parentElement.querySelector('code');
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Press Ctrl-C';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
  });
}

// Deep link so the popup's settings link can land straight on the helper tab.
const requested = new URLSearchParams(location.search).get('tab');
if (requested && tabs.some((b) => b.dataset.tab === requested)) showTab(requested);

/* -------------------------------- settings ------------------------------- */

const els = {
  enabled: document.getElementById('enabled'),
  adapter: document.getElementById('adapter'),
  adapterNote: document.getElementById('adapter-note'),
  endpoint: document.getElementById('endpoint'),
  token: document.getElementById('token'),
  test: document.getElementById('test'),
  save: document.getElementById('save'),
  config: document.getElementById('config'),
  warnings: document.getElementById('warnings'),
};

function notify(text, kind = 'info') {
  els.warnings.textContent = '';
  const p = document.createElement('p');
  p.className = `notice ${kind}`;
  p.textContent = text;
  els.warnings.append(p);
}

for (const a of Object.values(Helper.ADAPTERS)) {
  const opt = document.createElement('option');
  opt.value = a.id;
  opt.textContent = a.label;
  els.adapter.append(opt);
}

function syncAdapterNote() {
  els.adapterNote.textContent = Helper.ADAPTERS[els.adapter.value]?.note || '';
}

function syncEnabled() {
  els.config.style.opacity = els.enabled.checked ? '1' : '.55';
  for (const el of [els.adapter, els.endpoint, els.token, els.test, els.save]) {
    el.disabled = !els.enabled.checked;
  }
  // Save stays usable so the user can persist "off" without re-enabling first.
  els.save.disabled = false;
}

function currentConfig() {
  return {
    enabled: els.enabled.checked,
    adapter: els.adapter.value,
    endpoint: els.endpoint.value.trim().replace(/\/+$/, ''),
    token: els.token.value,
  };
}

async function load() {
  const { helper } = await api.storage.local.get('helper');
  const cfg = { ...Helper.DEFAULT_CONFIG, ...(helper || {}) };
  els.enabled.checked = cfg.enabled;
  els.adapter.value = cfg.adapter;
  els.endpoint.value = cfg.endpoint;
  els.token.value = cfg.token;
  syncAdapterNote();
  syncEnabled();
}

els.adapter.addEventListener('change', syncAdapterNote);
els.enabled.addEventListener('change', syncEnabled);

els.save.addEventListener('click', async () => {
  const cfg = currentConfig();
  if (cfg.enabled && !cfg.endpoint) {
    notify('Enter an endpoint, or turn the helper off.', 'error');
    return;
  }
  await api.storage.local.set({ helper: cfg });
  notify('Saved.', 'info');
});

els.test.addEventListener('click', async () => {
  const cfg = currentConfig();
  if (!cfg.endpoint) {
    notify('Enter an endpoint first.', 'error');
    return;
  }
  els.test.disabled = true;
  notify('Contacting the service...');
  try {
    const adapter = Helper.adapterFor(cfg);
    const health = await adapter.health(cfg);
    const caps = Object.entries(health.capabilities || {})
      .map(([k, v]) => `${k}: ${v ? 'yes' : 'no'}`)
      .join(', ');
    notify(`Connected — ${health.info}${caps ? ` (${caps})` : ''}`, 'info');
  } catch (err) {
    // A blocked fetch and a stopped service look identical from here, so say so
    // rather than asserting which one it was.
    notify(
      `Could not reach it: ${err.message}. Check the service is running and the URL is right.`,
      'error',
    );
  } finally {
    els.test.disabled = false;
  }
});

load();
