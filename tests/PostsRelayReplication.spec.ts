import { test, expect, type Page } from '@playwright/test';
import {
  getRelayMetricsOriginsRaw,
  getRelaySeedPeerIds,
} from './relayTestEnv';
import {
  waitForPeerCount,
  waitForRelayPeerConnection,
} from './peerConnectivity';
import {
  getRelayMetricsOrigins,
  waitForRelayDatabaseListing,
} from './relayPinning';

type CreatedPostInfo = {
  postId: string;
  createdAtMs: number;
  postsDbAddress: string;
};

const RELAY_SYNC_CLOCK_SKEW_MS = 2_000;

async function closeSidebarIfVisible(page: Page) {
  const closeSidebarOverlay = page.locator('[aria-label="close_sidebar"]');
  if (await closeSidebarOverlay.isVisible()) {
    await closeSidebarOverlay.click();
  }
}

async function ensureGeneralCategory(page: Page) {
  await page.getByTestId('settings-header').click();
  await closeSidebarIfVisible(page);
  await page.getByTestId('blog-settings-accordion').click();
  await page.getByTestId('categories').click();

  const removeButtons = page.getByTestId(/^remove-category-button-/);
  while ((await removeButtons.count()) > 0) {
    await removeButtons.first().click();
  }

  await page.getByTestId('new-category-input').fill('General');
  await page.getByTestId('add-category-button').click();
  await expect(page.getByTestId('category-item')).toContainText('General');
}

async function createPublishedPost(page: Page, title: string, content: string) {
  await page.getByTestId('post-title-input').fill(title);
  await page.getByTestId('post-content-input').fill(content);

  await page.locator('#categories [role="button"]').click();
  await page.locator('#categories').getByRole('button', { name: 'General', exact: true }).click();
  await page.locator('#categories [role="button"]').click();

  await page.locator('#publish').check();
  await page.getByTestId('publish-post-button').click();

  await expect(page.getByTestId('post-item-title').filter({ hasText: title })).toBeVisible({ timeout: 60000 });
}

async function readCreatedPostInfo(page: Page, title: string) {
  return page.evaluate(async (expectedTitle: string) => {
    const globalWindow = window as typeof window & {
      postsDB?: { all?: () => Promise<Array<{ value?: Record<string, unknown> }>>; address?: { toString?: () => string } };
      settingsDB?: { get?: (key: string) => Promise<{ value?: { value?: string } } | null> };
    };

    const db = globalWindow.postsDB;
    const settingsDb = globalWindow.settingsDB;
    if (!db?.all || !settingsDb?.get) return null;

    const allRows = await db.all();
    const match = allRows
      .map((entry) => entry?.value ?? {})
      .find((value) => value?.title === expectedTitle && typeof value?._id === 'string');

    if (!match) return null;

    const postsDbAddressEntry = await settingsDb.get('postsDBAddress');
    const createdAtRaw = match.createdAt;
    const createdAtMs =
      typeof createdAtRaw === 'number'
        ? createdAtRaw
        : Number.isFinite(Date.parse(String(createdAtRaw ?? '')))
          ? Date.parse(String(createdAtRaw))
          : NaN;

    return {
      postId: String(match._id ?? ''),
      createdAtMs,
      postsDbAddress:
        postsDbAddressEntry?.value?.value?.trim() ||
        db.address?.toString?.()?.trim() ||
        '',
    };
  }, title);
}

test.describe('Post creation replicates to relay database sync history', () => {
  test('creates a post via UI and verifies postsDB appears in relay /pinning/databases', async ({ page }) => {
    test.slow();

    const metricsOrigins = getRelayMetricsOrigins(getRelayMetricsOriginsRaw());
    const relayPeerIds = getRelaySeedPeerIds();
    const title = `relay-post-${Date.now()}`;
    const content = `relay replication check ${Date.now()}`;

    await page.goto('http://localhost:5173');
    await expect(page.getByTestId('loading-overlay')).toBeHidden({ timeout: 120000 });
    await expect(page.getByTestId('post-form')).toBeVisible({ timeout: 120000 });
    await waitForPeerCount(page, 1, 120000);
    await waitForRelayPeerConnection(page, relayPeerIds, 120000);

    await ensureGeneralCategory(page);
    await createPublishedPost(page, title, content);

    let createdPostInfo: CreatedPostInfo | null = null;
    await expect
      .poll(
        async () => {
          createdPostInfo = await readCreatedPostInfo(page, title);
          if (!createdPostInfo?.postId || !createdPostInfo?.postsDbAddress || !Number.isFinite(createdPostInfo?.createdAtMs)) {
            return '';
          }
          return createdPostInfo.postId;
        },
        {
          timeout: 60000,
          message: 'wait for created post to be readable from postsDB',
        },
      )
      .not.toBe('');

    expect(createdPostInfo?.postsDbAddress).toMatch(/^\/orbitdb\/[a-zA-Z0-9]+$/);

    const relayLastSyncedAt = await waitForRelayDatabaseListing(
      metricsOrigins,
      createdPostInfo!.postsDbAddress,
      'postsDB',
    );

    expect(Date.parse(relayLastSyncedAt ?? '')).toBeGreaterThanOrEqual(
      createdPostInfo!.createdAtMs - RELAY_SYNC_CLOCK_SKEW_MS,
    );
  });
});
