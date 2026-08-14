import { webSockets } from "@libp2p/websockets";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { noise } from "@chainsafe/libp2p-noise";
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify, identifyPush } from "@libp2p/identify"
import { dcutr } from "@libp2p/dcutr"
import { autoNAT } from '@libp2p/autonat'
import { gossipsub } from "@libp2p/gossipsub"
import { ping } from '@libp2p/ping'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { multiaddr } from '@multiformats/multiaddr'
import { bootstrap } from '@libp2p/bootstrap'
import { discoverAlephBootstrapMultiaddrs } from '@le-space/aleph-bootstrap'
import type { Libp2p, Libp2pOptions } from 'libp2p'
import { createLogger } from './utils/logger.js'

const log = createLogger('p2p')

function parseEnvList(value: string | undefined | null): string[] {
    if (typeof value !== 'string') return []
    return value
        .replace(/\r?\n/g, ',')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
}

let VITE_SEED_NODES = parseEnvList(import.meta.env.VITE_SEED_NODES)
let VITE_SEED_NODES_DEV = parseEnvList(import.meta.env.VITE_SEED_NODES_DEV)
let MODE = import.meta.env.VITE_MODE //|| 'development';
let VITE_P2P_PUPSUB_DEV = parseEnvList(import.meta.env.VITE_P2P_PUPSUB_DEV);
let VITE_P2P_PUPSUB = parseEnvList(import.meta.env.VITE_P2P_PUPSUB);
let VITE_ALEPH_BOOTSTRAP_ENABLED = import.meta.env.VITE_ALEPH_BOOTSTRAP_ENABLED;
let VITE_ALEPH_BOOTSTRAP_API_HOST = import.meta.env.VITE_ALEPH_BOOTSTRAP_API_HOST;
let VITE_ALEPH_BOOTSTRAP_CHANNEL = import.meta.env.VITE_ALEPH_BOOTSTRAP_CHANNEL;
let VITE_ALEPH_BOOTSTRAP_REF = import.meta.env.VITE_ALEPH_BOOTSTRAP_REF;
let VITE_ALEPH_BOOTSTRAP_POST_TYPE = import.meta.env.VITE_ALEPH_BOOTSTRAP_POST_TYPE;
let VITE_ALEPH_BOOTSTRAP_TIMEOUT_MS = import.meta.env.VITE_ALEPH_BOOTSTRAP_TIMEOUT_MS;
let VITE_ALEPH_BOOTSTRAP_REQUIRE_DUAL_KEY = import.meta.env.VITE_ALEPH_BOOTSTRAP_REQUIRE_DUAL_KEY;

let _VITE_SEED_NODES_DEV = process.env.VITE_SEED_NODES_DEV || '';
let _VITE_SEED_NODES = process.env.VITE_SEED_NODES || '';
let _MODE = process.env.VITE_MODE || '';

let _VITE_P2P_PUPSUB_DEV = process.env.VITE_P2P_PUPSUB_DEV || '';
let _VITE_P2P_PUPSUB = process.env.VITE_P2P_PUPSUB || '';
let _VITE_ALEPH_BOOTSTRAP_ENABLED = process.env.VITE_ALEPH_BOOTSTRAP_ENABLED || '';
let _VITE_ALEPH_BOOTSTRAP_API_HOST = process.env.VITE_ALEPH_BOOTSTRAP_API_HOST || '';
let _VITE_ALEPH_BOOTSTRAP_CHANNEL = process.env.VITE_ALEPH_BOOTSTRAP_CHANNEL || '';
let _VITE_ALEPH_BOOTSTRAP_REF = process.env.VITE_ALEPH_BOOTSTRAP_REF || '';
let _VITE_ALEPH_BOOTSTRAP_POST_TYPE = process.env.VITE_ALEPH_BOOTSTRAP_POST_TYPE || '';
let _VITE_ALEPH_BOOTSTRAP_TIMEOUT_MS = process.env.VITE_ALEPH_BOOTSTRAP_TIMEOUT_MS || '';
let _VITE_ALEPH_BOOTSTRAP_REQUIRE_DUAL_KEY = process.env.VITE_ALEPH_BOOTSTRAP_REQUIRE_DUAL_KEY || '';

