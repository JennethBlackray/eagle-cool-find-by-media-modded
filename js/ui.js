/**
 * ui.js - UI rendering and interaction
 * Grid, preview overlay, loading states, controls
 */

const UI = {

    _clickTimer: null,
    _allItems: null,
    _previewClickTimer: null,
    _currentPreviewItemId: null,

    /**
     * Store items map for result rendering
     */
    setItemsMap(items) {
        UI._allItems = new Map();
        for (const item of items) {
            UI._allItems.set(item.id, item);
        }
    },

    /**
     * Render similarity results as a thumbnail grid
     * @param {Array} results - Array of { id, score }
     */
    renderResults(results) {
        const grid = document.getElementById('results-grid');
        const emptyState = document.getElementById('empty-state');

        grid.innerHTML = '';

        if (!results || results.length === 0) {
            grid.classList.add('hidden');
            emptyState.classList.remove('hidden');
            document.getElementById('empty-text').textContent = 'No similar images found';
            return;
        }

        emptyState.classList.add('hidden');
        grid.classList.remove('hidden');

        for (const result of results) {
            const item = UI._allItems ? UI._allItems.get(result.id) : null;
            const cell = UI._createResultCell(result, item);
            grid.appendChild(cell);
        }
    },

    /**
     * Create a single result cell element
     */
    _createResultCell(result, item) {
        const cell = document.createElement('div');
        cell.className = 'result-cell';
        cell.dataset.itemId = result.id;

        // Thumbnail image
        const img = document.createElement('img');
        if (item && item.thumbnailPath) {
            img.src = Hasher.filePathToURL(item.thumbnailPath);
        } else if (item && item.filePath) {
            img.src = Hasher.filePathToURL(item.filePath);
        }
        img.alt = (item && item.name) || '';
        img.loading = 'lazy';
        img.onerror = () => {
            img.style.display = 'none';
        };
        cell.appendChild(img);

        // Score badge
        const badge = document.createElement('span');
        badge.className = 'score-badge';
        badge.textContent = `${Math.round(result.score * 100)}%`;
        cell.appendChild(badge);

        // Click handling: single = preview, double = navigate
        cell.addEventListener('click', (e) => {
            if (UI._clickTimer) {
                // Double click
                clearTimeout(UI._clickTimer);
                UI._clickTimer = null;
                UI._navigateToItem(result.id);
            } else {
                // Wait to see if it's a double click
                UI._clickTimer = setTimeout(() => {
                    UI._clickTimer = null;
                    UI._showPreview(result, item);
                }, 250);
            }
        });

        return cell;
    },

    /**
     * Show large preview overlay
     */
    _showPreview(result, item) {
        const overlay = document.getElementById('preview-overlay');
        const previewImg = document.getElementById('preview-img');
        const previewInfo = document.getElementById('preview-info');

        UI._currentPreviewItemId = result.id;

        if (item && item.filePath) {
            previewImg.src = Hasher.filePathToURL(item.filePath);
        } else if (item && item.thumbnailPath) {
            previewImg.src = Hasher.filePathToURL(item.thumbnailPath);
        }

        const name = (item && item.name) || 'Unknown';
        const score = Math.round(result.score * 100);
        const dims = (item && item.width && item.height)
            ? ` | ${item.width}x${item.height}`
            : '';
        previewInfo.textContent = `${name}${dims} | ${score}% similar`;

        overlay.classList.remove('hidden');
    },

    /**
     * Hide preview overlay
     */
    hidePreview() {
        document.getElementById('preview-overlay').classList.add('hidden');
        document.getElementById('preview-img').src = '';
        UI._currentPreviewItemId = null;
    },

    /**
     * Navigate to item in Eagle
     */
    async _navigateToItem(itemId) {
        try {
            // Eagle 4.0+ API
            if (eagle && eagle.item && eagle.item.open) {
                await eagle.item.open(itemId);
            }
        } catch (e) {
            console.warn('UI: Failed to navigate to item:', e.message);
        }
    },

    /**
     * Show loading indicator
     */
    showLoading(text) {
        const loading = document.getElementById('loading');
        const loadingText = document.getElementById('loading-text');
        loadingText.textContent = text || 'Searching...';
        loading.classList.remove('hidden');
    },

    /**
     * Hide loading indicator
     */
    hideLoading() {
        document.getElementById('loading').classList.add('hidden');
    },

    /**
     * Show indexing progress bar
     */
    showIndexingProgress(current, total, phase) {
        const bar = document.getElementById('indexing-bar');
        const progress = document.getElementById('indexing-progress');
        const text = document.getElementById('indexing-text');

        bar.classList.remove('hidden');
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        progress.style.width = `${pct}%`;
        const label = phase === 'clip' ? 'AI indexing' : 'Indexing';
        text.textContent = `${label}: ${current}/${total}`;
    },

    /**
     * Hide indexing progress bar
     */
    hideIndexingProgress() {
        document.getElementById('indexing-bar').classList.add('hidden');
    },

    /**
     * Show empty state message
     */
    showEmptyState(message) {
        const grid = document.getElementById('results-grid');
        const emptyState = document.getElementById('empty-state');
        const emptyText = document.getElementById('empty-text');

        grid.classList.add('hidden');
        grid.innerHTML = '';
        emptyState.classList.remove('hidden');
        emptyText.textContent = message;
    },

    /**
     * Update theme
     */
    updateTheme(theme) {
        document.body.dataset.theme = theme;
    },

    /**
     * Initialize preview overlay interactions
     * Single click anywhere = close preview
     * Double click = navigate to item in Eagle
     */
    initPreviewOverlay() {
        const overlay = document.getElementById('preview-overlay');

        overlay.addEventListener('click', (e) => {
            if (UI._previewClickTimer) {
                // Double click on preview -> navigate to item
                clearTimeout(UI._previewClickTimer);
                UI._previewClickTimer = null;
                if (UI._currentPreviewItemId) {
                    UI._navigateToItem(UI._currentPreviewItemId);
                }
                UI.hidePreview();
            } else {
                UI._previewClickTimer = setTimeout(() => {
                    UI._previewClickTimer = null;
                    UI.hidePreview();
                }, 250);
            }
        });

        // ESC key to dismiss
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                UI.hidePreview();
            }
        });
    }
};

window.UI = UI;
