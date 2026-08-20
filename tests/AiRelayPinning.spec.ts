import { test, expect, type Page } from '@playwright/test';
import {
  getPrimaryRelayOrigin,
  getRelayMetricsOriginsRaw,
  getRelayTargetLabel,
} from './relayTestEnv';
import {
  getRelayMetricsOrigins,
  waitForRelayDatabaseListing,
} from './relayPinning';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZqkQAAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

type UploadedMediaInfo = {
  cid: string;
  createdAt: string;
  mediaDbAddress: string;
};

const RELAY_SYNC_CLOCK_SKEW_MS = 2_000;

async function readUploadedMediaInfo(page: Page, fileName: string) {
  return page.evaluate(async (expectedName: string) => {
    const globalWindow = window as typeof window & {
      mediaDB?: { all?: () => Promise<Array<{ value?: Record<string, unknown> }>>; address?: { toString?: () => string } };
      settingsDB?: { get?: (key: string) => Promise<{ value?: { value?: string } } | null> };
    };

    const db = globalWindow.mediaDB;
    const settingsDb = globalWindow.settingsDB;
    if (!db?.all || !settingsDb?.get) return null;

    const allRows = await db.all();
    const match = allRows
      .map((entry) => entry?.value ?? {})
      .find((value) => value?.name === expectedName && typeof value?.cid === 'string');

    if (!match) return null;

    const mediaDbAddressEntry = await settingsDb.get('mediaDBAddress');

    return {
      cid: String(match.cid ?? ''),
      createdAt: String(match.createdAt ?? ''),
      mediaDbAddress:
        mediaDbAddressEntry?.value?.value?.trim() ||
        db.address?.toString?.()?.trim() ||
        '',
    };
  }, fileName);
}

async function fetchRelayPinnedBytes(relayOrigin: string, cid: string) {
  const response = await fetch(new URL(`/ipfs/${cid}`, relayOrigin), { method: 'GET' });
  if (!response.ok) return null;

  return {
    contentType: response.headers.get('content-type') ?? '',
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

test.describe('AI image upload replicates to relay pinning service', () => {
  test('uploads an AI image input and verifies relay pinning via /pinning and /ipfs', async ({ page }) => {
    test.slow();

    const relayOrigin = getPrimaryRelayOrigin();
    const metricsOrigins = getRelayMetricsOrigins(getRelayMetricsOriginsRaw());
    const fileName = `ai-relay-upload-${Date.now()}.png`;

    await page.goto('http://localhost:5173');
    await expect(page.getByTestId('loading-overlay')).toBeHidden({ timeout: 120000 });
    await expect(page.getByTestId('post-form')).toBeVisible({ timeout: 120000 });

    const closeSidebarOverlay = page.locator('[aria-label="close_sidebar"]');
    if (await closeSidebarOverlay.isVisible()) {
      await closeSidebarOverlay.click();
    }

    await page.getByTestId('post-form-ai-toggle').click();
    await expect(page.getByTestId('post-form-ai-panel')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#ai-schema-field-image-file')).toBeAttached({ timeout: 60000 });

    await page.locator('#ai-schema-field-image-file').setInputFiles([
      {
        name: fileName,
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      },
    ]);

    await expect(page.getByTestId('ai-image-selected-thumb')).toBeVisible({ timeout: 60000 });

    let uploadedInfo: UploadedMediaInfo | null = null;
    await expect
      .poll(
        async () => {
          uploadedInfo = await readUploadedMediaInfo(page, fileName);
          if (!uploadedInfo?.cid || !uploadedInfo?.mediaDbAddress || !uploadedInfo?.createdAt) {
            return '';
          }
          return uploadedInfo.cid;
        },
        {
          timeout: 60000,
          message: 'wait for uploaded image to be written into mediaDB',
        },
      )
      .toMatch(/^baf/i);

    expect(uploadedInfo?.mediaDbAddress).toMatch(/^\/orbitdb\/[a-zA-Z0-9]+$/);

    const relayLastSyncedAt = await waitForRelayDatabaseListing(
      metricsOrigins,
      uploadedInfo!.mediaDbAddress,
      'mediaDB',
    );

    expect(Date.parse(relayLastSyncedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(uploadedInfo?.createdAt ?? '') - RELAY_SYNC_CLOCK_SKEW_MS,
    );

    let pinnedAsset: { contentType: string; bytes: Buffer } | null = null;
    await expect
      .poll(
        async () => {
          pinnedAsset = await fetchRelayPinnedBytes(relayOrigin, uploadedInfo!.cid);
          return pinnedAsset?.bytes.length ?? 0;
        },
        {
          timeout: 120000,
          message: `wait for ${getRelayTargetLabel()} to serve the uploaded image from /ipfs/${uploadedInfo!.cid}`,
        },
      )
      .toBe(PNG_BYTES.length);

    expect(pinnedAsset?.contentType).toMatch(/^(application\/octet-stream|image\/png)/);
    expect(pinnedAsset?.bytes.equals(PNG_BYTES)).toBe(true);
  });
});
