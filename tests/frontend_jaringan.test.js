'use strict';

/**
 * ============================================================
 * Pengujian lokal — Ketahanan jaringan checkout & API
 * Regresi bug nyata: "Checkout gagal: Failed to fetch" — jalur POST
 * ke web app Google Apps Script bisa gagal sesaat (jaringan mobile /
 * jalur redirect script.googleusercontent.com), padahal GET normal.
 * Perbaikan yang diuji:
 *  1. apiRequest: timeout + retry otomatis 3x + pesan error ramah.
 *  2. Fallback jalur GET untuk aksi BACA (getInitialData, checkLogin).
 *  3. doGet backend menolak aksi TULIS (prosesCheckout, tambahStokProduk).
 *  4. Error bisnis dari server TIDAK di-retry (tampil apa adanya).
 * ============================================================
 */

const { createGasMock, loadBackend, createDomStub, loadFrontend, createRunner } = require('./helpers');

const r = createRunner();

const PRODUK_VALID = [
  ['id', 'nama', 'stok', 'harga', 'foto_url'],
  ['1', 'Semangci 250 ml', 50, 15000, ''],
  ['2', 'Wonapel 250 ml', 30, 14000, '']
];

// ---------- util frontend ----------

/**
 * Muat frontend lalu aktifkan jalur apiRequest (bukan mock file:).
 * fetchStub(url, opts) dipasang sebagai `fetch` di sandbox dan merekam panggilan.
 */
function loadJaringanSkenario(fetchStub) {
  const dom = createDomStub();
  const app = loadFrontend(dom);
  dom.window.location.protocol = 'https:'; // keluar dari mode file: agar safeGoogleRun -> apiRequest

  const panggilan = [];
  app.sandbox.fetch = function (url, opts) {
    panggilan.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return fetchStub(url, opts, panggilan.length);
  };
  return { dom, app, panggilan };
}

async function tangkapError(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

// ============================================================
// BACKEND: doGet (fallback GET) + proteksi aksi tulis
// ============================================================

r.suite('Backend — doGet fallback GET (aksi baca)', () => {

  r.test('doGet getInitialData mengembalikan JSON data lengkap', () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    const out = backend.doGet({ parameter: { action: 'getInitialData' } });
    const payload = JSON.parse(out.getContent());

    r.assertArray(payload.produk, 'produk berupa array');
    r.assertEq(payload.produk.length, 3, 'header + 2 produk');
    r.assertArray(payload.penjualan, 'penjualan berupa array');
  });

  r.test('doGet checkLogin valid mengembalikan status login', () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    const out = backend.doGet({ parameter: { action: 'checkLogin', args: JSON.stringify(['admin', 'password']) } });
    const payload = JSON.parse(out.getContent());
    r.assertEq(payload.status, true, 'login sukses lewat GET');
    r.assertEq(payload.role, 'SUPER_ADMIN', 'role ikut dikembalikan');
  });

  r.test('REGRESI KEAMANAN: doGet menolak prosesCheckout (aksi tulis lewat GET dilarang)', async () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    const args = JSON.stringify([[{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }], 'CASH', 20000]);
    const out = backend.doGet({ parameter: { action: 'prosesCheckout', args: args } });
    const payload = JSON.parse(out.getContent());

    r.assertEq(payload.status, 'error', 'checkout via GET harus ditolak');
    r.assertIncludes(payload.message, 'POST', 'pesan menyebut wajib POST');
    // Pastikan tidak ada transaksi yang tercipta
    const rows = gas.scriptRuntime.activeSpreadsheet.__penjualan.__rows();
    r.assertEq(rows.length, 1, 'tidak ada baris penjualan baru');
  });

  r.test('doGet juga menolak tambahStokProduk (aksi tulis lain)', () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    const out = backend.doGet({ parameter: { action: 'tambahStokProduk', args: JSON.stringify(['1', 10, 'SUPER_ADMIN']) } });
    const payload = JSON.parse(out.getContent());
    r.assertEq(payload.status, 'error', 'tambah stok via GET harus ditolak');
    r.assertEq(gas.scriptRuntime.activeSpreadsheet.__produk.__rows()[1][2], 50, 'stok tidak berubah');
  });

  r.test('doGet tanpa action -> jalur halaman web app (HTML), BUKAN JSON', () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    // Di mock, HtmlService.createTemplateFromFile melempar error. Jika doGet tanpa
    // ?action memanggilnya, berarti jalur "sajikan halaman" tetap berjalan seperti asli.
    let errorDilempar = null;
    try {
      backend.doGet({ parameter: {} });
    } catch (e) {
      errorDilempar = e;
    }
    r.assertOk(errorDilempar, 'tanpa ?action harus masuk jalur halaman (HtmlService)');
    r.assertIncludes(String(errorDilempar && errorDilempar.message), 'HtmlService', 'jalur halaman web app yang dipakai, bukan API JSON');
  });

  r.test('doPost prosesCheckout tetap bekerja (jalur tulis utama tidak rusak)', () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    const body = JSON.stringify({
      action: 'prosesCheckout',
      args: [[{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }], 'CASH', 50000]
    });
    const out = backend.doPost({ postData: { contents: body } });
    const payload = JSON.parse(out.getContent());
    r.assertEq(payload.status, 'success', 'checkout via POST sukses');
    r.assertEq(gas.scriptRuntime.activeSpreadsheet.__produk.__rows()[1][2], 50, 'stok tidak disentuh via POST (stok manual)');
  });

});

// ============================================================
// FRONTEND: retry, fallback GET, dan pesan ramah
// ============================================================

