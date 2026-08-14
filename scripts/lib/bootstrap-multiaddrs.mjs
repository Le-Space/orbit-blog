import { multiaddr } from '@multiformats/multiaddr';

export function extractPeerIdFromMultiaddr(address) {
  const parts = address.split('/').filter(Boolean);
  const peerIndex = parts.findIndex((part) => part === 'p2p' || part === 'ipfs');
  return peerIndex >= 0 ? parts[peerIndex + 1] || null : null;
}

export function extractHttpsOriginFromBrowserMultiaddr(address) {
  const match = address.match(/^\/dns[46]\/([^/]+)\/tcp\/443\/(?:tls\/ws|wss)\/p2p\/[^/]+$/i);
  return match ? `https://${match[1]}` : null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const HOST_PROTOCOLS = new Set(['ip4', 'ip6', 'dns', 'dns4', 'dns6', 'dnsaddr']);

function multiaddrHost(address) {
  const parts = address.toLowerCase().split('/').filter(Boolean);
  const index = parts.findIndex((part) => HOST_PROTOCOLS.has(part));
  return index >= 0 ? parts[index + 1] || '' : '';
}

function isLoopbackMultiaddr(address) {
  const host = multiaddrHost(address);
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

/**
 * Whether a WebSocket multiaddr terminates TLS, i.e. maps to `wss://` rather
 * than `ws://`. `/wss` is the legacy spelling of `/tls/ws`, and the relay
 * announces `/tls/sni/<host>/ws` when Caddy fronts it. A bare `/ws` is plaintext.
 */
function isSecureWebSocketMultiaddr(address) {
  const parts = address.toLowerCase().split('/').filter(Boolean);
  if (parts.includes('wss')) return true;
  const wsIndex = parts.indexOf('ws');
  return wsIndex > 0 && parts.lastIndexOf('tls', wsIndex) >= 0;
}

export function isBrowserDialableBootstrapMultiaddr(address) {
  const normalized = address.toLowerCase();
  if (normalized.includes('/webrtc-direct')) return true;
  if (!/\/wss?(\/|$)/.test(normalized)) return false;
  // The deployed site is served over https, and an https page cannot open a
  // plaintext ws:// socket — the browser blocks it as mixed content. Baking a
  // plaintext relay into VITE_SEED_NODES only buys a console error, so keep
  // those out. Loopback stays dialable for local development.
  return isSecureWebSocketMultiaddr(address) || isLoopbackMultiaddr(address);
}

function rankBrowserBootstrapMultiaddr(address) {
  const normalized = address.toLowerCase();
  if (normalized.includes('/tcp/443/') && normalized.includes('/tls/ws')) return 0;
  if (normalized.includes('/tls/ws')) return 1;
  if (normalized.includes('/wss')) return 2;
  if (normalized.includes('/ip4/127.0.0.1/') && normalized.includes('/ws')) return 3;
  if (normalized.includes('/ws')) return 4;
  if (normalized.includes('/webrtc-direct')) return 5;
  return 10;
}

export function selectValidBrowserBootstrapMultiaddrs(addresses) {
  return [...new Set(addresses.map((address) => address.trim()).filter(Boolean))]
    .filter(isBrowserDialableBootstrapMultiaddr)
    .filter((address) => {
      try {
        multiaddr(address);
        return extractPeerIdFromMultiaddr(address) != null;
      } catch {
        return false;
      }
    })
    .sort(
      (left, right) => rankBrowserBootstrapMultiaddr(left) - rankBrowserBootstrapMultiaddr(right),
    );
}

export function parseBootstrapMultiaddrs(value) {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((address) => address.trim())
        .filter(Boolean)
    : [];
}

export function resolveBootstrapMultiaddrs({ override, discovered = [], fallback } = {}) {
  const candidates = [
    ['override', parseBootstrapMultiaddrs(override)],
    ['aleph', [...discovered]],
    ['fallback', parseBootstrapMultiaddrs(fallback)],
  ];

  for (const [source, addresses] of candidates) {
    const selected = selectValidBrowserBootstrapMultiaddrs(addresses);
    if (selected.length > 0) {
      return { addresses: selected, source };
    }
  }

  return { addresses: [], source: 'none' };
}
