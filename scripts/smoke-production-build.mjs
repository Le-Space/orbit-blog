// Load the production bundle in a real browser and fail on uncaught errors.
//
// Every other check in this repo runs against the Vite dev server, which serves
// modules unbundled. Whole classes of failure only exist after Rollup chunking,
// and the suite is structurally blind to them. One such bug reached production:
// the Node shims were placed in the mermaid chunk, so the p2p chunk opened with
// `import { p as process$1 } from './mermaid-<hash>.js'` and read it before that
// chunk had initialised — "Cannot access 'process$1' before initialization",
// which killed the p2p stack on load and left a blank page. Build, unit tests,
// type check and eleven e2e specs all passed on that commit.
//
// So: serve dist, open it, and look at the console.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const DIST = join(process.cwd(), 'dist');
const PORT = Number(process.env.SMOKE_PORT || 4173);
// How long to stay on the page after load. Module-initialisation errors surface
// immediately; this window also catches what the app throws while starting up.
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS || 15_000);

// Errors that depend on whether the machine can reach a relay or the Aleph API.
// A CI runner cannot, and neither can a developer offline — that must not be
// what this check reports. Uncaught exceptions are matched against this list;
// anything else fails the run.
const ENVIRONMENTAL = [
  /ERR_TUNNEL_CONNECTION_FAILED/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /ERR_CONNECTION_REFUSED/i,
  /ERR_INTERNET_DISCONNECTED/i,
  /Failed to fetch/i,
  /NetworkError/i,
  /WebSocket/i,
];

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`No production build at ${DIST}. Run \`pnpm run build\` first.`);
  process.exit(1);
}

const server = createServer((req, res) => {
  const requested = decodeURIComponent((req.url || '/').split('?')[0]);
  // Resolve inside dist, and fall back to index.html so hash routes work.
  const candidate = normalize(join(DIST, requested === '/' ? 'index.html' : requested));
  const file = candidate.startsWith(DIST) && existsSync(candidate) && extname(candidate)
    ? candidate
    : join(DIST, 'index.html');
  try {
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(500);
    res.end('smoke server error');
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch({
  // Escape hatch for containers that ship a different Chromium build than the
  // pinned @playwright/test expects. CI installs the matching one and ignores this.
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});

let failures = [];
let mounted = false;

try {
  const page = await browser.newPage();
  const uncaught = [];
  page.on('pageerror', (err) => uncaught.push(err.message));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(SETTLE_MS);

  // A page that throws nothing because it rendered nothing is not a pass.
  mounted = await page.evaluate(() => document.querySelectorAll('[data-testid]').length > 0);

  failures = uncaught.filter((message) => !ENVIRONMENTAL.some((pattern) => pattern.test(message)));

  for (const message of uncaught) {
    const ignored = failures.includes(message) ? '' : '  (environmental, ignored)';
    console.log(`uncaught: ${message}${ignored}`);
  }
} finally {
  await browser.close();
  server.close();
}

if (!mounted) {
  console.error('FAIL: the production build rendered no [data-testid] elements — the app did not mount.');
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} uncaught error(s) in the production build:`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log('OK: production build loads and mounts with no uncaught errors.');
