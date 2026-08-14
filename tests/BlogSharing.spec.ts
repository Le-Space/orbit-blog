import { test, expect, chromium } from '@playwright/test';
import { getRelayMetricsOriginsRaw, getRelaySeedPeerIds, getRelayTargetLabel } from './relayTestEnv';
import { waitForPeerCount, waitForRelayPeerConnection } from './peerConnectivity';
import {
    fetchRelayDatabaseListingAny,
    getRelayMetricsOrigins,
    requestRelayDatabaseSyncAny,
} from './relayPinning';

const config = {
    seedNodes: process.env.VITE_P2P_PUPSUB_DEV || ''
};

type CreatedPostInfo = {
    postId: string;
    createdAtMs: number;
    postsDbAddress: string;
};

const RELAY_SYNC_CLOCK_SKEW_MS = 2_000;

async function readCreatedPostInfo(page, title: string): Promise<CreatedPostInfo | null> {
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

async function expectPostsDbReplicatedToRelay(page, title: string, timeoutMs = 120000) {
    const metricsOrigins = getRelayMetricsOrigins(getRelayMetricsOriginsRaw());

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
                message: `wait for "${title}" to be readable from postsDB`,
            },
        )
        .not.toBe('');

    expect(createdPostInfo?.postsDbAddress).toMatch(/^\/orbitdb\/[a-zA-Z0-9]+$/);

    await requestRelayDatabaseSyncAny(metricsOrigins, createdPostInfo!.postsDbAddress);

    await expect
        .poll(
            async () => {
                const listing = await fetchRelayDatabaseListingAny(metricsOrigins, createdPostInfo!.postsDbAddress);
                const relayLastSyncedAtMs = Date.parse(listing.row?.lastSyncedAt ?? '');
                if (!Number.isFinite(relayLastSyncedAtMs)) return 0;
                return relayLastSyncedAtMs;
            },
            {
                timeout: timeoutMs,
                message: `wait for ${getRelayTargetLabel()} to advance postsDB sync history after "${title}"`,
            },
        )
        .toBeGreaterThanOrEqual(createdPostInfo!.createdAtMs - RELAY_SYNC_CLOCK_SKEW_MS);
}

