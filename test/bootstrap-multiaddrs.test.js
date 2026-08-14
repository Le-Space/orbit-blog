import { expect } from 'chai';
import {
  extractHttpsOriginFromBrowserMultiaddr,
  resolveBootstrapMultiaddrs,
  selectValidBrowserBootstrapMultiaddrs,
} from '../scripts/lib/bootstrap-multiaddrs.mjs';

const peerA = '12D3KooWAJjbRkp8FPF5MKgMU53aUTxWkqvDrs4zc1VMbwRwfsbE';
const peerB = '12D3KooWSc3Sqr3Q7RGJAFBz5i7WTTC5kzunnm2tvXVcSwTEtUTP';
const secureAddress = `/dns4/relay.example/tcp/443/tls/ws/p2p/${peerA}`;
const websocketAddress = `/ip4/127.0.0.1/tcp/4001/ws/p2p/${peerB}`;

describe('deployment bootstrap multiaddresses', () => {
  it('derives an HTTPS API origin only from secure port-443 DNS WebSockets', () => {
    expect(
      extractHttpsOriginFromBrowserMultiaddr(
        '/dns4/relay.example/tcp/443/tls/ws/p2p/12D3KooWExample',
      ),
    ).to.equal('https://relay.example');
    expect(
      extractHttpsOriginFromBrowserMultiaddr(
        '/dns6/relay.example/tcp/443/wss/p2p/12D3KooWExample',
      ),
    ).to.equal('https://relay.example');
    expect(
      extractHttpsOriginFromBrowserMultiaddr(
        '/dns4/relay.example/tcp/9092/ws/p2p/12D3KooWExample',
      ),
    ).to.equal(null);
  });

  it('filters invalid addresses, deduplicates, and ranks secure WebSockets first', () => {
    expect(
      selectValidBrowserBootstrapMultiaddrs([
        websocketAddress,
        '/ip4/203.0.113.1/tcp/4001',
        secureAddress,
        secureAddress,
        '/not/a/multiaddr',
      ]),
    ).to.deep.equal([secureAddress, websocketAddress]);
  });

  it('drops plaintext ws relays that an https page cannot dial', () => {
    const plainPublic = `/ip4/93.186.192.85/tcp/24057/ws/p2p/${peerB}`;
    const plainPublicV6 = `/ip6/2001:db8::10/tcp/9092/ws/p2p/${peerB}`;
    const sniAddress = `/ip4/93.186.192.85/tcp/443/tls/sni/relay.example/ws/p2p/${peerA}`;
    const wssAddress = `/dns4/relay.example/tcp/443/wss/p2p/${peerA}`;

    expect(
      selectValidBrowserBootstrapMultiaddrs([plainPublic, plainPublicV6, secureAddress]),
    ).to.deep.equal([secureAddress]);

    expect(selectValidBrowserBootstrapMultiaddrs([sniAddress])).to.deep.equal([sniAddress]);
    expect(selectValidBrowserBootstrapMultiaddrs([wssAddress])).to.deep.equal([wssAddress]);
  });

  it('uses explicit override, Aleph discovery, then fallback precedence', () => {
    expect(
      resolveBootstrapMultiaddrs({
        override: secureAddress,
        discovered: [websocketAddress],
        fallback: websocketAddress,
      }),
    ).to.deep.equal({ addresses: [secureAddress], source: 'override' });

    expect(
      resolveBootstrapMultiaddrs({ discovered: [websocketAddress], fallback: secureAddress }),
    ).to.deep.equal({ addresses: [websocketAddress], source: 'aleph' });

    expect(resolveBootstrapMultiaddrs({ fallback: secureAddress })).to.deep.equal({
      addresses: [secureAddress],
      source: 'fallback',
    });
  });
});
