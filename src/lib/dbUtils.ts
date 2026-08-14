import { get } from 'svelte/store';
import { helia, orbitdb, blogName, categories, blogDescription, postsDBAddress, profilePictureCid, postsDB, posts, settingsDB, remoteDBs, commentsDB, mediaDB, aiDB, remoteDBsDatabases, commentsDBAddress, mediaDBAddress, aiDBAddress, identity, identities, loadingState } from './store.js';
import type { RemoteDB } from './types.js';
import { IPFSAccessController } from '@orbitdb/core';
import { multiaddr } from '@multiformats/multiaddr';
import { multiaddrs as seedMultiaddrs } from './config.js';
import { getRelayMetricsOriginsForFetch } from './relay/relayEnv.js';
import { requestRelayDbPinSync } from './services/relayPinStatus.js';
import { createLogger } from './utils/logger.js'

const log = createLogger('db')

// For the Libp2p related functions, we need to use the correct API
// Here's how to fix the dial and getPeers errors:
const connectToPeer = async (heliaInstance: any, peerId: string) => {
    try {
        // Use the correct method for connecting to peers
        await heliaInstance.libp2p.connect(peerId);
    } catch (err) {
        log.error('Failed to connect to peer:', err);
    }
};

// Fix the database creation/handling
const createNewDB = (name: string): RemoteDB => {
    return {
        id: crypto.randomUUID(),
        postsAddress: '',
        commentsAddress: '',
        mediaAddress: '',
        aiAddress: ''
    };
};

// Fix the database checks
const isDuplicateDB = (existingDBs: RemoteDB[], newDB: RemoteDB): boolean => {
    return existingDBs.some(db => db.id === newDB.id);
};

// Fix the peer handling
const getPeerList = async (heliaInstance: any) => {
    try {
        // Use the correct method for getting peers
        const peers = await heliaInstance?.libp2p?.getPeers();
        return peers || [];
    } catch (err) {
        log.error('Failed to get peers:', err);
        return [];
    }
};

// Add this helper function
function updateLoadingState(step: string, detail: string = '', progress: number = 0) {
  loadingState.set({ step, detail, progress });
  log.debug('Loading State:', { step, detail, progress });
}

async function requestRelaySyncForAddress(dbAddress: string): Promise<boolean> {
  const normalized = dbAddress?.trim();
  if (!normalized) return false;

  const metricsOrigins = getRelayMetricsOriginsForFetch();
  let anyOk = false;

  for (const origin of metricsOrigins) {
    try {
      if (await requestRelayDbPinSync(origin, normalized)) {
        anyOk = true;
      }
    } catch (error) {
      log.warn('Relay sync request failed for database address:', normalized, origin, error);
    }
  }

  if (anyOk) {
    log.info('Requested relay sync for database address:', normalized);
  }

  return anyOk;
}

// Add a global write operation tracker
let writeOperationCounter = 0;
function trackWriteOperation(operation: string, dbName: string, data: any = null) {
  writeOperationCounter++;
  const writeId = `write-${writeOperationCounter}`;
  log.debug(`🚀 [${writeId}] WRITE OPERATION: ${operation} to ${dbName}`);
  log.debug(`🚀 [${writeId}] Data:`, data);
  log.debug(`🚀 [${writeId}] Stack trace:`);
  log.debug(`Stack trace for ${writeId}`, new Error().stack);
  return writeId;
}

/**
 * Adds a remote database to the store
 * @param address - The address of the remote database
 * @param peerId - The peer ID of the remote database
 * @param name - The name of the remote database
 * @returns True if the database was added successfully, false otherwise
 */
