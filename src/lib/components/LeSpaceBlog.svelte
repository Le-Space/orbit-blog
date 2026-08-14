<!-- @migration-task Error while migrating Svelte code: Cannot subscribe to stores that are not declared at the top level of the component
https://svelte.dev/e/store_invalid_scoped_subscription -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';

  import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';

  import Sidebar from './Sidebar.svelte';
  import PostList from './PostList.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import PasswordModal from './PasswordModal.svelte';
  import LoadingBlog from './LoadingBlog.svelte';
  import LanguageSelector from './LanguageSelector.svelte';

  import FaBars from 'svelte-icons/fa/FaBars.svelte';
  import FaTimes from 'svelte-icons/fa/FaTimes.svelte';
  import { getLocaleVersionString } from '$lib/utils/buildInfo.js';
  import { derived, get } from 'svelte/store';
  import { locale } from 'svelte-i18n';

  import { encryptSeedPhrase } from '$lib/cryptoUtils.js';
  import { initHashRouter, isLoadingRemoteBlog } from '$lib/router.js';
  import { setupPeerEventListeners } from '$lib/peerConnections.js';
  import { getImageUrlFromHelia } from '$lib/utils/mediaUtils.js';
  import type { UnixFS } from '@helia/unixfs';
  import { 
    initialAddress,
    loadingState,
    postsDB, 
    postsDBAddress, 
    posts, 
    selectedPostId,
    remoteDBs, 
    remoteDBsDatabases, 
    showDBManager, 
    showPeers, 
    showSettings, 
    profilePictureCid,
    profileImageUrl,
    blogName, 
    libp2p, 
    helia, 
    orbitdb, 
    identity, 
    identities, 
    settingsDB, 
    blogDescription, 
    categories, 
    seedPhrase, 
    commentsDB,
    commentsDBAddress,
    mediaDB,
    mediaDBAddress,
    aiDB,
    aiDBAddress,
    identitySeed32,
    isRTL
  } from '$lib/store';

  import { currentTheme, loadThemeState, persistThemeState, themeState, applyTheme } from '$lib/themes/themeStore.js';
  import { info, debug, warn, error } from '../utils/logger.js'
  import { startAiCapabilitiesPubsub } from '$lib/ai/aiCapabilitiesPubsub.js';
  import { startRelayDatabasePolling } from '$lib/services/relayPinStatus.js';

  let blockstore: any;
  let datastore: any;
  let createAccessController: typeof import('@orbitdb/core').IPFSAccessController | null = null;

  let encryptedSeedPhrase = localStorage.getItem('encryptedSeedPhrase');

  let showPasswordModal = $state(encryptedSeedPhrase ? true : false);
  let isNewUser = !encryptedSeedPhrase;
  let canWrite = $state(false);
  let ownerIdentityId = $state<string | null>(null);
  let DBManagerComponent = $state<any>(null);
  let ConnectedPeersComponent = $state<any>(null);
  let SettingsComponent = $state<any>(null);
  let PostFormComponent = $state<any>(null);

  // Add sidebar state variables
  let sidebarVisible = $state(true);
  let touchStartX = 0;
  let touchEndX = 0;
  const SWIPE_THRESHOLD = 50; 

  let routerUnsubscribe;
  /** Story 6.1 — tear down AI capability pubsub on re-init / destroy (avoids duplicate HMR listeners). */
  let disposeAiCapabilitiesPubsub: (() => void) | undefined;
  let showNotification = false;

  let settingsDBUpdateHandler;
  // Track event listeners to prevent memory leaks
  let settingsDBUpdateListener = null;
  let postsDBUpdateListener = null;
  let settingsDBErrorListener = null;
  let postsDBErrorListener = null;
  let commentsDBErrorListener = null;
  let mediaDBErrorListener = null;
  let aiDBErrorListener = null;
  let remoteDBsErrorListener = null;

  const sidebarPosition = $derived($isRTL ? 'right' : 'left');
  const sidebarButtonPosition = $derived($isRTL ? 'right' : 'left');
  const sidebarTriggerPosition = $derived($isRTL ? 'right' : 'left');

  // Create a reactive version string that updates when locale changes
  const reactiveVersionString = derived(locale, ($locale) => {
    return getLocaleVersionString();
  });

  let fs = $state<UnixFS | null>(null);

  function closeSidebarPanel(section: 'dbManager' | 'peers' | 'settings') {
    if (section === 'dbManager') {
      showDBManager.set(false);
    } else if (section === 'peers') {
      showPeers.set(false);
    } else {
      showSettings.set(false);
    }
  }

  async function loadDBManagerComponent() {
    DBManagerComponent ??= (await import('./DBManager.svelte')).default;
  }

  async function loadConnectedPeersComponent() {
    ConnectedPeersComponent ??= (await import('./ConnectedPeers.svelte')).default;
  }

  async function loadSettingsComponent() {
    SettingsComponent ??= (await import('./Settings.svelte')).default;
  }

  async function loadPostFormComponent() {
    PostFormComponent ??= (await import('./PostForm.svelte')).default;
  }

  $effect(() => {
    if ($showDBManager) void loadDBManagerComponent();
  });

  $effect(() => {
    if ($showPeers) void loadConnectedPeersComponent();
  });

  $effect(() => {
    if ($showSettings) void loadSettingsComponent();
  });

  $effect(() => {
    if (canWrite) void loadPostFormComponent();
  });

  async function generateNewSeedPhrase() {
    const { generateMnemonic } = await import('bip39');
    return generateMnemonic();
  }

  async function ensureUnixFs() {
    if (!$helia || fs) return;
    const { unixfs } = await import('@helia/unixfs');
    fs = unixfs($helia as any);
    info('LeSpaceBlog - UnixFS initialized');
  }

  if(!encryptedSeedPhrase) {
      info('no seed phrase, generating new one')
      generateNewSeedPhrase().then((newSeedPhrase) => {
        $seedPhrase = newSeedPhrase;
        initializeApp();
      });
  }

  function toggleSidebar() {
    sidebarVisible = !sidebarVisible;
  }

  async function handleSeedPhraseCreated(event: CustomEvent) {
    const newSeedPhrase = await generateNewSeedPhrase();
    const encryptedPhrase = await encryptSeedPhrase(newSeedPhrase, event.detail.password);
    localStorage.setItem('encryptedSeedPhrase', encryptedPhrase);
    $seedPhrase = newSeedPhrase;
    showPasswordModal = false; 
    initializeApp();
  }

  async function handleSeedPhraseDecrypted(event: CustomEvent) {
    $seedPhrase = event.detail.seedPhrase;
    showPasswordModal = false; 
    initializeApp();
  }

	  async function initializeApp() {
	    if (!$seedPhrase) return;
	    
	    info('initializeApp')

      const [
        { createHeliaWithLibp2p },
        { createLibp2p },
        { createOrbitDB, IPFSAccessController },
        { LevelDatastore },
        { LevelBlockstore },
        { generateKeyPairFromSeed, privateKeyFromProtobuf, privateKeyToProtobuf },
        { connectBootstrapPeers, createResolvedLibp2pOptions },
        { default: createIdentityProvider },
        { unixfs },
        { mnemonicToSeedSync },
      ] = await Promise.all([
        import('$lib/helia.js'),
        import('libp2p'),
        import('@orbitdb/core'),
        import('datastore-level'),
        import('blockstore-level'),
        import('@libp2p/crypto/keys'),
        import('$lib/config.js'),
        import('$lib/identityProvider.js'),
        import('@helia/unixfs'),
        import('bip39'),
      ]);

      createAccessController = IPFSAccessController;
      blockstore ??= new LevelBlockstore('./helia-blocks');
      datastore ??= new LevelDatastore('./helia-data');
	    
	    const masterSeed = mnemonicToSeedSync($seedPhrase, "password");
      const keyPair = await generateKeyPairFromSeed('Ed25519', masterSeed.subarray(0, 32));
	    const hex = Buffer.from(privateKeyToProtobuf(keyPair)).toString('hex');
	    const privKeyBuffer = uint8ArrayFromString(hex, 'hex');
	    const _keyPair = await privateKeyFromProtobuf(privKeyBuffer);
	    const resolvedLibp2pOptions = await createResolvedLibp2pOptions()
	    // Let Helia start libp2p after the Helia 7 mixins have been composed.
	    // Starting it here lets bootstrap peers connect before Bitswap is ready,
	    // which can race the relay's first OrbitDB manifest/identity fetches.
	    const _libp2p = await createLibp2p({
	      privateKey: _keyPair,
	      ...resolvedLibp2pOptions,
	      start: false,
	    })
	    $libp2p = _libp2p
	    ;(window as any).libp2p=_libp2p
    // for (const multiaddr of multiaddrs) { 
    //   try {
    //     info('dialing', multiaddr)
    //     const connection = await $libp2p.dial(multiaddr)
    //     info('connection', connection)
    //   } catch (err) {
    //     warn('error dialing', err)
    //   }
    // }
	    $helia = await createHeliaWithLibp2p($libp2p, { datastore, blockstore }).start() as any
	    await connectBootstrapPeers($libp2p)
	    //     const { valid, invalid, dialable, undialable } = await validateMultiaddrs(multiaddrs, $libp2p)
	    // info('valid', valid)
	    // info('invalid', invalid)
	    // info('dialable', dialable)
	    // info('undialable', undialable)
	    // Deterministic OrbitDB identity from the seed phrase.
	    // This is critical for headless agents: with the same seed phrase they can recreate the same writer identity.
	    // Use native Web Crypto here. The Node `crypto` browser polyfill can
	    // coerce the Uint8Array seed incorrectly and produce the same digest in
	    // isolated browser contexts, which would give different users the same
	    // OrbitDB writer identity.
	    const identitySeedInput = new Uint8Array(masterSeed.length)
	    identitySeedInput.set(masterSeed)
	    const identitySeed = new Uint8Array(
	      await globalThis.crypto.subtle.digest('SHA-256', identitySeedInput),
	    )
	    identitySeed32.set(identitySeed)
	    const idProvider = await createIdentityProvider('ed25519', identitySeed, $helia)
	    $identities = idProvider.identities
	    $identity = idProvider.identity
	    
	    $orbitdb = await createOrbitDB({
	      ipfs: $helia,
	      identity: $identity,
	      identities: $identities,
	      storage: blockstore,
	      directory: './orbitdb',
	    })
    setupPeerEventListeners($libp2p);

    disposeAiCapabilitiesPubsub?.();
    disposeAiCapabilitiesPubsub = startAiCapabilitiesPubsub(_libp2p);

    if ($helia) {
      fs = unixfs($helia as any);
      info('UnixFS initialized');
    }

    // Always create local databases first so they cannot overwrite a remote switch later.
    await createDefaultDatabases();

    // Initialize hash router after local DB setup to avoid duplicate/racy remote switches.
    routerUnsubscribe = await initHashRouter();
  }

  // Move the default database creation to a separate function
  async function createDefaultDatabases() {
    // IMPORTANT: This must await all opens. Otherwise, the `.then(...)` handlers can
    // run *after* `switchToRemoteDB()` and overwrite the global stores back to local DBs.
    if (!createAccessController) {
      const { IPFSAccessController } = await import('@orbitdb/core');
      createAccessController = IPFSAccessController;
    }

    try {
      const _db = await $orbitdb.open('settings', {
        type: 'documents',
        create: true,
        overwrite: false,
        directory: './orbitdb/settings',
        identity: $identity,
        identities: $identities,
        AccessController: createAccessController({ write: [$identity.id] }),
      })
      $settingsDB = _db
      ;(window as any).settingsDB = _db

      // Persist the blog owner identity so remote viewers can reliably detect ownership.
      ownerIdentityId = $identity.id
      try {
        const entry = await _db.get('ownerIdentity')
        const existing = entry?.value?.value
        if (!existing) await _db.put({ _id: 'ownerIdentity', value: $identity.id })
      } catch {
        // best-effort only
      }
    } catch (err) {
      warn('Error opening settings DB:', err)
    }

    try {
      const _db = await $orbitdb.open('posts', {
        type: 'documents',
        create: true,
        overwrite: false,
        directory: './orbitdb/posts',
        identity: $identity,
        identities: $identities,
        AccessController: createAccessController({ write: [$identity.id] }),
      })
      $postsDB = _db
      ;(window as any).postsDB = _db
      info('postsDB', _db.address.toString())
      $postsDBAddress = _db.address.toString()
    } catch (err) {
      warn('Error opening posts DB:', err)
    }

    try {
      const _db = await $orbitdb.open('remote-dbs', {
        type: 'documents',
        create: true,
        overwrite: false,
        identities: $identities,
        identity: $identity,
        AccessController: createAccessController({ write: [$identity.id] }),
      })
      $remoteDBsDatabases = _db
      ;(window as any).remoteDBsDatabases = _db
    } catch (err) {
      warn('Error opening remote DBs database:', err)
    }

    try {
      const _db = await $orbitdb.open('comments', {
        type: 'documents',
        create: true,
        overwrite: false,
        directory: './orbitdb/comments',
        identity: $identity,
        identities: $identities,
        AccessController: createAccessController({ write: ['*'] }),
      })
      $commentsDB = _db
      $commentsDBAddress = _db.address.toString()
      ;(window as any).commentsDB = _db
    } catch (err) {
      warn('Error opening comments DB:', err)
    }

    try {
      const _db = await $orbitdb.open('media', {
        type: 'documents',
        create: true,
        overwrite: false,
        directory: './orbitdb/media',
        identity: $identity,
        identities: $identities,
        AccessController: createAccessController({ write: [$identity.id] }),
      })
      $mediaDB = _db
      $mediaDBAddress = _db.address.toString()
      ;(window as any).mediaDB = _db
    } catch (err) {
      warn('Error opening media DB:', err)
    }

    try {
      const _db = await $orbitdb.open('ai', {
        type: 'documents',
        create: true,
        overwrite: false,
        directory: './orbitdb/ai',
        identity: $identity,
        identities: $identities,
        AccessController: createAccessController({ write: [$identity.id] }),
      })
      $aiDB = _db
      $aiDBAddress = _db.address.toString()
      ;(window as any).aiDB = _db
    } catch (err) {
      warn('Error opening AI DB:', err)
    }
  }

  $effect(() => {
    if($initialAddress) {
      info('initialAddress', $initialAddress);
      sidebarVisible = false;
    }
  });
  
  /**
   * Check if the user has write access to the posts database
  */
  $effect(() => {
    if ($orbitdb && $postsDB && $identity) {
      const postsAddr = $postsDB.address?.toString?.() || String($postsDB.address || '');
      canWrite = Boolean(ownerIdentityId && ownerIdentityId === $identity.id) && (postsAddr === $postsDBAddress)
    }
  });

  onDestroy(async () => {
    disposeAiCapabilitiesPubsub?.();
    disposeAiCapabilitiesPubsub = undefined;
    if (routerUnsubscribe) routerUnsubscribe();
    
    // Clean up all event listeners
    if (settingsDBUpdateHandler) {
      $settingsDB?.events.removeListener('update', settingsDBUpdateHandler);
    }
    if (settingsDBUpdateListener) {
      $settingsDB?.events.removeListener('update', settingsDBUpdateListener);
    }
    if (postsDBUpdateListener) {
      $postsDB?.events.removeListener('update', postsDBUpdateListener);
    }
    if (settingsDBErrorListener) {
      $settingsDB?.events.removeListener('error', settingsDBErrorListener);
    }
    if (postsDBErrorListener) {
      $postsDB?.events.removeListener('error', postsDBErrorListener);
    }
    if (commentsDBErrorListener) {
      $commentsDB?.events.removeListener('error', commentsDBErrorListener);
    }
    if (mediaDBErrorListener) {
      $mediaDB?.events.removeListener('error', mediaDBErrorListener);
    }
    if (aiDBErrorListener) {
      $aiDB?.events.removeListener('error', aiDBErrorListener);
    }
    if (remoteDBsErrorListener) {
      $remoteDBsDatabases?.events.removeListener('error', remoteDBsErrorListener);
    }
    
    try {
      await $settingsDB?.close();
      await $commentsDB?.close();
      await $postsDB?.close();
      await $mediaDB?.close();
      await $aiDB?.close();
    } catch (_error) {
      error('Error closing OrbitDB connections:', _error);
    }
  })

  // Databases are now only opened in createDefaultDatabases() or switchToRemoteDB()
  // This prevents duplicate protocol handler registration

  // Track the last settingsDB address to prevent duplicate loading
  let lastSettingsDBAddress = '';
  let lastOwnerIdentitySettingsAddr = '';
  // Persist sub-DB addresses into settings only once per (settingsAddr, subDbAddr) pair.
  let lastPersistedSettingsAddr = '';
  let lastPersistedPostsAddr = '';
  let lastPersistedCommentsAddr = '';
  let lastPersistedMediaAddr = '';
  let lastPersistedAiAddr = '';
  let lastPersistedThemeState = '';
  const settingsValueCache = new Map<string, string>();

  function serializeSettingValue(value: unknown): string {
    try {
      return JSON.stringify(value) ?? 'null';
    } catch {
      return String(value);
    }
  }

  async function persistSettingsValue(key: string, value: unknown, context: string) {
    if (!$settingsDB) return;

    const nextSerialized = serializeSettingValue(value);
    const cachedSerialized = settingsValueCache.get(key);
    if (cachedSerialized === nextSerialized) return;

    try {
      await $settingsDB.put({ _id: key, value });
      settingsValueCache.set(key, nextSerialized);
    } catch (err) {
      warn(`Failed to persist ${key} during ${context}:`, err);
    }
  }

  function attachDatabaseErrorListener(db: any, label: string, currentListener: any) {
    if (currentListener && db?.events?.removeListener) {
      db.events.removeListener('error', currentListener);
    }

    if (!db?.events?.on) return null;

    const listener = (err: unknown) => {
      warn(`${label} OrbitDB sync error:`, err);
    };

    db.events.on('error', listener);
    return listener;
  }

  // Load ownerIdentity from the current settings DB (local or remote).
  $effect(() => {
    if (!$settingsDB || !$identity) return;
    const settingsAddr = $settingsDB.address?.toString?.() || '';
    if (!settingsAddr || settingsAddr === lastOwnerIdentitySettingsAddr) return;
    lastOwnerIdentitySettingsAddr = settingsAddr;

    const loadOwner = async (retries = 10) => {
      try {
        const entry = await $settingsDB.get('ownerIdentity');
        const value = entry?.value?.value;
        if (value) {
          ownerIdentityId = value;
          return;
        }

        // If we're the settings writer (local blog), treat us as owner even if the entry isn't persisted yet.
        if ($settingsDB.access?.write?.includes($identity.id)) {
          ownerIdentityId = $identity.id;
        }

        if (retries > 0) {
          setTimeout(() => loadOwner(retries - 1), 300);
        }
      } catch {
        if (retries > 0) setTimeout(() => loadOwner(retries - 1), 300);
      }
    };

    loadOwner();
  });
  
  $effect(() => {
    if($settingsDB && $settingsDB.address.toString() !== lastSettingsDBAddress) {
    // Update the tracking variable
    lastSettingsDBAddress = $settingsDB.address.toString();
    info('Loading settings from new database:', lastSettingsDBAddress);
    
    // Initial load of settings - use .all() to get all documents first to avoid CID parsing errors on empty DBs
    $settingsDB.all().then(async allSettings => {
      info('All settings from database:', allSettings);

      const canWriteSettings = $settingsDB?.access?.write?.includes?.($identity?.id);
      
      // Process each setting
      for (const entry of allSettings) {
        const setting = entry.value;
        settingsValueCache.set(setting._id, serializeSettingValue(setting.value));
        switch(setting._id) {
          case 'blogName':
            if (setting.value !== undefined) blogName.set(setting.value);
            break;
          case 'blogDescription':
            if (setting.value !== undefined) blogDescription.set(setting.value);
            break;
          case 'categories':
            if (setting.value !== undefined) categories.set(setting.value);
            break;
          case 'postsDBAddress':
            if (setting.value !== undefined) postsDBAddress.set(setting.value);
            break;
          case 'commentsDBAddress':
            if (setting.value !== undefined) commentsDBAddress.set(setting.value);
            break;
          case 'mediaDBAddress':
            if (setting.value !== undefined) mediaDBAddress.set(setting.value);
            break;
          case 'aiDBAddress':
            if (setting.value !== undefined) aiDBAddress.set(setting.value);
            break;
          case 'profilePicture':
            if (setting.value !== undefined) {
              profilePictureCid.set(setting.value);
              info('Set profile picture CID from settings:', setting.value);
            }
            break;
          case 'themeState':
            if (setting.value !== undefined) {
              const loadedThemeState = await loadThemeState($settingsDB);
              themeState.set(loadedThemeState);
              persistThemeState($settingsDB).catch((err) => {
                warn('Failed to persist themeState after load:', err);
              });
            }
            break;
        }
      }
      
      const activeTheme = get(currentTheme);
      applyTheme(activeTheme);
      
      // If no postsDBAddress found but we have a postsDB, save it (only if we can write settings).
      if (canWriteSettings && !$postsDBAddress && $postsDB?.address) {
        const postsDBAddressValue = $postsDB.address.toString();
        await persistSettingsValue('postsDBAddress', postsDBAddressValue, 'initial settings load');
        postsDBAddress.set(postsDBAddressValue);
      }
      
      // If no commentsDBAddress found but we have a commentsDB, save it (only if we can write settings).
      if (canWriteSettings && !$commentsDBAddress && $commentsDB?.address) {
        const commentsDBAddressValue = $commentsDB.address.toString();
        await persistSettingsValue('commentsDBAddress', commentsDBAddressValue, 'initial settings load');
        commentsDBAddress.set(commentsDBAddressValue);
      }
      
      // If no mediaDBAddress found but we have a mediaDB, save it (only if we can write settings).
      if (canWriteSettings && $mediaDB?.address) {
        const mediaDBAddressValue = $mediaDB.address.toString();
        await persistSettingsValue('mediaDBAddress', mediaDBAddressValue, 'initial settings load');
        mediaDBAddress.set(mediaDBAddressValue);
      }

      if (canWriteSettings && $aiDB?.address) {
        const addr = $aiDB.address.toString();
        await persistSettingsValue('aiDBAddress', addr, 'initial settings load');
        aiDBAddress.set(addr);
      }
    }).catch(err => {
      warn('Error loading settings from database:', err);
      // If database is completely empty or has issues, we can still continue
      // The settings will be created as needed when the user makes changes
    });

    // Clean up existing settingsDB event listener
    if (settingsDBUpdateListener) {
      $settingsDB?.events.removeListener('update', settingsDBUpdateListener);
    }
    
    // Create new event listener
    settingsDBUpdateListener = async (entry) => {
      info('Settings database update:', entry);
      if (entry?.payload?.op === 'PUT') {
        const { _id, ...rest } = entry.payload.value;
        info('settingsDB update:', rest);
        settingsValueCache.set(_id, serializeSettingValue(rest.value));
        
        // Update the appropriate store based on the _id
        switch(_id) {
          case 'blogName':
            $blogName = rest.value;
            break;
          case 'blogDescription':
            $blogDescription = rest.value;
            break;
          case 'categories':
            $categories = rest.value;
            break;
          case 'postsDBAddress':
            if (rest.value !== undefined) $postsDBAddress = rest.value;
            break;
          case 'commentsDBAddress':
            if (rest.value !== undefined) $commentsDBAddress = rest.value;
            break;
          case 'mediaDBAddress':
            if (rest.value !== undefined) $mediaDBAddress = rest.value;
            break;
          case 'aiDBAddress':
            if (rest.value !== undefined) $aiDBAddress = rest.value;
            break;
          case 'profilePicture':
            $profilePictureCid = rest.value;
            break;
          case 'themeState':
            if (rest.value) {
              loadThemeState($settingsDB).then((loadedThemeState) => {
                themeState.set(loadedThemeState);
              }).catch((err) => {
                warn('Failed to load themeState from update event:', err);
              });
            }
            break;
          // ... handle other settings ...
        }
      } else if (entry?.payload?.op === 'DEL') {
        info('settingsDB delete:', entry.payload.key);
        // Handle deletions if needed
      }
    };
    
    // Add the new event listener
    $settingsDB?.events.on('update', settingsDBUpdateListener);
    }
  });

  // Ensure settings DB contains pointers to the sub-databases. Without these,
  // other peers cannot discover which posts/comments/media DB to open.
  $effect(() => {
    if (!$settingsDB || !$identity) return;

    const canWriteSettings = $settingsDB?.access?.write?.includes($identity.id);
    if (!canWriteSettings) return;

    const settingsAddr = $settingsDB.address?.toString?.() || '';

    const postsAddr = $postsDB?.address?.toString?.() || '';
    if (postsAddr && (settingsAddr !== lastPersistedSettingsAddr || postsAddr !== lastPersistedPostsAddr)) {
      lastPersistedSettingsAddr = settingsAddr;
      lastPersistedPostsAddr = postsAddr;
      void persistSettingsValue('postsDBAddress', postsAddr, 'reactive posts address sync');
    }

    const commentsAddr = $commentsDB?.address?.toString?.() || '';
    if (commentsAddr && (settingsAddr !== lastPersistedSettingsAddr || commentsAddr !== lastPersistedCommentsAddr)) {
      lastPersistedSettingsAddr = settingsAddr;
      lastPersistedCommentsAddr = commentsAddr;
      void persistSettingsValue('commentsDBAddress', commentsAddr, 'reactive comments address sync');
    }

    const currentThemeState = get(themeState);
    const themeStateSerialized = currentThemeState ? serializeSettingValue(currentThemeState) : '';
    if (currentThemeState && settingsAddr && themeStateSerialized !== lastPersistedThemeState) {
      lastPersistedThemeState = themeStateSerialized;
      void persistSettingsValue('themeState', currentThemeState, 'reactive theme state sync');
    }

    const mediaAddr = $mediaDB?.address?.toString?.() || '';
    if (mediaAddr && (settingsAddr !== lastPersistedSettingsAddr || mediaAddr !== lastPersistedMediaAddr)) {
      lastPersistedSettingsAddr = settingsAddr;
      lastPersistedMediaAddr = mediaAddr;
      void persistSettingsValue('mediaDBAddress', mediaAddr, 'reactive media address sync');
    }

    const aiAddr = $aiDB?.address?.toString?.() || '';
    if (aiAddr && (settingsAddr !== lastPersistedSettingsAddr || aiAddr !== lastPersistedAiAddr)) {
      lastPersistedSettingsAddr = settingsAddr;
      lastPersistedAiAddr = aiAddr;
      void persistSettingsValue('aiDBAddress', aiAddr, 'reactive ai address sync');
    }
  });

  // Add logging for profilePictureCid changes
  $effect(() => {
    if ($profilePictureCid) {
      info('Profile picture CID changed:', $profilePictureCid);
    }
  });

  $effect(() => {
    if($postsDB){
    $postsDB.all().then(_posts => {
      // info('posts--', _posts);
      $posts = _posts.map(entry => ({
        ...entry.value,
        identity: entry.value.identity || entry.identity?.id // Use saved identity or fallback to entry identity ID
      }));
    }).catch(err => warn('Error opening posts database:', err));

    // Clean up existing postsDB event listener
    if (postsDBUpdateListener) {
      $postsDB?.events.removeListener('update', postsDBUpdateListener);
    }
    
    // Create new event listener
    postsDBUpdateListener = async (entry) => {
      info('Posts database update:', entry);
      try {
        // Re-read the full documents set to reliably reflect both local writes
        // and replicated remote writes.
        const allPosts = await $postsDB.all();
        $posts = allPosts.map(doc => ({
          ...doc.value,
          identity: doc.value.identity || doc.identity?.id
        }));
      } catch (err) {
        warn('Error refreshing posts after update event:', err);
      }
    };
    
    // Add the new event listener
    $postsDB.events.on('update', postsDBUpdateListener);
    }
  });

  // OrbitDB pubsub update notifications are best-effort. When a remote relay
  // reports a newer posts DB sync but this viewer missed the notification,
  // re-subscribing triggers OrbitDB's head exchange and repairs the local view.
  $effect(() => {
    const activePostsDB = $postsDB as any;
    const activeIdentityId = $identity?.id;
    const address = activePostsDB?.address?.toString?.() || '';
    const writers = activePostsDB?.access?.write || [];

    if (!activePostsDB || !activeIdentityId || !address) return;
    if (writers.includes(activeIdentityId) || writers.includes('*')) return;

    const abortController = new AbortController();
    let lastRelaySync: string | null = null;
    let resyncing = false;

    const stopPolling = startRelayDatabasePolling({
      dbAddress: address,
      signal: abortController.signal,
      pollDebugLabel: 'remote-posts-resync',
      onUpdate: ({ lastSyncedAt }) => {
        if (!lastSyncedAt) return;
        if (lastRelaySync === null) {
          lastRelaySync = lastSyncedAt;
          return;
        }
        if (lastRelaySync === lastSyncedAt || resyncing) return;

        lastRelaySync = lastSyncedAt;
        resyncing = true;
        void (async () => {
          try {
            info('Relay posts database advanced; refreshing OrbitDB heads:', address, lastSyncedAt);
            await activePostsDB.sync?.stop?.();
            if (!abortController.signal.aborted) {
              await activePostsDB.sync?.start?.();
            }
          } catch (err) {
            warn('Failed to refresh remote posts OrbitDB heads:', err);
          } finally {
            resyncing = false;
          }
        })();
      },
    });

    return () => {
      abortController.abort();
      stopPolling();
    };
  });

  $effect(() => {
    settingsDBErrorListener = attachDatabaseErrorListener($settingsDB, 'settingsDB', settingsDBErrorListener);
  });

  $effect(() => {
    postsDBErrorListener = attachDatabaseErrorListener($postsDB, 'postsDB', postsDBErrorListener);
  });

  $effect(() => {
    commentsDBErrorListener = attachDatabaseErrorListener($commentsDB, 'commentsDB', commentsDBErrorListener);
  });

  $effect(() => {
    mediaDBErrorListener = attachDatabaseErrorListener($mediaDB, 'mediaDB', mediaDBErrorListener);
  });

  $effect(() => {
    aiDBErrorListener = attachDatabaseErrorListener($aiDB, 'aiDB', aiDBErrorListener);
  });

  $effect(() => {
    remoteDBsErrorListener = attachDatabaseErrorListener($remoteDBsDatabases, 'remoteDBsDatabases', remoteDBsErrorListener);
  });

  $effect(() => {
    if($remoteDBsDatabases){
    info('Remote DBs database opened successfully:', $remoteDBsDatabases);
    
    const loadRemoteDBs = async () => {
      info('Starting to load remote DBs...');
      const savedDBs = await $remoteDBsDatabases.all();
      info("all of remoteDBsDatabases", savedDBs, new Date().toISOString());
      const _remoteDBs = savedDBs.map(entry => entry.value);
      info('Remote DBs list:', _remoteDBs);
      
      // Process each database
      _remoteDBs.forEach(async db => {
        // Load each database independently
      //   if (db.postsAddress) {
      //     console.log('loading postsDB', db.postsAddress)
      //     $orbitdb.open(db.postsAddress)
      //       .then(async postsDB => {
      //         console.log('postsDB loaded', postsDB)
      //         db.access = postsDB.access;
      //         const posts = await postsDB.all();
      //         db.postsCount = posts.length;
      //       })
      //       .catch(error => {
      //         console.info(`Posts database not available for ${db.name}:`, error);
      //         db.postsCount = 0;
      //       });

      //   if (db.commentsAddress) {
      //     console.log('loading commentsDB', db.commentsAddress)
      //     $orbitdb.open(db.commentsAddress)
      //       .then(async commentsDB => {
      //         console.log('commentsDB loaded', commentsDB)
      //         const comments = await commentsDB.all();
      //         db.commentsCount = comments.length;
      //       })
      //       .catch(error => {
      //         console.info(`Comments database not available for ${db.name}:`, error);
      //         db.commentsCount = 0;
      //       });
      //   }

      //   if (db.mediaAddress) {
      //     console.log('loading mediaDB', db.mediaAddress)
      //     $orbitdb.open(db.mediaAddress)
      //       .then(async mediaDB => {
      //         console.log('mediaDB loaded', mediaDB)
      //         const media = await mediaDB.all();
      //         db.mediaCount = media.length;
      //       })
      //       .catch(error => {
      //         console.info(`Media database not available for ${db.name}:`, error);
      //         db.mediaCount = 0;
      //       });
      //   }
      });

      $remoteDBs = _remoteDBs;
    };
    
    loadRemoteDBs() //.catch(err => console.error('Error loading remote DBs:', err));
    }
  });

  function handleTouchStart(e) {
    if (showPasswordModal) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    touchStartX = clientX;
  }

  function handleTouchMove(e) {
    if (showPasswordModal) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    touchEndX = clientX;
  }

  function handleTouchEnd(e) {
    if (showPasswordModal) return;
    const deltaX = touchStartX - touchEndX;
    const swipeDistance = Math.abs(deltaX);
    
    if (swipeDistance > SWIPE_THRESHOLD) {
      if (deltaX > 0 && sidebarVisible) {
        // Swipe left - hide sidebar
        sidebarVisible = false;
        e?.preventDefault?.();
      } else if (deltaX < 0 && !sidebarVisible) {
        // Swipe right - show sidebar
        sidebarVisible = true;
        e?.preventDefault?.();
      }
    }
    
    // Reset values
    touchStartX = 0;
    touchEndX = 0;
  }

  // The trigger strip is 24px wide and spans the full height of the window edge,
  // and it used to open the sidebar the instant a pointer touched it. Moving the
  // mouse towards the back button, across a scrollbar, or simply across the
  // window was enough to drop a full-screen backdrop over the content — no click,
  // no intent. Require the pointer to rest on the strip briefly instead, and
  // cancel as soon as it leaves. Click, touch and keyboard focus stay immediate,
  // because those are already deliberate.
  const SIDEBAR_HOVER_INTENT_MS = 300;
  let sidebarHoverTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelSidebarHoverIntent() {
    if (sidebarHoverTimer !== null) {
      clearTimeout(sidebarHoverTimer);
      sidebarHoverTimer = null;
    }
  }

  function handleMouseEnter() {
    if (sidebarVisible || sidebarHoverTimer !== null) return;
    sidebarHoverTimer = setTimeout(() => {
      sidebarHoverTimer = null;
      sidebarVisible = true;
    }, SIDEBAR_HOVER_INTENT_MS);
  }

  function openSidebarNow() {
    cancelSidebarHoverIntent();
    sidebarVisible = true;
  }

  function closeSidebarNow() {
    cancelSidebarHoverIntent();
    sidebarVisible = false;
  }

  // Function to copy the settingsDB address to clipboard
  async function copySettingsDBAddress() {
    if ($settingsDB) {
      try {
        const address = $settingsDB.address.toString();
        await navigator.clipboard.writeText(address);
        showNotification = true;
        setTimeout(() => showNotification = false, 3000); // Hide notification after 3 seconds
      } catch (err) {
        error('Failed to copy address: ', err);
      }
    } else {
      alert('Settings database is not available.');
    }
  }

  $effect(() => {
    if ($helia && !fs) void ensureUnixFs();
  });
