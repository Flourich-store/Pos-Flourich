'use strict';

/**
 * ============================================================
 * Audit jalur penginputan — Stok & Penjualan
 * Menguji seluruh rantai setiap metode input:
 *   STOK     : aksiTambahStok (UI) -> tambahStokProduk (backend)
 *   PENJUALAN: addToCart/updateCartQty (UI) -> checkout -> prosesCheckout (backend)
 * Fokus: kegagalan server HARUS tercermin di UI (tidak ada optimistic
 * update palsu), dan validasi harus konsisten dua sisi.
 * ============================================================
 */

const { createGasMock, loadBackend, createDomStub, loadFrontend, createRunner } = require('./helpers');

const r = createRunner();

const PRODUK_VALID = [
  ['id', 'nama', 'stok', 'harga', 'modal'],
  ['1', 'Semangci 250 ml', 50, 15000, 10000],
  ['2', 'Wonapel 250 ml', 30, 14000, 9000]
];

const PRODUK_ID_SPASI = [
  ['id', 'nama', 'stok', 'harga', 'modal'],
  [' SL0002 ', 'Semangci 350 ml', 15, 14000, 9000]
];

// Fixture selalu di-clone: terapkanPerubahanStokLokal memutasi dataProduk
// in-place, jadi array bersama tidak boleh dipakai ulang antar-test.
const produkBaru = () => JSON.parse(JSON.stringify(PRODUK_VALID));
const produkSpasiBaru = () => JSON.parse(JSON.stringify(PRODUK_ID_SPASI));

function backendBaru(produk) {
  const gas = createGasMock();
  const sheet = gas.createSpreadsheetMock(produk ? JSON.parse(JSON.stringify(produk)) : produkBaru());
  gas.scriptRuntime.activeSpreadsheet = sheet;
  const backend = loadBackend(gas);
  return { gas, sheet, backend };
}

/** Muat frontend dengan apiRequest aktif + fetch stub yang membalas dari backend sungguhan. */
function muatDenganBackend(produk) {
  const dom = createDomStub();
  const app = loadFrontend(dom);
  dom.window.location.protocol = 'https:';
  const b = backendBaru(produk);

  app.sandbox.fetch = function (url, opts) {
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { }
    let hasil;
    try {
      hasil = b.backend.doPost({ postData: { contents: JSON.stringify({ action: body.action, args: body.args }) } });
      hasil = JSON.parse(hasil.getContent());
    } catch (e) {
      hasil = { status: 'error', message: String(e && e.message || e) };
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ status: 'success', data: hasil })) });
  };
  return { dom, app, ...b };
}

function flush() { return new Promise(resolve => setTimeout(resolve, 20)); }

// ============================================================
// STOK — backend tambahStokProduk
// ============================================================

r.suite('Audit Stok — backend tambahStokProduk', () => {

  r.test('tambah stok sukses: stok di sheet bertambah', () => {
    const { sheet, backend } = backendBaru();
    const msg = backend.tambahStokProduk('1', 10, 'KASIR');
    r.assertIncludes(String(msg), 'Berhasil');
    r.assertEq(Number(sheet.__produk.__rows()[1][2]), 60, 'stok 50 -> 60');
  });

  r.test('ID dengan spasi tak sengaja tetap cocok (trim)', () => {
    const { sheet, backend } = backendBaru(produkSpasiBaru());
    const msg = backend.tambahStokProduk('SL0002', 5, 'KASIR');
    r.assertIncludes(String(msg), 'Berhasil');
    r.assertEq(Number(sheet.__produk.__rows()[1][2]), 20);
  });

  r.test('tolak: qty 0, negatif, non-angka', () => {
    const { sheet, backend } = backendBaru();
    r.assertIncludes(String(backend.tambahStokProduk('1', 0, 'KASIR')), 'lebih dari 0');
    r.assertIncludes(String(backend.tambahStokProduk('1', -5, 'KASIR')), 'lebih dari 0');
    r.assertIncludes(String(backend.tambahStokProduk('1', 'abc', 'KASIR')), 'lebih dari 0');
    r.assertEq(Number(sheet.__produk.__rows()[1][2]), 50, 'stok tidak berubah');
  });

  r.test('tolak: ID tidak ditemukan', () => {
    const { sheet, backend } = backendBaru();
    r.assertIncludes(String(backend.tambahStokProduk('999', 5, 'KASIR')), 'tidak ditemukan');
    r.assertEq(Number(sheet.__produk.__rows()[1][2]), 50, 'stok tidak berubah');
  });

  r.test('tolak: role tidak berwenang', () => {
    const { sheet, backend } = backendBaru();
    r.assertIncludes(String(backend.tambahStokProduk('1', 5, 'USER')), 'hak akses');
    r.assertEq(Number(sheet.__produk.__rows()[1][2]), 50, 'stok tidak berubah');
  });

  r.test('tolak: sheet Produk kosong/rusak', () => {
    const { backend } = backendBaru([['id', 'nama', 'stok', 'harga']]);
    r.assertOk(String(backend.tambahStokProduk('1', 5, 'KASIR')).length > 0, 'balas teks, bukan crash');
  });
});

