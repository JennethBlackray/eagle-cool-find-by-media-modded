/**
 * main.js - Entry point and orchestrator
 * Eagle API integration, selection polling, search coordination, drag & drop
 *
 * Search mode is automatic:
 * - CLIP not ready → pHash mode (pixel-level)
 * - CLIP ready → hybrid mode (AI + pixel)
 */

// nodePath already declared in cache.js (shared global scope)

const App = {

    // State
    pluginPath: '',
    libraryPath: '',
    libraryName: '',
    autoSearchEnabled: true,
    resultCount: 20,
    threshold: 70,
    lastSelectedId: null,
    lastSearchedId: null,
    allItems: [],
    isSearching: false,
    indexingDone: false,
    clipReady: false,
    _lastResults: null,
    _pendingSearch: null,

    // Library refresh state (picks up items added to Eagle while the plugin runs)
    _visible: true,
    _refreshing: false,
    _refreshAgain: false,
    _refreshTimer: null,
    _lastFullRefresh: 0,
    _lastCount: -1,
    _indexLoopActive: false,
    _indexPending: false,

    POLL_INTERVAL: 500,
    LIBRARY_CHECK_INTERVAL: 10000,   // cheap item-count check
    LIBRARY_FULL_REFRESH: 60000,     // full item list re-read (fallback when count is unavailable / unchanged)
    NEW_ITEM_REFRESH_DELAY: 1500,    // debounce for unknown selected items (batch imports)
    SMALL_BATCH: 10,                 // don't flash the progress bar for a handful of new images
    ITEM_FIELDS: ['id', 'name', 'ext', 'width', 'height', 'thumbnailPath', 'filePath'],

    /**
     * Get current search mode automatically
     */
    getSearchMode() {
        return App.clipReady ? 'hybrid' : 'phash';
    },

    /**
     * Open the standalone Duplicates Manager window
     */
    openDuplicatesWindow() {
        try {
            Cache.flush();
            const manifestPath = nodePath.join(App.pluginPath || __dirname, 'manifest.json');
            let pluginId = '443343C0-7AF4-4651-81A5-C6DA6FBB8B0D-PRO';
            if (fs.existsSync(manifestPath)) {
                const mf = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                if (mf && mf.id) pluginId = mf.id;
            }
            const { ipcRenderer } = require('electron');
            if (window.parentID) {
                ipcRenderer.sendTo(window.parentID, 'open-plugin', pluginId);
            } else {
                ipcRenderer.send('open-plugin', pluginId);
            }
        } catch (e) {
            console.warn('App: Failed to open duplicates window via IPC:', e.message);
        }
    },

    async init(plugin) {
        App.pluginPath = plugin.path;
        App._loadSettings();

        // Theme
        try {
            const theme = await eagle.app.theme;
            UI.updateTheme(theme);
        } catch (e) {}
        eagle.onThemeChanged((theme) => UI.updateTheme(theme));

        // UI
        UI.initPreviewOverlay();
        App._initControls();
        App._initDropZone();

        // Library + cache
        try {
            const lib = await eagle.library.info();
            App.libraryPath = lib.path || '';
            App.libraryName = lib.name || 'default';
            Cache.init(App.pluginPath, App.libraryPath, App.libraryName);
        } catch (e) {
            Cache.init(App.pluginPath, '', 'default');
        }

        console.log(`App: Cache has ${Cache.getCachedCount()} items from disk`);

        // Get all library items
        App.allItems = (await App._fetchItems()) || [];
        App._lastFullRefresh = Date.now();
        App._lastCount = await App._countItems();

        UI.setItemsMap(App.allItems);
        if (App.allItems.length > 0) {
            App._runIndexing();
        }

        // Start CLIP model loading in background (non-blocking, won't break anything)
        App._initClip();

        // Start polling
        App._pollSelection();
        App._scheduleLibraryCheck();
        UI.showEmptyState('Select an image to find similar items');
    },

    /* ---------------- Library refresh ---------------- */

    async _fetchItems() {
        try {
            const items = await eagle.item.get({ fields: App.ITEM_FIELDS });
            if (Array.isArray(items)) return items;
        } catch (e) {}
        try {
            const items = await eagle.item.getAll();
            if (Array.isArray(items)) return items;
        } catch (e) {}
        return null;
    },

    /**
     * Cheap item count if this Eagle version supports it, otherwise -1
     */
    async _countItems() {
        try {
            if (eagle.item && typeof eagle.item.countAll === 'function') {
                const n = await eagle.item.countAll();
                if (typeof n === 'number') return n;
            }
        } catch (e) {}
        return -1;
    },

    _scheduleLibraryCheck() {
        setTimeout(async () => {
            try {
                if (App._visible && !App._refreshing) {
                    const count = await App._countItems();
                    // With a working count, a full re-read is only a safety net (add+delete keeps count equal)
                    const fullEvery = count >= 0 ? App.LIBRARY_FULL_REFRESH * 5 : App.LIBRARY_FULL_REFRESH;
                    let needRefresh = Date.now() - App._lastFullRefresh >= fullEvery;
                    if (count >= 0 && count !== App._lastCount) needRefresh = true;
                    if (needRefresh) await App._refreshLibrary();
                }
            } catch (e) {}
            App._scheduleLibraryCheck();
        }, App.LIBRARY_CHECK_INTERVAL);
    },

    /**
     * Debounced refresh (used when an unknown item gets selected / plugin shown)
     */
    _requestRefresh(delay) {
        if (App._refreshTimer) clearTimeout(App._refreshTimer);
        App._refreshTimer = setTimeout(() => {
            App._refreshTimer = null;
            App._refreshLibrary();
        }, delay || 0);
    },

    /**
     * Re-read the Eagle item list, drop deleted items, index new ones
     */
    async _refreshLibrary() {
        if (App._refreshing) { App._refreshAgain = true; return; }
        App._refreshing = true;
        try {
            do {
                App._refreshAgain = false;

                // Handle library switch: never mix items/caches of two libraries
                let libPath = App.libraryPath;
                try {
                    const lib = await eagle.library.info();
                    libPath = lib.path || '';
                    if (libPath && libPath !== App.libraryPath) {
                        console.log('App: Library changed, reinitializing cache');
                        Indexer.stop();
                        Cache.flush();
                        App.libraryPath = libPath;
                        App.libraryName = lib.name || 'default';
                        Cache.init(App.pluginPath, App.libraryPath, App.libraryName);
                        App._lastResults = null;
                        App.lastSelectedId = null;
                        App.lastSearchedId = null;
                        App.indexingDone = false;
                        App.allItems = [];
                        UI.showEmptyState('Select an image to find similar items');
                    }
                } catch (e) {}

                const count = await App._countItems();
                const items = await App._fetchItems();
                if (!items) return;

                // Library switched while we were fetching - redo the pass
                try {
                    const lib2 = await eagle.library.info();
                    if ((lib2.path || '') !== libPath) { App._refreshAgain = true; continue; }
                } catch (e) {}

                App._lastFullRefresh = Date.now();
                App._lastCount = count;

                const oldIds = new Set(App.allItems.map(i => i.id));
                let added = 0;
                for (const it of items) if (!oldIds.has(it.id)) added++;
                const removed = oldIds.size + added - items.length;

                App.allItems = items;
                UI.setItemsMap(items);

                // Pick up hashes the Duplicates window computed meanwhile
                const merged = Cache.syncFromDisk();

                if (removed > 0 && items.length > 0) {
                    Cache.removeOrphans(items.map(i => i.id));
                }

                if (added > 0) console.log(`App: ${added} new item(s) in library`);
                if (added > 0 || merged > 0 || removed > 0) {
                    App._runIndexing();
                    if (merged > 0 || removed > 0) App._refilterResults();
                }
            } while (App._refreshAgain);
        } catch (e) {
            console.warn('App: Library refresh failed:', e.message);
        } finally {
            App._refreshing = false;
        }
    },

    /* ---------------- Indexing ---------------- */

    /**
     * Index everything that is missing (pHash, then neural embeddings).
     * Safe to call any time: concurrent calls are coalesced into another pass.
     */
    async _runIndexing() {
        if (App._indexLoopActive) { App._indexPending = true; return; }
        App._indexLoopActive = true;
        try {
            do {
                App._indexPending = false;
                const items = App.allItems;
                let changed = false;

                // Phase 1: pHash + color histogram
                const needPhash = items.filter(it => Indexer.needsPhash(it)).length;
                if (needPhash > 0) {
                    const showProgress = needPhash > App.SMALL_BATCH;
                    Indexer._isRunning = true;
                    Indexer._shouldStop = false;
                    Indexer._phase = 'phash';
                    await Indexer._indexPhash(items, showProgress ? (processed, total, phase) => {
                        UI.showIndexingProgress(processed, total, phase);
                    } : null);
                    Indexer._isRunning = false;
                    Indexer._phase = null;
                    if (showProgress) UI.hideIndexingProgress();
                    changed = true;
                }

                if (!App.indexingDone) {
                    App.indexingDone = true;
                    console.log('App: pHash fully indexed');
                    if (App.autoSearchEnabled && App.lastSelectedId) {
                        const item = App.allItems.find(i => i.id === App.lastSelectedId);
                        if (item) { App.lastSearchedId = null; App.performSearch(item); changed = false; }
                    }
                }
                // Newly indexed images should show up in the current results right away
                if (changed) App._refilterResults();

                // Phase 2: neural embeddings
                if (App.clipReady) {
                    const needClip = items.filter(it => Indexer.needsEmbedding(it)).length;
                    if (needClip > 0) {
                        const showProgress = needClip > App.SMALL_BATCH;
                        Indexer._isRunning = true;
                        Indexer._shouldStop = false;
                        Indexer._phase = 'clip';
                        await Indexer._indexClip(items, showProgress ? (processed, total, phase) => {
                            UI.showIndexingProgress(processed, total, phase);
                        } : null);
                        Indexer._isRunning = false;
                        Indexer._phase = null;
                        if (showProgress) UI.hideIndexingProgress();
                        App._refilterResults();
                    }
                }
            } while (App._indexPending);
        } catch (e) {
            console.warn('App: Indexing error:', e.message);
            Indexer._isRunning = false;
            Indexer._phase = null;
            UI.hideIndexingProgress();
        } finally {
            App._indexLoopActive = false;
        }
    },

    /**
     * Initialize CLIP model in background
     * If it fails, the plugin continues with pHash only
     */
    async _initClip() {
        const statusEl = document.getElementById('clip-status');
        const aiBadge = document.getElementById('ai-badge');

        try {
            // Show loading status
            statusEl.classList.remove('hidden');
            document.getElementById('clip-status-text').textContent = 'Loading neural search model...';

            const modelCacheDir = nodePath.join(App.pluginPath, 'models');
            const ok = await Embedder.init(modelCacheDir);

            if (ok) {
                App.clipReady = true;
                document.getElementById('clip-status-text').textContent = 'Neural search ready ✓';
                statusEl.classList.add('ready');
                if (aiBadge) aiBadge.classList.remove('hidden');
                setTimeout(() => statusEl.classList.add('hidden'), 3000);

                // Index embeddings (coalesces with a running pHash pass)
                if (App.allItems.length > 0) {
                    App._runIndexing();
                }

                // Re-search with AI if we already have results
                if (App.lastSelectedId && App._lastResults) {
                    const item = App.allItems.find(i => i.id === App.lastSelectedId);
                    if (item) {
                        App.lastSearchedId = null;
                        App.performSearch(item);
                    }
                }
            } else {
                const errMsg = Embedder.getError() || 'unknown error';
                console.warn('App: CLIP not available:', errMsg);
                document.getElementById('clip-status-text').textContent = 'Neural model not available (pixel mode)';
                setTimeout(() => statusEl.classList.add('hidden'), 5000);
            }
        } catch (e) {
            console.warn('App: CLIP init error:', e.message);
            statusEl.classList.add('hidden');
        }
    },

    async _pollSelection() {
        try {
            const selected = await eagle.item.getSelected();
            if (selected && selected.length === 1) {
                const item = selected[0];
                if (item.id !== App.lastSelectedId) {
                    App.lastSelectedId = item.id;

                    // Item added after the plugin started: register it now, re-read the library shortly
                    if (UI._allItems && !UI._allItems.has(item.id)) {
                        UI._allItems.set(item.id, item);
                        App.allItems.push(item);
                        App._requestRefresh(App.NEW_ITEM_REFRESH_DELAY);
                    }

                    if (App.autoSearchEnabled) App.performSearch(item);
                }
            }
        } catch (e) {}
        setTimeout(() => App._pollSelection(), App.POLL_INTERVAL);
    },

    async performSearch(item) {
        if (App.isSearching) {
            // Don't drop the selection - run it once the current search finishes
            App._pendingSearch = item;
            return;
        }
        App.isSearching = true;
        UI.showLoading('Searching...');

        try {
            if (Indexer.getHashPaths(item).length === 0) {
                UI.showEmptyState('Cannot access image file');
                App.isSearching = false;
                UI.hideLoading();
                App._runPendingSearch();
                return;
            }

            // Pick up hashes the Duplicates window computed meanwhile (only a stat unless the file changed)
            Cache.syncFromDisk();

            const searchMode = App.getSearchMode();
            const queryData = {};
            const isImage = Indexer.isImageType(item.ext);

            // pHash: reuse the cached one, otherwise compute (thumbnail, then original file)
            if (Cache.hasValidHash(item.id)) {
                const cached = Cache.getHash(item.id);
                queryData.pHash = cached.pHash;
                queryData.colorHistogram = cached.colorHistogram;
            } else {
                const hashes = await Indexer.withFallback(item, p => Hasher.computeHashes(p));
                queryData.pHash = hashes.pHash;
                queryData.colorHistogram = hashes.colorHistogram;
                // Store it so this (new) image is immediately findable from other searches
                if (isImage) {
                    Cache.setHash(item.id, {
                        ...(Cache.getHash(item.id) || {}),
                        pHash: hashes.pHash,
                        colorHistogram: hashes.colorHistogram,
                        ext: item.ext
                    });
                }
            }

            // CLIP embedding if available (for hybrid mode)
            if (App.clipReady) {
                const c = Cache.getHash(item.id);
                if (c && c.embedding) {
                    queryData.embedding = c.embedding;
                } else {
                    try {
                        queryData.embedding = await Indexer.withFallback(item, p => Embedder.computeEmbedding(p));
                        const c2 = Cache.getHash(item.id);
                        if (isImage && c2 && !c2.embedding) {
                            Cache.setHash(item.id, { ...c2, embedding: queryData.embedding });
                        }
                    } catch (e) {
                        console.warn('App: CLIP embedding failed for query:', e.message);
                    }
                }
            }

            const cacheItems = Cache.getAllItems();
            const results = Similarity.findSimilar(
                queryData, cacheItems, App.threshold, App.resultCount, item.id, searchMode
            );

            App._lastResults = { queryData, excludeId: item.id, searchMode };
            App.lastSearchedId = item.id;
            UI.hideLoading();
            UI.renderResults(results);

        } catch (e) {
            console.warn('App: Search failed:', e.message);
            UI.hideLoading();
            UI.showEmptyState('Search failed: ' + e.message);
        }

        App.isSearching = false;
        App._runPendingSearch();
    },

    _runPendingSearch() {
        const pending = App._pendingSearch;
        App._pendingSearch = null;
        if (pending && pending.id === App.lastSelectedId) {
            App.performSearch(pending);
        }
    },

    _refilterResults() {
        if (!App._lastResults || App.isSearching) return;
        const { queryData, excludeId, searchMode } = App._lastResults;
        const mode = searchMode || App.getSearchMode();
        const cacheItems = Cache.getAllItems();
        const results = Similarity.findSimilar(
            queryData, cacheItems, App.threshold, App.resultCount, excludeId, mode
        );
        UI.renderResults(results);
    },

    _initControls() {
        // Open Duplicates Manager Window button
        const openDupsBtn = document.getElementById('open-duplicates-btn');
        if (openDupsBtn) {
            openDupsBtn.addEventListener('click', () => {
                App.openDuplicatesWindow();
            });
        }

        // Auto-toggle
        const toggleBtn = document.getElementById('auto-toggle');
        toggleBtn.addEventListener('click', () => {
            App.autoSearchEnabled = !App.autoSearchEnabled;
            toggleBtn.textContent = App.autoSearchEnabled ? 'ON' : 'OFF';
            toggleBtn.classList.toggle('active', App.autoSearchEnabled);
            App._saveSettings();
            if (App.autoSearchEnabled && App.lastSelectedId) {
                const item = App.allItems.find(i => i.id === App.lastSelectedId);
                if (item) App.performSearch(item);
            }
        });
        toggleBtn.textContent = App.autoSearchEnabled ? 'ON' : 'OFF';
        toggleBtn.classList.toggle('active', App.autoSearchEnabled);

        // Result count
        const resultSlider = document.getElementById('result-count');
        const resultLabel = document.getElementById('result-count-label');
        resultSlider.value = App.resultCount;
        resultLabel.textContent = App.resultCount;
        resultSlider.addEventListener('input', () => {
            App.resultCount = parseInt(resultSlider.value);
            resultLabel.textContent = App.resultCount;
        });
        resultSlider.addEventListener('change', () => {
            App._saveSettings();
            App._refilterResults();
        });

        // Threshold
        const thresholdSlider = document.getElementById('threshold');
        const thresholdLabel = document.getElementById('threshold-label');
        thresholdSlider.value = App.threshold;
        thresholdLabel.textContent = App.threshold;
        thresholdSlider.addEventListener('input', () => {
            App.threshold = parseInt(thresholdSlider.value);
            thresholdLabel.textContent = App.threshold;
            App._refilterResults();
        });
        thresholdSlider.addEventListener('change', () => App._saveSettings());

    },

    _initDropZone() {
        const body = document.body;
        const dropZone = document.getElementById('drop-zone');
        let dragCounter = 0;

        body.addEventListener('dragenter', (e) => {
            e.preventDefault(); dragCounter++;
            dropZone.classList.remove('hidden');
            dropZone.classList.add('drag-over');
        });
        body.addEventListener('dragleave', (e) => {
            e.preventDefault(); dragCounter--;
            if (dragCounter <= 0) { dragCounter = 0; dropZone.classList.remove('drag-over'); dropZone.classList.add('hidden'); }
        });
        body.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        body.addEventListener('drop', async (e) => {
            e.preventDefault(); dragCounter = 0;
            dropZone.classList.remove('drag-over'); dropZone.classList.add('hidden');
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                const f = files[0];
                const isImg = (f.type && f.type.startsWith('image/')) || Indexer.isImageType(f.name.split('.').pop().toLowerCase());
                if (isImg) App._searchByExternalFile(f.path);
            }
        });
    },

    async _searchByExternalFile(filePath) {
        if (App.isSearching || !filePath) return;
        App.isSearching = true;
        UI.showLoading('Searching by dropped image...');
        try {
            const searchMode = App.getSearchMode();
            const queryData = {};

            const h = await Hasher.computeHashes(filePath);
            queryData.pHash = h.pHash;
            queryData.colorHistogram = h.colorHistogram;

            if (App.clipReady) {
                try { queryData.embedding = await Embedder.computeEmbedding(filePath); } catch (e) {}
            }

            const results = Similarity.findSimilar(queryData, Cache.getAllItems(), App.threshold, App.resultCount, null, searchMode);
            App._lastResults = { queryData, excludeId: null, searchMode };
            UI.hideLoading();
            UI.renderResults(results);
        } catch (e) {
            UI.hideLoading();
            UI.showEmptyState('Failed to process dropped image');
        }
        App.isSearching = false;
    },

    _saveSettings() {
        try {
            localStorage.setItem('fbm_settings', JSON.stringify({
                autoSearchEnabled: App.autoSearchEnabled,
                resultCount: App.resultCount,
                threshold: App.threshold
            }));
        } catch (e) {}
    },

    _loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem('fbm_settings') || '{}');
            if (typeof s.autoSearchEnabled === 'boolean') App.autoSearchEnabled = s.autoSearchEnabled;
            if (typeof s.resultCount === 'number') App.resultCount = s.resultCount;
            if (typeof s.threshold === 'number') App.threshold = s.threshold;
        } catch (e) {}
    }
};

// Lifecycle
eagle.onPluginCreate(async (plugin) => { console.log('Find by Media: init'); await App.init(plugin); });
eagle.onPluginRun(() => {});
eagle.onPluginShow(() => {
    App._visible = true;
    if (App.pluginPath) App._requestRefresh(300);
});
eagle.onPluginHide(() => {
    App._visible = false;
    Cache.flush();
});
