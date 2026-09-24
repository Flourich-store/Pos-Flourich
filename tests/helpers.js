'use strict';

/**
 * ============================================================
 * Helper pengujian lokal (tanpa dependensi eksternal)
 * Menjalankan logika Code.js dan blok <script> index.html
 * di dalam sandbox vm dengan mock Google Apps Script + stub DOM.
 * ============================================================
 */

/**
 * Mock API Google Apps Script (subset yang dipakai Code.js).
 */
function createGasMock() {
  const Logger = { logs: [], log: function (m) { this.logs.push(String(m)); } };

  function makeSheet(name, rows, opts) {
    const options = opts || {};
    const state = {
      name: name,
      rows: rows.map(r => r.slice()),
      failGetValues: !!(options && options.failGetValues),
      getValuesReturnsNonArray: !!(options && options.getValuesReturnsNonArray)
    };

    function rangeObj(row, col, numRows, numCols) {
      const hasShape = numRows !== undefined;
      return {
        getValues: () => {
          if (state.failGetValues) throw new Error('Simulasi gagal membaca sheet');
          if (state.getValuesReturnsNonArray) return { not: 'an array' };
          if (!hasShape) {
            return [[state.rows[row - 1] ? state.rows[row - 1][col - 1] : '']];
          }
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const r = state.rows[row - 1 + i];
            out.push(r ? r.slice() : []);
          }
          return out;
        },
        setValues: (vals) => {
          vals.forEach((rowVals, i) => {
            const r = row - 1 + i;
            if (!state.rows[r]) state.rows[r] = [];
            rowVals.forEach((v, j) => { state.rows[r][col - 1 + j] = v; });
          });
        },
        setValue: function (v) {
          if (!state.rows[row - 1]) state.rows[row - 1] = [];
          state.rows[row - 1][col - 1] = v;
          return this;
        },
        getValue: () => (state.rows[row - 1] ? state.rows[row - 1][col - 1] : '')
      };
    }

    const sheet = {
      getName: () => state.name,
      getDataRange: () => rangeObj(1, 1, state.rows.length, Math.max(1, ...state.rows.map(r => r.length))),
      getRange: (row, col, numRows, numCols) => rangeObj(row, col, numRows, numCols),
      getLastRow: () => state.rows.length,
      appendRow: (rowVals) => { state.rows.push(rowVals.slice()); return sheet; },
      __rows: () => state.rows.map(r => r.slice())
    };
    sheet.__state = state;
    return sheet;
  }

  /**
   * rowsProduk: array baris termasuk header.
   * Contoh: [['id','nama','stok','harga','foto_url'], ['1','Semangci 250 ml',50,15000,'']]
   */
  function createSpreadsheetMock(rowsProduk, opts) {
    const options = opts || {};
    const produkSheet = makeSheet('Produk', rowsProduk, options.produkSheet);
    const penjualanSheet = makeSheet('Penjualan',
      [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali', 'Modal', 'biayaOperasional', 'labaBersih']]);
    const userSheet = makeSheet('User', options.userRows || [
      ['username', 'password', 'role'],
      ['admin', 'password', 'SUPER_ADMIN'],
      ['kasir', 'kasir123', 'KASIR']
    ]);

    return {
      getSpreadsheetTimeZone: () => 'Asia/Jakarta',
      getSheetByName: (name) => {
        if (name === 'Produk') return options.noProdukSheet ? null : produkSheet;
        if (name === 'Penjualan') return options.noPenjualanSheet ? null : penjualanSheet;
        if (name === 'User') return userSheet;
        return null;
      },
      __produk: produkSheet,
      __penjualan: penjualanSheet,
      __user: userSheet,
      __props: {}
    };
  }

  const scriptRuntime = {
    props: {},          // isi via scriptRuntime.props['ENV'] = 'production'
    activeSpreadsheet: null
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in scriptRuntime.props ? scriptRuntime.props[k] : null),
      setProperty: (k, v) => { scriptRuntime.props[k] = String(v); },
      getProperties: () => Object.assign({}, scriptRuntime.props),
      deleteProperty: (k) => { delete scriptRuntime.props[k]; }
    })
  };

  const SpreadsheetApp = {
    openById: () => scriptRuntime.activeSpreadsheet || null,
    getActiveSpreadsheet: () => scriptRuntime.activeSpreadsheet
  };

  const DriveApp = {
    getFolderById: () => { throw new Error('DriveApp tidak tersedia di mock'); }
  };

  const Utilities = { formatDate: () => '' };
  const ScriptApp = {
    newTrigger: () => { throw new Error('ScriptApp tidak tersedia di mock'); }
  };

  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => {
      const out = { _text: String(text) };
      out.setMimeType = () => out;
      out.getContent = () => out._text;
      return out;
    }
  };

  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
    createTemplateFromFile: () => { throw new Error('HtmlService tidak tersedia di mock'); }
  };

  return {
    Logger, PropertiesService, SpreadsheetApp, DriveApp, Utilities, ScriptApp,
    ContentService, HtmlService, scriptRuntime, createSpreadsheetMock
  };
}

