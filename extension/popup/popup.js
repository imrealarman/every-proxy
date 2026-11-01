import { parseMany } from '../lib/parse.js';

const $ = (id) => document.getElementById(id);
let servers = [];
let selectedId = null;
let state = { connected: false };
let mode = 'all';
let sites = [];
let pings = {};
let realDelay = null;
let ready = false;

const store = {
  async load() {
    const d = await chrome.storage.local.get(['servers', 'selectedId', 'state', 'theme', 'mode', 'sites', 'pings']);
    servers = d.servers || [];
    selectedId = d.selectedId || null;
    state = d.state || { connected: false };
    mode = d.mode || 'all';
    sites = d.sites || [];
    pings = d.pings || {};
    if (d.theme) document.documentElement.dataset.theme = d.theme;
  },
  saveServers: () => chrome.storage.local.set({ servers, selectedId }),
};

function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg || '';
}

function render() {
  const list = $('list');
  list.replaceChildren();
  $('empty').hidden = servers.length > 0;

  for (const s of servers) {
    const li = document.createElement('li');
    li.className = 'item' + (s.id === selectedId ? ' sel' : '');
    li.innerHTML = '<span class="badge"></span><div class="meta"><div class="name"></div><div class="addr"></div></div>';
    li.querySelector('.badge').textContent = s.protocol === 'shadowsocks' ? 'ss' : s.protocol;
    li.querySelector('.name').textContent = s.name;
    li.querySelector('.addr').textContent = `${s.address}:${s.port}`;

    const del = document.createElement('button');
    del.className = 'icon-btn del';
    del.title = 'Remove';
    del.setAttribute('aria-label', `Remove ${s.name}`);
    del.textContent = '✕';
    del.onclick = async (e) => {
      e.stopPropagation();
      servers = servers.filter((x) => x.id !== s.id);
      if (selectedId === s.id) selectedId = null;
      await store.saveServers();
      render();
    };
    const ms = document.createElement('span');
    const v = pings[s.id];
    ms.className = 'ms' + (v === undefined ? '' : v < 0 ? ' bad' : v < 300 ? ' good' : v < 800 ? ' mid' : ' bad');
    ms.textContent = v === undefined ? '' : v < 0 ? 'timeout' : `${v} ms`;
    li.append(ms, del);
    li.onclick = async () => { selectedId = s.id; await store.saveServers(); render(); };
    list.append(li);
  }

  const active = servers.find((s) => s.id === state.id);
  $('status').classList.toggle('on', !!state.connected);
  $('status-title').textContent = state.connected ? 'Connected' : 'Disconnected';
  $('status-sub').textContent = state.connected && active
    ? active.name + (realDelay != null ? ` · ${realDelay < 0 ? 'unreachable' : realDelay + ' ms'}` : '')
    : selectedId ? servers.find((s) => s.id === selectedId)?.name ?? '' : 'Select a server to connect';
  const t = $('toggle');
  t.textContent = state.connected ? 'Disconnect' : 'Connect';
  // The setup check is advisory: connecting reports a missing core itself, so a failed check never locks the button.
  t.disabled = !state.connected && !selectedId;
  $('restart').disabled = !(state.id || selectedId);
  if (state.error) showError(state.error);

  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('sites-box').hidden = mode !== 'sites';
  $('sites-empty').hidden = sites.length > 0;
  const chips = $('sites');
  chips.replaceChildren();
  for (const host of sites) {
    const li = document.createElement('li');
    const x = document.createElement('button');
    x.textContent = '✕';
    x.setAttribute('aria-label', `Remove ${host}`);
    x.onclick = () => saveSites(sites.filter((h) => h !== host));
    li.append(host, x);
    chips.append(li);
  }
}

const saveSites = async (next) => { sites = next; await chrome.storage.local.set({ sites }); render(); };

document.querySelectorAll('.seg button').forEach((b) => {
  b.onclick = async () => { mode = b.dataset.mode; await chrome.storage.local.set({ mode }); render(); measureReal(); };
});

$('site-add').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host;
  try {
    const u = new URL(tab.url);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    host = u.hostname.replace(/^www\./, '');
  } catch {
    return showError('Open a regular website tab first.');
  }
  showError('');
  if (!sites.includes(host)) await saveSites([...sites, host]);
};