export async function addRemoteDBToStore(address: string, peerId: string, name?: string) {
  log.info('addRemoteDBToStore', address, peerId, name)
  const heliaInstance = get(helia);
  const orbitdbInstance = get(orbitdb);
  const identityInstance = get(identity);
  const identitiesInstance = get(identities);
  if (!orbitdbInstance) throw new Error("OrbitDB not initialized");

  
  try {
    let settingsDb;
    let newDB: RemoteDB;

    // If no address is provided, create a new local database
    if (!address && name) {
      const databases = await createDatabaseSet(orbitdbInstance, identityInstance, identitiesInstance, name);
      
      newDB = {
        id: crypto.randomUUID(),
        name: name,
        address: databases.addresses.settings,
        postsAddress: databases.addresses.posts,
        commentsAddress: databases.addresses.comments,
        mediaAddress: databases.addresses.media,
        aiAddress: databases.addresses.ai,
        fetchLater: false,
        date: new Date().toISOString().split('T')[0]
      };
    } else {
      // Handle remote database
      if (peerId && heliaInstance?.libp2p) {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        await heliaInstance.libp2p.dial(peerIdFromString(peerId));
      }

      // Create the database entry for remote DB
      newDB = {
        id: crypto.randomUUID(),
        name: name || 'Unknown Blog',
        address: address,
        postsAddress: '',
        commentsAddress: '',
        mediaAddress: '',
        aiAddress: '',
        fetchLater: true,
        date: new Date().toISOString().split('T')[0]
      };
      
      // Try to open the remote settings database
      settingsDb = await orbitdbInstance.open(address);
      log.debug('settingsDb', settingsDb)
      
      // Get all settings data like in switchToRemoteDB function
      const dbContents = await settingsDb.all();
      
      // Try to get blog name
      const blogNameValue = dbContents.find(content => content.key === 'blogName')?.value?.value;
      if (blogNameValue) {
        newDB.name = blogNameValue;
      }
      
      // Try to get posts address
      const postsAddressValue = dbContents.find(content => content.key === 'postsDBAddress')?.value?.value;
      if (postsAddressValue) {
        newDB.postsAddress = postsAddressValue;
        
        try {
          const postsDb = await orbitdbInstance.open(newDB.postsAddress);
          const allPosts = await postsDb.all();
          log.debug(`Fetched ${allPosts.length} posts from remote database`);
          newDB.fetchLater = false;
        } catch (_error) {
          log.error('Error opening posts database, will try later:',_error);
        }
      }
    }

    const remoteDBsDatabase = get(remoteDBsDatabases);
    const existingDBs = await remoteDBsDatabase.all();

    if (existingDBs.some(db => db.value.address === newDB.address)) {
      log.debug('Database already exists in store:', newDB.address);
      return true;
    }
    
    if (remoteDBsDatabase) {
      await remoteDBsDatabase.put({ _id: newDB.id, ...newDB });
      
      const updatedRemoteDBs = [...get(remoteDBs), newDB];
      remoteDBs.set(updatedRemoteDBs);
      
      log.debug('Added database to store:', newDB);
      return true;
    }
    return false;
  } catch (_error) {
    log.error('Error adding database to store:', _error);
    return false;
  }
}

// Add helper function at the top
function hasWriteAccess(db: any, identityId: string): boolean {
  try {
    if (!db?.access?.write) {
      log.warn('Database has no access control defined');
      return false;
    }
    const hasAccess = db.access.write.includes(identityId) || db.access.write.includes("*");
    log.debug("Write access check for", db.name || 'unknown', ":", hasAccess);
    return hasAccess;
  } catch (err) {
    log.error('Error checking write access:', err);
    return false;
  }
}

// Wait for database to be ready (either 'join' or 'update' event)
function waitForDatabaseReady(db: any, timeout: number = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const dbAddress = db.address?.toString() || 'unknown';
    
    const resolveOnce = (eventType: string) => {
      if (resolved) return;
      resolved = true;
      log.debug(`Database ready via '${eventType}' event:`, dbAddress);
      resolve(true);
    };
    
    // Listen for join event (peer connections)
    const joinHandler = (peerId: string, heads: any) => {
      log.debug('Database join event:', dbAddress, peerId);
      resolveOnce('join');
    };
    
    // Listen for update event (data synchronization)
    const updateHandler = (entry: any) => {
      log.debug('Database update event:', dbAddress, entry?.payload?.op);
      resolveOnce('update');
    };
    
    db.events.on('join', joinHandler);
    db.events.on('update', updateHandler);
    
    // Set timeout to prevent hanging
    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      
      // Clean up event listeners
      db.events.off('join', joinHandler);
      db.events.off('update', updateHandler);
      
      log.warn(`Database readiness timeout after ${timeout}ms:`, dbAddress);
      resolve(false);
    }, timeout);
    
    // Clean up timeout when resolved
    if (resolved) {
      clearTimeout(timeoutId);
      db.events.off('join', joinHandler);
      db.events.off('update', updateHandler);
    }
  });
}