if(_VITE_SEED_NODES || _VITE_SEED_NODES_DEV) {
    VITE_SEED_NODES = parseEnvList(_VITE_SEED_NODES)
    VITE_SEED_NODES_DEV = parseEnvList(_VITE_SEED_NODES_DEV)
    VITE_P2P_PUPSUB = parseEnvList(_VITE_P2P_PUPSUB)
    VITE_P2P_PUPSUB_DEV = parseEnvList(_VITE_P2P_PUPSUB_DEV)
    VITE_ALEPH_BOOTSTRAP_ENABLED = _VITE_ALEPH_BOOTSTRAP_ENABLED || VITE_ALEPH_BOOTSTRAP_ENABLED
    VITE_ALEPH_BOOTSTRAP_API_HOST = _VITE_ALEPH_BOOTSTRAP_API_HOST || VITE_ALEPH_BOOTSTRAP_API_HOST
    VITE_ALEPH_BOOTSTRAP_CHANNEL = _VITE_ALEPH_BOOTSTRAP_CHANNEL || VITE_ALEPH_BOOTSTRAP_CHANNEL
    VITE_ALEPH_BOOTSTRAP_REF = _VITE_ALEPH_BOOTSTRAP_REF || VITE_ALEPH_BOOTSTRAP_REF
    VITE_ALEPH_BOOTSTRAP_POST_TYPE = _VITE_ALEPH_BOOTSTRAP_POST_TYPE || VITE_ALEPH_BOOTSTRAP_POST_TYPE
    VITE_ALEPH_BOOTSTRAP_TIMEOUT_MS = _VITE_ALEPH_BOOTSTRAP_TIMEOUT_MS || VITE_ALEPH_BOOTSTRAP_TIMEOUT_MS
    VITE_ALEPH_BOOTSTRAP_REQUIRE_DUAL_KEY = _VITE_ALEPH_BOOTSTRAP_REQUIRE_DUAL_KEY || VITE_ALEPH_BOOTSTRAP_REQUIRE_DUAL_KEY
}
if (import.meta.env.DEV) {
    MODE = 'development'
}
export let multiaddrs = MODE === 'development'?VITE_SEED_NODES_DEV:VITE_SEED_NODES
log.debug('MODE === development', MODE === 'development')
log.debug('VITE_SEED_NODES_DEV', VITE_SEED_NODES_DEV)
log.debug('VITE_SEED_NODES', VITE_SEED_NODES)
let pubSubPeerDiscoveryTopics = MODE === 'development'?VITE_P2P_PUPSUB_DEV:VITE_P2P_PUPSUB
if (pubSubPeerDiscoveryTopics.length === 0) {
    pubSubPeerDiscoveryTopics = ['todo._peer-discovery._p2p._pubsub']
}
log.debug('pubSubPeerDiscoveryTopics', pubSubPeerDiscoveryTopics)
log.debug('seed nodes multiaddrs', multiaddrs)

function parseEnvBoolean(value: string | undefined | null, defaultValue: boolean): boolean {
    if (typeof value !== 'string' || !value.trim()) return defaultValue
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    return defaultValue
}

function parsePositiveInteger(value: string | undefined | null, defaultValue: number): number {
    if (typeof value !== 'string' || !value.trim()) return defaultValue
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue
}