</script>
<svelte:head>
  <title>{$blogName} {__APP_VERSION__}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes" />
  <meta name="description" content="{$blogDescription}">
  <!-- <meta name="author" content="{$blogName}"> -->
  <meta name="keywords" content="{Array.isArray($categories) ? $categories.join(', ') : $categories}">
  <meta name="author" content="{$blogName}">
  <meta name="robots" content="index, follow">
  <meta name="googlebot" content="index, follow">
  <meta name="bingbot" content="index, follow">
  <meta name="alexa" content="index, follow">
  <meta name="yandex" content="index, follow">
  <meta name="sitemap" content="index, follow">
  <!--no cache-->
  <meta name="cache-control" content="no-cache, no-store, must-revalidate">
  <meta name="pragma" content="no-cache">
  <meta name="expires" content="0">
  <!-- <meta name="cache-busting" content="{$cacheBusting}"> -->
  <meta name="theme-color" content="#000000">
  <meta name="msapplication-navbutton-color" content="#000000">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="application-name" content="{$blogName}">
  <meta name="apple-mobile-web-app-title" content="{$blogName}">
  <meta name="msapplication-TileColor" content="#000000">
  <meta name="msapplication-TileImage" content="{$blogName}">
  <meta name="msapplication-config" content="{$blogName}">
  <meta name="msapplication-starturl" content="{$blogName}">
  <meta name="msapplication-navbutton-color" content="#000000">
  <meta name="msapplication-TileColor" content="#000000">
  <meta name="msapplication-TileImage" content="{$blogName}">
  <meta name="dir" content={$isRTL ? 'rtl' : 'ltr'}>