// ============================================================
// STOK — UI aksiTambahStok via apiRequest (jalur HTTPS)
// ============================================================

r.suite('Audit Stok — UI aksiTambahStok (jalur HTTPS)', () => {

  r.test('sukses: stok di layar langsung bertambah (optimistic update)', async () => {
    const { dom, app } = muatDenganBackend();
    dom.sessionStorage.setItem('pos_role', 'SUPER_ADMIN');
    app.set('dataProduk', produkBaru());
    app.set('masterData', produkBaru());
    dom.window.__promptValue = '10';
    app.call('aksiTambahStok', '1', 'Semangci 250 ml');
    await flush();

    r.assertIncludes(dom.alerts.join(' '), 'Berhasil', 'alert sukses tampil');
    r.assertEq(Number(app.get('dataProduk')[1][2]), 60, 'stok lokal 50 -> 60 SEKETIKA');
  });

  r.test('REGRESI: server menolak (ID tidak ada) -> stok di layar TIDAK bertambah', async () => {
    const { dom, app } = muatDenganBackend();
    dom.sessionStorage.setItem('pos_role', 'SUPER_ADMIN');
    app.set('dataProduk', produkBaru());
    app.set('masterData', produkBaru());
    dom.window.__promptValue = '10';
    app.call('aksiTambahStok', '999', 'Produk Hantu');
    await flush();

    r.assertIncludes(dom.alerts.join(' '), 'tidak ditemukan', 'penolakan server tampil ke kasir');
    r.assertEq(Number(app.get('dataProduk')[1][2]), 50, 'stok Semangci TIDAK berubah (bug lama: ikut bertambah)');
  });

  r.test('qty tidak valid ditolak di frontend (guard) -> server tidak perlu diminta', async () => {
    const { dom, app } = muatDenganBackend();
    dom.sessionStorage.setItem('pos_role', 'SUPER_ADMIN');
    app.set('dataProduk', produkBaru());
    app.set('masterData', produkBaru());
    dom.window.__promptValue = '0';
    app.call('aksiTambahStok', '1', 'Semangci 250 ml');
    await flush();

    r.assertIncludes(dom.alerts.join(' '), 'angka positif', 'guard frontend menolak qty tidak valid');
    r.assertEq(Number(app.get('dataProduk')[1][2]), 50, 'stok tetap');
  });

  r.test('prompt dibatalkan -> tidak ada request ke server', async () => {
    const { dom, app } = muatDenganBackend();
    dom.sessionStorage.setItem('pos_role', 'SUPER_ADMIN');
    let dipanggil = 0;
    const asli = app.sandbox.fetch;
    app.sandbox.fetch = function (...a) { dipanggil++; return asli.apply(this, a); };
    dom.window.__promptValue = null;
    app.call('aksiTambahStok', '1', 'Semangci 250 ml');
    await flush();
    r.assertEq(dipanggil, 0, 'tidak ada fetch');
    r.assertEq(dom.alerts.length, 0, 'tidak ada alert');
  });

  r.test('role tanpa akses diblokir di frontend sebelum minta qty', () => {
    const { dom, app } = muatDenganBackend();
    dom.sessionStorage.setItem('pos_role', 'USER');
    app.call('aksiTambahStok', '1', 'Semangci 250 ml');
    r.assertIncludes(dom.alerts.join(' '), 'hak akses');
  });
});

// ============================================================
// PENJUALAN — rantai addToCart -> checkout -> prosesCheckout
// ============================================================