function dedupeMultiaddrs(addrs: string[]): string[] {
    return [...new Set(addrs.map(addr => addr.trim()).filter(Boolean))]
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const HOST_PROTOCOLS = new Set(['ip4', 'ip6', 'dns', 'dns4', 'dns6', 'dnsaddr'])

function multiaddrHost(addr: string): string {
    const parts = addr.toLowerCase().split('/').filter(Boolean)
    const index = parts.findIndex(part => HOST_PROTOCOLS.has(part))
    return index >= 0 ? parts[index + 1] || '' : ''
}

/**
 * Whether a WebSocket multiaddr terminates TLS, i.e. maps to `wss://` rather
 * than `ws://`. `/wss` is the legacy spelling of `/tls/ws`, and a relay behind
 * Caddy announces `/tls/sni/<host>/ws`. A bare `/ws` is plaintext.
 */
function isSecureWebSocketMultiaddr(addr: string): boolean {
    const parts = addr.toLowerCase().split('/').filter(Boolean)
    if (parts.includes('wss')) return true
    const wsIndex = parts.indexOf('ws')
    return wsIndex > 0 && parts.lastIndexOf('tls', wsIndex) >= 0
}

/**
 * A page served over https cannot open a plaintext `ws://` socket: the browser
 * blocks the dial as mixed content before libp2p ever sees it. Relays legitimately
 * announce the plaintext port they serve, so the registry contains such addresses;
 * they just have to be dropped here rather than dialled and logged as errors.
 */
function isMixedContentBlocked(addr: string): boolean {
    if (typeof window === 'undefined' || window.location?.protocol !== 'https:') return false
    const parts = addr.toLowerCase().split('/').filter(Boolean)
    if (!parts.includes('ws') && !parts.includes('wss')) return false
    if (isSecureWebSocketMultiaddr(addr)) return false
    const host = multiaddrHost(addr)
    return !(LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost'))
}

function createBootstrapConfig(addrs: string[]) {
    return {
        list: dedupeMultiaddrs(addrs).filter(addr => {
        try {
            multiaddr(addr);
        } catch (e) {
            log.warn(`Invalid multiaddr filtered out: ${addr}`);
            return false;
        }
        if (isMixedContentBlocked(addr)) {
            log.warn(`Plaintext ws relay filtered out on an https origin: ${addr}`);
            return false;
        }
        return true;
        }),
        // Browser nodes need a durable relay connection. libp2p 3's bootstrap
        // tag otherwise expires after two minutes, and only keep-alive-prefixed
        // tags are eligible for automatic reconnects.
        tagName: 'keep-alive-bootstrap',
        tagValue: 100,
        tagTTL: Infinity,
    }
}

export let bootstrapConfig = createBootstrapConfig(multiaddrs)

function createTimedFetch(timeoutMs: number): typeof fetch {
    return async (input, init) => {
        const controller = new AbortController()
        const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)
        try {
            return await fetch(input, {
                ...init,
                signal: init?.signal ?? controller.signal,
            })
        } finally {
            globalThis.clearTimeout(timeout)
        }
    }
}

async function discoverAlephSeedMultiaddrs(): Promise<string[]> {
    if (!parseEnvBoolean(VITE_ALEPH_BOOTSTRAP_ENABLED, true)) {
        log.debug('Aleph bootstrap discovery disabled')
        return []
    }

    const timeoutMs = parsePositiveInteger(VITE_ALEPH_BOOTSTRAP_TIMEOUT_MS, 5000)

    try {
        const discovered = await discoverAlephBootstrapMultiaddrs({
            apiHost: VITE_ALEPH_BOOTSTRAP_API_HOST || undefined,
            channel: VITE_ALEPH_BOOTSTRAP_CHANNEL || undefined,
            ref: VITE_ALEPH_BOOTSTRAP_REF || undefined,
            postType: VITE_ALEPH_BOOTSTRAP_POST_TYPE || undefined,
            browserDialableOnly: true,
            requireDualKeyAttestation: parseEnvBoolean(VITE_ALEPH_BOOTSTRAP_REQUIRE_DUAL_KEY, false),
            fetch: createTimedFetch(timeoutMs),
        })
        log.info(`Discovered ${discovered.length} Aleph bootstrap multiaddr(s)`)
        return discovered
    } catch (error) {
        log.warn('Aleph bootstrap discovery failed; falling back to configured seed nodes', error)
        return []
    }
}

export async function resolveBootstrapMultiaddrs(): Promise<string[]> {
    const discovered = await discoverAlephSeedMultiaddrs()
    multiaddrs = dedupeMultiaddrs([...discovered, ...multiaddrs])
    bootstrapConfig = createBootstrapConfig(multiaddrs)
    log.debug('resolved bootstrap multiaddrs', bootstrapConfig.list)
    return bootstrapConfig.list
}

export function createLibp2pOptions(bootstrapMultiaddrs: string[] = multiaddrs): Libp2pOptions {
    const resolvedBootstrapConfig = createBootstrapConfig(bootstrapMultiaddrs)
    return {
    addresses: {
        listen: [
            '/p2p-circuit',
            "/webrtc",
        ]
    },
    transports: [
        webSockets(),
        webRTCDirect({
            rtcConfiguration: {
                iceServers: [
                    { urls: ['stun:stun.l.google.com:19302'] },
                    { urls: ['stun:global.stun.twilio.com:3478'] }
                ]
            }
        }),
        webRTC({
            rtcConfiguration: {
                iceServers: [
                    { urls: ['stun:stun.l.google.com:19302'] },
                    { urls: ['stun:global.stun.twilio.com:3478'] }
                ]
            }
        }),
        circuitRelayTransport({
            discoverRelays: 1,
            reservationCompletionTimeout: 20000 // 20 seconds
          } as any)
    ],
    connectionEncrypters: [noise()],
    
    streamMuxers: [
        yamux(),
    ],
    connectionManager: {
        dialTimeout: 30000,
        inboundStreamProtocolNegotiationTimeout: 10000,
        inboundUpgradeTimeout: 10000,
        outboundStreamProtocolNegotiationTimeout: 10000,
        reconnectRetries: 20,
        reconnectRetryInterval: 1000,
        reconnectBackoffFactor: 1.5,
    },
    connectionGater: {
        denyDialMultiaddr: () => false,
        denyDialPeer: () => false,
        denyInboundConnection: () => false,
        denyOutboundConnection: () => false,
        denyInboundEncryptedConnection: () => false,
        denyOutboundEncryptedConnection: () => false,
        denyInboundUpgradedConnection: () => false,
        denyOutboundUpgradedConnection: () => false,
    },
    peerDiscovery: [
        pubsubPeerDiscovery({
            interval: 3000,
            topics: pubSubPeerDiscoveryTopics,
            listenOnly: false,
        })
    ],
    services: {
        identify: identify(),
        identifyPush: identifyPush(),
        ping: ping({ timeout: 10000 }),
        autonat: autoNAT(),
        dcutr: dcutr(),
        pubsub: gossipsub({ 
            allowPublishToZeroTopicPeers: true,
            runOnLimitedConnection: true
        }),
        ...(resolvedBootstrapConfig.list.length > 0
            ? {
                bootstrap: bootstrap(resolvedBootstrapConfig)
            }
            : {})
    }
    }
}

export async function createResolvedLibp2pOptions(): Promise<Libp2pOptions> {
    return createLibp2pOptions(await resolveBootstrapMultiaddrs())
}

/**
 * Establish one connection per configured bootstrap peer before OrbitDB opens
 * its databases. This ensures Helia's Bitswap handler is available when a
 * relay observes the first OrbitDB subscriptions and starts fetching manifests.
 */
export async function connectBootstrapPeers(libp2pNode: Libp2p): Promise<number> {
    const addressesByPeer = new Map<string, string[]>()

    for (const address of bootstrapConfig.list) {
        const peerId = address.match(/\/p2p\/([^/]+)$/)?.[1] ?? address
        const addresses = addressesByPeer.get(peerId) ?? []
        addresses.push(address)
        addressesByPeer.set(peerId, addresses)
    }

    let connectedPeers = 0

    for (const [peerId, addresses] of addressesByPeer) {
        if (libp2pNode.getConnections().some(connection => connection.remotePeer.toString() === peerId)) {
            connectedPeers += 1
            continue
        }

        for (const address of addresses) {
            try {
                await libp2pNode.dial(multiaddr(address), {
                    signal: AbortSignal.timeout(10_000),
                })
                connectedPeers += 1
                break
            } catch (error) {
                log.warn(`Failed bootstrap dial ${address}`, error)
            }
        }
    }

    return connectedPeers
}

export const libp2pOptions: Libp2pOptions = createLibp2pOptions()

export async function validateMultiaddrs(
    addrs: string[], 
    libp2p?: any
): Promise<{ 
    valid: string[], 
    invalid: string[], 
    dialable?: string[], 
    undialable?: string[] 
}> {
    const valid: string[] = [];
    const invalid: string[] = [];
    const dialable: string[] = [];
    const undialable: string[] = [];
    
    for (const addr of addrs) {
        try {
            // Try to create a multiaddr object - this will throw if invalid
            const ma = multiaddr(addr);
            valid.push(addr);
            
            // Only attempt dialing if libp2p instance is provided
            if (libp2p) {
                try {
                    await libp2p.dial(ma);
                    dialable.push(addr);
                } catch (error) {
                    undialable.push(addr);
                    log.error(`Failed to dial ${addr}:`, error);
                }
            }
        } catch (error) {
            invalid.push(addr);
            log.error(`Invalid multiaddr ${addr}:`, error);
        }
    }
    
    // Only include dialability results if libp2p was provided
    return libp2p 
        ? { valid, invalid, dialable, undialable }
        : { valid, invalid };
}

// Test your multiaddrs
(async () => {
    const result = await validateMultiaddrs(multiaddrs);
    log.debug('Valid multiaddrs:', result.valid);
    log.debug('Invalid multiaddrs:', result.invalid);
})();
