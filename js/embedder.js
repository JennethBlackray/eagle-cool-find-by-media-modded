/**
 * embedder.js - Neural image embedding via ONNX Runtime WebGL
 *
 * Uses MobileNet V2 (ONNX opset 7) with WebGL backend for GPU-accelerated
 * image feature extraction. No WASM, no native addons — pure WebGL.
 *
 * WebGL backend avoids SharedArrayBuffer/WASM issues in Eagle's Chromium 107.
 * If loading fails, plugin continues with pHash only.
 */

var Embedder = {

    _session: null,
    _loading: false,
    _ready: false,
    _error: null,
    _ortLoaded: false,

    EMBEDDING_DIM: 1000,  // MobileNet V2 classification logits

    // ImageNet normalization constants
    _MEAN: [0.485, 0.456, 0.406],
    _STD:  [0.229, 0.224, 0.225],
    _INPUT_SIZE: 224,

    /**
     * Initialize the neural embedding model
     * @param {string} modelDir - Directory containing the ONNX model file
     * @returns {boolean} true if model loaded successfully
     */
    init: async function(modelDir) {
        if (Embedder._ready) return true;
        if (Embedder._loading) {
            // Wait for existing load to finish
            while (Embedder._loading) {
                await new Promise(function(r) { setTimeout(r, 200); });
            }
            return Embedder._ready;
        }

        Embedder._loading = true;
        Embedder._error = null;
        console.log('Embedder: Initializing MobileNet V2 (WebGL)...');

        try {
            // Step 1: Load onnxruntime-web WebGL bundle via <script> tag
            if (!Embedder._ortLoaded) {
                await Embedder._loadOrtScript();
            }

            // Step 2: Create inference session with WebGL provider
            var modelPath = modelDir + '/mobilenetv2-7.onnx';
            var modelUrl = 'file:///' + modelPath.replace(/\\/g, '/');

            console.log('Embedder: Loading model from', modelUrl);

            Embedder._session = await window.ort.InferenceSession.create(
                modelUrl,
                { executionProviders: ['webgl'] }
            );

            Embedder._ready = true;
            Embedder._loading = false;
            console.log('Embedder: MobileNet V2 ready (WebGL)');
            console.log('Embedder: Inputs:', Embedder._session.inputNames,
                        'Outputs:', Embedder._session.outputNames);
            return true;

        } catch (e) {
            console.warn('Embedder: Failed to initialize:', e.message);
            Embedder._error = e.message;
            Embedder._loading = false;
            return false;
        }
    },

    /**
     * Load ort.webgl.min.js via script tag injection
     * This registers window.ort with WebGL backend only (no WASM)
     */
    _loadOrtScript: function() {
        return new Promise(function(resolve, reject) {
            if (window.ort) {
                Embedder._ortLoaded = true;
                resolve();
                return;
            }

            try {
                // Locate the ort.webgl.min.js bundle in node_modules
                // require.resolve returns dist/ort-web.node.js, so we go up to the package root
                var ortMainPath = require.resolve('onnxruntime-web').replace(/\\/g, '/');
                // Strip everything after node_modules/onnxruntime-web/
                var ortDir = ortMainPath.replace(/(\/onnxruntime-web\/).*$/, '$1');
                var ortWebglPath = ortDir + 'dist/ort.webgl.min.js';
                var ortUrl = 'file:///' + ortWebglPath;

                console.log('Embedder: Loading ORT WebGL from', ortUrl);

                var script = document.createElement('script');
                script.src = ortUrl;

                script.onload = function() {
                    if (window.ort) {
                        Embedder._ortLoaded = true;
                        console.log('Embedder: ORT WebGL loaded, version:',
                                    window.ort.env && window.ort.env.versions
                                        ? window.ort.env.versions.common : 'unknown');
                        resolve();
                    } else {
                        reject(new Error('ort global not found after script load'));
                    }
                };

                script.onerror = function() {
                    reject(new Error('Failed to load ort.webgl.min.js'));
                };

                document.head.appendChild(script);
            } catch (e) {
                reject(new Error('Failed to resolve onnxruntime-web: ' + e.message));
            }
        });
    },

    isReady: function() {
        return Embedder._ready;
    },

    getError: function() {
        return Embedder._error;
    },

    /**
     * Compute embedding for an image file
     * @param {string} filePath - Path to the image file
     * @returns {number[]} L2-normalized embedding vector (1000-dim)
     */
    _queue: Promise.resolve(),

    /**
     * Serialized wrapper: an ONNX session must not run concurrently
     * (background indexing and an interactive search can overlap)
     */
    computeEmbedding: function(filePath) {
        var run = Embedder._queue.then(function() { return Embedder._computeEmbedding(filePath); });
        Embedder._queue = run.catch(function() {});
        return run;
    },

    _computeEmbedding: async function(filePath) {
        if (!Embedder._ready) {
            throw new Error('Embedder not initialized');
        }

        // Preprocess image to tensor
        var tensor = await Embedder._preprocessImage(filePath);

        // Run inference
        var inputName = Embedder._session.inputNames[0];
        var feeds = {};
        feeds[inputName] = tensor;

        var results = await Embedder._session.run(feeds);
        var outputName = Embedder._session.outputNames[0];
        var output = results[outputName];

        // Extract data and L2-normalize
        var data = Array.from(output.data);
        return Embedder._l2Normalize(data);
    },

    /**
     * Preprocess image for MobileNet V2:
     * 1. Load image via Canvas
     * 2. Resize to 224x224
     * 3. Convert RGBA to CHW float32
     * 4. Apply ImageNet normalization
     *
     * @param {string} filePath - Path to image
     * @returns {ort.Tensor} Input tensor [1, 3, 224, 224]
     */
    _preprocessImage: function(filePath) {
        var size = Embedder._INPUT_SIZE;
        var mean = Embedder._MEAN;
        var std = Embedder._STD;

        return new Promise(function(resolve, reject) {
            var img = new window.Image();
            var timeout = setTimeout(function() {
                img.onload = null;
                img.onerror = null;
                reject(new Error('Image load timeout'));
            }, 10000);

            img.onload = function() {
                clearTimeout(timeout);
                try {
                    // Draw to 224x224 canvas
                    var canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    var ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, size, size);
                    var imageData = ctx.getImageData(0, 0, size, size);
                    var pixels = imageData.data; // RGBA Uint8

                    // Convert to CHW float32 with ImageNet normalization
                    var totalPixels = size * size;
                    var float32Data = new Float32Array(3 * totalPixels);

                    for (var i = 0; i < totalPixels; i++) {
                        var base = i * 4;
                        // R channel -> index 0 * totalPixels + i
                        float32Data[i] = (pixels[base] / 255 - mean[0]) / std[0];
                        // G channel -> index 1 * totalPixels + i
                        float32Data[totalPixels + i] = (pixels[base + 1] / 255 - mean[1]) / std[1];
                        // B channel -> index 2 * totalPixels + i
                        float32Data[2 * totalPixels + i] = (pixels[base + 2] / 255 - mean[2]) / std[2];
                    }

                    var tensor = new window.ort.Tensor('float32', float32Data, [1, 3, size, size]);
                    resolve(tensor);
                } catch (err) {
                    reject(err);
                }
            };

            img.onerror = function() {
                clearTimeout(timeout);
                reject(new Error('Failed to load: ' + filePath));
            };

            img.src = Hasher.filePathToURL(filePath);
        });
    },

    /**
     * L2-normalize a vector
     * @param {number[]} vec - Input vector
     * @returns {number[]} Normalized vector
     */
    _l2Normalize: function(vec) {
        var sumSq = 0;
        for (var i = 0; i < vec.length; i++) {
            sumSq += vec[i] * vec[i];
        }
        var norm = Math.sqrt(sumSq);
        if (norm === 0) return vec;

        var result = new Array(vec.length);
        for (var i = 0; i < vec.length; i++) {
            result[i] = vec[i] / norm;
        }
        return result;
    }
};

window.Embedder = Embedder;
