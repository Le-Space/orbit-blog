# Deployment Guide

## What gets deployed

The production artifact is a **static site**: HTML, JS, CSS from **`pnpm run build`**, with **PWA** support via `vite-plugin-pwa` (service worker, Workbox; see `vite.config.ts`).

There is **no Node server** required for the app itself.

## Aleph site deployment

The repo now deploys through GitHub Actions instead of the old local
`ipfs-publish.sh` operator flow.

Workflow:

- `.github/workflows/deploy-site.yml`

What it does:

- installs app dependencies
- builds the app into `dist/`
- installs `@le-space/node@0.6.4`
- uses the shared Node-based Aleph site runner from that package to publish `dist/` to Aleph IPFS
- pins the uploaded CID to Aleph storage
- attaches the resulting Aleph item to the configured custom domain
- keeps the latest `10` uploads for the `orbit-blog-prod` site scope and forgets older ones automatically
- writes `/.well-known/orbit-blog.json` from the configured default blog address

Required repository secret:

- `ALEPH_PRIVATE_KEY`

Optional repository variable:

- `ALEPH_SITE_DOMAIN`
  Defaults to `blog.le-space.de` when unset.
- `ORBIT_BLOG_INITIAL_ADDRESS`
  Unset by default. The deploy then writes an empty
  `.well-known/orbit-blog.json`, and a visitor who opens the bare domain starts
  with their own local blog instead of a preselected database. Set it to an
  `/orbitdb/...` address to pin the deployed site to one blog.

Trigger model:

- automatic on pushes to `main` and `master`
- manual through `workflow_dispatch`

## Progressive Web App

- Caching excludes heavy/local **`orbitdb`** / **`ipfs`** paths from precache globs.
- Runtime caching avoids treating **`/ipfs/`** and **`/orbitdb/`** navigation like static app routes.

## CI

**`.github/workflows/test.yml`:**

- Triggers on `main`, `master`, `e2e-relay-pinner`
- **Node 22**, `npm install`, Playwright browsers
- Starts **relay** for Mocha, then runs **`npx mocha "test/**/*.test.js"`**
- Runs the main Playwright suite with `DEBUG=playwright:*`
- Excludes `tests/WebRTCDirectConnectivity.spec.ts` from the main suite; that spec lives in the dedicated comparison workflow below

**`.github/workflows/webrtc-compare.yml`:**

- Focused comparison workflow for `tests/WebRTCDirectConnectivity.spec.ts`
- Runs a two-way matrix on GitHub Actions: `local` relay mode and `remote` relay mode
- Triggers on pushes to `e2e-relay-pinner` and manual `workflow_dispatch`
- Keeps the main test workflow unchanged while we compare relay behavior

Forks should align install command with their lockfile (`pnpm` vs `npm`).

## Security note

README states **alpha / not security audited**. Do not treat default crypto or relay setup as production-hardened without review.

## Environment for production builds

Set **`VITE_*`** seed nodes and discovery topics for the networks you trust. Wrong bootstrap addresses will partition or isolate peers.

Last updated: 2026-04-02
