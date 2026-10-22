'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const claspIgnore = fs.readFileSync(path.join(root, '.claspignore'), 'utf8');
const rootUrl = new URL('https://flourich-store.github.io/Pos-Flourich/');
const appVersionMeta = html.match(/<meta name="app-version" content="(\d+)">/);
const appVersionCode = html.match(/const VERSI_HTML = (\d+);/);
let passed = 0;
let failed = 0;

function test(name, run) {
  try {
    run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function assertIcon(src, size, purpose) {
  const declaration = manifest.icons.find((icon) =>
    icon.src === src &&
    icon.sizes === `${size}x${size}` &&
    icon.type === 'image/png' &&
    icon.purpose === purpose
  );
  assert.ok(declaration, `Manifest icon declaration missing for ${src}`);

  const iconPath = path.join(root, src.replace(/^\.\//, ''));
  const png = fs.readFileSync(iconPath);
  assert.deepStrictEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${src} must be a PNG`
  );
  assert.strictEqual(png.readUInt32BE(16), size, `${src} width`);
  assert.strictEqual(png.readUInt32BE(20), size, `${src} height`);
}

test('manifest has required install fields and relative URLs resolve to the app root', () => {
  assert.strictEqual(manifest.name, 'Flourich POS');
  assert.strictEqual(manifest.short_name, 'Flourich');
  assert.strictEqual(manifest.start_url, './');
  assert.strictEqual(manifest.scope, './');
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.theme_color, '#0d8a63');
  assert.strictEqual(manifest.background_color, '#f4f1ec');
  assert.strictEqual(new URL(manifest.start_url, rootUrl).pathname, '/Pos-Flourich/');
  assert.strictEqual(new URL(manifest.scope, rootUrl).pathname, '/Pos-Flourich/');
  assert.ok(!Object.hasOwn(manifest, 'orientation'));
  assert.ok(!Object.hasOwn(manifest, 'id'));
});

test('manifest icon entries point to PNG files with matching dimensions', () => {
  assertIcon('./icons/icon-192.png', 192, 'any');
  assertIcon('./icons/icon-512.png', 512, 'any');
  assertIcon('./icons/icon-maskable-512.png', 512, 'maskable');
});

test('index.html links the manifest, theme color, and local Apple touch icon', () => {
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.json">/);
  assert.match(html, /<meta name="theme-color" content="#0d8a63">/);
  assert.match(html, /<link rel="apple-touch-icon"[^>]*href="\.\/icons\/icon-192\.png"/s);
});

test('app-version metadata matches the VERSI_HTML constant', () => {
  assert.ok(appVersionMeta, 'app-version meta tag must exist');
  assert.ok(appVersionCode, 'VERSI_HTML constant must exist');
  assert.strictEqual(appVersionMeta[1], appVersionCode[1]);
  const workerCacheVersion = workerSource.match(/const CACHE_NAME = 'flourich-pos-v(\d+)';/);
  assert.ok(workerCacheVersion, 'service worker cache version must be declared');
  assert.strictEqual(workerCacheVersion[1], appVersionMeta[1]);
});

test('clasp ignores the PWA manifest, service worker, and icon folder', () => {
  assert.match(claspIgnore, /^manifest\.json$/m);
  assert.match(claspIgnore, /^sw\.js$/m);
  assert.match(claspIgnore, /^icons\/\*\*$/m);
});

test('service worker registration only targets the GitHub Pages app path', () => {
  assert.match(html, /window\.location\.hostname === 'flourich-store\.github\.io'/);
  assert.match(html, /window\.location\.pathname\.startsWith\('\/Pos-Flourich\/'\)/);
  assert.match(html, /register\('\.\/sw\.js', \{ scope: '\.\/' \}\)/);
  assert.match(html, /\.catch\(function \(error\) \{\s*console\.warn\('\[PWA\] Registrasi service worker dilewati:'/);
});

function createWorkerHarness() {
  const listeners = new Map();
  const stores = new Map();
  const fetchCalls = [];
  let fetchImplementation = async () => createResponse('online');
  let skipWaitingCalls = 0;
  let claimCalls = 0;
  const scope = 'https://flourich-store.github.io/Pos-Flourich/';

  function cacheFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      async match(key) {
        const normalized = typeof key === 'string' ? key : key.url;
        return entries.get(normalized);
      },
      async put(key, response) {
        const normalized = typeof key === 'string' ? key : key.url;
        entries.set(normalized, response.clone());
      }
    };
  }

  const cachesStub = {
    async open(name) {
      return cacheFor(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    }
  };

  const selfStub = {
    location: { origin: 'https://flourich-store.github.io' },
    registration: { scope },
    clients: {
      async claim() {
        claimCalls++;
      }
    },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    async skipWaiting() {
      skipWaitingCalls++;
    }
  };

  const context = {
    URL,
    Response: {
      error() {
        return createResponse('network-error', false);
      }
    },
    self: selfStub,
    caches: cachesStub,
    console: { warn() {} },
    fetch: async (request, options) => {
      fetchCalls.push({ request, options });
      return fetchImplementation(request, options);
    }
  };
  vm.runInNewContext(workerSource, context, { filename: 'sw.js' });

  function createResponse(body, ok = true) {
    return {
      body,
      ok,
      clone() {
        return createResponse(body, ok);
      }
    };
  }

  async function dispatchLifecycle(name) {
    let promise;
    listeners.get(name)({
      waitUntil(value) {
        promise = value;
      }
    });
    if (promise) await promise;
  }

  async function dispatchFetch(request) {
    let responsePromise;
    listeners.get('fetch')({
      request,
      respondWith(value) {
        responsePromise = value;
      }
    });
    return responsePromise ? await responsePromise : undefined;
  }

  return {
    caches: stores,
    fetchCalls,
    async dispatchActivate() {
      await dispatchLifecycle('activate');
    },
    dispatchFetch,
    async dispatchInstall() {
      await dispatchLifecycle('install');
    },
    get claimCalls() {
      return claimCalls;
    },
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
    setFetchImplementation(implementation) {
      fetchImplementation = implementation;
    }
  };
}

function request(url, method = 'GET', mode = 'cors') {
  return { url, method, mode };
}

async function testAsync(name, run) {
  try {
    await run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function createResponse(body, ok = true) {
  return {
    body,
    ok,
    clone() {
      return createResponse(body, ok);
    }
  };
}

async function runServiceWorkerTests() {
  await testAsync('service worker leaves API and font requests to the browser', async () => {
    const worker = createWorkerHarness();
    const apiResponse = await worker.dispatchFetch(request(
      'https://script.google.com/macros/s/deployment/exec', 'POST'
    ));
    const fontResponse = await worker.dispatchFetch(request(
      'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans'
    ));
    assert.strictEqual(apiResponse, undefined);
    assert.strictEqual(fontResponse, undefined);
    assert.strictEqual(worker.fetchCalls.length, 0);
  });

  await testAsync('service worker bypasses same-origin version-check requests', async () => {
    const worker = createWorkerHarness();
    const response = await worker.dispatchFetch(request(
      'https://flourich-store.github.io/Pos-Flourich/?_v=123'
    ));
    assert.strictEqual(response, undefined);
    assert.strictEqual(worker.fetchCalls.length, 0);
  });

  await testAsync('service worker bypasses non-GET requests', async () => {
    const worker = createWorkerHarness();
    const response = await worker.dispatchFetch(request(
      'https://flourich-store.github.io/Pos-Flourich/', 'POST', 'navigate'
    ));
    assert.strictEqual(response, undefined);
    assert.strictEqual(worker.fetchCalls.length, 0);
  });

  await testAsync('navigation is network-first and caches the latest online HTML', async () => {
    const worker = createWorkerHarness();
    worker.setFetchImplementation(async () => createResponse('fresh-html'));
    const response = await worker.dispatchFetch(request(
      'https://flourich-store.github.io/Pos-Flourich/', 'GET', 'navigate'
    ));
    assert.strictEqual(response.body, 'fresh-html');
    assert.strictEqual(worker.fetchCalls[0].options.cache, 'no-store');
    const cached = await worker.caches.get('flourich-pos-v95').get(
      'https://flourich-store.github.io/Pos-Flourich/'
    );
    assert.strictEqual(cached.body, 'fresh-html');
  });

  await testAsync('navigation uses cached HTML only when the network is offline', async () => {
    const worker = createWorkerHarness();
    const cache = await (async () => {
      const local = worker.caches;
      if (!local.has('flourich-pos-v95')) local.set('flourich-pos-v95', new Map());
      return local.get('flourich-pos-v95');
    })();
    cache.set('https://flourich-store.github.io/Pos-Flourich/', createResponse('offline-html'));
    worker.setFetchImplementation(async () => {
      throw new Error('offline');
    });
    const response = await worker.dispatchFetch(request(
      'https://flourich-store.github.io/Pos-Flourich/', 'GET', 'navigate'
    ));
    assert.strictEqual(response.body, 'offline-html');
  });

  await testAsync('activation deletes old Flourich caches and claims clients', async () => {
    const worker = createWorkerHarness();
    worker.caches.set('flourich-pos-v93', new Map());
    worker.caches.set('unrelated-cache', new Map());
    worker.caches.set('flourich-pos-v95', new Map());
    await worker.dispatchActivate();
    assert.deepStrictEqual([...worker.caches.keys()].sort(), [
      'flourich-pos-v95',
      'unrelated-cache'
    ]);
    assert.strictEqual(worker.claimCalls, 1);
  });

  await testAsync('QR uses network-first and replaces its cached copy when online', async () => {
    const worker = createWorkerHarness();
    const cache = await (async () => {
      if (!worker.caches.has('flourich-pos-v95')) worker.caches.set('flourich-pos-v95', new Map());
      return worker.caches.get('flourich-pos-v95');
    })();
    const qrUrl = 'https://flourich-store.github.io/Pos-Flourich/qris-flourich.png';
    cache.set(qrUrl, createResponse('old-qr'));
    worker.setFetchImplementation(async () => createResponse('new-qr'));
    const onlineResponse = await worker.dispatchFetch(request(qrUrl));
    assert.strictEqual(onlineResponse.body, 'new-qr');
    assert.strictEqual(worker.fetchCalls.length, 1);

    worker.setFetchImplementation(async () => {
      throw new Error('offline');
    });
    const offlineResponse = await worker.dispatchFetch(request(qrUrl));
    assert.strictEqual(offlineResponse.body, 'new-qr');
  });

  await testAsync('one precache failure does not abort worker installation', async () => {
    const worker = createWorkerHarness();
    worker.setFetchImplementation(async (url) => {
      if (String(url).endsWith('/qris-flourich.png')) throw new Error('offline');
      if (String(url).endsWith('/Pos-Flourich/')) return createResponse('precached-html');
      return createResponse('asset');
    });
    await worker.dispatchInstall();
    assert.strictEqual(worker.skipWaitingCalls, 1);
    assert.ok(worker.caches.has('flourich-pos-v95'));
    assert.strictEqual(
      worker.caches.get('flourich-pos-v95').get('https://flourich-store.github.io/Pos-Flourich/').body,
      'precached-html'
    );
  });

  await testAsync('static icons and logo are cache-first', async () => {
    const worker = createWorkerHarness();
    const cache = await (async () => {
      if (!worker.caches.has('flourich-pos-v95')) worker.caches.set('flourich-pos-v95', new Map());
      return worker.caches.get('flourich-pos-v95');
    })();
    const iconUrl = 'https://flourich-store.github.io/Pos-Flourich/icons/icon-192.png';
    cache.set(iconUrl, createResponse('cached-icon'));
    const response = await worker.dispatchFetch(request(iconUrl));
    assert.strictEqual(response.body, 'cached-icon');
    assert.strictEqual(worker.fetchCalls.length, 0);
  });

  await testAsync('HTTP error responses do not trigger stale navigation fallback', async () => {
    const worker = createWorkerHarness();
    if (!worker.caches.has('flourich-pos-v95')) worker.caches.set('flourich-pos-v95', new Map());
    worker.caches.get('flourich-pos-v95').set(
      'https://flourich-store.github.io/Pos-Flourich/',
      createResponse('stale-html')
    );
    worker.setFetchImplementation(async () => createResponse('server-error', false));
    const response = await worker.dispatchFetch(request(
      'https://flourich-store.github.io/Pos-Flourich/', 'GET', 'navigate'
    ));
    assert.strictEqual(response.body, 'server-error');
  });
}

runServiceWorkerTests().then(() => {
  console.log(`PWA: ${passed} lulus, ${failed} gagal`);
  if (failed > 0) process.exitCode = 1;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