test.describe('Blog Sharing between Alice and Bob', () => {
    // This file shares mutable state across tests (aliceBlogAddress, pageAlice/pageBob),
    // so it must run serially.
    test.describe.configure({ mode: 'serial' });
    
    let pageAlice;
    let pageBob;
    let aliceBlogAddress;
    let daemon;
    let wsAddr;
    let contextAlice;  // Separate context for Alice
    let contextBob;    // Separate context for Bob

    async function closeSidebarOverlayIfPresent(page) {
        const overlay = page.locator('[aria-label="close_sidebar"]').first();
        if (await overlay.count() === 0) return;
        if (await overlay.isVisible().catch(() => false)) {
            await overlay.click({ force: true, timeout: 3000 }).catch(() => {});
        }
    }

    function updateSeedNodes(nodes: string) {
        config.seedNodes = nodes;
    }
    
    test.beforeAll(async ({ browser }) => {
        // Create fresh test directory
        contextAlice = await browser.newContext({
            ignoreHTTPSErrors: true,
            launchOptions: {
                args: [
                    '--allow-insecure-localhost',
                    '--unsafely-treat-insecure-origin-as-secure=ws://localhost:19092',
                    '--disable-web-security'
                ]
            }
        });

        // Initialize browser context for Bob
        contextBob = await browser.newContext({
            ignoreHTTPSErrors: true,
            launchOptions: {
                args: [
                    '--allow-insecure-localhost',
                    '--unsafely-treat-insecure-origin-as-secure=ws://localhost:19092',
                    '--disable-web-security'
                ]
            }
        });
    });

    test('Alice creates Bach blog and gets the database address', async () => {
        test.slow();
        pageAlice = await contextAlice.newPage();
        pageAlice.on('console', msg => {
            console.log('[alice] BROWSER LOG:', msg.text());
        });
        pageAlice.on('pageerror', err => {
            console.error('PAGE ERROR:', err.message);
            if (err.stack) console.error(err.stack);
        });
        await pageAlice.goto('http://localhost:5173');
        await pageAlice.evaluate(() => {
            localStorage.setItem('debug', 'libp2p:*,le-space:*');
        });

        await expect(pageAlice.getByTestId('loading-overlay')).toBeHidden({ timeout: 120000 });
        await expect(pageAlice.getByTestId('post-form')).toBeVisible({ timeout: 120000 });
        await waitForPeerCount(pageAlice, 1, 120000);
        // First, let's run the existing blog setup test
        const blogName = await pageAlice.getByTestId('blog-name').textContent();
        const blogDescription = await pageAlice.getByTestId('blog-description').textContent();
        
        await expect(pageAlice.getByTestId('blog-name')).toBeVisible();
        await expect(pageAlice.getByTestId('blog-description')).toBeVisible();
        
        // Configure blog settings
        await pageAlice.getByTestId('settings-header').click();
        // Settings render in main content; close the sidebar overlay so it doesn't intercept clicks.
        const closeSidebarOverlay = pageAlice.locator('[aria-label="close_sidebar"]');
        if (await closeSidebarOverlay.isVisible()) {
            await closeSidebarOverlay.click();
        }
        await pageAlice.getByTestId('blog-settings-accordion').click();
        await pageAlice.getByTestId('blog-name-input').fill('Bach Chronicles');
        await pageAlice.getByTestId('blog-description-input').fill('Exploring the life and works of Johann Sebastian Bach');

        // Add categories
        await pageAlice.getByTestId('categories').click();
        const categories = ['General', 'Live', 'Works', 'Music'];
        for (const category of categories) {
            await pageAlice.getByTestId('new-category-input').fill(category);
            await pageAlice.getByTestId('add-category-button').click();
        }

        // Create posts about Bach
        const bachPosts = [
            {
                title: "The Birth of a Musical Genius",
                content: "Johann Sebastian Bach was born in Eisenach, Germany in 1685...",
                category: "Music"
            },
            {
                title: "The Well-Tempered Clavier",
                content: "One of Bach's most influential works, The Well-Tempered Clavier, demonstrates his mastery of counterpoint and harmony.",
                category: "Music"
            }
        ];

        for (const post of bachPosts) {
            await pageAlice.getByTestId('post-title-input').fill(post.title);
            await pageAlice.getByTestId('post-content-input').fill(post.content);
            // Category selection is a custom MultiSelect with id="categories"
            await pageAlice.locator('#categories [role="button"]').click();
            await pageAlice.locator('#categories').getByRole('button', { name: post.category, exact: true }).click();
            // Close dropdown so it doesn't cover other controls
            await pageAlice.locator('#categories [role="button"]').click();
            await pageAlice.locator('#publish').check();
            await pageAlice.getByTestId('publish-post-button').click();
            
            // Add an initial delay after clicking publish
            await pageAlice.waitForTimeout(2000);
            
            // Add wait for the post to appear in the list with increased timeout
            await expect(async () => {
                const postElements = await pageAlice.getByTestId('post-item-title').all();
                const postTitles = await Promise.all(postElements.map(el => el.textContent()));
                expect(postTitles).toContain(post.title);
            }).toPass({ timeout: 20000 }); // Increased timeout to 20 seconds

            // Add additional delay after confirmation to ensure DB processing
            await pageAlice.waitForTimeout(2000);

            // Verify the new post has actually been observed by the relay before Bob tries to load it.
            await expectPostsDbReplicatedToRelay(pageAlice, post.title);
        }

        // Replace the simple posts check with a retry mechanism
        await expect(async () => {
            const posts = await pageAlice.getByTestId('post-item-title').all();
            expect(posts).toHaveLength(2);
            
            // Verify both post titles are present
            const postTitles = await Promise.all(
                posts.map(post => post.textContent())
            );
            expect(postTitles).toContain("The Birth of a Musical Genius");
            expect(postTitles).toContain("The Well-Tempered Clavier");
        }).toPass({ timeout: 30000 });

        // Get the database address from DBManager
        await pageAlice.getByTestId('menu-button').click();
        await pageAlice.getByTestId('blogs-header').click();
        await pageAlice.getByTestId('db-manager-container').waitFor({ state: 'visible' });
        // DBManager is in main content, close sidebar overlay so buttons are clickable.
        const closeSidebarOverlay2 = pageAlice.locator('[aria-label="close_sidebar"]');
        if (await closeSidebarOverlay2.isVisible()) {
            await closeSidebarOverlay2.click();
        }
        
        // Verify the database address input is visible and has a value
        const dbAddressInput = pageAlice.getByTestId('db-address-input');
        await expect(dbAddressInput).toBeVisible();
        aliceBlogAddress = await dbAddressInput.inputValue();
        
        // Verify the address is a valid OrbitDB address
        expect(aliceBlogAddress).toBeTruthy();
        expect(aliceBlogAddress).toMatch(/^\/orbitdb\/[a-zA-Z0-9]+$/);
        
        // Copy the address to clipboard for Bob to use
        await pageAlice.getByTestId('copy-db-address-button').click();
        // await pageAlice.
    });

    test('Bob opens Alice\'s blog and waits for replication', async () => {
        test.slow();

        pageBob = await contextBob.newPage();
        pageBob.on('console', msg => {
            console.log('[bob] BROWSER LOG:', msg.text());
        }); 
        pageBob.on('pageerror', err => {
            console.error('PAGE ERROR:', err.message);
            if (err.stack) console.error(err.stack);
        });
        await pageBob.goto(`http://localhost:5173/#${aliceBlogAddress}`);
        await pageBob.evaluate(() => {
            localStorage.setItem('debug', 'libp2p:*,le-space:*');
        });
        const loadingOverlay = pageBob.getByTestId('loading-overlay');
        const loadingOverlayShown = await loadingOverlay.isVisible().catch(() => false);
        if (loadingOverlayShown) {
            await expect(loadingOverlay).toBeVisible({ timeout: 30000 });
        }
        // Remote blog load can take a while depending on replication/bootstrap timing.
        await expect(loadingOverlay).toBeHidden({ timeout: 120000 });
        await expect(pageBob.getByTestId('blog-name')).toHaveText('Bach Chronicles', { timeout: 120000 });

        // Loading the remote OrbitDB and rendering its entries is the sharing
        // contract. libp2p may keep either the relay or an upgraded direct
        // WebRTC connection open; transport-specific assertions live in the
        // dedicated relay and WebRTC specs.
        await expect
            .poll(
                async () => {
                    const posts = await pageBob.getByTestId('post-item-title').all();
                    return Promise.all(posts.map((post) => post.textContent()));
                },
                {
                    timeout: 120000,
                    message: 'wait for Bob to render both replicated post titles',
                },
            )
            .toEqual(expect.arrayContaining([
                'The Birth of a Musical Genius',
                'The Well-Tempered Clavier',
            ]));

        const posts = await pageBob.getByTestId('post-item-title').all();
        for (const post of posts) {
            const postTitle = await post.textContent();
            console.log('postTitle', postTitle);
            await expect(post).toBeVisible();
        }

    });

    test('Alice edits a post and Bob sees the update while viewing', async () => {
        await closeSidebarOverlayIfPresent(pageAlice);
        await closeSidebarOverlayIfPresent(pageBob);

        // Both peers must hold the relay connection before the edit is made.
        // This suite asserts connectivity only once, early, and only for Alice,
        // and a page can lose the relay between tests. When that happens the
        // edit is published into an empty mesh, and the assertion below spends
        // 60s waiting for a message that was never broadcast:
        //
        //   [alice] libp2p:discovery:pubsub skipping broadcasting our peer data
        //           because there are no peers present
        //
        // Waiting here turns that race into a precondition, and a genuinely
        // unreachable relay now fails as "wait for relay peer connection"
        // instead of an unexplained replication timeout.
        const relayPeerIds = getRelaySeedPeerIds();
        await Promise.all([
            waitForRelayPeerConnection(pageAlice, relayPeerIds, 120000),
            waitForRelayPeerConnection(pageBob, relayPeerIds, 120000),
        ]);

        const targetTitle = "The Birth of a Musical Genius";
        const updatedContent = `Johann Sebastian Bach was born in Eisenach, Germany in 1685... (edited ${Date.now()})`;

        const aliceTargetPostTitle = pageAlice.getByTestId('post-item-title').filter({ hasText: targetTitle });
        await expect(aliceTargetPostTitle).toBeVisible({ timeout: 60000 });
        await aliceTargetPostTitle.first().click();

        const bobTargetPostTitle = pageBob.getByTestId('post-item-title').filter({ hasText: targetTitle });
        await expect(bobTargetPostTitle).toBeVisible({ timeout: 60000 });
        await bobTargetPostTitle.first().click();

        const aliceTargetPostItem = pageAlice
            .locator('[data-testid^="post-item-"]')
            .filter({ has: pageAlice.getByTestId('post-item-title').filter({ hasText: targetTitle }) })
            .first();
        await aliceTargetPostItem.hover();
        await aliceTargetPostItem.locator('[data-testid^="post-edit-"]').click();

        await expect(pageAlice.getByTestId('edit-post-content-input')).toBeVisible({ timeout: 30000 });
        await pageAlice.getByTestId('edit-post-content-input').fill(updatedContent);
        await pageAlice.getByTestId('save-edited-post-button').click();

        await expect(pageAlice.getByTestId('blog-post').getByText(updatedContent)).toBeVisible({ timeout: 60000 });

        await expect
            .poll(
                () => pageBob.evaluate(async ({ title }) => {
                    const db = (window as typeof window & {
                        postsDB?: { all?: () => Promise<Array<{ value?: { title?: string; content?: string } }>> };
                    }).postsDB;
                    const entries = await db?.all?.() || [];
                    return entries.find((entry) => entry.value?.title === title)?.value?.content || '';
                }, { title: targetTitle }),
                {
                    timeout: 60000,
                    message: 'wait for Bob postsDB to receive Alice post edit',
                },
            )
            .toBe(updatedContent);

        await expect(pageBob.getByTestId('post-content')).toContainText(updatedContent, { timeout: 30000 });
    });

    test.fixme('Alice deletes and restores her blog from OrbitDB address', async ({ browser }) => {
        // Close Bob's browser first
        if (pageBob) await pageBob.close();
        if (contextBob) await contextBob.close();

        // Reopen Alice's browser
        contextAlice = await browser.newContext({
            ignoreHTTPSErrors: true,
            launchOptions: {
                args: [
                    '--allow-insecure-localhost',
                    '--unsafely-treat-insecure-origin-as-secure=ws://localhost:19092',
                    '--disable-web-security'
                ]
            }
        });
        pageAlice = await contextAlice.newPage();
        await pageAlice.goto('http://localhost:5173');

        // Open Sidebar and DBManager
        // await pageAlice.getByTestId('menu-button').click();  
        await pageAlice.getByTestId('blogs-header').click();
        await pageAlice.getByTestId('db-manager-container').waitFor({ state: 'visible' });
        // DBManager renders in main content; ensure sidebar overlay doesn't intercept clicks.
        await closeSidebarOverlayIfPresent(pageAlice);

        //DBManager add aliceBlogAddress as remote database
        // await pageAlice.getByTestId('add-remote-db-button').click();
        await pageAlice.getByTestId('remote-db-address-input').fill(aliceBlogAddress);
        await closeSidebarOverlayIfPresent(pageAlice);
        await pageAlice.getByTestId('add-db-button').click();
 
        //check if aliceBlogAddress is in the remote databases list
        await expect(async () => {
            await expect(pageAlice.getByTestId('remote-db-item')).toBeVisible();
            
            // Get all remote database items
            const remoteDatabases = await pageAlice.getByTestId('remote-db-item').all();
            
            // Check their text content
            const remoteDBTexts = await Promise.all(remoteDatabases.map(db => db.textContent()));
            
            // Find at least one item that contains both the address and "Unknown Blog"
            const hasMatchingDB = remoteDBTexts.some(text => 
                text.includes("Unknown Blog") && text.includes(aliceBlogAddress)
            );
            
            expect(hasMatchingDB).toBe(true);
        }).toPass({ timeout: 30000 });
        //click on unknown blog
        await pageAlice.getByTestId('remote-db-item').first().click();
        await pageAlice.waitForTimeout(2000);

        //wait until we see the post titles in the posts list
        await expect(async () => {
            const posts = await pageAlice.getByTestId('post-item-title').all();
            expect(posts).toHaveLength(2);
            // Verify both posts are visible
            for (const post of posts) {
                await expect(post).toBeVisible();
            }
            // Verify the specific titles are present
            const postTitles = await Promise.all(posts.map(post => post.textContent()));
            expect(postTitles).toContain("The Birth of a Musical Genius");
            expect(postTitles).toContain("The Well-Tempered Clavier");
        }).toPass({ timeout: 30000 });

        //delete the database
        await pageAlice.getByTestId('delete-db-button').click();
        // Click the confirm button in the modal
        await pageAlice.getByRole('button', { name: 'Confirm' }).first().click();
        
        //wait until the database is deleted
        await expect(pageAlice.getByTestId('remote-db-item')).not.toBeVisible();
        // // Get the database address before deletion
        // const dbAddressInput = pageAlice.getByTestId('db-address-input');
        // await expect(dbAddressInput).toBeVisible();
        // const savedAddress = await dbAddressInput.inputValue();

        // // Delete the database - need to add test IDs for these elements
        // await pageAlice.getByTestId('delete-db-button').click();
        // await pageAlice.getByTestId('confirm-delete-button').click();

        // ... rest of the test ...
    });


    test.afterAll(async () => {
        // await pageAlice.close();
        // await pageBob.close();
        // await contextAlice.close();  // Close Alice's context
        // await contextBob.close();    // Close Bob's context
        
 
    });
}); 
