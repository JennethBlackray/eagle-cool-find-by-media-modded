/**
 * indexer.js - Chunked async library indexing
 * Phase 1: pHash + color histogram (fast)
 * Phase 2: CLIP embeddings (slower, AI-based)
 */

const IMAGE_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg',
    'tiff', 'tif', 'ico', 'avif'
]);

const Indexer = {

    CHUNK_SIZE: 10,
    CHUNK_DELAY: 30,
    EMBED_CHUNK_SIZE: 3,   // WebGL inference ~100-300ms per image
    EMBED_CHUNK_DELAY: 50,

    _isRunning: false,
    _shouldStop: false,
    _phase: null,  // 'phash' or 'clip'
    _failures: new Map(),  // itemId -> failed attempts this session
    MAX_FAILURES: 3,

    isImageType(ext) {
        if (!ext) return false;
        return IMAGE_EXTENSIONS.has(ext.toLowerCase());
    },

    getHashPath(item) {
        if (item.thumbnailPath) return item.thumbnailPath;
        if (item.filePath) return item.filePath;
        return null;
    },

    /**
     * Candidate paths: thumbnail first (fast), original file as fallback
     * (Eagle generates thumbnails asynchronously, so fresh imports may not have one yet)
     */
    getHashPaths(item) {
        const paths = [];
        if (item.thumbnailPath) paths.push(item.thumbnailPath);
        if (item.filePath && item.filePath !== item.thumbnailPath) paths.push(item.filePath);
        return paths;
    },

    /**
     * Run fn(path) on each candidate path until one succeeds
     */
    async withFallback(item, fn) {
        const paths = Indexer.getHashPaths(item);
        let lastErr = new Error('No image path');
        for (const p of paths) {
            try {
                return await fn(p);
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr;
    },

    _markFailed(itemId) {
        Indexer._failures.set(itemId, (Indexer._failures.get(itemId) || 0) + 1);
    },

    /**
     * Items that keep failing are not retried by background indexing in this session
     */
    isGivenUp(itemId) {
        return (Indexer._failures.get(itemId) || 0) >= Indexer.MAX_FAILURES;
    },

    needsPhash(item) {
        return Indexer.isImageType(item.ext) && !Cache.hasValidHash(item.id) && !Indexer.isGivenUp(item.id);
    },

    needsEmbedding(item) {
        if (!Indexer.isImageType(item.ext) || Indexer.isGivenUp(item.id)) return false;
        const cached = Cache.getHash(item.id);
        return !!(cached && !cached.embedding);
    },

    /**
     * Full indexing: Phase 1 (pHash) then Phase 2 (CLIP)
     */
    async indexLibrary(items, onProgress) {
        if (Indexer._isRunning) {
            console.log('Indexer: Already running');
            return;
        }

        Indexer._isRunning = true;
        Indexer._shouldStop = false;

        // Phase 1: pHash + color histogram
        Indexer._phase = 'phash';
        await Indexer._indexPhash(items, onProgress);

        // Phase 2: CLIP embeddings (only if model is ready or can be loaded)
        if (!Indexer._shouldStop) {
            Indexer._phase = 'clip';
            await Indexer._indexClip(items, onProgress);
        }

        Indexer._isRunning = false;
        Indexer._phase = null;
        console.log('Indexer: All phases complete');
    },

    /**
     * Phase 1: Index pHash + color histogram
     */
    async _indexPhash(items, onProgress) {
        const toIndex = items.filter(item => Indexer.needsPhash(item));

        const totalImages = items.filter(item => Indexer.isImageType(item.ext)).length;

        if (toIndex.length === 0) {
            console.log('Indexer: Phase 1 (pHash) - all indexed');
            return;
        }

        console.log(`Indexer: Phase 1 - ${toIndex.length} items need pHash`);

        const validIds = items.map(item => item.id);
        Cache.removeOrphans(validIds);

        let processed = 0;
        const alreadyCached = totalImages - toIndex.length;

        if (onProgress) onProgress(alreadyCached, totalImages, 'phash');

        for (let i = 0; i < toIndex.length; i += Indexer.CHUNK_SIZE) {
            if (Indexer._shouldStop) break;

            const chunk = toIndex.slice(i, i + Indexer.CHUNK_SIZE);
            await Promise.all(chunk.map(async (item) => {
                try {
                    const hashes = await Indexer.withFallback(item, p => Hasher.computeHashes(p));
                    // Item may already have been hashed meanwhile (e.g. by a search) - keep its embedding
                    const existing = Cache.getHash(item.id) || {};
                    Cache.setHash(item.id, {
                        ...existing,
                        pHash: hashes.pHash,
                        colorHistogram: hashes.colorHistogram,
                        ext: item.ext
                    });
                } catch (err) {
                    Indexer._markFailed(item.id);
                }
            }));

            processed += chunk.length;
            if (onProgress) onProgress(alreadyCached + processed, totalImages, 'phash');
            await new Promise(r => setTimeout(r, Indexer.CHUNK_DELAY));
        }

        Cache.flush();
        console.log('Indexer: Phase 1 complete');
    },

    /**
     * Phase 2: Index CLIP embeddings
     */
    async _indexClip(items, onProgress) {
        // Check if neural model is available
        if (!Embedder.isReady()) {
            console.log('Indexer: Phase 2 - Neural model not loaded yet, skipping');
            return;
        }

        const toEmbed = items.filter(item => Indexer.needsEmbedding(item));

        const totalImages = items.filter(item => Indexer.isImageType(item.ext)).length;

        if (toEmbed.length === 0) {
            console.log('Indexer: Phase 2 (neural) - all embedded');
            return;
        }

        console.log(`Indexer: Phase 2 - ${toEmbed.length} items need neural embedding`);

        let processed = 0;
        const alreadyEmbedded = totalImages - toEmbed.length;

        if (onProgress) onProgress(alreadyEmbedded, totalImages, 'neural');

        for (let i = 0; i < toEmbed.length; i += Indexer.EMBED_CHUNK_SIZE) {
            if (Indexer._shouldStop) break;

            const chunk = toEmbed.slice(i, i + Indexer.EMBED_CHUNK_SIZE);

            // Process chunk items sequentially (GPU can only handle one at a time)
            for (const item of chunk) {
                if (Indexer._shouldStop) break;
                try {
                    const existingBefore = Cache.getHash(item.id);
                    if (existingBefore && existingBefore.embedding) { processed++; continue; }

                    const embedding = await Indexer.withFallback(item, p => Embedder.computeEmbedding(p));
                    const existing = Cache.getHash(item.id) || {};
                    Cache.setHash(item.id, {
                        ...existing,
                        embedding: embedding
                    });
                } catch (err) {
                    Indexer._markFailed(item.id);
                }
                processed++;
            }

            if (onProgress) onProgress(alreadyEmbedded + processed, totalImages, 'neural');
            await new Promise(r => setTimeout(r, Indexer.EMBED_CHUNK_DELAY));
        }

        Cache.flush();
        console.log('Indexer: Phase 2 complete');
    },

    stop() {
        Indexer._shouldStop = true;
    },

    isRunning() {
        return Indexer._isRunning;
    },

    getPhase() {
        return Indexer._phase;
    }
};

window.Indexer = Indexer;