/**
 * Memuat Code.js ke dalam sandbox dengan mock GAS sebagai global.
 */
function loadBackend(gas) {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const code = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');

  const sandbox = {
    Logger: gas.Logger,
    PropertiesService: gas.PropertiesService,
    SpreadsheetApp: gas.SpreadsheetApp,
    DriveApp: gas.DriveApp,
    Utilities: gas.Utilities,
    ScriptApp: gas.ScriptApp,
    ContentService: gas.ContentService,
    HtmlService: gas.HtmlService,
    Session: { getActiveUser: () => ({ getEmail: () => '' }) },
    console: console
  };
  sandbox.globalThis = sandbox;

  vm.runInContext(code, vm.createContext(sandbox), { filename: 'Code.js' });

  return {
    sandbox: sandbox,
    prosesCheckout: sandbox.prosesCheckout,
    tambahStokProduk: sandbox.tambahStokProduk,
    checkLogin: sandbox.checkLogin,
    getProdukData: sandbox.getProdukData,
    getPenjualanData: sandbox.getPenjualanData,
    getInitialData: sandbox.getInitialData,
    doPost: sandbox.doPost,
    doGet: sandbox.doGet
  };
}

/**
 * Stub DOM + localStorage untuk menjalankan blok <script> index.html.
 */
