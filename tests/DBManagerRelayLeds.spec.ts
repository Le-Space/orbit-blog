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

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZqkQAAAAASUVORK5CYII=';

type CurrentDbAddresses = {
  settings: string;
  posts: string;
  comments: string;
  media: string;
};

async function closeSidebarIfVisible(page: Page) {
  const closeSidebarOverlay = page.locator('[aria-label="close_sidebar"]').first();
  if (await closeSidebarOverlay.count() === 0) return;
  if (await closeSidebarOverlay.isVisible().catch(() => false)) {
    await closeSidebarOverlay.click({ force: true, timeout: 3000 }).catch(() => {});
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

async function createPublishedPostWithMedia(page: Page, title: string, content: string, fileName: string) {
  await page.getByTestId('post-title-input').fill(title);
  await page.getByTestId('post-content-input').fill(content);

  await page.locator('#categories [role="button"]').click();
  await page.locator('#categories').getByRole('button', { name: 'General', exact: true }).click();
  await page.locator('#categories [role="button"]').click();
  await page.getByTestId('post-content-input').click();

  await page
    .getByTestId('post-form')
    .getByRole('button', { name: /add media|hide media library/i })
    .first()
    .click();

  await page.locator('input#file-input').setInputFiles([{
    name: fileName,
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  }]);

  const mediaItem = page.getByLabel(`Select ${fileName}`);
  await expect(mediaItem).toBeVisible({ timeout: 60000 });
  await mediaItem.click();

  await expect(page.getByTestId('post-form').locator(`img[alt="${fileName}"]`)).toBeVisible({ timeout: 60000 });

  await page.locator('#publish').check();
  await page.getByTestId('publish-post-button').click();
  await expect(page.getByTestId('post-item-title').filter({ hasText: title })).toBeVisible({ timeout: 60000 });
}

async function addCommentToPost(page: Page, title: string, author: string, comment: string) {
  const postTitle = page.getByTestId('post-item-title').filter({ hasText: title });
  await postTitle.first().click();
  await expect(page.getByTestId('blog-post')).toBeVisible({ timeout: 60000 });

  const commentForm = page.getByTestId('blog-post').locator('form').last();
  await commentForm.locator('input[type="text"]').fill(author);
  await commentForm.locator('textarea').fill(comment);
  await commentForm.locator('button[type="submit"]').click();

  await expect(page.getByTestId('blog-post').getByText(comment, { exact: true })).toBeVisible({ timeout: 60000 });
}

async function readCurrentDbAddresses(page: Page) {
  return page.evaluate(async (): Promise<CurrentDbAddresses | null> => {
    const globalWindow = window as typeof window & {
      settingsDB?: {
        address?: { toString?: () => string };
        get?: (key: string) => Promise<{ value?: { value?: string } } | null>;
      };
      postsDB?: { address?: { toString?: () => string } };
      commentsDB?: { address?: { toString?: () => string } };
      mediaDB?: { address?: { toString?: () => string } };
    };

    const settingsDb = globalWindow.settingsDB;
    if (!settingsDb?.get || !settingsDb?.address?.toString) return null;

    const [postsEntry, commentsEntry, mediaEntry] = await Promise.all([
      settingsDb.get('postsDBAddress'),
      settingsDb.get('commentsDBAddress'),
      settingsDb.get('mediaDBAddress'),
    ]);

    const settings = settingsDb.address.toString().trim();
    const posts =
      postsEntry?.value?.value?.trim() ||
      globalWindow.postsDB?.address?.toString?.()?.trim() ||
      '';
    const comments =
      commentsEntry?.value?.value?.trim() ||
      globalWindow.commentsDB?.address?.toString?.()?.trim() ||
      '';
    const media =
      mediaEntry?.value?.value?.trim() ||
      globalWindow.mediaDB?.address?.toString?.()?.trim() ||
      '';

    return { settings, posts, comments, media };
  });
}

async function waitForRelayListing(metricsOrigins: string[], dbAddress: string, label: string) {
  await waitForRelayDatabaseListing(metricsOrigins, dbAddress, label);
}

async function expectDbManagerLedGreen(page: Page, key: keyof CurrentDbAddresses) {
  await expect
    .poll(
      async () => page.evaluate((ledKey) => {
        return document
          .querySelector(`[data-testid="db-sync-led-${ledKey}"] [role="status"]`)
          ?.getAttribute('aria-label') ?? '';
      }, key),
      {
        timeout: 120000,
        message: `wait for db-sync-led-${key} to report relay replication`,
      },
    )
    .toContain('State: Replicated on relay');
}

test.describe('DB Manager replication LEDs', () => {
  test('shows relay replication for settings, posts, comments, and media DBs', async ({ page }) => {
    test.slow();

    const relayPeerIds = getRelaySeedPeerIds();
    const metricsOrigins = getRelayMetricsOrigins(getRelayMetricsOriginsRaw());
    const title = `db-led-post-${Date.now()}`;
    const content = `db-led content ${Date.now()}`;
    const comment = `db-led comment ${Date.now()}`;
    const mediaFileName = `db-led-${Date.now()}.png`;

    await page.goto('http://localhost:5173');
    await expect(page.getByTestId('loading-overlay')).toBeHidden({ timeout: 120000 });
    await expect(page.getByTestId('post-form')).toBeVisible({ timeout: 120000 });
    await waitForPeerCount(page, 1, 120000);
    await waitForRelayPeerConnection(page, relayPeerIds, 120000);

    await ensureGeneralCategory(page);
    await createPublishedPostWithMedia(page, title, content, mediaFileName);
    await addCommentToPost(page, title, 'LED Tester', comment);

    let addresses: CurrentDbAddresses | null = null;
    await expect
      .poll(
        async () => {
          addresses = await readCurrentDbAddresses(page);
          if (!addresses) return '';
          return [addresses.settings, addresses.posts, addresses.comments, addresses.media].every(Boolean)
            ? 'ready'
            : '';
        },
        {
          timeout: 60000,
          message: 'wait for settings/posts/comments/media DB addresses to be available',
        },
      )
      .toBe('ready');

    await waitForRelayListing(metricsOrigins, addresses!.settings, 'settingsDB');
    await waitForRelayListing(metricsOrigins, addresses!.posts, 'postsDB');
    await waitForRelayListing(metricsOrigins, addresses!.comments, 'commentsDB');
    await waitForRelayListing(metricsOrigins, addresses!.media, 'mediaDB');

    await page.getByTestId('menu-button').click();
    await page.getByTestId('blogs-header').click();
    await page.getByTestId('db-manager-container').waitFor({ state: 'visible' });

    await expectDbManagerLedGreen(page, 'settings');
    await expectDbManagerLedGreen(page, 'posts');
    await expectDbManagerLedGreen(page, 'comments');
    await expectDbManagerLedGreen(page, 'media');
  });
});