// Enhanced function to wait for database data to be available
async function waitForDatabaseData(db: any, timeout: number = 20000): Promise<any[]> {
  const dbAddress = db.address?.toString() || 'unknown';
  const startTime = Date.now();
  let retryCount = 0;
  const maxRetries = 10;
  
  while (Date.now() - startTime < timeout && retryCount < maxRetries) {
    retryCount++;
    
    try {
      const data = await db.all();
      
      if (data && data.length > 0) {
        log.debug(`Database data loaded on attempt ${retryCount}:`, dbAddress, `${data.length} entries`);
        return data;
      }
      
      // If no data yet, wait for events or timeout
      log.debug(`Database ${dbAddress} empty on attempt ${retryCount}, waiting for sync...`);
      await requestRelaySyncForAddress(dbAddress);
      
      // Wait for either an update event or a short timeout
      await new Promise((resolve) => {
        let resolved = false;
        
        const resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          resolve(true);
        };
        
        // Listen for update event
        const updateHandler = () => {
          log.debug('Data sync event detected for:', dbAddress);
          db.events.off('update', updateHandler);
          resolveOnce();
        };
        
        db.events.on('update', updateHandler);
        
        // Fallback timeout for this iteration
        setTimeout(() => {
          db.events.off('update', updateHandler);
          resolveOnce();
        }, 2000); // Wait 2 seconds per attempt
      });
      
    } catch (error) {
      log.warn(`Error loading data from ${dbAddress} on attempt ${retryCount}:`, error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Final attempt - return whatever we have (even if empty)
  try {
    const finalData = await db.all();
    log.info(`Final data load attempt for ${dbAddress}: ${finalData?.length || 0} entries`);
    return finalData || [];
  } catch (error) {
    log.warn(`Final data load failed for ${dbAddress}:`, error);
    return [];
  }
}

async function waitForSettingValue(
  db: any,
  key: string,
  timeout: number = 15000
): Promise<string | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const byKey = await db.get(key);
      const keyValue = byKey?.value?.value;
      if (typeof keyValue === 'string' && keyValue.length > 0) return keyValue;

      const all = await db.all();
      const allValue = all.find((content: any) => content.key === key)?.value?.value;
      if (typeof allValue === 'string' && allValue.length > 0) return allValue;
    } catch {
      // keep polling while remote settings propagate
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return null;
}

interface DBConfig {
  name: string;
  directory: string;
  writeAccess: string[];
  store: any; // Svelte store
  addressStore: any; // Svelte store for address
}

async function openOrCreateDB(
  orbitdbInstance: any,
  dbContents: any[],
  dbKey: string,
  config: DBConfig,
  canWriteToSettings: boolean,
  settingsDB: any,
  isRemoteDB: boolean = false,
  isBlocking: boolean = true  // New parameter to control blocking behavior
) {
  const dbAddressValue = dbContents.find(content => content.key === dbKey)?.value?.value;
  log.info(`Found ${dbKey}:`, dbAddressValue);

  if (dbAddressValue) {
    try {
      if (isRemoteDB) {
        await requestRelaySyncForAddress(dbAddressValue);
      }

      const dbInstance = await orbitdbInstance.open(dbAddressValue);
      log.debug(`${config.name} ${dbAddressValue} loaded`);
      
      // Set the store immediately so it's available
      config.store.set(dbInstance);
      if (typeof window !== 'undefined' && config.name === 'posts') {
        (window as any).postsDB = dbInstance;
      }
      
      // Only wait for readiness if this is a blocking database (settings/posts)
      if (isRemoteDB && isBlocking) {
        updateLoadingState('waiting_db_ready', `Waiting for ${config.name} database to sync...`, 40);
        const timeout = config.name === 'posts' ? 8000 : 5000; // Reduced timeouts
        const isReady = await waitForDatabaseReady(dbInstance, timeout);
        
        if (!isReady) {
          log.warn(`Database ${config.name} did not become ready within timeout, proceeding anyway`);
        } else {
          log.info(`Database ${config.name} is ready for operations`);
        }
      } else if (isRemoteDB && !isBlocking) {
        // For non-blocking databases, just start the readiness check asynchronously
        waitForDatabaseReady(dbInstance, 5000).then(isReady => {
          if (isReady) {
            log.info(`Database ${config.name} is ready for operations (async)`);
          } else {
            log.warn(`Database ${config.name} async readiness timeout, but continuing in background`);
          }
        });
      }
      
      return dbInstance;
    } catch (_error) {
      log.error(`Failed to open ${config.name} database:`, _error);
      if (!canWriteToSettings) {
        log.debug(`No write access to settings - skipping ${config.name} database creation`);
      }
    }
  } else if (canWriteToSettings && !isRemoteDB) {
    // Only create new databases for local setups, not remote ones
    log.info('creating new database', config.name)
    try {
      const dbInstance = await orbitdbInstance.open(config.name, {
        type: 'documents',
        create: true,
        overwrite: false,
        directory: config.directory,
        identity: get(identity),
        identities: get(identities),
        AccessController: IPFSAccessController({ write: config.writeAccess })
      });
      config.store.set(dbInstance);
      const dbAddress = dbInstance.address.toString();
      // Store in settings (no need to wait for readiness on local creation)
      log.info('storing dbAddress in settings', dbAddress)
      await settingsDB.put({ _id: dbKey, value: dbAddress });
      return dbInstance;
    } catch (_error) {
      log.error(`Failed to create ${config.name} database:`, _error);
    }
  } else {
    if (isRemoteDB && !dbAddressValue) {
      log.warn(`No ${config.name} database address found in remote database`);
    } else {
      log.warn(`No ${config.name} database address found and no write access to create one`);
    }
  }
  return null;
}

/**
 * Updates a remote database entry with counts and addresses
 * @param address - The address of the database to update
 * @param updates - Object containing the new values to update
 */
function updateRemoteDBEntry(
  address: string,
  updates: {
    postsCount?: number;
    commentsCount?: number;
    mediaCount?: number;
    postsDBAddress?: string;
    commentsDBAddress?: string;
    mediaDBAddress?: string;
    aiDBAddress?: string;
    access?: any;
  }
) {
  remoteDBs.update(dbs => {
    return dbs.map(db => {
      if (db.address === address) {
        return {
          ...db,
          ...updates
        };
      }
      return db;
    });
  });
}

async function waitForPeers(heliaInstance: any, minPeers: number = 1, timeout: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  let lastBootstrapDialAt = 0;
  
  while (Date.now() - startTime < timeout) {
    const peers = await heliaInstance?.libp2p?.getPeers();
    const activeConnections = heliaInstance?.libp2p?.getConnections?.() ?? [];
    const connectedPeerIds = new Set(
      activeConnections
        .map((connection: any) => connection?.remotePeer?.toString?.() ?? '')
        .filter(Boolean),
    );
    const peerCount = Math.max(peers?.length || 0, connectedPeerIds.size);
    
    updateLoadingState('connecting_peers', `Connected to ${peerCount} peers. Waiting for at least ${minPeers}...`, 20);
    log.debug('peerCount', peerCount)
    if (peerCount >= minPeers) {
      log.debug('peerCount >= minPeers', peerCount, minPeers)
      return true;
    }

    if (
      connectedPeerIds.size === 0 &&
      seedMultiaddrs.length > 0 &&
      Date.now() - lastBootstrapDialAt >= 3000
    ) {
      lastBootstrapDialAt = Date.now();
      for (const seed of seedMultiaddrs) {
        try {
          log.info('Attempting bootstrap dial while waiting for peers:', seed);
          await heliaInstance?.libp2p?.dial?.(multiaddr(seed));
          break;
        } catch (error: any) {
          const message = String(error?.message ?? error ?? '');
          if (message.includes('Duplicate multiaddr connection') || message.includes('had an existing non-limited connection')) {
            log.debug('Bootstrap dial skipped; connection already exists for seed:', seed);
            break;
          }
          log.warn('Bootstrap dial failed while waiting for peers:', seed, error);
        }
      }
    }
    
    // Wait for 1 second before checking again
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return false;
}

/**
 * Switches the application to use a remote OrbitDB database
 * 
 * This function performs a complete database switch operation by:
 * 1. Opening the remote settings database using the provided address
 * 2. Adding the database to Voyager for persistence
 * 3. Loading all blog settings (name, description, categories, posts address)
 * 4. Opening the posts database referenced in the settings
 * 5. Loading all posts from the posts database
 * 6. Updating all relevant Svelte stores with the remote data
 * 
 * The function implements a retry mechanism that continues attempting to 
 * load the database until all required data is successfully retrieved.
 * 
 * @param {string} address - The OrbitDB address of the remote settings database to switch to
 * @param {boolean} [showModal=false] - Whether to show a loading modal during the operation
 * 
 * @returns {Promise<boolean>} True if the switch was successful, false if it failed
 * 
 * @throws {Error} Throws an error if OrbitDB is not initialized
 * 
 * @example
 * // Switch to a remote database without showing a modal
 * await switchToRemoteDB('zdpuAywgooGrEcDdAoMsK4umnDZyxY9gMTdjwww29h2B9MKeh/db-name');
 * 
 * @example
 * // Switch to a remote database with a loading modal
 * await switchToRemoteDB('zdpuAywgooGrEcDdAoMsK4umnDZyxY9gMTdjwww29h2B9MKeh/db-name', true);
 */
export async function switchToRemoteDB(address: string, showModal = false) {
  let retry = true;
  let cancelOperation = false;
  let retryCount = 0;
  const maxRetries = 3;
  
  let blogNameValue;
  let categoriesValue; 
  
  const orbitdbInstance = get(orbitdb);
  const heliaInstance = get(helia);
  
  log.debug('🔄 switchToRemoteDB called with address:', address);
  log.debug('🔄 Current identity:', get(identity)?.id);
  
  try {
    updateLoadingState('initializing', 'Starting database switch...', 5);

    while (retry && !cancelOperation && retryCount < maxRetries) {
      retryCount++;
      log.debug(`🔄 switchToRemoteDB attempt ${retryCount}/${maxRetries} for address:`, address);
      
      if (!orbitdbInstance) throw new Error("OrbitDB not initialized");
      
      // Connect to peers
      updateLoadingState('connecting_peers', 'Connecting to P2P network...', 10);

      await waitForPeers(heliaInstance);
      const peers = await heliaInstance?.libp2p?.getPeers();
      updateLoadingState('connecting_peers', `Connected to ${peers?.length || 0} peers`, 20);
      
      // First clear stores to prevent stale data display/writes during remote switch.
      //
      // postsDB and postsDBAddress belong here too, and leaving them out was a
      // write-access hole: they are the two stores canWrite is computed from.
      // When the remote settings have not replicated their postsDBAddress entry
      // yet, openOrCreateDB below correctly refuses to create one for a remote
      // blog and returns undefined — so without this, both stores keep pointing
      // at the visitor's *own* posts database while settingsDB already shows
      // someone else's blog. canWrite then finds a posts DB the visitor owns and
      // renders the post form on a blog they cannot write to.
      posts.set([]);
      postsDB.set(null);
      postsDBAddress.set(null);
      commentsDB.set(null);
      mediaDB.set(null);
      aiDB.set(null);
      
      updateLoadingState('identifying_db', `Opening database: ${address}`, 30);

      await requestRelaySyncForAddress(address);
      
      // Try opening with Voyager first, fall back to direct OrbitDB if it fails
      log.debug('🔄 Opening database with address:', address);
      let db = await orbitdbInstance.open(address);
      
      if (!db) {
        throw new Error("Failed to open database with both Voyager and OrbitDB");
      }
      
      log.debug('✅ Database opened successfully:', {
        address: db.address?.toString(),
        name: db.name,
        accessWrite: db.access?.write,
        type: db.type
      });
      
      // Set the settings DB store
      settingsDB.set(db);
      
      // Get all settings data with enhanced retry mechanism
      updateLoadingState('loading_settings', 'Loading blog configuration...', 40);
      log.debug('🔄 Loading settings from database...');

      await requestRelaySyncForAddress(address);
      
      // Use the enhanced data loading function to handle empty results
      const dbContents = await waitForDatabaseData(db, 20000); // 20 second timeout
      log.debug('📄 Database contents loaded:', dbContents?.length || 0, 'entries');
      log.info('try to switch to remote dbContents', dbContents);

      // Set values from dbContents
      blogNameValue = dbContents.find(content => content.key === 'blogName')?.value?.value;
      log.info('blogNameValue', blogNameValue);
      const blogDescriptionValue = dbContents.find(content => content.key === 'blogDescription')?.value?.value;
      log.info('blogDescriptionValue', blogDescriptionValue);
      const postsDBAddressValue = dbContents.find(content => content.key === 'postsDBAddress')?.value?.value;
      log.info('postsDBAddressValue', postsDBAddressValue);
      let commentsDBAddressValue = dbContents.find(content => content.key === 'commentsDBAddress')?.value?.value;
      log.info('commentsDBAddressValue', commentsDBAddressValue);
      const mediaDBAddressValue = dbContents.find(content => content.key === 'mediaDBAddress')?.value?.value;
      log.info('mediaDBAddressValue', mediaDBAddressValue);
      const aiDBAddressValue = dbContents.find(content => content.key === 'aiDBAddress')?.value?.value;
      log.info('aiDBAddressValue', aiDBAddressValue);
      categoriesValue = dbContents.find(content => content.key === 'categories')?.value?.value || ['please add categories']; // Fetch categories
      log.info('categoriesValue', categoriesValue);
      const profilePictureValue = dbContents.find(content => content.key === 'profilePicture')?.value?.value;
      log.info('profilePictureValue', profilePictureValue);

      updateLoadingState('loading_settings', 'Processing blog settings...', 50);
      // Update stores with settings data
      if (blogNameValue) blogName.set(blogNameValue);
      if (blogDescriptionValue) blogDescription.set(blogDescriptionValue);
      if (postsDBAddressValue) postsDBAddress.set(postsDBAddressValue);
      if (commentsDBAddressValue) commentsDBAddress.set(commentsDBAddressValue);
      if (mediaDBAddressValue) mediaDBAddress.set(mediaDBAddressValue);
      if (aiDBAddressValue) aiDBAddress.set(aiDBAddressValue);
      if (categoriesValue) categories.set(categoriesValue);
      // Always update profile picture CID - set to null if new database doesn't have one
      profilePictureCid.set(profilePictureValue || null);
      

      // Check if we have write access to the settings database
      const identityId = get(identity).id;
      const canWriteToSettings = hasWriteAccess(db, identityId);
      log.info('Write access to settings:', canWriteToSettings);
      if(canWriteToSettings){
        updateRemoteDBEntry(address, {
          postsDBAddress: postsDBAddressValue,
          commentsDBAddress: commentsDBAddressValue,
          mediaDBAddress: mediaDBAddressValue,
          aiDBAddress: aiDBAddressValue
        });
      }


      // Check if all required data is available
      if (blogNameValue && postsDBAddressValue)  {
        if (!commentsDBAddressValue) {
          updateLoadingState('loading_settings', 'Waiting for comments database address...', 55);
          const syncedCommentsAddress = await waitForSettingValue(db, 'commentsDBAddress', 20000);
          if (syncedCommentsAddress) {
            commentsDBAddressValue = syncedCommentsAddress;
            commentsDBAddress.set(syncedCommentsAddress);
          } else {
            log.warn('commentsDBAddress missing after timeout; comments remain unavailable for this remote session.');
          }
        }

        log.info('blogNameValue', blogNameValue);
        log.info('blogDescriptionValue', blogDescriptionValue);
        log.info('postsDBAddressValue', postsDBAddressValue);

        // Track counts for later update
        let postsCount = 0;
        let commentsCount = 0;
        let mediaCount = 0;
        let postsDBAddr = '';
        let commentsDBAddr = '';
        let mediaDBAddr = '';
        let aiDBAddr = '';
        const isRemotePostsLoad = true;

        updateLoadingState('loading_posts', 'Opening posts database...', 60);
        // Create promises for all DB operations
        const postsPromise = openOrCreateDB(orbitdbInstance, dbContents, 'postsDBAddress', {
          name: 'posts',
          directory: './orbitdb/posts',
          writeAccess: [get(identity).id],
          store: postsDB,
          addressStore: postsDBAddress
        }, canWriteToSettings, db, true)
        .then(async postsInstance => {
          if (postsInstance) {
            log.info('postsInstance', postsInstance)
            postsDBAddr = postsInstance.address.toString()
            // Only attempt to write if we have permissions
            try {
              if (canWriteToSettings && hasWriteAccess(postsInstance, get(identity).id)) {
                await get(settingsDB).put({ _id: 'postsDBAddress', value: postsDBAddr });
              }
            } catch (writeError) {
              log.warn('Could not update postsDBAddress in settings:', writeError.message);
            }
            const rawPosts = isRemotePostsLoad
              ? await waitForDatabaseData(postsInstance, 20000)
              : await postsInstance.all();
            const allPosts = rawPosts.map(post => {
              const { _id, ...rest } = post.value;
              const resolvedId = _id ?? post.key;
              const mappedPost = {
                ...rest,
                _id: resolvedId,
                content: rest.content || rest.value?.content,
                title: rest.title || rest.value?.title,
                date: rest.date || rest.value?.date,
                published: rest.published !== undefined ? rest.published : rest.value?.published,
              };
              return mappedPost;
            });
            postsCount = allPosts.length;
            log.info(`Loaded ${postsCount} posts from ${isRemotePostsLoad ? 'remote' : 'local'} posts database`);
            posts.set(allPosts);
            return { instance: postsInstance, access: postsInstance.access };
          }
          return null;
        });

        // Load comments database asynchronously (non-blocking)
        openOrCreateDB(orbitdbInstance, dbContents, 'commentsDBAddress', {
          name: 'comments',
          directory: './orbitdb/comments',
          writeAccess: ["*"],
          store: commentsDB,
          addressStore: commentsDBAddress
        }, canWriteToSettings, db, true, false) // isBlocking = false
        .then(async commentsInstance => {
          if (commentsInstance) {
            log.info('commentsInstance loaded asynchronously:', commentsInstance)
            commentsDBAddr = commentsInstance.address.toString()
            try {
              if (canWriteToSettings && hasWriteAccess(commentsInstance, get(identity).id)) {
                await get(settingsDB).put({ _id: 'commentsDBAddress', value: commentsDBAddr });
              }
            } catch (writeError) {
              log.warn('Could not update commentsDBAddress in settings:', writeError.message);
            }
            
            const allComments = await commentsInstance.all();
            commentsCount = allComments.length;
            log.info('Comments database ready with', commentsCount, 'comments');
          }
        }).catch(err => {
          log.warn('Error loading comments database (async):', err);
        });

        // Load media database asynchronously (non-blocking)
        openOrCreateDB(orbitdbInstance, dbContents, 'mediaDBAddress', {
          name: 'media',
          directory: './orbitdb/media',
          writeAccess: [get(identity).id],
          store: mediaDB,
          addressStore: mediaDBAddress
        }, canWriteToSettings, db, true, false) // isBlocking = false
        .then(async mediaInstance => {
          if (mediaInstance) {
            log.info('mediaInstance loaded asynchronously:', mediaInstance)
            mediaDBAddr = mediaInstance.address.toString()
            try {
              if (canWriteToSettings && hasWriteAccess(mediaInstance, get(identity).id)) {
                await get(settingsDB).put({ _id: 'mediaDBAddress', value: mediaDBAddr });
              }
            } catch (writeError) {
              log.warn('Could not update mediaDBAddress in settings:', writeError.message);
            }
            const allMedia = await mediaInstance.all();
            mediaCount = allMedia.length;
            log.info('Media database ready with', mediaCount, 'media items');
          }
        }).catch(err => {
          log.warn('Error loading media database (async):', err);
        });

        // Load AI database asynchronously (non-blocking), same pattern as media
        openOrCreateDB(orbitdbInstance, dbContents, 'aiDBAddress', {
          name: 'ai',
          directory: './orbitdb/ai',
          writeAccess: [get(identity).id],
          store: aiDB,
          addressStore: aiDBAddress
        }, canWriteToSettings, db, true, false)
        .then(async aiInstance => {
          if (aiInstance) {
            log.info('aiInstance loaded asynchronously:', aiInstance);
            aiDBAddr = aiInstance.address.toString();
            try {
              if (canWriteToSettings && hasWriteAccess(aiInstance, get(identity).id)) {
                await get(settingsDB).put({ _id: 'aiDBAddress', value: aiDBAddr });
              }
            } catch (writeError: any) {
              log.warn('Could not update aiDBAddress in settings:', writeError?.message);
            }
            log.info('AI database ready at', aiDBAddr);
          }
        }).catch(err => {
          log.warn('Error loading AI database (async):', err);
        });
        
        // Only wait for posts database (critical)
        updateLoadingState('loading_posts', 'Finalizing posts database...', 90);
        const [postsResult] = await Promise.all([postsPromise]);
        
        // Immediately mark as complete after posts
        updateLoadingState('complete', 'Blog loaded successfully!', 100);

        // Update remote DBs with the counts and access info
        updateRemoteDBEntry(address, {
          postsCount,
          commentsCount,
          mediaCount,
          postsDBAddress: postsDBAddr,
          commentsDBAddress: commentsDBAddr,
          mediaDBAddress: mediaDBAddr,
          aiDBAddress: aiDBAddr,
          access: postsResult?.access
        });

        log.info('remoteDBs', get(remoteDBs))
        retry = false; // Stop retrying if all data is fetched
      } else {
        // If we don't have the minimum required data after several attempts, give up
        if (!blogNameValue || !postsDBAddressValue) {
          log.warn('❌ Missing required data after loading attempt. BlogName:', !!blogNameValue, 'PostsDBAddress:', !!postsDBAddressValue);
          log.warn('❌ Retry count:', retryCount, '/', maxRetries);
          
          if (retryCount >= maxRetries) {
            log.error('❌ Max retries reached, stopping to prevent endless loop');
            updateLoadingState('error', 'Could not load required blog data after multiple attempts', 0);
            retry = false;
            return false;
          }
        }
        updateLoadingState('loading_settings', 'Waiting for required data...', 45);
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait before retrying
      }
    }
    return true;
  } catch (_error) {
    log.error('Failed to switch to remote DB:', _error);
    updateLoadingState('error', `Error: ${_error.message}`, 0);
    return false;
  } finally {
    // Update remote DBs store
    const remoteDBsDatabase = get(remoteDBsDatabases);
    if (remoteDBsDatabase) {
      const existingDBs = await remoteDBsDatabase.all();
      if (!existingDBs.some(db => db.value?.address === address)) {
        await addRemoteDBToStore(address, '', blogNameValue || 'Loading...');
      }
    }
  }
}

/**
 * Creates a new set of databases (settings, posts, comments, media) and initializes them
 * @param orbitdbInstance - The OrbitDB instance
 * @param identity - The user's identity
 * @param identities - The identities instance
 * @param name - The name for the blog/database set
 * @returns Object containing all created database instances and their addresses
 */
export async function createDatabaseSet(orbitdbInstance: any, identity: any, identities: any, name: string = 'blog') {
  if (!orbitdbInstance) throw new Error("OrbitDB not initialized");
  
  // Create settings database
  const settingsDb = await orbitdbInstance.open(`${name}-settings`, {
    type: 'documents',
    create: true,
    overwrite: false,
    directory: './orbitdb/settings',
    identity: identity,
    identities: identities,
    AccessController: IPFSAccessController({write: [identity.id]})
  });

  // Create posts database
  const postsDb = await orbitdbInstance.open(`${name}-posts`, {
    type: 'documents',
    create: true,
    overwrite: false,
    directory: './orbitdb/posts',
    identity: identity,
    identities: identities,
    AccessController: IPFSAccessController({write: [identity.id]})
  });

  // Create comments database
  const commentsDb = await orbitdbInstance.open(`${name}-comments`, {
    type: 'documents',
    create: true,
    overwrite: false,
    directory: './orbitdb/comments',
    identity: identity,
    identities: identities,
    AccessController: IPFSAccessController({write: ["*"]})
  });

  // Create media database
  const mediaDb = await orbitdbInstance.open(`${name}-media`, {
    type: 'documents',
    create: true,
    overwrite: false,
    directory: './orbitdb/media',
    identity: identity,
    identities: identities,
    AccessController: IPFSAccessController({write: [identity.id]})
  });

  // Create AI documents database (same access model as media)
  const aiDb = await orbitdbInstance.open(`${name}-ai`, {
    type: 'documents',
    create: true,
    overwrite: false,
    directory: './orbitdb/ai',
    identity: identity,
    identities: identities,
    AccessController: IPFSAccessController({write: [identity.id]})
  });

  // Store addresses in settings DB
  await settingsDb.put({ _id: 'blogName', value: name });
  await settingsDb.put({ _id: 'blogDescription', value: 'please change' });
  await settingsDb.put({ _id: 'postsDBAddress', value: postsDb.address.toString() });
  await settingsDb.put({ _id: 'commentsDBAddress', value: commentsDb.address.toString() });
  await settingsDb.put({ _id: 'mediaDBAddress', value: mediaDb.address.toString() });
  await settingsDb.put({ _id: 'aiDBAddress', value: aiDb.address.toString() });

  return {
    settingsDb,
    postsDb,
    commentsDb,
    mediaDb,
    aiDb,
    addresses: {
      settings: settingsDb.address.toString(),
      posts: postsDb.address.toString(),
      comments: commentsDb.address.toString(),
      media: mediaDb.address.toString(),
      ai: aiDb.address.toString()
    }
  };
} 
