import { test, expect } from '@playwright/test';
import { closeSidebarOverlayIfPresent, waitForLoadingOverlayToSettle } from './pageLoad';

test.describe('Realtime comments between Alice and Bob', () => {
  test('Bob comments on Alice post and Alice replies without reload', async ({ browser }) => {
    test.slow();
    const contextAlice = await browser.newContext({
      ignoreHTTPSErrors: true,
      launchOptions: {
        args: [
          '--allow-insecure-localhost',
          '--unsafely-treat-insecure-origin-as-secure=ws://localhost:9092',
          '--disable-web-security'
        ]
      }
    });

    const contextBob = await browser.newContext({
      ignoreHTTPSErrors: true,
      launchOptions: {
        args: [
          '--allow-insecure-localhost',
          '--unsafely-treat-insecure-origin-as-secure=ws://localhost:9092',
          '--disable-web-security'
        ]
      }
    });

    const pageAlice = await contextAlice.newPage();
    const pageBob = await contextBob.newPage();

    pageAlice.on('console', (msg) => console.log('[alice]', msg.text()));
    pageBob.on('console', (msg) => console.log('[bob]', msg.text()));
    pageAlice.on('pageerror', (err) => console.error('[alice] PAGE ERROR:', err.message));
    pageBob.on('pageerror', (err) => console.error('[bob] PAGE ERROR:', err.message));

    await pageAlice.goto('http://localhost:5173');
    await expect(pageAlice.getByTestId('loading-overlay')).toBeHidden({ timeout: 120000 });
    await expect(pageAlice.getByTestId('blog-name')).toBeVisible({ timeout: 120000 });

    await pageAlice.getByTestId('settings-header').click();
    const closeSidebarOverlay = pageAlice.locator('[aria-label="close_sidebar"]');
    if (await closeSidebarOverlay.isVisible()) {
      await closeSidebarOverlay.click();
    }

    await pageAlice.getByTestId('blog-settings-accordion').click();
    await pageAlice.getByTestId('blog-name-input').fill('Realtime Comments Blog');
    await pageAlice.getByTestId('blog-description-input').fill('E2E realtime comments test');

    await pageAlice.getByTestId('categories').click();
    while (await pageAlice.getByTestId(/^remove-category-button-/).count() > 0) {
      await pageAlice.getByTestId(/^remove-category-button-/).first().click();
    }
    await pageAlice.getByTestId('new-category-input').fill('General');
    await pageAlice.getByTestId('add-category-button').click();

    await expect(pageAlice.getByTestId('post-form')).toBeVisible({ timeout: 60000 });

    await pageAlice.getByTestId('post-title-input').fill('Realtime comments post');
    await pageAlice.getByTestId('post-content-input').fill('Alice created this post for realtime comment sync testing.');
    await pageAlice.locator('#categories [role="button"]').click();
    await pageAlice.locator('#categories').getByRole('button', { name: 'General', exact: true }).click();
    await pageAlice.locator('#categories [role="button"]').click();
    await pageAlice.locator('#publish').check();
    await pageAlice.getByTestId('publish-post-button').click();

    const alicePostTitle = pageAlice.getByTestId('post-item-title').filter({ hasText: 'Realtime comments post' });
    await expect(alicePostTitle).toBeVisible({ timeout: 60000 });
    await alicePostTitle.first().click();
    await expect(pageAlice.getByTestId('post-title')).toContainText('Realtime comments post');

    // Ensure DB addresses are fully persisted before sharing.
    await expect
      .poll(async () => {
        return await pageAlice.evaluate(async () => {
          const db = (window as any).settingsDB;
          if (!db?.get) return '';
          const entry = await db.get('commentsDBAddress');
          return entry?.value?.value || '';
        });
      }, { timeout: 60000 })
      .toMatch(/^\/orbitdb\/[a-zA-Z0-9]+$/);

    await pageAlice.getByTestId('menu-button').click();
    await pageAlice.getByTestId('blogs-header').click();
    await pageAlice.getByTestId('db-manager-container').waitFor({ state: 'visible' });
    const closeSidebarOverlay2 = pageAlice.locator('[aria-label="close_sidebar"]');
    if (await closeSidebarOverlay2.isVisible()) {
      await closeSidebarOverlay2.click();
    }

    const aliceBlogAddress = await pageAlice.getByTestId('db-address-input').inputValue();
    expect(aliceBlogAddress).toMatch(/^\/orbitdb\/[a-zA-Z0-9]+$/);

    await pageBob.goto(`http://localhost:5173/#${aliceBlogAddress}`);
    await waitForLoadingOverlayToSettle(pageBob);
    await expect(pageBob.getByTestId('blog-name')).toHaveText('Realtime Comments Blog', { timeout: 120000 });

    const bobPostTitle = pageBob.getByTestId('post-item-title').filter({ hasText: 'Realtime comments post' });
    await expect(bobPostTitle).toBeVisible({ timeout: 120000 });
    await closeSidebarOverlayIfPresent(pageBob);
    await bobPostTitle.first().click();
    await expect(pageBob.getByTestId('post-title')).toContainText('Realtime comments post');

    let aliceNavigated = false;
    let bobNavigated = false;

    pageAlice.on('framenavigated', (frame) => {
      if (frame === pageAlice.mainFrame()) {
        aliceNavigated = true;
      }
    });
    pageBob.on('framenavigated', (frame) => {
      if (frame === pageBob.mainFrame()) {
        bobNavigated = true;
      }
    });

    const bobComment = `Bob realtime comment ${Date.now()}`;
    const aliceReply = `Alice realtime reply ${Date.now()}`;

    const bobCommentForm = pageBob.getByTestId('blog-post').locator('form').last();
    await bobCommentForm.locator('input[type="text"]').fill('Bob');
    await bobCommentForm.locator('textarea').fill(bobComment);
    await bobCommentForm.locator('button[type="submit"]').click();

    await expect(pageBob.getByTestId('blog-post').getByText(bobComment, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(pageAlice.getByTestId('blog-post').getByText(bobComment, { exact: true })).toBeVisible({ timeout: 60000 });

    const aliceCommentForm = pageAlice.getByTestId('blog-post').locator('form').last();
    await aliceCommentForm.locator('input[type="text"]').fill('Alice');
    await aliceCommentForm.locator('textarea').fill(aliceReply);
    await aliceCommentForm.locator('button[type="submit"]').click();

    await expect(pageBob.getByTestId('blog-post').getByText(aliceReply, { exact: true })).toBeVisible({ timeout: 60000 });

    expect(aliceNavigated).toBeFalsy();
    expect(bobNavigated).toBeFalsy();

    await contextAlice.close();
    await contextBob.close();
  });
});
