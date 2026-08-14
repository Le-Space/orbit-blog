import { test, expect } from '@playwright/test';
import { closeSidebarOverlayIfPresent, waitForLoadingOverlayToSettle } from './pageLoad';

const RELAY_WS_ORIGIN = 'ws://localhost:19092';

test.describe('Blog media sharing between Alice and Bob', () => {
  test('Alice uploads image to a post and Bob sees it', async ({ browser }) => {
    test.slow();
    const contextAlice = await browser.newContext({
      ignoreHTTPSErrors: true,
      launchOptions: {
        args: [
          '--allow-insecure-localhost',
          `--unsafely-treat-insecure-origin-as-secure=${RELAY_WS_ORIGIN}`,
          '--disable-web-security'
        ]
      }
    });

    const contextBob = await browser.newContext({
      ignoreHTTPSErrors: true,
      launchOptions: {
        args: [
          '--allow-insecure-localhost',
          `--unsafely-treat-insecure-origin-as-secure=${RELAY_WS_ORIGIN}`,
          '--disable-web-security'
        ]
      }
    });

    const pageAlice = await contextAlice.newPage();
    const pageBob = await contextBob.newPage();

    await pageAlice.goto('http://localhost:5173');
    await expect(pageAlice.getByTestId('loading-overlay')).toBeHidden({ timeout: 120000 });
    await expect(pageAlice.getByTestId('blog-name')).toBeVisible({ timeout: 120000 });

    await pageAlice.getByTestId('settings-header').click();
    await closeSidebarOverlayIfPresent(pageAlice);

    await pageAlice.getByTestId('blog-settings-accordion').click();
    await pageAlice.getByTestId('blog-name-input').fill('Alice Media Blog');
    await pageAlice.getByTestId('blog-description-input').fill('E2E media sharing test');

    await pageAlice.getByTestId('categories').click();
    while (await pageAlice.getByTestId(/^remove-category-button-/).count() > 0) {
      await pageAlice.getByTestId(/^remove-category-button-/).first().click();
    }
    await pageAlice.getByTestId('new-category-input').fill('General');
    await pageAlice.getByTestId('add-category-button').click();

    await expect(pageAlice.getByTestId('post-form')).toBeVisible({ timeout: 60000 });

    await pageAlice.getByTestId('post-title-input').fill('Alice image post');
    await pageAlice.getByTestId('post-content-input').fill('Alice post with embedded image.');
    await pageAlice.locator('#categories [role="button"]').click();
    await pageAlice.locator('#categories').getByRole('button', { name: 'General', exact: true }).click();
    await pageAlice.locator('#categories [role="button"]').click();
    await pageAlice.getByTestId('post-content-input').click();

    await pageAlice
      .getByTestId('post-form')
      .getByRole('button', { name: /add media|hide media library/i })
      .first()
      .click();

    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZqkQAAAAASUVORK5CYII=';
    const fileInput = pageAlice.locator('input#file-input');
    await fileInput.setInputFiles([{
      name: 'alice-photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(pngBase64, 'base64')
    }]);

    const mediaItem = pageAlice.getByLabel('Select alice-photo.png');
    await expect(mediaItem).toBeVisible({ timeout: 60000 });
    await mediaItem.click();

    await expect(pageAlice.getByTestId('post-form').locator('img[alt="alice-photo.png"]')).toBeVisible({ timeout: 60000 });
    const contentValue = await pageAlice.getByTestId('post-content-input').inputValue();
    if (!contentValue.trim()) {
      await pageAlice.getByTestId('post-content-input').fill('Alice post with embedded image.');
    }

    await pageAlice.locator('#publish').check();
    await pageAlice.getByTestId('publish-post-button').click();

    const alicePostTitle = pageAlice.getByTestId('post-item-title').filter({ hasText: 'Alice image post' });
    await expect(alicePostTitle).toBeVisible({ timeout: 60000 });
    await alicePostTitle.first().click();
    await expect(pageAlice.getByTestId('blog-post').locator('img[alt="alice-photo.png"]')).toBeVisible({ timeout: 120000 });

    await expect
      .poll(async () => {
        return await pageAlice.evaluate(async () => {
          const db = (window as any).settingsDB;
          if (!db?.get) return '';
          const entry = await db.get('mediaDBAddress');
          return entry?.value?.value || '';
        });
      }, { timeout: 60000 })
      .toMatch(/^\/orbitdb\/[a-zA-Z0-9]+$/);

    const aliceBlogAddress = await pageAlice.evaluate(() => {
      return (window as any).settingsDB?.address?.toString?.() || '';
    });
    expect(aliceBlogAddress).toMatch(/^\/orbitdb\/[a-zA-Z0-9]+$/);

    await pageBob.goto(`http://localhost:5173/#${aliceBlogAddress}`);
    await waitForLoadingOverlayToSettle(pageBob);
    await expect(pageBob.getByTestId('blog-name')).toHaveText('Alice Media Blog', { timeout: 120000 });

    const bobPostTitle = pageBob.getByTestId('post-item-title').filter({ hasText: 'Alice image post' });
    await expect(bobPostTitle).toBeVisible({ timeout: 120000 });
    await closeSidebarOverlayIfPresent(pageBob);
    await bobPostTitle.first().click();

    await expect(pageBob.getByTestId('blog-post').locator('img[alt="alice-photo.png"]')).toBeVisible({ timeout: 120000 });

    await contextAlice.close();
    await contextBob.close();
  });
});
