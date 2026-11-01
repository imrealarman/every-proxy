import { buildXrayConfig, SOCKS_PORT } from './lib/parse.js';

const HOST = 'com.everyproxy.host';
let port = null;
let pending = null;

const getState = async () => (await chrome.storage.local.get('state')).state || { connected: false };
const setState = (state) => chrome.storage.local.set({ state });

function clearProxy() {
  return chrome.proxy.settings.clear({ scope: 'regular' });
}

// "all": every request goes through the core. "sites": only listed domains (and their subdomains).
async function applyProxy() {
  const { mode = 'all', sites = [] } = await chrome.storage.local.get(['mode', 'sites']);
  if (mode === 'sites') {
    const pac = `function FindProxyForURL(url, host) {
  var sites = ${JSON.stringify(sites)};
  for (var i = 0; i < sites.length; i++) {
    if (host === sites[i] || dnsDomainIs(host, "." + sites[i])) return "SOCKS5 127.0.0.1:${SOCKS_PORT}";
  }
  return "DIRECT";
}`;
    return chrome.proxy.settings.set({ scope: 'regular', value: { mode: 'pac_script', pacScript: { data: pac } } });
  }
  return chrome.proxy.settings.set({
    scope: 'regular',
    value: {
      mode: 'fixed_servers',
      rules: {
        singleProxy: { scheme: 'socks5', host: '127.0.0.1', port: SOCKS_PORT },
        bypassList: ['localhost', '127.0.0.1', '[::1]', '<local>'],
      },
    },
  });
}

function request(msg, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending = null; reject(new Error('Native host did not respond')); }, timeoutMs);
    pending = (reply) => { clearTimeout(t); pending = null; reply.ok ? resolve(reply) : reject(new Error(reply.error || 'Host error')); };
    port.postMessage(msg);
  });
}

async function teardown(error) {
  if (port) { const p = port; port = null; try { p.disconnect(); } catch { /* already gone */ } }
  await clearProxy();
  await setState({ connected: false, error: error || null });
}

async function connect(id) {
  const { servers = [] } = await chrome.storage.local.get('servers');
  const server = servers.find((s) => s.id === id);
  if (!server) throw new Error('Server not found');
  if (port) await teardown();

  const config = buildXrayConfig(server.raw);
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener((m) => pending && pending(m));
  port.onDisconnect.addListener(() => {
    const msg = chrome.runtime.lastError?.message;
    port = null;
    if (pending) pending({ ok: false, error: msg || 'Native host unavailable' });
    else teardown(msg || 'Proxy core stopped');
  });

  try {
    await request({ cmd: 'start', config });
  } catch (e) {
    await teardown(e.message);
    throw e;
  }
  await applyProxy();
  await setState({ connected: true, id, error: null });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === 'check') {
      try {
        const r = await chrome.runtime.sendNativeMessage(HOST, { cmd: 'status' });
        return reply({ ok: true, host: true, core: !!r.core });
      } catch {
        return reply({ ok: true, host: false, core: false });
      }
    }
    if (msg.type === 'ping') {
      const r = await chrome.runtime.sendNativeMessage(HOST, { cmd: 'ping', targets: msg.targets });
      if (!r.ok) throw new Error(r.error);
      return reply({ ok: true, results: r.results });
    }
    if (msg.type === 'connect') await connect(msg.id);
    else if (msg.type === 'disconnect') await teardown();
    reply({ ok: true, state: await getState() });
  })().catch((e) => reply({ ok: false, error: e.message }));
  return true;
});

// Scope changes take effect immediately while connected.
chrome.storage.onChanged.addListener(async (c) => {
  if ((c.mode || c.sites) && (await getState()).connected) await applyProxy();
});

// A proxy setting outlives the browser but the core does not, so reset on launch.
chrome.runtime.onStartup.addListener(() => teardown());
chrome.runtime.onInstalled.addListener(() => teardown());
