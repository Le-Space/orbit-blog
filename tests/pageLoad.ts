import { expect, type Page } from '@playwright/test';

export async function waitForLoadingOverlayToSettle(
  page: Page,
  visibleTimeoutMs = 30_000,
  hiddenTimeoutMs = 120_000,
) {
  const loadingOverlay = page.getByTestId('loading-overlay');
  const wasVisible = await loadingOverlay.isVisible().catch(() => false);

  if (wasVisible) {
    await expect(loadingOverlay).toBeVisible({ timeout: visibleTimeoutMs });
  }

  await expect(loadingOverlay).toBeHidden({ timeout: hiddenTimeoutMs });
}

/**
 * The sidebar's dismiss layer is a full-screen `fixed inset-0 z-30` div. While it
 * is mounted it swallows pointer events, so a click on anything underneath keeps
 * reporting "element is visible, enabled and stable" and then times out with
 * `<div aria-label="close_sidebar"> intercepts pointer events`. Playwright retries
 * for the full timeout, and a Playwright-level retry does not help because the
 * overlay is there again on the next attempt.
 *
 * Dismiss it before clicking into the page. Both pages need this, not just the
 * one that opened the sidebar: a freshly navigated page can mount the overlay on
 * its own.
 */
export async function closeSidebarOverlayIfPresent(page: Page) {
  const overlay = page.locator('[aria-label="close_sidebar"]').first();
  if ((await overlay.count()) === 0) return;
  if (await overlay.isVisible().catch(() => false)) {
    await overlay.click({ force: true, timeout: 3_000 }).catch(() => {});
  }
}