r.suite('Audit Penjualan — rantai UI -> backend', () => {

  r.test('addToCart menolak qty > stok', () => {
    const { dom, app } = muatDenganBackend();
    app.set('dataProduk', produkBaru());
    app.set('masterData', produkBaru());
    const sel = dom.window.document.getElementById('selProduk');
    sel.value = '2'; // Wonapel, stok 30
    dom.window.document.getElementById('inpQty').value = '99';
    app.call('addToCart');
    r.assertIncludes(dom.alerts.join(' '), 'tidak mencukupi');
    r.assertEq(app.get('cart').length, 0);
  });

  r.test('updateCartQty menolak kenaikan melebihi stok', () => {
    const { dom, app } = muatDenganBackend();
    app.set('dataProduk', produkBaru());
    app.set('masterData', produkBaru());
    app.set('cart', [{ id: '2', nama: 'Wonapel 250 ml', jumlah: 30, harga: 14000, total: 420000 }]);
    app.call('updateCartQty', 0, 1); // 30 -> 31 melebihi stok 30
    r.assertIncludes(dom.alerts.join(' '), 'tidak mencukupi');
    r.assertEq(app.get('cart')[0].jumlah, 30, 'qty tetap 30');
  });

  r.test('checkout gagal di server (uang kurang) -> keranjang TIDAK hilang, tanpa antrian', async () => {
    const { dom, app, sheet } = muatDenganBackend();
    // Backend tetap menolak uang CASH kurang (validasi pembayaran dipertahankata):
    // cart 2 x 15000 = 30000, bayar cuma 20000.
    app.set('dataProduk', produkBaru());
    app.set('masterData', produkBaru());
    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, harga: 15000, total: 30000 }]);
    dom.window.document.getElementById('selMetode').value = 'CASH';
    dom.window.document.getElementById('inpBayar').value = '20000';
    dom.confirms.length = 0;
    dom.alerts.length = 0;
    app.call('checkout');
    await flush();

    const gabung = dom.alerts.join(' ');
    r.assertIncludes(gabung, 'kurang', 'penolakan server tampil');
    r.assertEq(app.get('cart').length, 1, 'keranjang tetap ada (bisa dikoreksi)');
    r.assertEq(dom.localStorage.getItem('pos_offline_queue'), null, 'penolakan bisnis TIDAK masuk antrian offline');
    r.assertEq(sheet.__penjualan.__rows().length, 1, 'tidak ada transaksi tercatat');
  });

  r.test('checkout sukses ujung-ke-ujung: Penjualan tercatat & stok sheet berkurang', async () => {
    const { dom, app, sheet } = muatDenganBackend();
    app.set('dataProduk', produkBaru());
    app.set('masterData', produkBaru());
    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, harga: 15000, total: 30000 }]);
    dom.window.document.getElementById('selMetode').value = 'CASH';
    dom.window.document.getElementById('inpBayar').value = '50000';
    dom.confirms.length = 0;
    app.call('checkout');
    await flush();

    r.assertOk(dom.alerts.length === 0, 'tidak ada alert error');
    r.assertEq(app.get('cart').length, 0, 'keranjang dikosongkan setelah sukses');
    r.assertEq(sheet.__penjualan.__rows().length, 2, 'Penjualan: header + 1 baris');
    r.assertEq(Number(sheet.__produk.__rows()[1][2]), 48, 'stok sheet 50 -> 48');
  });

  r.test('validasi konsisten: frontend & backend sama-sama menolak uang kurang', async () => {
    const { dom, app, sheet } = muatDenganBackend();
    app.set('dataProduk', produkBaru());
    app.set('masterData', produkBaru());
    // Cart total 30000, bayar 20000 -> backend menolak "Uang pembayaran kurang."
    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, harga: 15000, total: 30000 }]);
    dom.window.document.getElementById('selMetode').value = 'CASH';
    dom.window.document.getElementById('inpBayar').value = '20000';
    dom.confirms.length = 0;
    app.call('checkout');
    await flush();

    r.assertIncludes(dom.alerts.join(' '), 'kurang', 'penolakan uang kurang tampil');
    r.assertEq(sheet.__penjualan.__rows().length, 1, 'tidak ada transaksi tercatat');
  });
});

r.run('Audit Jalur Input Stok & Penjualan').then(ok => { process.exit(ok ? 0 : 1); });