// Round-trip through the active proxy; only meaningful when all traffic is proxied.
async function measureReal() {
  realDelay = null;
  if (!state.connected || mode !== 'all') return render();
  const t0 = performance.now();
  try {
    await fetch('https://www.gstatic.com/generate_204', { cache: 'no-store', mode: 'no-cors' });
    realDelay = Math.round(performance.now() - t0);
  } catch {
    realDelay = -1;
  }
  render();
}

$('ping').onclick = async () => {
  const btn = $('ping');
  btn.disabled = true;
  btn.textContent = 'Pinging…';
  showError('');
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'ping',
      targets: servers.map((s) => ({ id: s.id, host: s.address, port: s.port })),
    });
    if (!r.ok) throw new Error(r.error);
    pings = r.results;
    await chrome.storage.local.set({ pings });
  } catch (e) {
    showError(`Ping failed: ${e.message}`);
  }
  btn.disabled = false;
  btn.textContent = 'Ping';
  render();
};

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (!r.ok) throw new Error(r.error);
  state = r.state;
}

// Detects a missing native helper or Xray core and keeps polling until setup is done.
let checkTimer = null;
async function checkSetup() {
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: 'check' });
  } catch {
    r = { host: false, core: false };
  }
  ready = r.host && r.core;
  $('setup').hidden = ready;
  if (!r.host) {
    $('setup-title').textContent = 'Setup required: helper not installed';
    $('setup-text').textContent = 'Browsers cannot run VLESS/VMess/Trojan themselves. Install the helper once to enable the proxy core.';
  } else if (!r.core) {
    $('setup-title').textContent = 'Setup required: proxy core missing';
    $('setup-text').textContent = 'The helper is installed but Xray-core is not downloaded yet.';
  }
  if (ready) { clearInterval(checkTimer); checkTimer = null; if (state.error) showError(''); }
  else if (!checkTimer) checkTimer = setInterval(async () => { await checkSetup(); render(); }, 2000);
  render();
}

$('copy').onclick = async () => {
  await navigator.clipboard.writeText(String.raw`powershell -ExecutionPolicy Bypass -File .\native\install.ps1`);
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
};

$('toggle').onclick = async () => {
  const btn = $('toggle');
  btn.disabled = true;
  showError('');
  try {
    await send(state.connected ? { type: 'disconnect' } : { type: 'connect', id: selectedId });
  } catch (e) {
    showError(e.message);
  }
  btn.disabled = false;
  render();
};

// Stops the core and starts it again with the active (or selected) server.
$('restart').onclick = async () => {
  const btn = $('restart');
  btn.disabled = true;
  btn.textContent = 'Restarting…';
  showError('');
  try {
    await send({ type: 'restart', id: state.id || selectedId });
    measureReal();
  } catch (e) {
    showError(e.message);
  }
  btn.textContent = 'Restart core';
  render();
};

$('add-open').onclick =() => { $('add').hidden = false; $('links').focus(); };
$('add-cancel').onclick = () => { $('add').hidden = true; };

async function importText(text) {
  const { servers: added, errors } = parseMany(text);
  if (added.length) {
    servers.push(...added);
    selectedId ||= added[0].id;
    await store.saveServers();
  }
  showError(errors.length ? `${errors.length} link(s) skipped: ${errors[0]}` : '');
  return added.length;
}

$('add-save').onclick = async () => {
  const n = await importText($('links').value);
  if (n) { $('links').value = ''; $('add').hidden = true; }
  render();
};

$('sub-fetch').onclick = async () => {
  const url = $('sub-url').value.trim();
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Subscription returned ${res.status}`);
    const n = await importText(await res.text());
    if (n) { $('sub-url').value = ''; $('add').hidden = true; }
  } catch (e) {
    showError(e.message);
  }
  render();
};

$('theme').onclick = async () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  await chrome.storage.local.set({ theme: next });
};

chrome.storage.onChanged.addListener((c) => {
  if (c.state) { state = c.state.newValue || { connected: false }; render(); measureReal(); }
});

await store.load();
render();
measureReal();
checkSetup();