function createDomStub() {
  const listeners = {};

  function makeElem(id) {
    const el = {
      id: id,
      value: '',
      innerHTML: '',
      innerText: '',
      textContent: '',
      style: {},
      dataset: {},
      classList: {
        _set: new Set(['hidden']),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
        toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
      },
      addEventListener(type, fn) { (listeners[id + ':' + type] = listeners[id + ':' + type] || []).push(fn); },
      appendChild() { },
      remove() { },
      focus() { },
      select() { },
      blur() { },
      querySelector() { return makeElem(id + '-child'); }
    };
    return el;
  }

  const elements = {};
  [
    'userInp', 'passInp', 'loginBtn', 'loginPage', 'mainPage', 'lblUsername',
    'selProduk', 'inpQty', 'selMetode', 'inpBayar', 'kembalianBox',
    'cartDisplay', 'txtGrandTotal', 'uangInputWrapper',
    'successModal', 'receiptModal', 'receiptContent',
    'filterStartDate', 'filterEndDate', 'filterSearch',
    'btnPrev', 'btnNext', 'pageInfo', 'runtimeNotice', 'runtimeNoticeMessage'
  ].forEach(id => { elements[id] = makeElem(id); });

  const doc = {
    getElementById: (id) => {
      // Elemen ad-hoc DI-CACHE agar setiap getElementById(id) mengembalikan
      // objek yang sama (perilaku DOM asli) — penting untuk badge antrian dll.
      if (!(id in elements)) elements[id] = makeElem(id);
      return elements[id];
    },
    querySelector: () => makeElem('tbody-stub'),
    addEventListener: (type, fn) => { (listeners['document:' + type] = listeners['document:' + type] || []).push(fn); },
    activeElement: null,
    body: makeElem('body'),
    createElement: (tag) => makeElem('created-' + tag)
  };

  function makeStorage() {
    const store = {};
    return {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear: () => { for (const k in store) delete store[k]; },
      __store: store
    };
  }

  const localStorage = makeStorage();
  const sessionStorage = makeStorage();

  const alerts = [];
  const confirms = [];
  const consoleLogs = [];
  const intervalHolder = { cb: null };
  const timeoutHolder = { pending: [] };

  const windowObj = {
    location: { protocol: 'file:' },
    google: { script: { run: {} } },
    localStorage,
    sessionStorage,
    confirm: (msg) => { confirms.push(msg); return true; },
    alert: (msg) => { alerts.push(String(msg)); },
    prompt: (msg) => (windowObj.__promptValue !== undefined ? windowObj.__promptValue : null),
    console: {
      log: (...a) => consoleLogs.push(['log', ...a].join(' ')),
      warn: (...a) => consoleLogs.push(['warn', ...a].join(' ')),
      error: (...a) => consoleLogs.push(['error', ...a].join(' '))
    },
    setTimeout: (fn, delayMs) => {
      // Eksekusi sinkron HANYA untuk delay pendek (<= 5000ms, mis. retry 2.5s & mock file: 100ms).
      // Timer panjang (mis. sesi 30 menit / print 300s... tidak, print 300ms ok) tidak dieksekusi
      // supaya tidak memicu logout otomatis dsb. saat pengujian.
      const d = typeof delayMs === 'number' ? delayMs : 0;
      if (d <= 5000) { fn(); return 0; }
      timeoutHolder.pending.push(fn);
      return timeoutHolder.pending.length;   // id palsu
    },
    clearTimeout: () => { },
    setInterval: (fn) => { intervalHolder.cb = fn; return 1; },
    clearInterval: () => { },
    navigator: { share: undefined, clipboard: { writeText: () => Promise.resolve() } },
    open: () => null,
    addEventListener: (type, fn) => { (listeners['window:' + type] = listeners['window:' + type] || []).push(fn); },
    __listeners: listeners,
    __elements: elements
  };
  windowObj.document = doc;
  Object.defineProperty(windowObj, '__lastIntervalCallback', {
    get: () => intervalHolder.cb,
    configurable: true
  });
  Object.defineProperty(windowObj, '__pendingTimeouts', {
    get: () => timeoutHolder.pending,
    configurable: true
  });

  return {
    window: windowObj,
    alerts,
    confirms,
    consoleLogs,
    localStorage,
    sessionStorage,
    triggerEvent: (scope, type) => {
      (listeners[scope + ':' + type] || []).forEach(fn => fn());
    }
  };
}

/**
 * Memuat blok <script> index.html ke sandbox window stub.
 * getInitialDataPayload (opsional) menimpa respon mock getInitialData
 * untuk mensimulasikan respon API yang rusak/tidak valid.
 */