</svelte:head>

<!-- Capture swipe gestures globally instead of attaching listeners to a non-interactive element. -->
<svelte:window
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
  onmousedown={handleTouchStart}
  onmousemove={handleTouchMove}
  onmouseup={handleTouchEnd}
/>

{#if showPasswordModal}
  <PasswordModal 
    {isNewUser} 
    encryptedSeedPhrase={encryptedSeedPhrase}
    on:seedPhraseCreated={handleSeedPhraseCreated}
    on:seedPhraseDecrypted={handleSeedPhraseDecrypted}
  />
{:else}
  <div class="flex min-h-screen transition-colors" style="background-color: var(--bg); color: var(--text);" role="main">
    
    {#if sidebarVisible}
      <!-- Backdrop -->
      <div 
        class="fixed inset-0 z-30"
        style="background-color: rgba(0, 0, 0, 0.4); backdrop-filter: blur(2px);"
        role="button"
        tabindex="0"
        onclick={closeSidebarNow}
        ontouchend={(e) => {closeSidebarNow(); e.stopPropagation()}}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            closeSidebarNow();
          }
        }}
        onoutrostart={(e) => {
          // `transition:fade` only animates opacity, so the backdrop keeps
          // swallowing clicks for the whole fade-out. Anything the user clicks
          // in that window is lost.
          (e.currentTarget as HTMLElement).style.pointerEvents = 'none';
        }}
        transition:fade
        aria-label={$_('close_sidebar')}
      ></div>
      
      <div 
        in:fly={{ x: $isRTL ? 280 : -280, duration: 250, easing: cubicOut }} 
        out:fly={{ x: $isRTL ? 280 : -280, duration: 200, easing: cubicOut }}
        class="fixed top-0 {sidebarPosition}-0 h-full z-40 max-w-[85vw]"
      >
        <Sidebar />
      </div>
      
      <!-- Close button -->
      <button
        class="fixed top-3 z-50 btn-icon"
        style="{sidebarButtonPosition}: 0.75rem;"
        onclick={(e) => {e.stopPropagation(); sidebarVisible = false;}}
        ontouchstart={(e) => {e.stopPropagation();}}
        ontouchend={(e) => {e.stopPropagation(); e.preventDefault(); sidebarVisible = false;}}
        onmousedown={(e) => {e.stopPropagation();}}
        onmouseup={(e) => {e.stopPropagation(); sidebarVisible = false;}}
        aria-label={$_('close')}
        data-testid="close-sidebar-button">
        <div class="w-4 h-4" style="color: var(--text-secondary);">
          <FaTimes />
        </div>
      </button>
    {:else}
      <!-- Sidebar toggle button -->
      <button
        class="fixed top-4 z-50 btn-icon"
        style="{sidebarButtonPosition}: 1rem; background-color: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem; box-shadow: var(--shadow-sm);"
        onclick={() => sidebarVisible = true}
        ontouchend={(e) => {sidebarVisible = true; e.stopPropagation()}}
        aria-label={$_('show_editor')}
        data-testid="menu-button">
        <div class="w-4 h-4" style="color: var(--text-secondary);">
          <FaBars />
        </div>
      </button>
      
      <!-- Sidebar trigger area -->
      <div 
        class="w-6 h-full fixed top-0 z-10 cursor-pointer"
        style="{sidebarTriggerPosition}: 0;"
        role="button"
        tabindex="0"
        onclick={openSidebarNow}
        ontouchend={(e) => {openSidebarNow(); e.stopPropagation()}}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openSidebarNow();
          }
        }}
        onmouseenter={handleMouseEnter}
        onmouseleave={cancelSidebarHoverIntent}
        onfocus={openSidebarNow}
        onblur={cancelSidebarHoverIntent}
        aria-label={$_('show_sidebar')}>
      </div>
    {/if}
    
    <!-- Main Content -->
    <div class="flex-1 overflow-x-hidden">
      {#if $isLoadingRemoteBlog}
        <LoadingBlog loadingState={$loadingState} />
      {:else}
        <div class="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
          <!-- Masthead -->
          <header class="flex items-center gap-4 mb-10">
            <div class="w-12 h-12 rounded-full overflow-hidden flex-shrink-0" style="background-color: var(--bg-tertiary);">
              {#if $profilePictureCid}
                {#await getImageUrlFromHelia($profilePictureCid, fs)}
                  <div class="w-full h-full flex items-center justify-center"></div>
                {:then imageUrl}
                  {#if imageUrl}
                    <img 
                      src={imageUrl}
                      alt="Profile" 
                      class="w-full h-full object-cover"
                      onload={() => {
                        info('Image loaded successfully from Helia');
                      }}
                    />
                  {:else}
                    <div class="w-full h-full flex items-center justify-center">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" style="color: var(--text-muted);" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd" />
                      </svg>
                    </div>
                  {/if}
                {:catch error}
                  <div class="w-full h-full flex items-center justify-center" style="color: var(--danger);">
                    <span class="text-xs">Error</span>
                  </div>
                {/await}
              {:else}
                <div class="w-full h-full flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" style="color: var(--text-muted);" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd" />
                  </svg>
                </div>
              {/if}
            </div>
            <div>
              <h1 class="text-xl font-semibold leading-tight" style="color: var(--text);" data-testid="blog-name">
                {$blogName}
              </h1>
              <p class="text-sm leading-snug mt-0.5" style="color: var(--text-secondary);" data-testid="blog-description">
                {$blogDescription}
              </p>
              <p class="text-xs mt-0.5" style="color: var(--text-muted);">{$reactiveVersionString}</p>
            </div>
          </header>

          <div class="divider mb-8"></div>

          {#if $showDBManager}
            <div class="panel-shell">
              <button
                class="panel-close-button"
                type="button"
                onclick={() => closeSidebarPanel('dbManager')}
                aria-label={$_('hide_database_manager')}
                title={$_('hide_database_manager')}
                data-testid="close-db-manager-panel"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              {#if DBManagerComponent}
                <DBManagerComponent />
              {:else}
                <div class="p-4 text-sm" style="color: var(--text-secondary);">{$_('loading')}...</div>
              {/if}
            </div>
          {/if}
          
          {#if $showPeers}
            <div class="panel-shell">
              <button
                class="panel-close-button"
                type="button"
                onclick={() => closeSidebarPanel('peers')}
                aria-label={$_('hide_connected_peers')}
                title={$_('hide_connected_peers')}
                data-testid="close-peers-panel"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              {#if ConnectedPeersComponent}
                <ConnectedPeersComponent />
              {:else}
                <div class="p-4 text-sm" style="color: var(--text-secondary);">{$_('loading')}...</div>
              {/if}
            </div>
          {/if}

          {#if $showSettings}
            <div class="panel-shell">
              <button
                class="panel-close-button"
                type="button"
                onclick={() => closeSidebarPanel('settings')}
                aria-label={$_('hide_settings')}
                title={$_('hide_settings')}
                data-testid="close-settings-panel"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              {#if SettingsComponent}
                <SettingsComponent />
              {:else}
                <div class="p-4 text-sm" style="color: var(--text-secondary);">{$_('loading')}...</div>
              {/if}
            </div>
          {/if}
          
          <div class="grid gap-8">
            <PostList />
            {#if canWrite}
              {#if PostFormComponent}
                <PostFormComponent />
              {:else}
                <div class="card p-6 text-sm" style="color: var(--text-secondary);">{$_('loading')}...</div>
              {/if}
            {/if}
            <!-- e2e/debug hook: lets tests verify write gating without relying on UI text -->
            <span
              data-testid="can-write-debug"
              class="hidden"
              >{canWrite ? '1' : '0'}|{ownerIdentityId || ''}|{$identity?.id || ''}|{$settingsDB?.address?.toString?.() || ''}|{$postsDB?.address?.toString?.() || ''}|{$postsDBAddress || ''}</span
            >
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- Fixed controls toolbar -->
  <div class="fixed-controls">
    <a
      href="https://github.com/Le-Space/le-space-blog"
      target="_blank"
      rel="noopener noreferrer"
      class="control-button"
      aria-label={$_('view_source_on_github')}>
      <svg class="w-4 h-4" style="color: var(--text-secondary);" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
      </svg>
    </a>
    <LanguageSelector />
    <ThemeToggle />
  </div>
{/if}

<style>
  /* Scoped button overrides for this component */
  button {
    color: inherit;
    border: none;
    cursor: pointer;
  }

  button:hover {
    opacity: 0.9;
  }

  /* Sidebar padding for toggle button clearance */
  :global(.sidebar) {
    padding-top: 3rem;
  }

  /* Fixed button positioning */
  button.fixed {
    position: fixed !important;
    transform: translateZ(0);
  }

  /* Share button override */
  .share-button {
    left: auto !important;
    right: 20px !important;
  }

  .panel-shell {
    position: relative;
    margin-bottom: 1.5rem;
  }

  .panel-close-button {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    border: 1px solid var(--border) !important;
    border-radius: 9999px;
    background-color: color-mix(in srgb, var(--bg-primary) 86%, transparent);
    color: var(--text-muted);
    box-shadow: var(--shadow-sm);
    backdrop-filter: blur(4px);
  }

  .panel-close-button:hover {
    background-color: var(--bg-hover);
    color: var(--text);
    opacity: 1;
  }

  /* Fixed controls toolbar */
  :global(.fixed-controls) {
    position: fixed;
    top: 1rem;
    right: 1rem;
    display: flex;
    gap: 0.25rem;
    align-items: center;
    z-index: 50;
  }

  :global(.control-button) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem;
    background-color: transparent;
    border: none;
    border-radius: 6px;
    transition: background-color 0.15s ease;
    cursor: pointer;
  }

  :global(.control-button:hover) {
    background-color: var(--bg-hover);
  }

  @media (max-width: 768px) {
    :global(.fixed-controls) {
      gap: 0.125rem;
    }
  }
</style>
