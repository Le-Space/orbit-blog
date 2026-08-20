import { getRelayTargetLabel } from './relayTestEnv';

type RelayDatabaseRow = {
  address?: string;
  lastSyncedAt?: string;
};

type RelayProbe = 'listed' | 'not_listed' | 'unknown';

/** What one origin answered, kept so a timeout can say why rather than just that. */
export type RelayListingAttempt = {
  origin: string;
  probe: RelayProbe;
  status: number | null;
  detail: string;
};

export type RelaySyncAttempt = {
  origin: string;
  ok: boolean;
  status: number | null;
  detail: string;
};

/**
 * What the relay answers `POST /pinning/sync` with. `ok: true` only means the
 * relay handled the request — it says `ok` for an address that does not exist,
 * with `receivedUpdate: false` and `entryCount: 0`. Those two are the fields that
 * say whether anything actually replicated.
 */
type RelaySyncResponse = {
  ok?: boolean;
  error?: string;
  receivedUpdate?: boolean;
  entryCount?: number;
  snapshotSource?: string;
};

type RelayDatabaseListing = {
  probe: RelayProbe;
  row: RelayDatabaseRow | null;
  attempts: RelayListingAttempt[];
};

const DEFAULT_LISTING_TIMEOUT_MS = 120_000;

// `POST /pinning/sync` blocks for about ten seconds while the relay waits for an
// update, so it needs a generous cap — but it does need one. Without a signal the
// fetch is unbounded, and a relay that accepts the connection and then goes quiet
// would hang the spec until Playwright's own test timeout, reported as a timeout
// on whatever line happened to be running.
const SYNC_TIMEOUT_MS = Number(process.env.RELAY_PINNING_SYNC_TIMEOUT_MS || 30_000);
const LISTING_TIMEOUT_MS = Number(process.env.RELAY_PINNING_LISTING_TIMEOUT_MS || 15_000);

// How long to keep polling the listing before asking the relay to sync again.
const SYNC_RETRY_AFTER_MS = Number(process.env.RELAY_PINNING_SYNC_RETRY_AFTER_MS || 20_000);
const POLL_INTERVAL_MS = 2_000;