function loadFrontend(dom, getInitialDataPayload) {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length < 3) throw new Error('index.html tidak memiliki 3 blok script seperti biasa');

  const w = dom.window;

  const sandbox = {
    window: w,
    document: w.document,
    localStorage: w.localStorage,
    sessionStorage: w.sessionStorage,
    confirm: w.confirm,
    alert: w.alert,
    console: w.console,
    setTimeout: w.setTimeout,
    clearTimeout: w.clearTimeout,
    setInterval: w.setInterval,
    clearInterval: w.clearInterval,
    navigator: w.navigator,
    location: w.location,
    event: undefined,
    prompt: w.prompt,
    fetch: undefined // diisi test bila perlu (pengujian apiRequest)
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);

  // Di browser, bare identifier `google` dan `window.google` adalah binding yang sama.
  // Di sandbox vm keduanya terpisah, jadi proxy lewat accessor agar selalu sinkron
  // (blok mock menimpa window.google dengan objek baru lalu memakai bare `google`).
  Object.defineProperty(sandbox, 'google', {
    get: () => w.google,
    set: (v) => { w.google = v; },
    configurable: true
  });

  // Hook untuk mengakses variabel `let/const` tingkat atas (cart, masterData, dataProduk, ...)
  // yang TIDAK menjadi properti globalThis di sandbox vm. Direct eval dari fungsi yang
  // dideklarasikan di global script masih bisa membaca/menulis global lexical bindings.
  const TEST_HOOK = [
    ';(function () {',
    '  globalThis.__testState = {',
    '    get: function (n) { try { return eval(n); } catch (e) { return undefined; } },',
    "    set: function (n, v) { eval(n + ' = v'); }",
    '  };',
    '})();'
  ].join('\n');

  // Blok 1: shim devtools; Blok 2: mock file:; Blok 3: aplikasi utama
  vm.runInContext(scripts[0], ctx, { filename: 'index.html#shim' });
  vm.runInContext(scripts[1], ctx, { filename: 'index.html#mock' });
  vm.runInContext(scripts[2] + TEST_HOOK, ctx, { filename: 'index.html#app' });

  if (getInitialDataPayload !== undefined) {
    w.google.script.run.getInitialData = function () { return getInitialDataPayload; };
  }

  return {
    sandbox: sandbox,
    call: (fnName, ...args) => {
      const fn = sandbox[fnName];
      if (typeof fn !== 'function') throw new Error('Fungsi ' + fnName + ' tidak diekspor ke global sandbox');
      return fn.apply(null, args);
    },
    get: (name) => {
      // Variabel let/const tingkat atas hanya terlihat lewat hook __testState
      if (sandbox.__testState) {
        const v = sandbox.__testState.get(name);
        if (v !== undefined) return v;
      }
      return sandbox[name];
    },
    set: (name, val) => {
      if (sandbox.__testState) {
        sandbox.__testState.set(name, val);
        return;
      }
      sandbox[name] = val;
    }
  };
}

/**
 * Runner mini: kumpul suite/test, jalankan berurutan, laporkan hasil.
 */
function createRunner() {
  const suites = [];
  let currentSuite = null;
  let failed = 0;
  let passed = 0;

  function suite(name, fn) {
    currentSuite = { name, tests: [] };
    suites.push(currentSuite);
    fn();
  }

  function test(name, fn) {
    currentSuite.tests.push({ name, fn });
  }

  function assertEq(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error((msg || 'assertEq gagal') +
        ' | actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
    }
  }

  function assertOk(value, msg) {
    if (!value) throw new Error((msg || 'assertOk gagal') + ' | actual=' + JSON.stringify(value));
  }

  function assertArray(v, msg) {
    if (!Array.isArray(v)) throw new Error((msg || 'Harus array') + ' | actual=' + JSON.stringify(v));
  }

  function assertIncludes(haystack, needle, msg) {
    if (typeof haystack !== 'string' || !haystack.includes(needle)) {
      throw new Error((msg || 'assertIncludes gagal') + ' | teks tidak memuat: ' + JSON.stringify(needle));
    }
  }

  function assertNotIncludes(haystack, needle, msg) {
    if (typeof haystack === 'string' && haystack.includes(needle)) {
      throw new Error((msg || 'assertNotIncludes gagal') + ' | teks seharusnya tidak memuat: ' + JSON.stringify(needle));
    }
  }

  function assertFalse(value, msg) {
    if (value) throw new Error((msg || 'assertFalse gagal') + ' | actual=' + JSON.stringify(value));
  }

  function assertDoesNotThrow(fn, msg) {
    try {
      fn();
    } catch (e) {
      throw new Error((msg || 'Seharusnya tidak melempar error') + ' | dilempar: ' + (e && e.message ? e.message : String(e)));
    }
  }

  async function run(label) {
    console.log('');
    for (const s of suites) {
      console.log('[' + s.name + ']');
      for (const t of s.tests) {
        try {
          await t.fn();
          passed++;
          console.log('  \u2713 ' + t.name);
        } catch (e) {
          failed++;
          console.log('  \u2717 ' + t.name);
          console.log('      ' + e.message);
        }
      }
    }
    console.log('');
    console.log('=== ' + label + ': ' + passed + ' lulus, ' + failed + ' gagal ===');
    return failed === 0;
  }

  return { suite, test, assertEq, assertOk, assertArray, assertIncludes, assertNotIncludes, assertFalse, assertDoesNotThrow, run };
}

module.exports = { createGasMock, loadBackend, createDomStub, loadFrontend, createRunner };
