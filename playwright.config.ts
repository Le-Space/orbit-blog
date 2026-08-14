import { defineConfig, devices } from '@playwright/test'
import {
  LOCAL_RELAY_QUIC_PORT,
  LOCAL_RELAY_TCP_PORT,
  LOCAL_RELAY_WEBRTC_PORT,
  LOCAL_RELAY_WS_PORT,
  getRelayViteEnv,
} from './tests/relayTestEnv'

const relayViteEnv = getRelayViteEnv()

export default defineConfig({
  testDir: './tests',

  // These e2e specs share on-disk state (./orbitdb) and share state across tests
  // inside a describe block, so run with a single worker for stability.
  workers: 1,
  fullyParallel: false,

  // The app+P2P stack can take a while to bootstrap.
  timeout: 120_000,
  expect: { timeout: 30_000 },

  // A hosted runner has two cores, shared between the relay, the Vite dev
  // server and two Chromium contexts each running libp2p and OrbitDB. Under
  // that contention a peer can lose its relay connection and not get it back
  // inside the test budget, which is why runs on identical commits have failed
  // in three different specs and then passed on re-run. Locally, on four cores,
  // the same specs pass repeatedly. Retry rather than read that as a defect.
  retries: process.env.CI ? 2 : 0,

  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',

  use: {
    baseURL: 'http://localhost:5173',
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
    trace: 'on-first-retry',
  },

  // Start the app server for the tests. The specs currently hardcode
  // http://localhost:5173, so keep that stable.
  webServer: {
    // Use a dedicated Vite mode so env is deterministic for e2e (see `.env.test`).
    command: 'npm run dev -- --mode test --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true',
    timeout: 120_000,
    env: {
      ...process.env,
      ...relayViteEnv,

      // Keep relay ports in sync with tests/global-setup.ts spawning.
      RELAY_TCP_PORT: String(LOCAL_RELAY_TCP_PORT),
      RELAY_WS_PORT: String(LOCAL_RELAY_WS_PORT),
      RELAY_QUIC_PORT: String(LOCAL_RELAY_QUIC_PORT),
      RELAY_WEBRTC_PORT: String(LOCAL_RELAY_WEBRTC_PORT),
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
