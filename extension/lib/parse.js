// Share-link parsing and Xray outbound generation for vless://, vmess://, trojan://, ss://

export const SOCKS_PORT = 10808;

function b64decode(s) {
  s = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function newId() {
  return crypto.randomUUID();
}

// Builds Xray streamSettings from a flat option object.
function buildStream(o) {
  const net = (o.net || 'tcp').toLowerCase();
  const security = (o.security || 'none').toLowerCase();
  const s = { network: net === 'http' ? 'h2' : net, security };
  const host = o.host || undefined;
  const path = o.path || '/';

  if (net === 'ws') {
    s.wsSettings = { path, headers: host ? { Host: host } : {} };
  } else if (net === 'grpc') {
    s.grpcSettings = { serviceName: o.serviceName || '', multiMode: o.mode === 'multi' };
  } else if (net === 'h2' || net === 'http') {
    s.httpSettings = { path, host: host ? host.split(',') : [] };
  } else if (net === 'httpupgrade') {
    s.httpupgradeSettings = { path, host };
  } else if (net === 'xhttp' || net === 'splithttp') {
    s.network = 'xhttp';
    s.xhttpSettings = { path, host, mode: o.mode || 'auto' };
  } else if (net === 'tcp' && o.headerType === 'http') {
    s.tcpSettings = {
      header: { type: 'http', request: { path: path.split(','), headers: host ? { Host: host.split(',') } : {} } },
    };
  }

  if (security === 'tls') {
    s.tlsSettings = {
      serverName: o.sni || host || o.address,
      allowInsecure: o.allowInsecure === '1' || o.allowInsecure === 'true' || o.allowInsecure === true,
      fingerprint: o.fp || undefined,
      alpn: o.alpn ? o.alpn.split(',') : undefined,
    };
  } else if (security === 'reality') {
    s.realitySettings = {
      serverName: o.sni || '',
      fingerprint: o.fp || 'chrome',
      publicKey: o.pbk || '',
      shortId: o.sid || '',
      spiderX: o.spx || '',
    };
  }
  return s;
}

function parseVmess(link) {
  const j = JSON.parse(b64decode(link.slice('vmess://'.length)));
  const address = j.add;
  const port = Number(j.port);
  const stream = buildStream({
    net: j.net,
    security: j.tls === 'tls' ? 'tls' : 'none',
    host: j.host,
    path: j.path,
    sni: j.sni,
    alpn: j.alpn,
    fp: j.fp,
    headerType: j.type,
    serviceName: j.path,
    mode: j.type === 'multi' ? 'multi' : undefined,
    address,
  });
  return {
    name: j.ps || `${address}:${port}`,
    protocol: 'vmess',
    address,
    port,
    outbound: {
      protocol: 'vmess',
      settings: {
        vnext: [{ address, port, users: [{ id: j.id, alterId: Number(j.aid || 0), security: j.scy || 'auto' }] }],
      },
      streamSettings: stream,
    },
  };
}

function parseUrlStyle(link, protocol) {
  const u = new URL(link);
  const p = u.searchParams;
  const address = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || 443);
  const secret = decodeURIComponent(u.username);
  const name = decodeURIComponent(u.hash.slice(1)) || `${address}:${port}`;
  const stream = buildStream({
    net: p.get('type') || 'tcp',
    security: p.get('security') || (protocol === 'trojan' ? 'tls' : 'none'),
    host: p.get('host'),
    path: p.get('path') ? decodeURIComponent(p.get('path')) : undefined,
    sni: p.get('sni') || p.get('peer'),
    alpn: p.get('alpn'),
    fp: p.get('fp'),
    allowInsecure: p.get('allowInsecure') || p.get('insecure'),
    serviceName: p.get('serviceName'),
    mode: p.get('mode'),
    headerType: p.get('headerType'),
    pbk: p.get('pbk'),
    sid: p.get('sid'),
    spx: p.get('spx'),
    address,
  });

  if (protocol === 'vless') {
    return {
      name, protocol, address, port,
      outbound: {
        protocol: 'vless',
        settings: {
          vnext: [{ address, port, users: [{ id: secret, encryption: p.get('encryption') || 'none', flow: p.get('flow') || undefined }] }],
        },
        streamSettings: stream,
      },
    };
  }
  return {
    name, protocol, address, port,
    outbound: { protocol: 'trojan', settings: { servers: [{ address, port, password: secret }] }, streamSettings: stream },
  };
}

function parseShadowsocks(link) {
  let rest = link.slice('ss://'.length);
  let name = '';
  const hashAt = rest.indexOf('#');
  if (hashAt >= 0) {
    name = decodeURIComponent(rest.slice(hashAt + 1));
    rest = rest.slice(0, hashAt);
  }
  rest = rest.split('?')[0];
  let method, password, hostPort;
  if (rest.includes('@')) {
    // SIP002: base64(method:password)@host:port  (or plain method:password)
    const at = rest.lastIndexOf('@');
    let userinfo = rest.slice(0, at);
    hostPort = rest.slice(at + 1);
    if (!userinfo.includes(':')) userinfo = b64decode(userinfo);
    else userinfo = decodeURIComponent(userinfo);
    [method, ...password] = userinfo.split(':');
    password = password.join(':');
  } else {
    // legacy: base64(method:password@host:port)
    const decoded = b64decode(rest);
    const at = decoded.lastIndexOf('@');
    hostPort = decoded.slice(at + 1);
    const userinfo = decoded.slice(0, at);
    [method, ...password] = userinfo.split(':');
    password = password.join(':');
  }
  const colon = hostPort.lastIndexOf(':');
  const address = hostPort.slice(0, colon).replace(/^\[|\]$/g, '');
  const port = Number(hostPort.slice(colon + 1));
  return {
    name: name || `${address}:${port}`,
    protocol: 'shadowsocks',
    address,
    port,
    outbound: { protocol: 'shadowsocks', settings: { servers: [{ address, port, method, password }] } },
  };
}

/** Parses one share link. Throws on unsupported or malformed input. */
export function parseLink(raw) {
  const link = raw.trim();
  let r;
  if (link.startsWith('vmess://')) r = parseVmess(link);
  else if (link.startsWith('vless://')) r = parseUrlStyle(link, 'vless');
  else if (link.startsWith('trojan://')) r = parseUrlStyle(link, 'trojan');
  else if (link.startsWith('ss://')) r = parseShadowsocks(link);
  else throw new Error('Unsupported link (use vless://, vmess://, trojan:// or ss://)');
  if (!r.address || !r.port) throw new Error('Link is missing a host or port');
  return r;
}

/** Turns pasted text (one or many links, or a base64 subscription body) into server records. */
export function parseMany(text) {
  let body = text.trim();
  if (!/^[a-z]+:\/\//im.test(body)) {
    try { body = b64decode(body); } catch { /* not base64 */ }
  }
  const servers = [];
  const errors = [];
  for (const line of body.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      const { name, protocol, address, port } = parseLink(l);
      servers.push({ id: newId(), name, protocol, address, port, raw: l });
    } catch (e) {
      errors.push(`${l.slice(0, 40)}… — ${e.message}`);
    }
  }
  return { servers, errors };
}

/** Full Xray config: local SOCKS inbound + the chosen server as outbound. */
export function buildXrayConfig(raw, port = SOCKS_PORT) {
  const { outbound } = parseLink(raw);
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'socks-in',
        listen: '127.0.0.1',
        port,
        protocol: 'socks',
        settings: { udp: true, auth: 'noauth' },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      },
    ],
    outbounds: [{ tag: 'proxy', ...outbound }, { tag: 'direct', protocol: 'freedom' }],
  };
}
