# Every Proxy

Chrome / Edge (Manifest V3) extension that connects the browser through **VLESS, VMess, Trojan and Shadowsocks** servers, with an Adobe Spectrum-style light/dark UI.

Browsers can only speak HTTP/SOCKS to a proxy, so the extension drives [Xray-core](https://github.com/XTLS/Xray-core) through a small Native Messaging host (`native/host.py`). Xray exposes a local SOCKS5 port (`127.0.0.1:10808`) and the extension points the browser's proxy settings at it.

## Features

- Add servers by pasting `vless://`, `vmess://`, `trojan://` and `ss://` links, several at once, a base64 subscription, or a subscription URL.
- One-click Connect and Disconnect. Disconnect restores direct browsing.
- **Restart core** stops Xray-core and starts it again with the active server.
- **Ping** measures TCP connect time to every server, shown on each row. While connected in All-tabs mode, the status line also shows the real round trip through the proxy.
- **Use proxy for**: *All tabs* proxies everything. *Selected sites* proxies only the domains you add (use **+ Add this tab's site**) and leaves everything else direct.
- Light and dark themes. The default follows the system, and the moon button toggles it.
- Transports: tcp, ws, grpc, h2, httpupgrade, xhttp. Security: none, tls, reality. Shadowsocks in SIP002 and legacy forms.

## How it works

```
Browser  --SOCKS5-->  127.0.0.1:10808  (Xray-core)  --VLESS/VMess/Trojan/SS-->  your server
   ^
   |  Native Messaging
Extension  <------>  native/host.py  (starts and stops Xray)
```

## Install (Windows)

Requires Python 3 on `PATH`.

1. Run `powershell -ExecutionPolicy Bypass -File native\install.ps1`. It downloads Xray-core into `native\core` and registers the native host for Chrome and Edge (current user).
2. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, choose **Load unpacked** and pick the `extension` folder.
   The extension ID is pinned (`native/extension_id.txt`), so no extra setup is needed.

The Xray-core binaries (`native/core`) are not stored in this repository. The install script downloads them.

## Use

- **+ Add**, then paste your links or a subscription.
- Click a server, then **Connect**.
- Pick **All tabs** or **Selected sites** under *Use proxy for*.

## Project layout

| Path | What it holds |
|------|---------------|
| `extension/` | The MV3 extension: `background.js`, `popup/`, `lib/parse.js` (link parsing and Xray config generation) |
| `native/host.py` | Native Messaging host that runs Xray-core |
| `native/install.ps1` | Downloads Xray-core and registers the host |

## Limits

- Hysteria / TUIC are not wired up (Xray-core's native support differs; sing-box would be the core for those).
- Chrome can't route by tab, only by domain, so "selected tabs" is implemented as selected sites (a site's subdomains are included; third-party domains it loads, such as CDNs, are not unless you add them).
- Only the browser is proxied, not the whole system.
- Windows only as shipped; macOS/Linux need a different install step and host path.

## Author

Arman Soltani
