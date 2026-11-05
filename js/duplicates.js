/**
 * duplicates.js - Standalone Duplicate Manager Window Controller
 * Full-library visual duplicate detection, side-by-side & overlay comparison,
 * parent:... variation set inspection & management, tag/metadata merging,
 * whitelist management, and batch auto-cleanup.
 */

const PARENT_TAG_REGEX = /^parent:(.+)$/i;

const DuplicateManager = {

    // State
    pluginPath: '',
    libraryPath: '',
    libraryName: '',
    itemsMap: new Map(),        // id -> Eagle Item object
    parentTagIndex: new Map(),  // lower(parent:xxx) -> { tag: string, items: Array<Item> }
    rawPairs: [],               // All scanned pairs >= scannedMinScore
    scannedMinScore: 1.0,       // Lowest threshold (0..1) scanned so far
    scannedMode: null,          // 'phash' | 'strict_phash'

    // Filtered & Paginated view data
    filteredPairs: [],
    filteredGroups: [],
    sameParentHiddenCount: 0,
    currentPage: 1,
    pageSize: 30,

    // User Controls State
    threshold: 95,              // 80..100 (%)
    viewMode: 'pairs',          // 'pairs' | 'groups'
    sortBy: 'score_desc',       // 'score_desc' | 'parent_first' | 'res_diff' | 'ext_diff' | 'tags_diff' | 'size_desc'
    sameAspectOnly: true,
    ignoreSameParent: true,     // Ignore pairs sharing the same parent:... tag (default ON)
    hideVariations: false,
    onlyDiffFormatRes: false,
    strictMode: false,

    // Parent Popover State
    _popoverHideTimer: null,
    _activePopoverTag: null,
    _activePopoverCurrentId: null,

    // Modal Comparison State
    modalOpen: false,
    modalMode: 'side',          // 'side' | 'overlay'
    modalPairIndex: -1,         // Index in filteredPairs
    modalLeftId: null,
    modalRightId: null,
    overlayShowingRight: false,
    zoomScale: 1,
    panX: 0,
    panY: 0,
    isDraggingPan: false,
    dragStartX: 0,
    dragStartY: 0,

    isBusy: false,

    async init(plugin) {
        this.pluginPath = (plugin && plugin.path) || (window.eagle && eagle.plugin && eagle.plugin.path) || __dirname;
        this._loadSettings();

        // Sync Theme with Eagle
        try {
            const theme = await eagle.app.theme;
            if (theme) document.body.dataset.theme = theme;
        } catch (e) {}
        if (window.eagle && eagle.onThemeChanged) {
            eagle.onThemeChanged((theme) => {
                document.body.dataset.theme = theme;
            });
        }

        this._bindUIEvents();
        this._initParentPopoverEvents();
        this._syncControlsUI();

        await this.loadAndScan(false);
    },

    /* ============================================================
       Parent Tag Extraction & Library-Wide Indexing
       ============================================================ */

    /**
     * Extract all parent:... tags from an item's tags array
     */
    _extractParentTags(tags) {
        if (!Array.isArray(tags) || tags.length === 0) return [];
        const result = [];
        for (const t of tags) {
            if (typeof t === 'string' && PARENT_TAG_REGEX.test(t.trim())) {
                result.push(t.trim());
            }
        }
        return result;
    },

    /**
     * Extract normal (non-parent) tags from an item's tags array
     */
    _extractNormalTags(tags) {
        if (!Array.isArray(tags) || tags.length === 0) return [];
        return tags.filter(t => typeof t === 'string' && !PARENT_TAG_REGEX.test(t.trim()));
    },

    /**
     * Rebuild index of all parent:... tags across active library items
     */
    _rebuildParentIndex() {
        this.parentTagIndex.clear();
        for (const item of this.itemsMap.values()) {
            const pTags = this._extractParentTags(item.tags);
            for (const pt of pTags) {
                const key = pt.toLowerCase();
                let entry = this.parentTagIndex.get(key);
                if (!entry) {
                    entry = { tag: pt, items: [] };
                    this.parentTagIndex.set(key, entry);
                }
                entry.items.push(item);
            }
        }

        // Re-enrich existing rawPairs so parent metadata stays in sync
        if (this.rawPairs && this.rawPairs.length > 0) {
            for (const p of this.rawPairs) {
                this._enrichPair(p);
            }
        }
    },

    /**
     * Get all active library items belonging to a specific parent:... tag
     */
    getParentSetItems(parentTag) {
        if (!parentTag) return [];
        const entry = this.parentTagIndex.get(String(parentTag).toLowerCase());
        return entry ? entry.items : [];
    },

    /* ============================================================
       Library Loading & All-Pairs Duplicate Scanning
       ============================================================ */

    /**
     * Load library items, index any new images, and run all-pairs duplicate scan
     */
    async loadAndScan(forceRescan = false) {
        if (this.isBusy) return;
        this.isBusy = true;

        try {
            this.showStatus('Loading Eagle library...', 5);

            try {
                const lib = await eagle.library.info();
                this.libraryPath = lib.path || '';
                this.libraryName = lib.name || 'default';
                Cache.init(this.pluginPath, this.libraryPath, this.libraryName);
            } catch (e) {
                Cache.init(this.pluginPath, '', 'default');
            }

            this.updateIgnoredCounter();

            // Fetch all items from Eagle
            let allItems = [];
            try {
                allItems = await eagle.item.get({
                    fields: [
                        'id', 'name', 'ext', 'width', 'height', 'size',
                        'tags', 'folders', 'url', 'annotation', 'star',
                        'importedAt', 'modifiedAt', 'thumbnailPath', 'filePath', 'isDeleted'
                    ]
                });
            } catch (e) {
                try {
                    allItems = await eagle.item.getAll();
                } catch (e2) {
                    allItems = [];
                }
            }

            this.itemsMap.clear();
            const imageItems = [];
            for (const item of allItems) {
                if (!item || item.isDeleted) continue;
                if (!Indexer.isImageType(item.ext)) continue;
                this.itemsMap.set(item.id, item);
                imageItems.push(item);
            }

            // Build parent:... tag index across all library items
            this._rebuildParentIndex();

            // Index any uncached images first
            const uncached = imageItems.filter(it => !Cache.hasValidHash(it.id));
            if (uncached.length > 0) {
                await Indexer._indexPhash(imageItems, (done, total) => {
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    this.showStatus(`Indexing new images: ${done} of ${total}`, pct);
                });
            }

            // Determine scan threshold
            const targetMinScore = Math.min((this.threshold - 1) / 100, 0.88);
            const mode = this.strictMode ? Similarity.MODE_STRICT_PHASH : Similarity.MODE_PHASH;

            if (forceRescan || this.rawPairs.length === 0 || targetMinScore < this.scannedMinScore || mode !== this.scannedMode) {
                await this._runAllPairsScan(Math.max(0.78, targetMinScore), mode);
            }

            this.hideStatus();
            this.applyFiltersAndRender();

        } catch (err) {
            console.error('DuplicateManager: loadAndScan error:', err);
            this.hideStatus();
            this.showToast('Scan error: ' + err.message);
        } finally {
            this.isBusy = false;
        }
    },

    async _runAllPairsScan(minScore, mode) {
        const cacheItems = Cache.getAllItems();
        this.showStatus('Scanning visual matches across library...', 0);

        const pairs = await Similarity.findAllDuplicates(
            cacheItems,
            this.itemsMap,
            { minScore, mode },
            (done, total) => {
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                this.showStatus(`Comparing fingerprints: ${done} / ${total}`, pct);
            }
        );

        // Enrich pairs with metadata & parent:... tag comparisons for instant filtering/sorting
        for (const p of pairs) {
            this._enrichPair(p);
        }

        this.rawPairs = pairs;
        this.scannedMinScore = minScore;
        this.scannedMode = mode;
    },

    /**
     * Precompute metadata differences and parent:... tag info on a pair object
     */
    _enrichPair(p) {
        const a = this.itemsMap.get(p.id1);
        const b = this.itemsMap.get(p.id2);
        if (!a || !b) return;

        const w1 = a.width || 1, h1 = a.height || 1;
        const w2 = b.width || 1, h2 = b.height || 1;
        const ratio1 = w1 / h1;
        const ratio2 = w2 / h2;
        p.aspectDiff = Math.abs(ratio1 - ratio2) / Math.max(ratio1, ratio2);

        const area1 = w1 * h1;
        const area2 = w2 * h2;
        p.resDiff = Math.abs(area1 - area2);
        p.sameDimensions = (w1 === w2 && h1 === h2);

        const ext1 = (a.ext || '').toLowerCase();
        const ext2 = (b.ext || '').toLowerCase();
        p.extDiff = ext1 !== ext2 ? 1 : 0;

        const tags1 = Array.isArray(a.tags) ? a.tags : [];
        const tags2 = Array.isArray(b.tags) ? b.tags : [];
        p.tagsDiff = Math.abs(tags1.length - tags2.length);
        p.maxFileSize = Math.max(a.size || 0, b.size || 0);

        // Parent tag analysis
        const pTagsA = this._extractParentTags(tags1);
        const pTagsB = this._extractParentTags(tags2);
        const lowerSetA = new Set(pTagsA.map(t => t.toLowerCase()));
        p.sameParentTag = pTagsB.some(t => lowerSetA.has(t.toLowerCase()));
        p.hasParentA = pTagsA.length > 0;
        p.hasParentB = pTagsB.length > 0;
        p.hasAnyParentTag = p.hasParentA || p.hasParentB;

        // Detect artist CG variation set:
        // Same dimensions, not 100% identical (<99.5%), same source website domain, different post URLs
        const dom1 = this._extractDomain(a.url);
        const dom2 = this._extractDomain(b.url);
        const sameDomainDiffPost = !!(dom1 && dom1 === dom2 && a.url !== b.url);
        p.isVariationSet = (p.score < 0.995 && p.pScore < 0.992 && p.sameDimensions && sameDomainDiffPost);
    },

    _extractDomain(url) {
        if (!url) return '';
        try {
            return new URL(url).hostname.replace(/^www\./, '');
        } catch (e) {
            return '';
        }
    },

    /**
     * Filter rawPairs according to current UI controls and render current page
     */
    async applyFiltersAndRender() {
        const neededMinScore = this.threshold / 100;
        const neededMode = this.strictMode ? Similarity.MODE_STRICT_PHASH : Similarity.MODE_PHASH;

        // If user lowered threshold below what was scanned or toggled strict mode, rescan first
        if (!this.isBusy && (neededMinScore < this.scannedMinScore || neededMode !== this.scannedMode)) {
            this.isBusy = true;
            try {
                await this._runAllPairsScan(Math.min(neededMinScore, 0.85), neededMode);
            } finally {
                this.isBusy = false;
                this.hideStatus();
            }
        }

        const minScoreNorm = (this.threshold - 0.05) / 100;
        const filtered = [];
        let sameParentHidden = 0;

        for (const p of this.rawPairs) {
            if (p.score < minScoreNorm) continue;
            if (!this.itemsMap.has(p.id1) || !this.itemsMap.has(p.id2)) continue;
            if (Cache.isPairIgnored(p.id1, p.id2)) continue;

            // Ignore pairs that share the same parent:... tag (including 100% pixel matches)
            if (p.sameParentTag && (this.ignoreSameParent || p.score >= 0.9995 || p.pScore === 1)) {
                if (this.ignoreSameParent) {
                    sameParentHidden++;
                    continue;
                }
            }

            if (this.sameAspectOnly && p.aspectDiff > 0.045) continue;
            if (this.hideVariations && p.isVariationSet) continue;
            if (this.onlyDiffFormatRes && !p.extDiff && p.sameDimensions) continue;

            filtered.push(p);
        }

        this.sameParentHiddenCount = sameParentHidden;

        // Sort filtered pairs
        this._sortPairs(filtered);
        this.filteredPairs = filtered;

        if (this.viewMode === 'groups') {
            this.filteredGroups = Similarity.buildGroups(filtered);
        } else {
            this.filteredGroups = [];
        }

        const totalUnits = this.viewMode === 'groups' ? this.filteredGroups.length : this.filteredPairs.length;
        const maxPage = Math.max(1, Math.ceil(totalUnits / this.pageSize));
        if (this.currentPage > maxPage) this.currentPage = maxPage;

        this._updateStatsBar();
        this._renderCurrentPage();
    },

    _sortPairs(pairs) {
        const s = this.sortBy;
        if (s === 'score_desc') {
            pairs.sort((a, b) => b.score - a.score || b.resDiff - a.resDiff);
        } else if (s === 'parent_first') {
            pairs.sort((a, b) => (b.hasAnyParentTag ? 1 : 0) - (a.hasAnyParentTag ? 1 : 0) || b.score - a.score);
        } else if (s === 'res_diff') {
            pairs.sort((a, b) => b.resDiff - a.resDiff || b.score - a.score);
        } else if (s === 'ext_diff') {
            pairs.sort((a, b) => b.extDiff - a.extDiff || b.resDiff - a.resDiff || b.score - a.score);
        } else if (s === 'tags_diff') {
            pairs.sort((a, b) => b.tagsDiff - a.tagsDiff || b.score - a.score);
        } else if (s === 'size_desc') {
            pairs.sort((a, b) => b.maxFileSize - a.maxFileSize || b.score - a.score);
        }
    },

    _updateStatsBar() {
        const summaryEl = document.getElementById('stats-summary');
        const totalImages = this.itemsMap.size;
        const pairCount = this.filteredPairs.length;
        const sameParentNote = this.sameParentHiddenCount > 0
            ? ` • Same-parent skipped: <strong>${this.sameParentHiddenCount}</strong>`
            : '';

        if (this.viewMode === 'groups') {
            summaryEl.innerHTML = `Library: <strong>${totalImages}</strong> images • Groups: <strong>${this.filteredGroups.length}</strong> (${pairCount} pairs)${sameParentNote}`;
        } else {
            summaryEl.innerHTML = `Library: <strong>${totalImages}</strong> images • Pairs found: <strong>${pairCount}</strong>${sameParentNote}`;
        }
        this.updateIgnoredCounter();
    },

    updateIgnoredCounter() {
        const count = Cache.getIgnoredCount();
        const countEl = document.getElementById('ignored-count');
        const resetBtn = document.getElementById('reset-ignored-btn');
        if (countEl) countEl.textContent = count;
        if (resetBtn) {
            resetBtn.classList.toggle('hidden', count === 0);
        }
    },

    /**
     * Render the current page of pairs or groups
     */
    _renderCurrentPage() {
        const listEl = document.getElementById('pairs-list');
        const emptyEl = document.getElementById('empty-state');
        const pageBar = document.getElementById('pagination-bar');

        this.hideParentPopover(true);
        listEl.innerHTML = '';

        const list = this.viewMode === 'groups' ? this.filteredGroups : this.filteredPairs;
        const total = list.length;

        if (total === 0) {
            emptyEl.classList.remove('hidden');
            pageBar.classList.add('hidden');
            return;
        }

        emptyEl.classList.add('hidden');
        pageBar.classList.remove('hidden');

        const startIdx = (this.currentPage - 1) * this.pageSize;
        const endIdx = Math.min(total, startIdx + this.pageSize);
        const slice = list.slice(startIdx, endIdx);

        const frag = document.createDocumentFragment();
        for (let i = 0; i < slice.length; i++) {
            const globalIdx = startIdx + i;
            if (this.viewMode === 'groups') {
                const card = this._createGroupCard(slice[i], globalIdx);
                if (card) frag.appendChild(card);
            } else {
                const card = this._createPairCard(slice[i], globalIdx);
                if (card) frag.appendChild(card);
            }
        }
        listEl.appendChild(frag);

        // Update pagination UI
        const maxPage = Math.max(1, Math.ceil(total / this.pageSize));
        document.getElementById('page-range').textContent = `${startIdx + 1}–${endIdx}`;
        document.getElementById('total-filtered').textContent = total;
        document.getElementById('page-indicator').textContent = `Page ${this.currentPage} of ${maxPage}`;
        document.getElementById('prev-page-btn').disabled = this.currentPage <= 1;
        document.getElementById('next-page-btn').disabled = this.currentPage >= maxPage;
    },

    /**
     * Determine which item in a list has the best technical quality
     * Priority: 1) Resolution (width*height), 2) Format (png > webp > jpg) & File size, 3) Tag count
     */
    _pickBestItem(items) {
        if (!items || items.length === 0) return null;
        const extRank = { png: 4, tif: 4, tiff: 4, bmp: 3, webp: 2, avif: 2, jpg: 1, jpeg: 1, gif: 1 };

        let best = items[0];
        for (let i = 1; i < items.length; i++) {
            const curr = items[i];
            if (this._compareTwoItems(curr, best, extRank) > 0) {
                best = curr;
            }
        }
        return best;
    },

    _compareTwoItems(a, b, extRank = { png: 4, webp: 2, jpg: 1, jpeg: 1 }) {
        const areaA = (a.width || 0) * (a.height || 0);
        const areaB = (b.width || 0) * (b.height || 0);
        if (areaA !== areaB) return areaA - areaB;

        const rankA = extRank[(a.ext || '').toLowerCase()] || 1;
        const rankB = extRank[(b.ext || '').toLowerCase()] || 1;
        if (rankA !== rankB) return rankA - rankB;

        const sizeA = a.size || 0;
        const sizeB = b.size || 0;
        if (Math.abs(sizeA - sizeB) > Math.max(sizeA, sizeB) * 0.03) {
            return sizeA - sizeB;
        }

        const tagsA = Array.isArray(a.tags) ? a.tags.length : 0;
        const tagsB = Array.isArray(b.tags) ? b.tags.length : 0;
        if (tagsA !== tagsB) return tagsA - tagsB;

        return (b.importedAt || 0) - (a.importedAt || 0);
    },

    /**
     * Build a DOM card for a 2-item Pair
     */
    _createPairCard(pair, pairIndex) {
        const itemA = this.itemsMap.get(pair.id1);
        const itemB = this.itemsMap.get(pair.id2);
        if (!itemA || !itemB) return null;

        const items = [itemA, itemB];
        const bestItem = this._pickBestItem(items);

        const pTagsA = this._extractParentTags(itemA.tags);
        const pTagsB = this._extractParentTags(itemB.tags);
        const hasParentA = pTagsA.length > 0;
        const hasParentB = pTagsB.length > 0;

        const card = document.createElement('div');
        card.className = 'pair-card' + ((hasParentA || hasParentB) ? ' pair-has-parent' : '');
        card.dataset.id1 = pair.id1;
        card.dataset.id2 = pair.id2;

        const scorePct = Math.round(pair.score * 1000) / 10;
        const pPct = Math.round(pair.pScore * 100);
        const cPct = Math.round(pair.cScore * 100);
        const pillClass = scorePct >= 99.5 ? 'exact' : (scorePct >= 95 ? 'high' : 'medium');

        const variationBadge = pair.isVariationSet
            ? `<span class="spec-chip" title="Same resolution & website domain, but different post URLs — likely an artist variation set">🎨 Possible variation set</span>`
            : '';

        // High-visibility header warning when parent:... tags are present
        let parentHeaderWarning = '';
        if (hasParentA && hasParentB) {
            if (pair.sameParentTag) {
                parentHeaderWarning = `<span class="parent-header-badge same" title="Both artworks share the same parent:... tag">🔗 Same parent set (${this._escapeHtml(pTagsA[0])})</span>`;
            } else {
                const countA = this.getParentSetItems(pTagsA[0]).length;
                const countB = this.getParentSetItems(pTagsB[0]).length;
                parentHeaderWarning = `<span class="parent-header-badge both" title="Both artworks belong to different parent:... sets! Hover over their parent tags below to compare sets.">⚠️ Two Parent Sets: Left ${this._escapeHtml(pTagsA[0])} (${countA}) vs Right ${this._escapeHtml(pTagsB[0])} (${countB})</span>`;
            }
        } else if (hasParentA || hasParentB) {
            const sideWithParent = hasParentA ? 'Left' : 'Right';
            const pTag = hasParentA ? pTagsA[0] : pTagsB[0];
            const setCount = this.getParentSetItems(pTag).length;
            const otherIsBest = (hasParentA && bestItem.id === itemB.id) || (hasParentB && bestItem.id === itemA.id);
            parentHeaderWarning = `<span class="parent-header-badge ${otherIsBest ? 'conflict' : 'single'}" title="Do not miss: the ${sideWithParent.toLowerCase()} artwork belongs to ${this._escapeHtml(pTag)} (${setCount} artworks in set)">⚠️ ${sideWithParent} has ${this._escapeHtml(pTag)} (${setCount} arts)${otherIsBest ? ' — Other side is higher quality!' : ''}</span>`;
        }

        card.innerHTML = `
            <div class="pair-card-header">
                <span class="score-pill ${pillClass}">${scorePct}% match</span>
                <span class="pair-subscore">Contours: ${pPct}% • Colors: ${cPct}%</span>
                ${variationBadge}
                ${parentHeaderWarning}
                <div class="pair-header-actions">
                    <button class="btn btn-sm btn-secondary act-compare" title="Open large comparison view (Side by Side / Overlay)">
                        🔍 Compare Large
                    </button>
                    <button class="btn btn-sm btn-secondary act-select-both" title="Select both images in Eagle">
                        🎯 Select Both in Eagle
                    </button>
                    <button class="btn btn-sm btn-ignore act-ignore" title="Remember that this pair is NOT a duplicate and hide it">
                        🙈 Not Duplicate
                    </button>
                </div>
            </div>
            <div class="pair-items-grid"></div>
        `;

        const grid = card.querySelector('.pair-items-grid');
        grid.appendChild(this._createItemBox(itemA, [itemB], bestItem.id === itemA.id, pairIndex));
        grid.appendChild(this._createItemBox(itemB, [itemA], bestItem.id === itemB.id, pairIndex));

        // Header actions
        card.querySelector('.act-compare').addEventListener('click', () => {
            this.openCompareModal(pairIndex, pair.id1, pair.id2, pair.score);
        });
        card.querySelector('.act-select-both').addEventListener('click', () => {
            this.selectInEagle([pair.id1, pair.id2]);
        });
        card.querySelector('.act-ignore').addEventListener('click', () => {
            Cache.ignorePair(pair.id1, pair.id2);
            this.showToast('Pair added to "Not Duplicate" list');
            this.applyFiltersAndRender();
        });

        return card;
    },

    /**
     * Build a DOM card for a multi-item Group (Cluster)
     */
    _createGroupCard(group, groupIndex) {
        const items = group.items.map(id => this.itemsMap.get(id)).filter(Boolean);
        if (items.length < 2) return null;

        const bestItem = this._pickBestItem(items);
        const anyHasParent = items.some(it => this._extractParentTags(it.tags).length > 0);

        const card = document.createElement('div');
        card.className = 'pair-card' + (anyHasParent ? ' pair-has-parent' : '');

        const maxPct = Math.round(group.maxScore * 1000) / 10;
        const minPct = Math.round(group.minScore * 1000) / 10;
        const scoreLabel = maxPct === minPct ? `${maxPct}%` : `${minPct}%–${maxPct}%`;

        const parentGroupBadge = anyHasParent
            ? `<span class="parent-header-badge single">⚠️ Group contains parent:... tags</span>`
            : '';

        card.innerHTML = `
            <div class="pair-card-header">
                <span class="score-pill high">Group: ${items.length} items (${scoreLabel})</span>
                <span class="pair-subscore">Connected pairs in group: ${group.pairCount}</span>
                ${parentGroupBadge}
                <div class="pair-header-actions">
                    <button class="btn btn-sm btn-secondary act-compare-group" title="Compare first two images in large modal">
                        🔍 Compare Large
                    </button>
                    <button class="btn btn-sm btn-secondary act-select-group" title="Select entire group in Eagle">
                        🎯 Select All (${items.length}) in Eagle
                    </button>
                    <button class="btn btn-sm btn-ignore act-ignore-group" title="Mark all pairs in this group as 'Not Duplicate'">
                        🙈 Ignore Group (Set)
                    </button>
                </div>
            </div>
            <div class="pair-items-grid"></div>
        `;

        const grid = card.querySelector('.pair-items-grid');
        for (const item of items) {
            const others = items.filter(it => it.id !== item.id);
            grid.appendChild(this._createItemBox(item, others, bestItem.id === item.id, 0, group));
        }

        card.querySelector('.act-compare-group').addEventListener('click', () => {
            this.openCompareModal(-1, items[0].id, items[1].id, group.maxScore);
        });
        card.querySelector('.act-select-group').addEventListener('click', () => {
            this.selectInEagle(items.map(it => it.id));
        });
        card.querySelector('.act-ignore-group').addEventListener('click', () => {
            for (const p of group.pairs) {
                Cache.ignorePair(p.id1, p.id2);
            }
            this.showToast(`Group of ${items.length} images hidden ("Not Duplicate")`);
            this.applyFiltersAndRender();
        });

        return card;
    },

    /**
     * Build the interactive Parent Tag Banner HTML & bind hover/click events
     */
    _createParentSectionElement(item, isNotRecommendedButHasParent = false) {
        const parentTags = this._extractParentTags(item.tags);
        if (parentTags.length === 0) return null;

        const container = document.createElement('div');
        container.className = 'parent-tags-section' + (isNotRecommendedButHasParent ? ' parent-attention-alert' : '');

        for (const pt of parentTags) {
            const setItems = this.getParentSetItems(pt);
            const count = setItems.length;

            const row = document.createElement('div');
            row.className = 'parent-alert-row';

            row.innerHTML = `
                <div class="parent-badge-trigger" data-parent-tag="${this._escapeHtml(pt)}" data-current-id="${this._escapeHtml(item.id)}" title="Hover to preview all ${count} artworks in ${this._escapeHtml(pt)}">
                    <span class="parent-badge-icon">🔗</span>
                    <span class="parent-badge-text">${this._escapeHtml(pt)}</span>
                    <span class="parent-badge-count">(${count} ${count === 1 ? 'art' : 'arts'})</span>
                    <span class="parent-badge-eye">👁 Preview</span>
                </div>
                <div class="parent-row-actions">
                    <button class="btn-parent-action btn-parent-select" title="Select all ${count} artworks of ${this._escapeHtml(pt)} in Eagle">
                        🎯
                    </button>
                    <button class="btn-parent-action btn-parent-delete-set" title="Delete entire ${this._escapeHtml(pt)} set (${count} artworks) to Eagle Trash in one click">
                        🗑 Delete Set (${count})
                    </button>
                </div>
            `;

            const trigger = row.querySelector('.parent-badge-trigger');
            trigger.addEventListener('mouseenter', () => {
                this.showParentPopover(pt, item.id, trigger);
            });
            trigger.addEventListener('mouseleave', () => {
                this.scheduleHideParentPopover();
            });
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showParentPopover(pt, item.id, trigger);
            });

            row.querySelector('.btn-parent-select').addEventListener('click', (e) => {
                e.stopPropagation();
                const ids = this.getParentSetItems(pt).map(it => it.id);
                if (ids.length > 0) this.selectInEagle(ids);
            });

            row.querySelector('.btn-parent-delete-set').addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.deleteParentSet(pt);
            });

            container.appendChild(row);
        }

        return container;
    },

    /**
     * Create an individual image box inside a Pair or Group card
     */
    _createItemBox(item, otherItems, isRecommended, pairIndex, groupObj = null) {
        const parentTags = this._extractParentTags(item.tags);
        const hasParent = parentTags.length > 0;
        const isNotRecommendedButHasParent = hasParent && !isRecommended;

        const box = document.createElement('div');
        box.className = 'item-box'
            + (isRecommended ? ' recommended' : '')
            + (hasParent ? ' has-parent-tag' : '')
            + (isNotRecommendedButHasParent ? ' parent-attention-needed' : '');

        const thumbSrc = Hasher.filePathToURL(item.thumbnailPath || item.filePath || '');
        const area = (item.width || 0) * (item.height || 0);
        const maxOtherArea = Math.max(...otherItems.map(o => (o.width || 0) * (o.height || 0)));
        const isBetterRes = area > maxOtherArea;

        const sizeBytes = item.size || 0;
        const maxOtherSize = Math.max(...otherItems.map(o => o.size || 0));
        const isBetterSize = sizeBytes > maxOtherSize * 1.05;

        const tags = Array.isArray(item.tags) ? item.tags : [];
        const normalTags = this._extractNormalTags(tags);
        const maxOtherTags = Math.max(...otherItems.map(o => Array.isArray(o.tags) ? o.tags.length : 0));
        const isBetterTags = tags.length > maxOtherTags;

        // Calculate how many new tags would be gained by merging from otherItems
        const myTagSet = new Set(tags);
        const gainedTags = new Set();
        for (const o of otherItems) {
            if (Array.isArray(o.tags)) {
                for (const t of o.tags) {
                    if (!myTagSet.has(t)) gainedTags.add(t);
                }
            }
        }

        // Calculate normal tags unique to THIS item (that otherItems don't have)
        const otherTagUnion = new Set();
        for (const o of otherItems) {
            if (Array.isArray(o.tags)) {
                for (const t of o.tags) otherTagUnion.add(t);
            }
        }
        const uniqueNormalHere = normalTags.filter(t => !otherTagUnion.has(t));

        const domain = this._extractDomain(item.url) || 'Local file';
        const sizeFormatted = this._formatSize(sizeBytes);
        const dimsFormatted = (item.width && item.height) ? `${item.width} × ${item.height}` : 'Unknown';

        const gainLabel = gainedTags.size > 0 ? `+${gainedTags.size} tags` : 'no tag loss';
        const keepBtnText = otherItems.length === 1
            ? `✅ Keep This (${gainLabel})`
            : `✅ Keep Only This (${gainLabel})`;

        const uniquePreviewHtml = uniqueNormalHere.length > 0
            ? `<span class="unique-tag">+${uniqueNormalHere.length} unique tags:</span> ${this._escapeHtml(uniqueNormalHere.slice(0, 8).join(', '))}${uniqueNormalHere.length > 8 ? '…' : ''}`
            : (normalTags.length > 0 ? this._escapeHtml(normalTags.slice(0, 8).join(', ')) : 'No regular tags');

        // Thumbnail parent badge
        let thumbParentBadgeHtml = '';
        if (hasParent) {
            const firstSetCount = this.getParentSetItems(parentTags[0]).length;
            thumbParentBadgeHtml = `<span class="parent-thumb-badge" title="${this._escapeHtml(parentTags.join(', '))} (${firstSetCount} artworks in set)">🔗 PARENT (${firstSetCount})</span>`;
        }

        box.innerHTML = `
            <div class="item-thumb-wrap" title="Click — large comparison | Middle-click — open in Eagle">
                <img src="${thumbSrc}" alt="" loading="lazy">
                ${isRecommended ? '<span class="best-badge">★ Best</span>' : ''}
                ${thumbParentBadgeHtml}
                <span class="ext-badge">${this._escapeHtml(item.ext || 'img')}</span>
            </div>
            <div class="item-details">
                <div class="item-title" title="${this._escapeHtml(item.name || '')}">${this._escapeHtml(item.name || item.id)}</div>
                <div class="specs-grid">
                    <span class="spec-chip ${isBetterRes ? 'better' : ''}" title="Image resolution">${dimsFormatted}</span>
                    <span class="spec-chip ${isBetterSize ? 'better' : ''}" title="File size">${sizeFormatted}</span>
                    <span class="spec-chip ${isBetterTags ? 'better' : ''}" title="Total tags on file">${tags.length} tags</span>
                </div>
                <div class="parent-slot"></div>
                <div class="item-source" title="${this._escapeHtml(item.url || '')}">
                    Source: <strong>${this._escapeHtml(domain)}</strong>
                    ${item.url ? `• <a href="#" class="open-url-link" data-url="${this._escapeHtml(item.url)}">Open Post ↗</a>` : ''}
                </div>
                <div class="item-tags-preview" title="${this._escapeHtml(tags.join(', '))}">
                    ${uniquePreviewHtml}
                </div>
                <div class="item-actions">
                    <button class="btn btn-sm btn-keep act-keep-merge" title="Transfer all missing tags, folders, URL, and notes from the other copy to this one, and move the other copy to Eagle Trash">
                        ${keepBtnText}
                    </button>
                    <button class="btn btn-sm btn-danger act-trash-this" title="Move this copy to Eagle Trash">
                        🗑 Trash
                    </button>
                    <button class="btn btn-sm btn-secondary act-open-eagle" title="Select and reveal this file in Eagle">
                        ↗ In Eagle
                    </button>
                </div>
            </div>
        `;

        // Insert prominent parent:... tag section if present
        const parentSlot = box.querySelector('.parent-slot');
        const parentSection = this._createParentSectionElement(item, isNotRecommendedButHasParent);
        if (parentSection) {
            parentSlot.replaceWith(parentSection);
        } else {
            parentSlot.remove();
        }

        // Thumbnail click -> compare modal; middle-click -> open in new Eagle window
        const thumbWrap = box.querySelector('.item-thumb-wrap');
        thumbWrap.addEventListener('mousedown', (e) => {
            if (e.button === 1) e.preventDefault();
        });
        thumbWrap.addEventListener('click', () => {
            const other = otherItems[0];
            if (other) {
                const pairScore = groupObj ? groupObj.maxScore : (this.filteredPairs[pairIndex]?.score || 1);
                this.openCompareModal(pairIndex, item.id, other.id, pairScore);
            }
        });
        thumbWrap.addEventListener('auxclick', async (e) => {
            if (e.button === 1) {
                e.preventDefault();
                if (window.eagle && eagle.item && eagle.item.open) {
                    await eagle.item.open(item.id, { window: true });
                }
            }
        });

        // External post URL link
        const urlLink = box.querySelector('.open-url-link');
        if (urlLink) {
            urlLink.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const url = urlLink.dataset.url;
                if (url && window.eagle && eagle.shell) {
                    eagle.shell.openExternal(url);
                }
            });
        }

        // Keep & Merge button
        box.querySelector('.act-keep-merge').addEventListener('click', async () => {
            await this.keepAndMerge(item.id, otherItems.map(o => o.id));
        });

        // Move this item to Trash
        box.querySelector('.act-trash-this').addEventListener('click', async () => {
            await this.moveItemToTrash(item.id);
        });

        // Open in Eagle
        box.querySelector('.act-open-eagle').addEventListener('click', () => {
            this.selectInEagle([item.id], true);
        });

        return box;
    },

    /* ============================================================
       Floating Parent Set Preview Popover & One-Click Set Deletion
       ============================================================ */

    _initParentPopoverEvents() {
        const popover = document.getElementById('parent-preview-popover');
        if (!popover) return;

        popover.addEventListener('mouseenter', () => {
            if (this._popoverHideTimer) {
                clearTimeout(this._popoverHideTimer);
                this._popoverHideTimer = null;
            }
        });

        popover.addEventListener('mouseleave', () => {
            this.scheduleHideParentPopover();
        });

        document.getElementById('popover-copy-tag-btn').addEventListener('click', () => {
            if (!this._activePopoverTag) return;
            if (window.eagle && eagle.clipboard && eagle.clipboard.writeText) {
                eagle.clipboard.writeText(this._activePopoverTag);
            } else if (navigator.clipboard) {
                navigator.clipboard.writeText(this._activePopoverTag);
            }
            this.showToast(`Copied "${this._activePopoverTag}" to clipboard`, true);
        });

        document.getElementById('popover-select-all-btn').addEventListener('click', () => {
            if (!this._activePopoverTag) return;
            const items = this.getParentSetItems(this._activePopoverTag);
            if (items.length > 0) {
                this.selectInEagle(items.map(it => it.id));
            }
        });

        document.getElementById('popover-trash-set-btn').addEventListener('click', async () => {
            if (!this._activePopoverTag) return;
            const tagToDelete = this._activePopoverTag;
            this.hideParentPopover(true);
            await this.deleteParentSet(tagToDelete);
        });
    },

    showParentPopover(parentTag, currentItemId, anchorEl) {
        if (this._popoverHideTimer) {
            clearTimeout(this._popoverHideTimer);
            this._popoverHideTimer = null;
        }

        const popover = document.getElementById('parent-preview-popover');
        const grid = document.getElementById('parent-popover-grid');
        if (!popover || !grid) return;

        this._activePopoverTag = parentTag;
        this._activePopoverCurrentId = currentItemId;

        const setItems = this.getParentSetItems(parentTag);
        document.getElementById('parent-popover-tag').textContent = parentTag;
        document.getElementById('parent-popover-count').textContent = `${setItems.length} ${setItems.length === 1 ? 'artwork' : 'artworks'} in set`;
        document.getElementById('popover-trash-set-btn').textContent = `🗑 Delete Entire Set (${setItems.length})`;

        grid.innerHTML = '';

        // Sort so current item is first, or by name/resolution
        const sorted = [...setItems].sort((a, b) => {
            if (a.id === currentItemId) return -1;
            if (b.id === currentItemId) return 1;
            return ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0));
        });

        for (const it of sorted) {
            const isCurrent = it.id === currentItemId;
            const thumbUrl = Hasher.filePathToURL(it.thumbnailPath || it.filePath || '');
            const dims = (it.width && it.height) ? `${it.width}×${it.height}` : '';
            const sizeStr = this._formatSize(it.size || 0);

            const card = document.createElement('div');
            card.className = 'popover-art-card' + (isCurrent ? ' is-current' : '');
            card.innerHTML = `
                <div class="popover-art-thumb" title="Click: Select in Eagle | Middle-click: Open in new window">
                    <img src="${thumbUrl}" alt="" loading="lazy">
                    ${isCurrent ? '<span class="popover-current-pill">THIS ART</span>' : ''}
                    <span class="popover-ext-pill">${this._escapeHtml((it.ext || '').toUpperCase())}</span>
                    <button class="popover-single-trash-btn" title="Trash only this variation">🗑</button>
                </div>
                <div class="popover-art-meta">
                    <div class="popover-art-name" title="${this._escapeHtml(it.name || '')}">${this._escapeHtml(it.name || it.id)}</div>
                    <div class="popover-art-specs">${dims} • ${sizeStr}</div>
                </div>
            `;

            const thumbEl = card.querySelector('.popover-art-thumb');
            thumbEl.addEventListener('mousedown', (e) => {
                if (e.button === 1) e.preventDefault();
            });
            thumbEl.addEventListener('click', (e) => {
                if (e.target.closest('.popover-single-trash-btn')) return;
                this.selectInEagle([it.id], true);
            });
            thumbEl.addEventListener('auxclick', async (e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    if (window.eagle && eagle.item && eagle.item.open) {
                        await eagle.item.open(it.id, { window: true });
                    }
                }
            });

            card.querySelector('.popover-single-trash-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.moveItemToTrash(it.id);
                // Refresh popover if more items remain in the set
                const remaining = this.getParentSetItems(parentTag);
                if (remaining.length > 0 && !popover.classList.contains('hidden')) {
                    this.showParentPopover(parentTag, currentItemId, anchorEl);
                } else {
                    this.hideParentPopover(true);
                }
            });

            grid.appendChild(card);
        }

        popover.classList.remove('hidden');

        // Position popover near anchorEl while keeping it inside viewport bounds
        if (anchorEl && anchorEl.getBoundingClientRect) {
            const rect = anchorEl.getBoundingClientRect();
            const popRect = popover.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;

            let top = rect.bottom + 6;
            if (top + popRect.height > vh - 12) {
                top = Math.max(12, rect.top - popRect.height - 6);
            }

            let left = rect.left;
            if (left + popRect.width > vw - 16) {
                left = Math.max(16, vw - popRect.width - 16);
            }

            popover.style.top = `${Math.round(top)}px`;
            popover.style.left = `${Math.round(left)}px`;
        }
    },

    scheduleHideParentPopover() {
        if (this._popoverHideTimer) clearTimeout(this._popoverHideTimer);
        this._popoverHideTimer = setTimeout(() => {
            this.hideParentPopover(true);
        }, 200);
    },

    hideParentPopover(immediate = false) {
        if (this._popoverHideTimer) {
            clearTimeout(this._popoverHideTimer);
            this._popoverHideTimer = null;
        }
        if (immediate) {
            const popover = document.getElementById('parent-preview-popover');
            if (popover) popover.classList.add('hidden');
            this._activePopoverTag = null;
            this._activePopoverCurrentId = null;
        }
    },

    /**
     * Delete (move to Eagle Trash) ALL artworks belonging to a parent:... tag in one click
     */
    async deleteParentSet(parentTag) {
        const setItems = [...this.getParentSetItems(parentTag)];
        if (setItems.length === 0) {
            this.showToast(`No active items found for ${parentTag}`);
            return;
        }

        try {
            let trashedCount = 0;
            for (const it of setItems) {
                try {
                    const eagleItem = await eagle.item.getById(it.id);
                    if (eagleItem) {
                        await eagleItem.moveToTrash();
                    }
                    this.itemsMap.delete(it.id);
                    Cache.removeItem(it.id);
                    trashedCount++;
                } catch (innerErr) {
                    console.warn('DuplicateManager: Failed to trash set item:', it.id, innerErr);
                }
            }

            this._rebuildParentIndex();
            this.showToast(`✓ Entire set ${parentTag} (${trashedCount} artworks) moved to Eagle Trash`, true);
            await this.applyFiltersAndRender();

            if (this.modalOpen) {
                if (!this.itemsMap.has(this.modalLeftId) || !this.itemsMap.has(this.modalRightId)) {
                    this._advanceOrCloseModalAfterAction();
                } else {
                    const p = this.filteredPairs[this.modalPairIndex];
                    this._renderCompareModalContent(p ? p.score : 1);
                }
            }
        } catch (err) {
            console.error('DuplicateManager: deleteParentSet error:', err);
            this.showToast('Error deleting parent set: ' + err.message);
        }
    },

    /* ============================================================
       Keep & Merge / Single Item Trash / Select in Eagle
       ============================================================ */

    /**
     * Keep `keepId`, merge all tags/folders/url/annotation from `removeIds` into `keepId`,
     * and move `removeIds` to Eagle Trash.
     * Smart parent:... handling:
     * - If `keepItem` has NO `parent:...` tag, it inherits `parent:...` from `removeIds`.
     * - If `keepItem` ALREADY has a `parent:...` tag, it keeps its own `parent:...` tag without mixing a conflicting second `parent:...` ID.
     */
    async keepAndMerge(keepId, removeIds, silent = false) {
        try {
            const keepItem = await eagle.item.getById(keepId);
            if (!keepItem) {
                if (!silent) this.showToast('Could not find kept file in Eagle');
                return false;
            }

            const existingKeepTags = Array.isArray(keepItem.tags) ? keepItem.tags : [];
            const keepHasParent = this._extractParentTags(existingKeepTags).length > 0;

            const mergedTags = new Set(existingKeepTags);
            const initialTagCount = mergedTags.size;
            const mergedFolders = new Set(Array.isArray(keepItem.folders) ? keepItem.folders : []);
            let newUrl = keepItem.url || '';
            let newAnnotation = keepItem.annotation || '';
            let newStar = keepItem.star || 0;

            let inheritedParent = keepHasParent;
            const toTrashItems = [];

            for (const remId of removeIds) {
                const remItem = await eagle.item.getById(remId);
                if (!remItem) continue;
                toTrashItems.push(remItem);

                if (Array.isArray(remItem.tags)) {
                    for (const t of remItem.tags) {
                        const isParent = PARENT_TAG_REGEX.test(String(t).trim());
                        if (isParent) {
                            // Only inherit a parent:... tag if kept item doesn't already have one
                            if (!inheritedParent) {
                                mergedTags.add(t);
                                inheritedParent = true;
                            }
                        } else {
                            mergedTags.add(t);
                        }
                    }
                }
                if (Array.isArray(remItem.folders)) {
                    for (const f of remItem.folders) mergedFolders.add(f);
                }
                if (!newUrl && remItem.url) {
                    newUrl = remItem.url;
                }
                if (remItem.annotation && !newAnnotation.includes(remItem.annotation)) {
                    newAnnotation = newAnnotation
                        ? `${newAnnotation}\n${remItem.annotation}`
                        : remItem.annotation;
                }
                if ((remItem.star || 0) > newStar) {
                    newStar = remItem.star;
                }
            }

            const addedTagsCount = mergedTags.size - initialTagCount;

            // Save merged metadata to kept item if anything changed
            if (
                addedTagsCount > 0 ||
                mergedFolders.size > (keepItem.folders ? keepItem.folders.length : 0) ||
                newUrl !== (keepItem.url || '') ||
                newAnnotation !== (keepItem.annotation || '') ||
                newStar !== (keepItem.star || 0)
            ) {
                keepItem.tags = Array.from(mergedTags);
                keepItem.folders = Array.from(mergedFolders);
                keepItem.url = newUrl;
                keepItem.annotation = newAnnotation;
                if (newStar > 0) keepItem.star = newStar;
                await keepItem.save();
            }

            // Update local itemsMap cache for kept item
            const localKept = this.itemsMap.get(keepId);
            if (localKept) {
                localKept.tags = Array.from(mergedTags);
                localKept.folders = Array.from(mergedFolders);
                localKept.url = newUrl;
                localKept.annotation = newAnnotation;
            }

            // Move duplicate items to Trash
            for (const remItem of toTrashItems) {
                await remItem.moveToTrash();
                this.itemsMap.delete(remItem.id);
                Cache.removeItem(remItem.id);
            }

            this._rebuildParentIndex();

            if (!silent) {
                const tagMsg = addedTagsCount > 0 ? ` (+${addedTagsCount} tags merged)` : '';
                this.showToast(`✓ Kept best file${tagMsg}, duplicate moved to Trash`, true);
                this.applyFiltersAndRender();
            }
            return true;
        } catch (err) {
            console.error('DuplicateManager: keepAndMerge failed:', err);
            if (!silent) this.showToast('Merge error: ' + err.message);
            return false;
        }
    },

    /**
     * Move a single item to Eagle Trash without merging
     */
    async moveItemToTrash(itemId) {
        try {
            const item = await eagle.item.getById(itemId);
            if (item) {
                await item.moveToTrash();
            }
            this.itemsMap.delete(itemId);
            Cache.removeItem(itemId);
            this._rebuildParentIndex();
            this.showToast('File moved to Eagle Trash', true);
            this.applyFiltersAndRender();
        } catch (err) {
            console.error('DuplicateManager: moveItemToTrash failed:', err);
            this.showToast('Delete error: ' + err.message);
        }
    },

    /**
     * Select item(s) in the main Eagle window
     */
    async selectInEagle(itemIds, openSingle = false) {
        try {
            if (window.eagle && eagle.item) {
                if (eagle.item.select) {
                    await eagle.item.select(itemIds);
                }
                if (openSingle && itemIds.length === 1 && eagle.item.open) {
                    await eagle.item.open(itemIds[0]);
                }
            }
            if (window.eagle && eagle.app && eagle.app.show) {
                await eagle.app.show();
            }
            this.showToast(`Selected ${itemIds.length} ${itemIds.length === 1 ? 'file' : 'files'} in Eagle`);
        } catch (err) {
            console.warn('DuplicateManager: selectInEagle error:', err);
        }
    },

    /* ============================================================
       Fullscreen Comparison Modal (Side-by-Side & Overlay Blink)
       ============================================================ */

    openCompareModal(pairIndex, id1, id2, score = 1) {
        const item1 = this.itemsMap.get(id1);
        const item2 = this.itemsMap.get(id2);
        if (!item1 || !item2) return;

        this.modalOpen = true;
        this.modalPairIndex = pairIndex;
        this.modalLeftId = id1;
        this.modalRightId = id2;
        this.overlayShowingRight = false;
        this.resetZoom();

        const modal = document.getElementById('compare-modal');
        modal.classList.remove('hidden');

        this._renderCompareModalContent(score);
    },

    _renderCompareModalContent(score) {
        const item1 = this.itemsMap.get(this.modalLeftId);
        const item2 = this.itemsMap.get(this.modalRightId);
        if (!item1 || !item2) {
            this.closeCompareModal();
            return;
        }

        const pct = Math.round((score || 1) * 1000) / 10;
        document.getElementById('compare-score-badge').textContent = `${pct}%`;

        const src1 = Hasher.filePathToURL(item1.filePath || item1.thumbnailPath || '');
        const src2 = Hasher.filePathToURL(item2.filePath || item2.thumbnailPath || '');

        document.getElementById('compare-img-left').src = src1;
        document.getElementById('compare-img-right').src = src2;

        const best = this._pickBestItem([item1, item2]);
        const badge1 = best.id === item1.id ? ' ★ BEST VERSION' : '';
        const badge2 = best.id === item2.id ? ' ★ BEST VERSION' : '';

        document.getElementById('pane-label-left').textContent = `[A] ${item1.name || item1.id}${badge1}`;
        document.getElementById('pane-label-right').textContent = `[B] ${item2.name || item2.id}${badge2}`;

        this._renderModalPaneMeta('pane-meta-left', item1, best.id !== item1.id);
        this._renderModalPaneMeta('pane-meta-right', item2, best.id !== item2.id);

        this._updateOverlayImage();

        // Prev / Next buttons state
        document.getElementById('compare-prev-pair').disabled = (this.modalPairIndex <= 0);
        document.getElementById('compare-next-pair').disabled = (this.modalPairIndex < 0 || this.modalPairIndex >= this.filteredPairs.length - 1);
    },

    _renderModalPaneMeta(containerId, item, isNotBest) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';

        const specsSpan = document.createElement('span');
        specsSpan.textContent = `${(item.ext || '').toUpperCase()} • ${item.width}×${item.height} • ${this._formatSize(item.size)} • ${(item.tags || []).length} tags`;
        el.appendChild(specsSpan);

        const parentSection = this._createParentSectionElement(item, isNotBest);
        if (parentSection) {
            el.appendChild(parentSection);
        }
    },

    _updateOverlayImage() {
        const item1 = this.itemsMap.get(this.modalLeftId);
        const item2 = this.itemsMap.get(this.modalRightId);
        if (!item1 || !item2) return;

        const activeItem = this.overlayShowingRight ? item2 : item1;
        const sideLabel = this.overlayShowingRight ? 'Image B (Right)' : 'Image A (Left)';
        const src = Hasher.filePathToURL(activeItem.filePath || activeItem.thumbnailPath || '');

        document.getElementById('compare-img-overlay').src = src;
        document.getElementById('overlay-current-label').textContent = `Currently showing: ${sideLabel} — ${activeItem.name}`;

        const metaOverlay = document.getElementById('pane-meta-overlay');
        metaOverlay.innerHTML = '';
        const specsSpan = document.createElement('span');
        specsSpan.textContent = `${sideLabel}: ${(activeItem.ext || '').toUpperCase()} • ${activeItem.width}×${activeItem.height} • ${this._formatSize(activeItem.size)} • ${(activeItem.tags || []).length} tags`;
        metaOverlay.appendChild(specsSpan);

        const parentSection = this._createParentSectionElement(activeItem, false);
        if (parentSection) {
            metaOverlay.appendChild(parentSection);
        }
    },

    closeCompareModal() {
        this.modalOpen = false;
        this.hideParentPopover(true);
        document.getElementById('compare-modal').classList.add('hidden');
        document.getElementById('compare-img-left').src = '';
        document.getElementById('compare-img-right').src = '';
        document.getElementById('compare-img-overlay').src = '';
    },

    navigateModalPair(delta) {
        const nextIdx = this.modalPairIndex + delta;
        if (nextIdx < 0 || nextIdx >= this.filteredPairs.length) return;
        const p = this.filteredPairs[nextIdx];
        this.modalPairIndex = nextIdx;
        this.modalLeftId = p.id1;
        this.modalRightId = p.id2;
        this.overlayShowingRight = false;
        this.resetZoom();
        this._renderCompareModalContent(p.score);
    },

    resetZoom() {
        this.zoomScale = 1;
        this.panX = 0;
        this.panY = 0;
        this._applyZoomTransform();
    },

    _applyZoomTransform() {
        const t = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoomScale})`;
        const imgL = document.getElementById('compare-img-left');
        const imgR = document.getElementById('compare-img-right');
        const imgO = document.getElementById('compare-img-overlay');
        if (imgL) imgL.style.transform = t;
        if (imgR) imgR.style.transform = t;
        if (imgO) imgO.style.transform = t;
    },

    /* ============================================================
       Batch Auto-Cleanup Dialog & Execution
       ============================================================ */

    openAutoResolveModal() {
        const modal = document.getElementById('auto-modal');
        modal.classList.remove('hidden');
        this._updateAutoResolvePreviewCount();
    },

    _getAutoResolveCandidatePairs() {
        const sel = document.getElementById('auto-min-score').value;
        const skipParent = document.getElementById('auto-skip-parent')?.checked ?? true;
        const minPct = sel === 'current' ? this.threshold : parseFloat(sel);
        const minNorm = (minPct - 0.05) / 100;

        return this.filteredPairs.filter(p => {
            if (p.score < minNorm) return false;
            if (p.sameParentTag) return false;
            if (skipParent && p.hasAnyParentTag) return false;
            return true;
        });
    },

    _updateAutoResolvePreviewCount() {
        const candidates = this._getAutoResolveCandidatePairs();
        const box = document.getElementById('auto-preview-count');
        box.innerHTML = `Pairs to be automatically processed: <strong>${candidates.length}</strong>`;
        document.getElementById('auto-confirm-btn').disabled = candidates.length === 0;
    },

    async runAutoResolve() {
        const candidates = this._getAutoResolveCandidatePairs();
        document.getElementById('auto-modal').classList.add('hidden');
        if (candidates.length === 0) return;

        this.isBusy = true;
        let resolvedCount = 0;

        try {
            for (let i = 0; i < candidates.length; i++) {
                const p = candidates[i];
                const itemA = this.itemsMap.get(p.id1);
                const itemB = this.itemsMap.get(p.id2);
                if (!itemA || !itemB) continue; // Already trashed in an earlier pair

                const pct = Math.round(((i + 1) / candidates.length) * 100);
                this.showStatus(`Auto-cleaning duplicates: ${i + 1} of ${candidates.length}...`, pct);

                const best = this._pickBestItem([itemA, itemB]);
                const worst = best.id === itemA.id ? itemB : itemA;

                const ok = await this.keepAndMerge(best.id, [worst.id], true);
                if (ok) resolvedCount++;
            }
        } finally {
            this.isBusy = false;
            this.hideStatus();
            this.showToast(`✓ Auto-cleanup complete! Processed duplicates: ${resolvedCount}`, true);
            this.applyFiltersAndRender();
        }
    },

    /* ============================================================
       UI Event Bindings & Settings Persistence
       ============================================================ */

    _bindUIEvents() {
        // Threshold slider & number input
        const slider = document.getElementById('threshold-slider');
        const numInput = document.getElementById('threshold-input');
        const presetBtns = document.querySelectorAll('.preset-btn');

        const setThreshold = (val) => {
            const clamped = Math.max(80, Math.min(100, parseFloat(val) || 95));
            this.threshold = clamped;
            slider.value = Math.max(85, clamped);
            numInput.value = clamped;
            presetBtns.forEach(b => {
                b.classList.toggle('active', parseFloat(b.dataset.val) === clamped);
            });
            this.currentPage = 1;
            this._saveSettings();
            this.applyFiltersAndRender();
        };

        slider.addEventListener('input', () => {
            numInput.value = slider.value;
        });
        slider.addEventListener('change', () => setThreshold(slider.value));
        numInput.addEventListener('change', () => setThreshold(numInput.value));
        presetBtns.forEach(btn => {
            btn.addEventListener('click', () => setThreshold(btn.dataset.val));
        });

        // View mode segmented buttons (Pairs vs Groups)
        const segBtns = document.querySelectorAll('#view-mode-control .seg-btn');
        segBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.viewMode = btn.dataset.mode;
                segBtns.forEach(b => b.classList.toggle('active', b === btn));
                this.currentPage = 1;
                this._saveSettings();
                this.applyFiltersAndRender();
            });
        });

        // Sort select
        const sortSel = document.getElementById('sort-select');
        sortSel.addEventListener('change', () => {
            this.sortBy = sortSel.value;
            this.currentPage = 1;
            this._saveSettings();
            this.applyFiltersAndRender();
        });

        // Checkboxes
        document.getElementById('filter-same-aspect').addEventListener('change', (e) => {
            this.sameAspectOnly = e.target.checked;
            this.currentPage = 1;
            this._saveSettings();
            this.applyFiltersAndRender();
        });
        document.getElementById('filter-ignore-same-parent').addEventListener('change', (e) => {
            this.ignoreSameParent = e.target.checked;
            this.currentPage = 1;
            this._saveSettings();
            this.applyFiltersAndRender();
        });
        document.getElementById('filter-hide-variations').addEventListener('change', (e) => {
            this.hideVariations = e.target.checked;
            this.currentPage = 1;
            this._saveSettings();
            this.applyFiltersAndRender();
        });
        document.getElementById('filter-only-diff-format-res').addEventListener('change', (e) => {
            this.onlyDiffFormatRes = e.target.checked;
            this.currentPage = 1;
            this._saveSettings();
            this.applyFiltersAndRender();
        });
        document.getElementById('filter-strict-mode').addEventListener('change', (e) => {
            this.strictMode = e.target.checked;
            this.currentPage = 1;
            this._saveSettings();
            this.applyFiltersAndRender();
        });

        // Rescan & Auto-resolve buttons
        document.getElementById('rescan-btn').addEventListener('click', () => {
            this.loadAndScan(true);
        });
        document.getElementById('auto-resolve-btn').addEventListener('click', () => {
            this.openAutoResolveModal();
        });

        // Reset ignored pairs
        document.getElementById('reset-ignored-btn').addEventListener('click', () => {
            Cache.clearIgnoredPairs();
            this.showToast('"Not Duplicate" list cleared');
            this.applyFiltersAndRender();
        });

        // Pagination
        document.getElementById('prev-page-btn').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this._renderCurrentPage();
                document.getElementById('main-container').scrollTop = 0;
            }
        });
        document.getElementById('next-page-btn').addEventListener('click', () => {
            const list = this.viewMode === 'groups' ? this.filteredGroups : this.filteredPairs;
            const maxPage = Math.ceil(list.length / this.pageSize);
            if (this.currentPage < maxPage) {
                this.currentPage++;
                this._renderCurrentPage();
                document.getElementById('main-container').scrollTop = 0;
            }
        });
        document.getElementById('page-size-select').addEventListener('change', (e) => {
            this.pageSize = parseInt(e.target.value, 10) || 30;
            this.currentPage = 1;
            this._renderCurrentPage();
        });

        // Auto-Resolve Modal controls
        document.getElementById('auto-min-score').addEventListener('change', () => {
            this._updateAutoResolvePreviewCount();
        });
        const autoSkipParentEl = document.getElementById('auto-skip-parent');
        if (autoSkipParentEl) {
            autoSkipParentEl.addEventListener('change', () => {
                this._updateAutoResolvePreviewCount();
            });
        }
        document.getElementById('auto-cancel-btn').addEventListener('click', () => {
            document.getElementById('auto-modal').classList.add('hidden');
        });
        document.getElementById('auto-confirm-btn').addEventListener('click', () => {
            this.runAutoResolve();
        });

        // Fullscreen Comparison Modal controls
        document.getElementById('compare-close-btn').addEventListener('click', () => this.closeCompareModal());
        document.getElementById('compare-reset-zoom').addEventListener('click', () => this.resetZoom());
        document.getElementById('compare-prev-pair').addEventListener('click', () => this.navigateModalPair(-1));
        document.getElementById('compare-next-pair').addEventListener('click', () => this.navigateModalPair(1));

        // Compare Mode Tabs (Side vs Overlay)
        const modeTabs = document.querySelectorAll('.compare-mode-tabs .mode-tab');
        modeTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                this.modalMode = tab.dataset.cmode;
                modeTabs.forEach(t => t.classList.toggle('active', t === tab));
                document.getElementById('compare-stage-side').classList.toggle('hidden', this.modalMode !== 'side');
                document.getElementById('compare-stage-overlay').classList.toggle('hidden', this.modalMode !== 'overlay');
            });
        });

        // Overlay toggle button & double-click on overlay viewport
        document.getElementById('overlay-toggle-btn').addEventListener('click', () => {
            this.overlayShowingRight = !this.overlayShowingRight;
            this._updateOverlayImage();
        });

        const overlayViewport = document.getElementById('viewport-overlay');
        overlayViewport.addEventListener('dblclick', () => {
            this.overlayShowingRight = !this.overlayShowingRight;
            this._updateOverlayImage();
        });

        // Synchronized Zoom & Pan on all viewports
        const viewports = [
            document.getElementById('viewport-left'),
            document.getElementById('viewport-right'),
            document.getElementById('viewport-overlay')
        ];

        for (const vp of viewports) {
            vp.addEventListener('wheel', (e) => {
                e.preventDefault();
                const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
                this.zoomScale = Math.max(0.5, Math.min(12, this.zoomScale * factor));
                this._applyZoomTransform();
            }, { passive: false });

            vp.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                this.isDraggingPan = true;
                this.dragStartX = e.clientX - this.panX;
                this.dragStartY = e.clientY - this.panY;
            });
        }

        window.addEventListener('mousemove', (e) => {
            if (!this.isDraggingPan) return;
            this.panX = e.clientX - this.dragStartX;
            this.panY = e.clientY - this.dragStartY;
            this._applyZoomTransform();
        });

        window.addEventListener('mouseup', () => {
            this.isDraggingPan = false;
        });

        // Modal Footer Actions
        document.getElementById('modal-keep-left').addEventListener('click', async () => {
            const left = this.modalLeftId, right = this.modalRightId;
            await this.keepAndMerge(left, [right]);
            this._advanceOrCloseModalAfterAction();
        });
        document.getElementById('modal-keep-right').addEventListener('click', async () => {
            const left = this.modalLeftId, right = this.modalRightId;
            await this.keepAndMerge(right, [left]);
            this._advanceOrCloseModalAfterAction();
        });
        document.getElementById('modal-trash-left').addEventListener('click', async () => {
            await this.moveItemToTrash(this.modalLeftId);
            this._advanceOrCloseModalAfterAction();
        });
        document.getElementById('modal-trash-right').addEventListener('click', async () => {
            await this.moveItemToTrash(this.modalRightId);
            this._advanceOrCloseModalAfterAction();
        });
        document.getElementById('modal-open-left').addEventListener('click', () => {
            this.selectInEagle([this.modalLeftId], true);
        });
        document.getElementById('modal-open-right').addEventListener('click', () => {
            this.selectInEagle([this.modalRightId], true);
        });
        document.getElementById('modal-ignore-pair').addEventListener('click', () => {
            Cache.ignorePair(this.modalLeftId, this.modalRightId);
            this.showToast('Pair hidden ("Not Duplicate")');
            this.applyFiltersAndRender();
            this._advanceOrCloseModalAfterAction();
        });

        // Keyboard shortcuts in modal
        window.addEventListener('keydown', (e) => {
            if (!this.modalOpen) return;
            if (e.key === 'Escape') {
                this.closeCompareModal();
            } else if (e.key === ' ') {
                e.preventDefault();
                this.overlayShowingRight = !this.overlayShowingRight;
                this._updateOverlayImage();
                if (this.modalMode !== 'overlay') {
                    document.querySelector('.mode-tab[data-cmode="overlay"]').click();
                }
            } else if (e.key === 'ArrowLeft') {
                this.navigateModalPair(-1);
            } else if (e.key === 'ArrowRight') {
                this.navigateModalPair(1);
            }
        });
    },

    _advanceOrCloseModalAfterAction() {
        if (this.filteredPairs.length === 0) {
            this.closeCompareModal();
            return;
        }
        const idx = Math.min(this.modalPairIndex, this.filteredPairs.length - 1);
        if (idx >= 0 && this.filteredPairs[idx]) {
            const p = this.filteredPairs[idx];
            this.modalPairIndex = idx;
            this.modalLeftId = p.id1;
            this.modalRightId = p.id2;
            this.resetZoom();
            this._renderCompareModalContent(p.score);
        } else {
            this.closeCompareModal();
        }
    },

    _syncControlsUI() {
        document.getElementById('threshold-slider').value = Math.max(85, this.threshold);
        document.getElementById('threshold-input').value = this.threshold;
        document.querySelectorAll('.preset-btn').forEach(b => {
            b.classList.toggle('active', parseFloat(b.dataset.val) === this.threshold);
        });
        document.querySelectorAll('#view-mode-control .seg-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === this.viewMode);
        });
        document.getElementById('sort-select').value = this.sortBy;
        document.getElementById('filter-same-aspect').checked = this.sameAspectOnly;
        const ignoreSameParentEl = document.getElementById('filter-ignore-same-parent');
        if (ignoreSameParentEl) ignoreSameParentEl.checked = this.ignoreSameParent;
        document.getElementById('filter-hide-variations').checked = this.hideVariations;
        document.getElementById('filter-only-diff-format-res').checked = this.onlyDiffFormatRes;
        document.getElementById('filter-strict-mode').checked = this.strictMode;
    },

    _saveSettings() {
        try {
            localStorage.setItem('fbm_dups_settings', JSON.stringify({
                threshold: this.threshold,
                viewMode: this.viewMode,
                sortBy: this.sortBy,
                sameAspectOnly: this.sameAspectOnly,
                ignoreSameParent: this.ignoreSameParent,
                hideVariations: this.hideVariations,
                onlyDiffFormatRes: this.onlyDiffFormatRes,
                strictMode: this.strictMode
            }));
        } catch (e) {}
    },

    _loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem('fbm_dups_settings') || '{}');
            if (typeof s.threshold === 'number') this.threshold = s.threshold;
            if (s.viewMode === 'pairs' || s.viewMode === 'groups') this.viewMode = s.viewMode;
            if (s.sortBy) this.sortBy = s.sortBy;
            if (typeof s.sameAspectOnly === 'boolean') this.sameAspectOnly = s.sameAspectOnly;
            if (typeof s.ignoreSameParent === 'boolean') this.ignoreSameParent = s.ignoreSameParent;
            if (typeof s.hideVariations === 'boolean') this.hideVariations = s.hideVariations;
            if (typeof s.onlyDiffFormatRes === 'boolean') this.onlyDiffFormatRes = s.onlyDiffFormatRes;
            if (typeof s.strictMode === 'boolean') this.strictMode = s.strictMode;
        } catch (e) {}
    },

    /* ============================================================
       Status Banner & Toast Helpers
       ============================================================ */

    showStatus(text, pct = 0) {
        const banner = document.getElementById('status-banner');
        banner.classList.remove('hidden');
        document.getElementById('status-text').textContent = text;
        document.getElementById('status-percent').textContent = `${pct}%`;
        document.getElementById('status-progress-bar').style.width = `${pct}%`;
    },

    hideStatus() {
        document.getElementById('status-banner').classList.add('hidden');
    },

    showToast(message, isSuccess = false) {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast' + (isSuccess ? ' success' : '');
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.25s';
            setTimeout(() => toast.remove(), 250);
        }, 3200);
    },

    _formatSize(bytes) {
        if (!bytes || bytes <= 0) return '0 KB';
        const kb = bytes / 1024;
        if (kb < 1024) return `${Math.round(kb)} KB`;
        return `${(kb / 1024).toFixed(2)} MB`;
    },

    _escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
};

// Eagle Plugin Lifecycle Hooks
if (window.eagle) {
    eagle.onPluginCreate(async (plugin) => {
        await DuplicateManager.init(plugin);
    });
    eagle.onPluginRun(() => {});
    eagle.onPluginShow(() => {});
    eagle.onPluginHide(() => {
        if (window.Cache) Cache.flush();
    });
}
