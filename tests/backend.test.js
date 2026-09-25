'use strict';

/**
 * ============================================================
 * Pengujian lokal — Backend Code.js (prosesCheckout & doPost)
 * Menjalankan Code.js ASLI di sandbox vm dengan mock GAS.
 * ============================================================
 */

const { createGasMock, loadBackend, createRunner } = require('./helpers');

const r = createRunner();

const PRODUK_VALID = [
  ['id', 'nama', 'stok', 'harga', 'foto_url'],
  ['1', 'Semangci 250 ml', 50, 15000, ''],
  ['2', 'Wonapel 250 ml', 30, 14000, '']
];

function setupBackend(spreadsheetOpts, produkRows) {
  const gas = createGasMock();
  gas.scriptRuntime.activeSpreadsheet =
    gas.createSpreadsheetMock(produkRows || PRODUK_VALID, spreadsheetOpts);
  const backend = loadBackend(gas);
  return { gas, backend, spreadsheet: gas.scriptRuntime.activeSpreadsheet };
}

r.suite('Backend — prosesCheckout (alur normal)', () => {

  r.test('checkout CASH sukses: penjualan tercatat, stok TIDAK disentuh (stok manual)', () => {
    const { gas, backend, spreadsheet } = setupBackend();

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }],
      'CASH',
      50000
    );

    r.assertEq(res.status, 'success', 'status harus success');
    r.assertEq(res.total, 30000, 'grandTotal');
    r.assertEq(res.kembali, 20000, 'uang kembali');
    // Stok dikelola MANUAL via Tambah Stok — checkout tidak boleh mengubahnya.
    r.assertEq(spreadsheet.__produk.__rows()[1][2], 50, 'stok produk 1 TIDAK berubah');
    r.assertEq(spreadsheet.__penjualan.__rows().length, 2, '1 baris penjualan baru');
  });

  r.test('checkout QRIS sukses tanpa uang dibayar', () => {
    const { backend } = setupBackend();

    const res = backend.prosesCheckout(
      [{ id: '2', nama: 'Wonapel 250 ml', jumlah: 1, total: 14000 }],
      'QRIS',
      0
    );

    r.assertEq(res.status, 'success', 'status harus success');
    r.assertEq(res.total, 14000, 'total');
  });

  r.test('cart bukan array / kosong -> error, tanpa crash', () => {
    const { backend } = setupBackend();

    r.assertEq(backend.prosesCheckout(null, 'CASH', 0).status, 'error');
    r.assertEq(backend.prosesCheckout(undefined, 'CASH', 0).status, 'error');
    r.assertEq(backend.prosesCheckout([], 'CASH', 0).status, 'error');
    r.assertEq(backend.prosesCheckout('bukan-array', 'CASH', 0).status, 'error');
  });

  r.test('stok sheet basi (qty > stok) TETAP diproses — stok dikelola manual', () => {
    const { backend, spreadsheet } = setupBackend();

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 999, total: 999 * 15000 }],
      'CASH',
      999 * 15000
    );

    // Tanpa validasi stok di backend: penjualan tercatat apa adanya,
    // angka stok di sheet tidak pernah ditulis checkout.
    r.assertEq(res.status, 'success', 'checkout murni pencatatan penjualan');
    r.assertEq(spreadsheet.__penjualan.__rows().length, 2, 'penjualan tercatat');
    r.assertEq(spreadsheet.__produk.__rows()[1][2], 50, 'stok tidak disentuh');
  });

  r.test('uang CASH kurang -> error', () => {
    const { backend } = setupBackend();

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }],
      'CASH',
      10000
    );

    r.assertEq(res.status, 'error');
    r.assertIncludes(res.message, 'kurang', 'pesan uang kurang');
  });

  r.test('produk ID tidak dikenal -> error', () => {
    const { backend } = setupBackend();

    const res = backend.prosesCheckout(
      [{ id: '999', nama: 'Produk Misterius', jumlah: 1, total: 1000 }],
      'QRIS',
      0
    );

    r.assertEq(res.status, 'error');
    r.assertIncludes(res.message, 'tidak ditemukan', 'pesan produk tidak ditemukan');
  });
});

r.suite('Backend — prosesCheckout (data produk gagal dimuat)', () => {

  r.test('getValues() melempar error -> fallback array kosong, error terkendali, TANPA TypeError findIndex', () => {
    const { gas, backend } = setupBackend({ produkSheet: { failGetValues: true } });

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }],
      'CASH',
      15000
    );

    // Sebelum perbaikan: "TypeError: dataProduk.findindex is not a function" /
    // error baca sheet mentah. Sekarang: error jelas & ramah.
    r.assertEq(res.status, 'error');
    r.assertIncludes(res.message, 'Data produk belum termuat', 'pesan fallback');
    r.assertIncludes(gas.Logger.logs.join('\n'), 'gagal membaca sheet', 'kejadian tercatat di Logger');
  });

  r.test('getValues() mengembalikan objek non-array -> type guard Array.isArray mencegah TypeError', () => {
    const { backend } = setupBackend({ produkSheet: { getValuesReturnsNonArray: true } });

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }],
      'QRIS',
      0
    );

    r.assertEq(res.status, 'error');
    r.assertIncludes(res.message, 'Data produk belum termuat', 'fallback aman ke array kosong');
    r.assertNotIncludes(res.message, 'findIndex', 'tidak boleh error "findIndex is not a function"');
    r.assertNotIncludes(res.message, 'findindex', 'tidak boleh error "findindex is not a function"');
  });

  r.test('sheet Produk kosong (hanya header) -> error terkendali', () => {
    const { backend } = setupBackend(null, [['id', 'nama', 'stok', 'harga', 'foto_url']]);

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }],
      'QRIS',
      0
    );

    r.assertEq(res.status, 'error');
    r.assertIncludes(res.message, 'Data produk belum termuat', 'pesan sheet kosong');
  });

  r.test('sheet Produk tidak ada -> error sheet tidak ditemukan', () => {
    const { backend } = setupBackend({ noProdukSheet: true });

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'X', jumlah: 1, total: 1000 }],
      'QRIS',
      0
    );

    r.assertEq(res.status, 'error');
    r.assertIncludes(res.message, 'tidak ditemukan', 'pesan sheet hilang');
  });
});

r.suite('Backend — doPost (jalur HTTP frontend)', () => {

  r.test('prosesCheckout via doPost sukses dan mengembalikan JSON valid', () => {
    const { backend } = setupBackend();

    const event = {
      postData: {
        contents: JSON.stringify({
          action: 'prosesCheckout',
          args: [[{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }], 'CASH', 35000]
        })
      }
    };

    const out = backend.doPost(event);
    const parsed = JSON.parse(out.getContent());

    r.assertEq(parsed.status, 'success');
    r.assertEq(parsed.total, 30000);
  });

  r.test('doPost: action tidak dikenal -> error terkendali (bukan crash)', () => {
    const { backend } = setupBackend();

    const event = { postData: { contents: JSON.stringify({ action: 'tidakAda' }) } };
    const parsed = JSON.parse(backend.doPost(event).getContent());

    r.assertEq(parsed.status, 'error');
    r.assertIncludes(parsed.message, 'tidak tersedia');
  });
});

r.run('Backend Code.js').then(ok => { process.exit(ok ? 0 : 1); });
