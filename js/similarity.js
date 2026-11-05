/**
 * similarity.js - Combined similarity scoring & Fast All-Pairs Duplicate Scanner
 * Supports: pHash, Color Histogram, CLIP Embedding, and hybrid modes
 */

// Precompute 16-bit popcount table for ultra-fast 256-bit Hamming distance
const POP16 = new Uint8Array(65536);
for (let i = 1; i < 65536; i++) {
    POP16[i] = POP16[i >> 1] + (i & 1);
}

const Similarity = {

    // Search modes
    MODE_PHASH: 'phash',               // pHash (60%) + color histogram (40%)
    MODE_STRICT_PHASH: 'strict_phash', // pHash (85%) + color histogram (15%) - stricter contour match
    MODE_CLIP: 'clip',                 // CLIP embedding only (semantic, AI-based)
    MODE_HYBRID: 'hybrid',             // All three combined (best quality)

    // Weights for hybrid mode
    PHASH_WEIGHT: 0.25,
    COLOR_WEIGHT: 0.15,
    CLIP_WEIGHT: 0.60,

    MAX_HAMMING_BITS: 256,

    /**
     * Compute Hamming distance between two hex hash strings
     */
    hammingDistance(hash1, hash2) {
        if (!hash1 || !hash2 || hash1.length !== hash2.length) {
            return Similarity.MAX_HAMMING_BITS;
        }
        let distance = 0;
        for (let i = 0; i < hash1.length; i++) {
            const n1 = parseInt(hash1[i], 16);
            const n2 = parseInt(hash2[i], 16);
            let xor = n1 ^ n2;
            while (xor) {
                distance += xor & 1;
                xor >>= 1;
            }
        }
        return distance;
    },

    /**
     * pHash similarity score (0 to 1)
     */
    pHashScore(hash1, hash2) {
        const dist = Similarity.hammingDistance(hash1, hash2);
        return 1 - (dist / Similarity.MAX_HAMMING_BITS);
    },

    /**
     * Cosine similarity between two histogram vectors (0 to 1)
     */
    histogramSimilarity(hist1, hist2) {
        if (!hist1 || !hist2 || hist1.length !== hist2.length) return 0;
        let dot = 0, mag1 = 0, mag2 = 0;
        for (let i = 0; i < hist1.length; i++) {
            dot += hist1[i] * hist2[i];
            mag1 += hist1[i] * hist1[i];
            mag2 += hist2[i] * hist2[i];
        }
        mag1 = Math.sqrt(mag1);
        mag2 = Math.sqrt(mag2);
        if (mag1 === 0 || mag2 === 0) return 0;
        return dot / (mag1 * mag2);
    },

    /**
     * CLIP embedding similarity (cosine, already normalized = dot product)
     * Returns 0 to 1 (remapped from [-1,1] range)
     */
    clipSimilarity(emb1, emb2) {
        if (!emb1 || !emb2 || emb1.length !== emb2.length) return 0;
        let dot = 0;
        for (let i = 0; i < emb1.length; i++) {
            dot += emb1[i] * emb2[i];
        }
        // Remap from [-1, 1] to [0, 1]
        return (Math.max(-1, Math.min(1, dot)) + 1) / 2;
    },

    /**
     * Combined score based on search mode
     */
    combinedScore(queryData, candidateData, mode) {
        if (mode === Similarity.MODE_CLIP) {
            if (!queryData.embedding || !candidateData.embedding) return 0;
            return Similarity.clipSimilarity(queryData.embedding, candidateData.embedding);
        }

        if (mode === Similarity.MODE_STRICT_PHASH) {
            const pScore = Similarity.pHashScore(queryData.pHash, candidateData.pHash);
            const cScore = Similarity.histogramSimilarity(queryData.colorHistogram, candidateData.colorHistogram);
            return 0.85 * pScore + 0.15 * cScore;
        }

        if (mode === Similarity.MODE_PHASH) {
            const pScore = Similarity.pHashScore(queryData.pHash, candidateData.pHash);
            const cScore = Similarity.histogramSimilarity(queryData.colorHistogram, candidateData.colorHistogram);
            return 0.6 * pScore + 0.4 * cScore;
        }

        // Hybrid mode: all three
        const pScore = (queryData.pHash && candidateData.pHash)
            ? Similarity.pHashScore(queryData.pHash, candidateData.pHash) : 0;
        const cScore = (queryData.colorHistogram && candidateData.colorHistogram)
            ? Similarity.histogramSimilarity(queryData.colorHistogram, candidateData.colorHistogram) : 0;
        const eScore = (queryData.embedding && candidateData.embedding)
            ? Similarity.clipSimilarity(queryData.embedding, candidateData.embedding) : 0;

        // If CLIP embedding is not available, fall back to pHash mode
        if (!queryData.embedding || !candidateData.embedding) {
            return 0.6 * pScore + 0.4 * cScore;
        }

        return Similarity.PHASH_WEIGHT * pScore +
               Similarity.COLOR_WEIGHT * cScore +
               Similarity.CLIP_WEIGHT * eScore;
    },

    /**
     * Find similar items from cache for a single query image
     */
    findSimilar(queryData, cacheItems, threshold, maxResults, excludeId, mode) {
        const results = [];
        const thresholdNorm = threshold / 100;
        const searchMode = mode || Similarity.MODE_PHASH;

        const ids = Object.keys(cacheItems);
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (id === excludeId) continue;

            const candidate = cacheItems[id];
            if (!candidate) continue;

            if (searchMode === Similarity.MODE_CLIP && !candidate.embedding) continue;
            if (searchMode !== Similarity.MODE_CLIP && !candidate.pHash) continue;

            const score = Similarity.combinedScore(queryData, candidate, searchMode);
            if (score >= thresholdNorm) {
                results.push({ id, score });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, maxResults);
    },

    /**
     * Fast all-pairs duplicate scanner across the entire library.
     * Pre-packs pHash into Uint32Array(N * 8) with hoisted registers and normalizes 64-bin histograms.
     *
     * @param {Object} cacheItems - Map of itemId -> { pHash, colorHistogram }
     * @param {Map} validItemsMap - Map of active (non-deleted) Eagle items
     * @param {Object} options - { minScore: 0.88, mode: 'phash' | 'strict_phash' }
     * @param {Function} onProgress - Callback (processedItems, totalItems)
     * @returns {Promise<Array>} Sorted array of duplicate pairs: { id1, id2, score, pScore, cScore }
     */
    async findAllDuplicates(cacheItems, validItemsMap, options = {}, onProgress = null) {
        const minScore = typeof options.minScore === 'number' ? options.minScore : 0.88;
        const mode = options.mode || Similarity.MODE_PHASH;
        const pWeight = mode === Similarity.MODE_STRICT_PHASH ? 0.85 : 0.60;
        const cWeight = mode === Similarity.MODE_STRICT_PHASH ? 0.15 : 0.40;

        // Filter to active items present in Eagle library that have valid 64-char pHash & 64-bin histogram
        const ids = [];
        const rawEntries = [];
        for (const [id, data] of Object.entries(cacheItems)) {
            if (!data || !data.pHash || data.pHash.length !== 64 || !data.colorHistogram || data.colorHistogram.length !== 64) {
                continue;
            }
            if (validItemsMap && !validItemsMap.has(id)) {
                continue;
            }
            ids.push(id);
            rawEntries.push(data);
        }

        const N = ids.length;
        if (N < 2) return [];

        // Pack 256-bit pHash into 8 x Uint32 per item & normalize 64-bin color histograms
        const hashes = new Uint32Array(N * 8);
        const normHists = new Float32Array(N * 64);

        for (let i = 0; i < N; i++) {
            const h = rawEntries[i].pHash;
            const baseH = i * 8;
            for (let j = 0; j < 8; j++) {
                hashes[baseH + j] = parseInt(h.substr(j * 8, 8), 16) >>> 0;
            }

            const hist = rawEntries[i].colorHistogram;
            let mag = 0;
            for (let j = 0; j < 64; j++) {
                mag += hist[j] * hist[j];
            }
            mag = Math.sqrt(mag) || 1;
            const baseC = i * 64;
            for (let j = 0; j < 64; j++) {
                normHists[baseC + j] = hist[j] / mag;
            }
        }

        // Compute maximum allowed Hamming distance for early-exit:
        const mathMinPScore = (minScore - cWeight) / pWeight;
        const structureMinPScore = minScore - 0.08;
        const effectiveMinPScore = Math.max(0.75, mathMinPScore, structureMinPScore);
        const maxHamming = Math.min(64, Math.ceil((1 - effectiveMinPScore) * 256));

        const pairs = [];
        const CHUNK_ITEMS = 1500;

        for (let i = 0; i < N; i++) {
            const baseHi = i * 8;
            const h0 = hashes[baseHi],     h1 = hashes[baseHi + 1], h2 = hashes[baseHi + 2], h3 = hashes[baseHi + 3];
            const h4 = hashes[baseHi + 4], h5 = hashes[baseHi + 5], h6 = hashes[baseHi + 6], h7 = hashes[baseHi + 7];
            const baseCi = i * 64;

            for (let j = i + 1; j < N; j++) {
                const baseHj = j * 8;

                // First 64 bits
                const x0 = h0 ^ hashes[baseHj];
                const x1 = h1 ^ hashes[baseHj + 1];
                let dist = POP16[x0 & 0xffff] + POP16[x0 >>> 16] + POP16[x1 & 0xffff] + POP16[x1 >>> 16];
                if (dist > maxHamming) continue;

                // Bits 64..127
                const x2 = h2 ^ hashes[baseHj + 2];
                const x3 = h3 ^ hashes[baseHj + 3];
                dist += POP16[x2 & 0xffff] + POP16[x2 >>> 16] + POP16[x3 & 0xffff] + POP16[x3 >>> 16];
                if (dist > maxHamming) continue;

                // Bits 128..191
                const x4 = h4 ^ hashes[baseHj + 4];
                const x5 = h5 ^ hashes[baseHj + 5];
                dist += POP16[x4 & 0xffff] + POP16[x4 >>> 16] + POP16[x5 & 0xffff] + POP16[x5 >>> 16];
                if (dist > maxHamming) continue;

                // Bits 192..255
                const x6 = h6 ^ hashes[baseHj + 6];
                const x7 = h7 ^ hashes[baseHj + 7];
                dist += POP16[x6 & 0xffff] + POP16[x6 >>> 16] + POP16[x7 & 0xffff] + POP16[x7 >>> 16];
                if (dist > maxHamming) continue;

                const pScore = 1 - (dist / 256);

                // Compute normalized histogram dot product
                const baseCj = j * 64;
                let cScore = 0;
                for (let k = 0; k < 64; k++) {
                    cScore += normHists[baseCi + k] * normHists[baseCj + k];
                }

                const score = pWeight * pScore + cWeight * cScore;
                if (score >= minScore) {
                    pairs.push({
                        id1: ids[i],
                        id2: ids[j],
                        score: Math.min(1, score),
                        pScore,
                        cScore: Math.min(1, cScore)
                    });
                }
            }

            if (i > 0 && i % CHUNK_ITEMS === 0) {
                if (onProgress) onProgress(i, N);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (onProgress) onProgress(N, N);
        pairs.sort((a, b) => b.score - a.score);
        return pairs;
    },

    /**
     * Group connected pairs into clusters (connected components)
     */
    buildGroups(filteredPairs) {
        const adj = new Map();

        for (const p of filteredPairs) {
            if (!adj.has(p.id1)) adj.set(p.id1, []);
            if (!adj.has(p.id2)) adj.set(p.id2, []);
            adj.get(p.id1).push({ neighbor: p.id2, pair: p });
            adj.get(p.id2).push({ neighbor: p.id1, pair: p });
        }

        const visited = new Set();
        const groups = [];

        for (const p of filteredPairs) {
            if (visited.has(p.id1)) continue;

            const queue = [p.id1];
            visited.add(p.id1);
            const compIds = [];
            let maxScore = 0;
            let minScore = 1;
            const compPairs = [];
            const seenPairs = new Set();

            while (queue.length > 0 && compIds.length < 12) {
                const curr = queue.shift();
                compIds.push(curr);
                const edges = adj.get(curr) || [];
                for (const edge of edges) {
                    const pKey = edge.pair.id1 < edge.pair.id2
                        ? `${edge.pair.id1}:${edge.pair.id2}`
                        : `${edge.pair.id2}:${edge.pair.id1}`;
                    if (!seenPairs.has(pKey)) {
                        seenPairs.add(pKey);
                        compPairs.push(edge.pair);
                        if (edge.pair.score > maxScore) maxScore = edge.pair.score;
                        if (edge.pair.score < minScore) minScore = edge.pair.score;
                    }
                    if (!visited.has(edge.neighbor) && compIds.length + queue.length < 12) {
                        visited.add(edge.neighbor);
                        queue.push(edge.neighbor);
                    }
                }
            }

            if (compIds.length >= 2) {
                groups.push({
                    items: compIds,
                    maxScore,
                    minScore,
                    pairCount: compPairs.length,
                    pairs: compPairs
                });
            }
        }

        groups.sort((a, b) => b.maxScore - a.maxScore);
        return groups;
    }
};

window.Similarity = Similarity;