function splitCsv(raw: string): string[] {
  return [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
}

function normalizeOrbitDbAddress(address: string): string {
  return address.trim().replace(/\/+$/, '');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseIsoToMs(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const ms = Date.parse(raw.trim());
  return Number.isNaN(ms) ? null : ms;
}

function pickNewerRow(current: RelayDatabaseRow | null, candidate: RelayDatabaseRow | null): RelayDatabaseRow | null {
  if (!candidate) return current;
  if (!current) return candidate;

  const currentMs = parseIsoToMs(current.lastSyncedAt);
  const candidateMs = parseIsoToMs(candidate.lastSyncedAt);

  if (candidateMs === null) return current;
  if (currentMs === null) return candidate;
  return candidateMs > currentMs ? candidate : current;
}

export function getRelayMetricsOrigins(metricsOriginsRaw: string): string[] {
  return splitCsv(metricsOriginsRaw).map((origin) => origin.replace(/\/$/, ''));
}

export async function requestRelayDatabaseSync(
  metricsOrigin: string,
  dbAddressRaw: string,
): Promise<RelaySyncAttempt> {
  const dbAddress = normalizeOrbitDbAddress(dbAddressRaw);
  if (!metricsOrigin || !dbAddress) {
    return { origin: metricsOrigin, ok: false, status: null, detail: 'missing origin or address' };
  }

  try {
    const response = await fetch(`${metricsOrigin}/pinning/sync`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dbAddress }),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { origin: metricsOrigin, ok: false, status: response.status, detail: response.statusText };
    }

    const json = (await response.json()) as RelaySyncResponse;
    const detail = [
      `ok=${String(json.ok)}`,
      `receivedUpdate=${String(json.receivedUpdate)}`,
      `entryCount=${String(json.entryCount)}`,
      `snapshotSource=${json.snapshotSource ?? 'n/a'}`,
      json.error ? `error=${json.error}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    return { origin: metricsOrigin, ok: json.ok === true, status: response.status, detail };
  } catch (error) {
    return { origin: metricsOrigin, ok: false, status: null, detail: describeError(error) };
  }
}

export async function requestRelayDatabaseSyncAny(
  metricsOrigins: string[],
  dbAddress: string,
): Promise<RelaySyncAttempt[]> {
  const attempts: RelaySyncAttempt[] = [];
  for (const origin of metricsOrigins) {
    attempts.push(await requestRelayDatabaseSync(origin, dbAddress));
  }
  return attempts;
}

export async function fetchRelayDatabaseListing(
  metricsOrigin: string,
  dbAddressRaw: string,
): Promise<RelayDatabaseListing> {
  const dbAddress = normalizeOrbitDbAddress(dbAddressRaw);
  const attempt = (probe: RelayProbe, status: number | null, detail: string): RelayListingAttempt => ({
    origin: metricsOrigin,
    probe,
    status,
    detail,
  });

  if (!metricsOrigin || !dbAddress) {
    return { probe: 'unknown', row: null, attempts: [attempt('unknown', null, 'missing origin or address')] };
  }

  const url = new URL('/pinning/databases', metricsOrigin);
  url.searchParams.set('address', dbAddress);

  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
    });
    if (response.status === 404) {
      return { probe: 'not_listed', row: null, attempts: [attempt('not_listed', 404, 'not found')] };
    }
    if (!response.ok) {
      return { probe: 'unknown', row: null, attempts: [attempt('unknown', response.status, response.statusText)] };
    }

    const json = (await response.json()) as { databases?: RelayDatabaseRow[] };
    const databases = Array.isArray(json.databases) ? json.databases : [];
    const row =
      databases.find((candidate) => normalizeOrbitDbAddress(candidate.address ?? '') === dbAddress) ?? null;

    if (!row) {
      return {
        probe: 'not_listed',
        row: null,
        attempts: [attempt('not_listed', response.status, `${databases.length} database(s) returned, none matching`)],
      };
    }

    return {
      probe: 'listed',
      row,
      attempts: [attempt('listed', response.status, `lastSyncedAt=${row.lastSyncedAt || '(empty)'}`)],
    };
  } catch (error) {
    return { probe: 'unknown', row: null, attempts: [attempt('unknown', null, describeError(error))] };
  }
}

export async function fetchRelayDatabaseListingAny(
  metricsOrigins: string[],
  dbAddress: string,
): Promise<RelayDatabaseListing> {
  const results = await Promise.all(metricsOrigins.map((origin) => fetchRelayDatabaseListing(origin, dbAddress)));
  const attempts = results.flatMap((result) => result.attempts);

  let newestRow: RelayDatabaseRow | null = null;
  for (const result of results) {
    if (result.probe === 'listed') {
      newestRow = pickNewerRow(newestRow, result.row);
    }
  }

  if (newestRow) return { probe: 'listed', row: newestRow, attempts };
  if (results.some((result) => result.probe === 'not_listed')) return { probe: 'not_listed', row: null, attempts };
  return { probe: 'unknown', row: null, attempts };
}

function formatSyncAttempts(attempts: RelaySyncAttempt[]): string {
  if (attempts.length === 0) return '    (no metrics origin configured)';
  return attempts
    .map((a) => `    ${a.ok ? 'ok' : 'FAILED'}  ${a.origin}  [${a.status ?? 'no response'}] ${a.detail}`)
    .join('\n');
}

function formatListingAttempts(attempts: RelayListingAttempt[]): string {
  if (attempts.length === 0) return '    (never polled)';
  return attempts
    .map((a) => `    ${a.probe}  ${a.origin}  [${a.status ?? 'no response'}] ${a.detail}`)
    .join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the relay to sync `dbAddress`, then wait for it to report a `lastSyncedAt`.
 *
 * `POST /pinning/sync` is what makes the relay aware of a database — until it
 * completes, `GET /pinning/databases` answers 404 and no amount of polling will
 * change that. The previous version fired the sync exactly once and then polled
 * for two minutes, so a sync that failed left the poll waiting on something that
 * was never coming. That is how the daily `WebRTC (remote)` run fails: the sync
 * request for `settingsDB` never returns, and the listing 404s for the full
 * timeout.
 *
 * `settingsDB` is the first database this is called for after the UI flow, and
 * the relay has had the least time to replicate it. `postsDB` and `mediaDB` are
 * asked for later in the same run, against the same relay, and pass. So retry
 * the sync across the wait instead of betting the whole window on the first one.
 *
 * Returns the `lastSyncedAt` the relay reported.
 */
export async function waitForRelayDatabaseListing(
  metricsOrigins: string[],
  dbAddressRaw: string,
  label: string,
  timeoutMs: number = DEFAULT_LISTING_TIMEOUT_MS,
): Promise<string> {
  const dbAddress = normalizeOrbitDbAddress(dbAddressRaw);
  const deadline = Date.now() + timeoutMs;

  const syncAttempts: RelaySyncAttempt[] = [];
  let lastListing: RelayDatabaseListing = { probe: 'unknown', row: null, attempts: [] };
  let round = 0;

  while (Date.now() < deadline) {
    round += 1;
    const attempts = await requestRelayDatabaseSyncAny(metricsOrigins, dbAddress);
    syncAttempts.push(...attempts);

    // Print this on green runs too. `receivedUpdate=false entryCount=0` means the
    // relay answered without replicating anything, and the assertion below still
    // passes — so a run that only reports pass/fail hides whether the pinning
    // service did any work.
    for (const attempt of attempts) {
      console.log(`[pinning] sync ${label} ${dbAddress} via ${attempt.origin} (round ${round}): ${attempt.detail}`);
    }

    const sliceEnd = Math.min(Date.now() + SYNC_RETRY_AFTER_MS, deadline);
    while (Date.now() < sliceEnd) {
      lastListing = await fetchRelayDatabaseListingAny(metricsOrigins, dbAddress);
      const lastSyncedAt = lastListing.row?.lastSyncedAt ?? '';
      if (lastSyncedAt) return lastSyncedAt;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    [
      `${getRelayTargetLabel()} never reported lastSyncedAt for ${label} within ${timeoutMs}ms.`,
      `  address: ${dbAddress}`,
      `  final probe: ${lastListing.probe}`,
      `  POST /pinning/sync (${round} round(s)):`,
      formatSyncAttempts(syncAttempts),
      '  GET /pinning/databases (last poll):',
      formatListingAttempts(lastListing.attempts),
    ].join('\n'),
  );
}
