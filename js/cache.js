/**
 * cache.js - Hash cache & Ignored duplicate pairs management
 * JSON file-backed persistent cache with incremental indexing
 */

const fs = require('fs');
const nodePath = require('path');

const Cache = {

    CACHE_VERSION: 3,
    SAVE_DEBOUNCE_MS: 3000,

    _data: null,
    _ignoredPairs: new Set(),
    _cacheDir: '',
    _cacheFile: '',
    _ignoredFile: '',
    _saveTimer: null,
    _dirty: false,
    _diskStamp: null,      // mtime:size of cache file as last seen by this window
    _removed: new Set(),   // ids deliberately removed here (must not be resurrected from disk)

    /**
     * Initialize cache for a given library
     */
    init(pluginPath, libraryPath, libraryName) {
        Cache._cacheDir = nodePath.join(pluginPath, 'cache');
        const safeName = (libraryName || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
        Cache._cacheFile = nodePath.join(Cache._cacheDir, `${safeName}.json`);
        Cache._ignoredFile = nodePath.join(Cache._cacheDir, `ignored_${safeName}.json`);

        // Ensure cache directory exists
        try {
            if (!fs.existsSync(Cache._cacheDir)) {
                fs.mkdirSync(Cache._cacheDir, { recursive: true });
            }
        } catch (e) {
            console.warn('Cache: Failed to create cache dir:', e.message);
        }

        Cache._load(libraryPath, safeName);
        Cache._loadIgnored();
    },

    /**
     * Load cache from disk, and import any missing items from original Find by Media cache (read-only)
     */
    _load(libraryPath, safeName) {
        Cache._data = {
            version: Cache.CACHE_VERSION,
            libraryPath: libraryPath,
            items: {}
        };
        Cache._removed = new Set();
        Cache._diskStamp = null;

        try {
            if (fs.existsSync(Cache._cacheFile)) {
                const raw = fs.readFileSync(Cache._cacheFile, 'utf-8');
                const parsed = JSON.parse(raw);

                if (parsed.version === Cache.CACHE_VERSION && (!libraryPath || !parsed.libraryPath || parsed.libraryPath === libraryPath)) {
                    Cache._data = parsed;
                    if (libraryPath) Cache._data.libraryPath = libraryPath;
                    Cache._diskStamp = Cache._statStamp();
                    console.log(`Cache: Loaded ${Object.keys(Cache._data.items).length} items from disk`);
                } else {
                    console.log('Cache: Version mismatch or library changed, resetting');
                }
            }
        } catch (e) {
            console.warn('Cache: Failed to load, starting fresh:', e.message);
        }

        // Also check original installed Find by Media cache (read-only) to sync any newly indexed hashes
        try {
            const appData = process.env.APPDATA || (window.eagle && eagle.app && eagle.app.userDataPath ? nodePath.dirname(eagle.app.userDataPath) : '');
            if (appData && safeName) {
                const origCacheFile = nodePath.join(appData, 'Eagle', 'plugins', '443343C0-7AF4-4651-81A5-C6DA6FBB8B0D', 'cache', `${safeName}.json`);
                if (origCacheFile !== Cache._cacheFile && fs.existsSync(origCacheFile)) {
                    const origRaw = fs.readFileSync(origCacheFile, 'utf-8');
                    const origParsed = JSON.parse(origRaw);
                    if (origParsed && origParsed.items) {
                        let imported = 0;
                        for (const [id, val] of Object.entries(origParsed.items)) {
                            if (!Cache._data.items[id] && val && val.pHash) {
                                Cache._data.items[id] = val;
                                imported++;
                            } else if (Cache._data.items[id] && val && val.embedding && !Cache._data.items[id].embedding) {
                                Cache._data.items[id].embedding = val.embedding;
                                imported++;
                            }
                        }
                        if (imported > 0) {
                            console.log(`Cache: Imported ${imported} hashes from original Find by Media cache`);
                            Cache.save();
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore fallback read errors
        }
    },

    /**
     * Load ignored ("not duplicate") pairs from disk
     */
    _loadIgnored() {
        Cache._ignoredPairs = new Set();
        try {
            if (Cache._ignoredFile && fs.existsSync(Cache._ignoredFile)) {
                const raw = fs.readFileSync(Cache._ignoredFile, 'utf-8');
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    for (const key of arr) {
                        Cache._ignoredPairs.add(key);
                    }
                }
            }
        } catch (e) {
            console.warn('Cache: Failed to load ignored pairs:', e.message);
        }
    },

    /**
     * Save ignored pairs to disk immediately
     */
    _saveIgnored() {
        if (!Cache._ignoredFile) return;
        try {
            const arr = Array.from(Cache._ignoredPairs);
            fs.writeFileSync(Cache._ignoredFile, JSON.stringify(arr, null, 2), 'utf-8');
        } catch (e) {
            console.warn('Cache: Failed to save ignored pairs:', e.message);
        }
    },

    makePairKey(id1, id2) {
        return id1 < id2 ? `${id1}:${id2}` : `${id2}:${id1}`;
    },

    isPairIgnored(id1, id2) {
        return Cache._ignoredPairs.has(Cache.makePairKey(id1, id2));
    },

    ignorePair(id1, id2) {
        Cache._ignoredPairs.add(Cache.makePairKey(id1, id2));
        Cache._saveIgnored();
    },

    unignorePair(id1, id2) {
        Cache._ignoredPairs.delete(Cache.makePairKey(id1, id2));
        Cache._saveIgnored();
    },

    getIgnoredCount() {
        return Cache._ignoredPairs.size;
    },

    clearIgnoredPairs() {
        Cache._ignoredPairs.clear();
        Cache._saveIgnored();
    },

    /**
     * Save cache to disk (debounced)
     */
    save(immediate) {
        Cache._dirty = true;

        if (immediate) {
            Cache._doSave();
            return;
        }

        if (!Cache._saveTimer) {
            Cache._saveTimer = setTimeout(() => {
                Cache._doSave();
            }, Cache.SAVE_DEBOUNCE_MS);
        }
    },

    /**
     * Cheap fingerprint of the cache file on disk (null if missing)
     */
    _statStamp() {
        try {
            const st = fs.statSync(Cache._cacheFile);
            return `${st.mtimeMs}:${st.size}`;
        } catch (e) {
            return null;
        }
    },

    /**
     * Merge entries written to disk by another plugin window (inspector <-> duplicates manager).
     * Only does real work when the file changed since we last read/wrote it.
     * @returns {number} number of merged entries
     */
    syncFromDisk() {
        if (!Cache._data || !Cache._cacheFile) return 0;
        const stamp = Cache._statStamp();
        if (!stamp || stamp === Cache._diskStamp) return 0;

        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(Cache._cacheFile, 'utf-8'));
        } catch (e) {
            return 0; // possibly mid-write; retry next time
        }
        Cache._diskStamp = stamp;

        if (!parsed || parsed.version !== Cache.CACHE_VERSION || !parsed.items) return 0;
        if (Cache._data.libraryPath && parsed.libraryPath && parsed.libraryPath !== Cache._data.libraryPath) return 0;

        const items = Cache._data.items;
        let merged = 0;
        for (const id in parsed.items) {
            if (Cache._removed.has(id)) continue;
            const disk = parsed.items[id];
            if (!disk || !disk.pHash) continue;
            const mem = items[id];
            if (!mem) {
                items[id] = disk;
                merged++;
            } else if (disk.embedding && !mem.embedding) {
                mem.embedding = disk.embedding;
                merged++;
            }
        }
        if (merged > 0) console.log(`Cache: Merged ${merged} entries written by another window`);
        return merged;
    },

    _doSave() {
        if (Cache._saveTimer) {
            clearTimeout(Cache._saveTimer);
            Cache._saveTimer = null;
        }

        if (!Cache._dirty || !Cache._data) return;

        // Don't clobber entries another window saved since we loaded
        Cache.syncFromDisk();

        try {
            const json = JSON.stringify(Cache._data);
            // Atomic write so the other window never reads a half-written file
            const tmp = Cache._cacheFile + '.tmp';
            try {
                fs.writeFileSync(tmp, json, 'utf-8');
                fs.renameSync(tmp, Cache._cacheFile);
            } catch (e) {
                try { fs.unlinkSync(tmp); } catch (e2) {}
                fs.writeFileSync(Cache._cacheFile, json, 'utf-8');
            }
            Cache._diskStamp = Cache._statStamp();
            Cache._dirty = false;
            console.log(`Cache: Saved ${Object.keys(Cache._data.items).length} items to disk`);
        } catch (e) {
            console.warn('Cache: Failed to save:', e.message);
        }
    },

    /**
     * Get hash data for an item
     */
    getHash(itemId) {
        if (!Cache._data) return null;
        return Cache._data.items[itemId] || null;
    },

    /**
     * Check if an item has a valid cached hash (regardless of mtime)
     */
    hasValidHash(itemId) {
        if (!Cache._data) return false;
        const cached = Cache._data.items[itemId];
        if (!cached) return false;
        // Must have both hash components
        return !!(cached.pHash && cached.colorHistogram && cached.colorHistogram.length > 0);
    },

    /**
     * Store hash data for an item
     */
    setHash(itemId, hashData) {
        if (!Cache._data) return;
        Cache._removed.delete(itemId);
        Cache._data.items[itemId] = hashData;
        Cache.save();
    },

    /**
     * Remove a single item from cache (e.g. when moved to trash)
     */
    removeItem(itemId) {
        if (!Cache._data || !Cache._data.items[itemId]) return;
        delete Cache._data.items[itemId];
        Cache._removed.add(itemId);
        Cache.save();
    },

    /**
     * Get all cached items (the items map)
     */
    getAllItems() {
        if (!Cache._data) return {};
        return Cache._data.items;
    },

    /**
     * Remove orphaned entries (items no longer in library)
     */
    removeOrphans(validIds) {
        if (!Cache._data) return;
        const validSet = new Set(validIds);
        const cacheIds = Object.keys(Cache._data.items);
        let removed = 0;

        for (const id of cacheIds) {
            if (!validSet.has(id)) {
                delete Cache._data.items[id];
                Cache._removed.add(id);
                removed++;
            }
        }

        if (removed > 0) {
            console.log(`Cache: Removed ${removed} orphaned entries`);
            Cache.save();
        }
    },

    /**
     * Get count of cached items
     */
    getCachedCount() {
        if (!Cache._data) return 0;
        return Object.keys(Cache._data.items).length;
    },

    /**
     * Clear entire cache
     */
    clear() {
        if (Cache._data) {
            for (const id in Cache._data.items) Cache._removed.add(id);
            Cache._data.items = {};
            Cache.save(true);
        }
    },

    /**
     * Flush any pending saves
     */
    flush() {
        Cache._doSave();
    }
};

window.Cache = Cache;
