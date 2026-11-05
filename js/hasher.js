/**
 * hasher.js - Image hashing engine
 * Canvas-based pHash (via blockhash-js) + Color Histogram computation
 */

const { bmvbhash } = require('blockhash-core');

const Hasher = {

    PHASH_SIZE: 32,
    PHASH_BITS: 16,
    HIST_SIZE: 64,
    BINS_PER_CHANNEL: 4,

    /**
     * Convert a file path to a file:// URL with cache-busting
     */
    filePathToURL(filePath) {
        const normalized = filePath.replace(/\\/g, '/');
        const encoded = encodeURI(normalized).replace(/#/g, '%23');
        return `file:///${encoded}?v=${Math.random() * 101 | 0}`;
    },

    /**
     * Load an image and return canvas context + dimensions
     */
    loadImage(filePath, targetSize) {
        return new Promise((resolve, reject) => {
            const img = new window.Image();
            const timeout = setTimeout(() => {
                img.onload = null;
                img.onerror = null;
                reject(new Error('Image load timeout'));
            }, 10000);

            img.onload = () => {
                clearTimeout(timeout);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = targetSize;
                    canvas.height = targetSize;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, targetSize, targetSize);
                    const imageData = ctx.getImageData(0, 0, targetSize, targetSize);
                    resolve(imageData);
                } catch (err) {
                    reject(err);
                }
            };

            img.onerror = () => {
                clearTimeout(timeout);
                reject(new Error(`Failed to load: ${filePath}`));
            };

            img.src = Hasher.filePathToURL(filePath);
        });
    },

    /**
     * Compute perceptual hash using blockhash-js
     * Returns 64-char hex string (256 bits)
     */
    async computePHash(filePath) {
        const imageData = await Hasher.loadImage(filePath, Hasher.PHASH_SIZE);
        const hash = bmvbhash(
            { width: Hasher.PHASH_SIZE, height: Hasher.PHASH_SIZE, data: imageData.data },
            Hasher.PHASH_BITS
        );
        return hash;
    },

    /**
     * Compute color histogram (4x4x4 = 64 bins, normalized)
     * Returns array of 64 floats
     */
    async computeColorHistogram(filePath) {
        const imageData = await Hasher.loadImage(filePath, Hasher.HIST_SIZE);
        const data = imageData.data;
        const totalBins = Math.pow(Hasher.BINS_PER_CHANNEL, 3); // 64
        const histogram = new Float32Array(totalBins);
        let pixelCount = 0;

        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha < 128) continue; // skip transparent

            const rBin = Math.min(Math.floor(data[i] / 64), 3);
            const gBin = Math.min(Math.floor(data[i + 1] / 64), 3);
            const bBin = Math.min(Math.floor(data[i + 2] / 64), 3);
            const binIndex = rBin * 16 + gBin * 4 + bBin;
            histogram[binIndex]++;
            pixelCount++;
        }

        // Normalize
        if (pixelCount > 0) {
            for (let i = 0; i < totalBins; i++) {
                histogram[i] /= pixelCount;
            }
        }

        return Array.from(histogram);
    },

    /**
     * Compute both hashes for a given file
     * Returns { pHash: string, colorHistogram: number[] }
     */
    async computeHashes(filePath) {
        const [pHash, colorHistogram] = await Promise.all([
            Hasher.computePHash(filePath),
            Hasher.computeColorHistogram(filePath)
        ]);
        return { pHash, colorHistogram };
    }
};

// Expose globally
window.Hasher = Hasher;