r.suite('Frontend — apiRequest retry & fallback GET', () => {

  r.test('POST gagal jaringan 3x -> fallback GET sukses untuk getInitialData', async () => {
    const { app, panggilan } = loadJaringanSkenario(function (url, opts) {
      if ((opts && opts.method) === 'POST') {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      // Jalur GET berhasil
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ produk: [['id', 'nama', 'stok', 'harga', 'foto_url'], ['1', 'P', 7, 1000, '']], penjualan: [], timestamp: 1 }))
      });
    });

    const hasil = await app.call('apiRequest', 'getInitialData', []);

    r.assertArray(hasil.produk, 'data produk diterima via fallback GET');
    r.assertEq(panggilan.filter(p => p.method === 'POST').length, 3, '3x percobaan POST');
    r.assertEq(panggilan.filter(p => p.method === 'GET').length, 1, '1x fallback GET');
    r.assertIncludes(panggilan[panggilan.length - 1].url, 'action=getInitialData', 'URL GET memuat action');
    r.assertIncludes(panggilan[panggilan.length - 1].url, 'args=', 'URL GET memuat args');
  });

  r.test('POST berhasil di percobaan ke-2 -> tidak perlu fallback GET', async () => {
    const { app, panggilan } = loadJaringanSkenario(function (url, opts) {
      if (panggilan.length === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ produk: [], penjualan: [], timestamp: 2 }))
      });
    });

    await app.call('apiRequest', 'getInitialData', []);
    r.assertEq(panggilan.length, 2, 'pulih di percobaan ke-2 tanpa GET');
  });

  r.test('checkout (aksi tulis): POST gagal 3x -> TANPA fallback GET, pesan ramah menyebut keranjang aman', async () => {
    const { app, panggilan } = loadJaringanSkenario(function () {
      return Promise.reject(new TypeError('Failed to fetch'));
    });

    const err = await tangkapError(app.call('apiRequest', 'prosesCheckout', [
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }], 'CASH', 20000
    ]));

    r.assertOk(err, 'harus melempar error setelah semua percobaan gagal');
    r.assertIncludes(err.message, 'Koneksi ke server terputus', 'pesan ramah kegagalan jaringan');
    r.assertIncludes(err.message, 'keranjang', 'pesan menenangkan bahwa keranjang aman');
    r.assertEq(panggilan.filter(p => p.method === 'POST').length, 3, '3x percobaan POST');
    r.assertEq(panggilan.filter(p => p.method === 'GET').length, 0, 'TIDAK ada fallback GET untuk aksi tulis');
  });

  r.test('error bisnis dari server (stok kurang) TIDAK di-retry & pesan apa adanya', async () => {
    const { app, panggilan } = loadJaringanSkenario(function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ status: 'error', message: 'Stok Semangci 250 ml tidak mencukupi.' }))
      });
    });

    const err = await tangkapError(app.call('apiRequest', 'prosesCheckout', [[{ id: '1', nama: 'Semangci', jumlah: 99, total: 9 }]], 'QRIS', 0));

    r.assertOk(err, 'error bisnis tetap dilempar');
    r.assertIncludes(err.message, 'Stok Semangci 250 ml tidak mencukupi', 'pesan bisnis tampil apa adanya');
    r.assertEq(panggilan.length, 1, 'hanya 1x panggilan (tidak di-retry)');
  });

  r.test('respons HTML error Google diperlakukan seperti gagal jaringan (di-retry lalu fallback GET)', async () => {
    const { app, panggilan } = loadJaringanSkenario(function (url, opts) {
      if ((opts && opts.method) === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<!DOCTYPE html><html><body>Sorry, unable to open the file at this time...</body></html>')
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ produk: [], penjualan: [], timestamp: 3 }))
      });
    });

    const hasil = await app.call('apiRequest', 'getInitialData', []);
    r.assertArray(hasil.produk, 'sukses via fallback GET setelah POST balas HTML');
    r.assertEq(panggilan.filter(p => p.method === 'POST').length, 3, 'POST di-retry 3x');
    r.assertEq(panggilan.filter(p => p.method === 'GET').length, 1, 'lalu fallback GET');
  });

  r.test('respons HTTP 500 dengan JSON valid diperlakukan sebagai kegagalan jaringan (di-retry)', async () => {
    const { app, panggilan } = loadJaringanSkenario(function () {
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({ status: 'error', message: 'Internal Server Error' }))
      });
    });

    const err = await tangkapError(app.call('apiRequest', 'getInitialData', []));
    r.assertOk(err, 'gagal setelah semua percobaan');
    r.assertEq(panggilan.filter(p => p.method === 'POST').length, 3, 'POST di-retry 3x karena 500');
    r.assertEq(panggilan.filter(p => p.method === 'GET').length, 1, '1x percobaan terakhir via GET (getInitialData termasuk aksi baca)');
    r.assertIncludes(err.message, 'Koneksi ke server terputus', 'pesan akhir ramah jaringan');
  });

  r.test('checkLogin bisa lewat fallback GET saat POST mati (login tidak terblokir)', async () => {
    const { app, panggilan } = loadJaringanSkenario(function (url, opts) {
      if ((opts && opts.method) === 'POST') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ status: true, username: 'admin', role: 'SUPER_ADMIN' }))
      });
    });

    const hasil = await app.call('apiRequest', 'checkLogin', ['admin', 'password']);
    r.assertEq(hasil.status, true, 'login sukses via GET fallback');
    r.assertIncludes(panggilan[panggilan.length - 1].url, 'action=checkLogin', 'GET memuat action checkLogin');
  });

});

r.run('frontend_jaringan.test.js').then(ok => {
  process.exit(ok ? 0 : 1);
});
