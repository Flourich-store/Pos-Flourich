'use strict';

/**
 * ============================================================
 * Pengujian lokal — Backend Code.js (prosesCheckout & doPost)
 * Menjalankan Code.js ASLI di sandbox vm dengan mock GAS.
 * ============================================================
 */

const { createGasMock, loadBackend, loadBackendDiagnostik, createRunner } = require('./helpers');

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

  r.test('checkout CASH sukses: penjualan tercatat & stok berkurang', () => {
    const { gas, backend, spreadsheet } = setupBackend();

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }],
      'CASH',
      50000
    );

    r.assertEq(res.status, 'success', 'status harus success');
    r.assertEq(res.total, 30000, 'grandTotal');
    r.assertEq(res.kembali, 20000, 'uang kembali');
    r.assertEq(spreadsheet.__produk.__rows()[1][2], 48, 'stok produk 1 berkurang 50->48');
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

  r.test('stok sheet basi (qty > stok) TETAP diproses — stok ikut berkurang tanpa blokir', () => {
    const { backend, spreadsheet } = setupBackend();

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 999, total: 999 * 15000 }],
      'CASH',
      999 * 15000
    );

    // Tanpa validasi stok (stok manual): penjualan tetap tercatat dan stok
    // sheet ikut berkurang (bisa minus) tanpa memblokir transaksi.
    r.assertEq(res.status, 'success', 'checkout murni pencatatan penjualan');
    r.assertEq(spreadsheet.__penjualan.__rows().length, 2, 'penjualan tercatat');
    r.assertEq(spreadsheet.__produk.__rows()[1][2], 50 - 999, 'stok ikut berkurang (tanpa blokir)');
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

r.suite('Backend — LockService (kunci tulis checkout & tambah stok)', () => {

  r.test('prosesCheckout & tambahStokProduk berjalan di bawah kunci tulis (acquire + release)', () => {
    const { gas, backend } = setupBackend();

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }],
      'QRIS', 0
    );
    r.assertEq(res.status, 'success', 'checkout sukses di bawah lock');
    r.assertEq(gas.__lockState.acquired, 1, 'lock di-acquire 1x');
    r.assertEq(gas.__lockState.released, 1, 'lock di-release setelah selesai');

    backend.tambahStokProduk('1', 5, 'KASIR');
    r.assertEq(gas.__lockState.acquired, 2, 'tambahStokProduk juga memakai lock');
    r.assertEq(gas.__lockState.released, 2, 'lock dilepas lagi');
  });

  r.test('lock tidak diperoleh (timeout) -> transaksi TETAP diproses tanpa lock (tidak memblokir kasir)', () => {
    const { gas, backend, spreadsheet } = setupBackend();
    gas.__lockState.gagalkanLock = true; // simulasi tryLock gagal/timeout

    const res = backend.prosesCheckout(
      [{ id: '2', nama: 'Wonapel 250 ml', jumlah: 2, total: 28000 }],
      'QRIS', 0
    );
    r.assertEq(res.status, 'success', 'transaksi tetap sukses meski lock gagal');
    r.assertEq(spreadsheet.__produk.__rows()[2][2], 28, 'stok tetap berkurang 30-2=28');
    r.assertEq(gas.__lockState.released, 0, 'lock gagal didapat -> tidak ada release palsu');
  });
});

// ════════════════════════════════════════════════════════════════
// REGRESI SKEMA PENJUALAN — "Total Harga = HPP" & "QTY = Volume"
//
// Akar bug: reader/writer memakai pemetaan POSISIONAL 11 kolom ke sheet
// yang sudah 13 kolom (Volume (ml) & HPP Satuan disisipkan di tengah).
// Akibatnya jumlah mendarat di kolom Volume, totalHarga di HPP Satuan,
// metode di Jumlah, dan "Laba bersih" tidak pernah tertulis sama sekali.
//
// Test di bawah memakai header & data NYATA sheet user supaya regresi
// ini tidak bisa kembali diam-diam.
// ════════════════════════════════════════════════════════════════

const HEADER_PENJUALAN_13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah',
  'Total Harga', 'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];

const HEADER_PRODUK_NYATA = ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'];

const PRODUK_NYATA = [
  ['SL0001', 'Semangci 250 ml', 0, 10000, '', 7500, 250],
  ['SL0002', 'Semangci 350 ml', 9, 14000, '', 9000, 350],
  ['SL0003', 'Semangci 500 ml', 4, 20000, '', 11000, 500],
  ['WNA0001', 'Wonapel 250 ml', 3, 12000, '', 9500, 250],
  ['WNA0002', 'Wonapel 350 ml', 1, 15000, '', 10500, 350],
  ['WNA0003', 'Wonapel 500 ml', 0, 23000, '', 17500, 500],
  ['MO0001', 'Semangsu 350 ml', 0, 15000, '', 10000, 350]
];

// Baris historis era 21 Jun 2026 sengaja SPARSE (kolom finansial kosong).
const PENJUALAN_NYATA = [
  HEADER_PENJUALAN_13,
  ['FR-0001', '21/06/2026 09:12', 'Wonapel 250 ml', '', '', '', '', '', '', '', '', '', ''],
  ['FR-0002', '21/06/2026 10:05', 'Semangka Leci 350 ml', '', '', '', '', '', '', '', '', '', ''],
  ['FR-0003', '15/09/2026 14:30', 'Wonapel 250 ml', 250, 9500, 3, 36000, 'CASH', 36000, 0, 28500, 0, 7500],
  ['FR-0004', '27/09/2026 19:02', 'Semangci 500 ml', 500, 11000, 2, 40000, 'QRIS', 0, 0, 22000, 0, 18000]
];

function setupNyata() {
  const gas = createGasMock();
  const spreadsheet = gas.createSpreadsheetMock(
    [HEADER_PRODUK_NYATA].concat(PRODUK_NYATA),
    { penjualanRows: PENJUALAN_NYATA }
  );
  gas.scriptRuntime.activeSpreadsheet = spreadsheet;
  const backend = loadBackend(gas);
  return { gas, backend, spreadsheet };
}

r.suite('Regresi Skema Penjualan — reader berbasis NAMA HEADER (bukan posisi)', () => {

  r.test('getPenjualanData: kolom terisi ke kolom yang BENAR (qty, bukan volume)', () => {
    const { backend } = setupNyata();
    const out = backend.getPenjualanData();

    r.assertEq(out[0].length, 13, 'payload 13 kolom');
    const row = out[3]; // FR-0003 Wonapel 250 ml
    r.assertEq(row[2], 'Wonapel 250 ml', 'Nama Produk');
    r.assertEq(row[3], 250, 'Volume (ml) = 250 (kolom D)');
    r.assertEq(row[4], 9500, 'HPP Satuan = 9500 (kolom E)');
    r.assertEq(row[5], 3, 'Jumlah = 3 (kolom F) — BUKAN volume 250');
    r.assertEq(row[6], 36000, 'Total Harga = 36000 (kolom G) — BUKAN HPP 9500');
    r.assertEq(row[7], 'CASH', 'Metode Pembayaran (kolom H) — BUKAN qty');
    r.assertEq(row[10], 28500, 'Modal = qty x HPP (kolom K)');
    r.assertEq(row[12], 7500, 'Laba bersih (kolom M) — dulu TIDAK PERNAH tertulis');
  });

  r.test('Total Harga tidak pernah sama dengan HPP Satuan saat qty > 1', () => {
    const { backend } = setupNyata();
    let diperiksa = 0;
    backend.getPenjualanData().slice(1).forEach(row => {
      const jumlah = Number(row[5]) || 0;
      if (jumlah > 1) {
        diperiksa++;
        r.assertFalse(row[6] === row[4], 'baris ' + row[0] + ': Total != HPP');
      }
    });
    r.assertEq(diperiksa > 0, true, 'ada baris qty>1 yang diperiksa (test tidak kosong');
  });

  r.test('baris historis sparse (21 Jun 2026) terbaca tanpa crash, kolom kosong jadi 0/kosong', () => {
    const { backend } = setupNyata();
    const out = backend.getPenjualanData();
    r.assertEq(out.length, 5, 'header + 4 baris');
    r.assertEq(out[1][0], 'FR-0001', 'baris lama 1 terbaca');
    r.assertEq(out[1][3], '', 'Volume kosong tetap kosong (bukan 0)');
    r.assertEq(out[1][5], 0, 'Jumlah kosong jadi 0');
    r.assertEq(out[2][2], 'Semangka Leci 350 ml', 'nama produk lama (alias) apa adanya');
  });

  r.test('getPenjualanData & getInitialData menghasilkan baris IDENTIK', () => {
    const { backend } = setupNyata();
    const a = JSON.stringify(backend.getPenjualanData());
    const b = JSON.stringify(backend.getInitialData(60).penjualan);
    r.assertEq(a, b, 'tidak ada lagi reader yang pakai posisi sehingga berbeda');
  });

  r.test('kolom baru yang disisipkan di tengah TIDAK menggeser pembacaan', () => {
    const { backend } = setupNyata();
    const header13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
      'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Catatan', 'Modal', 'Biaya Operasional', 'Laba bersih'];
    const peta = backend.buatPetaKolom(header13, backend.KONST.PETA_KOLOM_PENJUALAN);
    r.assertEq(peta.col.jumlah, 5, 'Jumlah tetap di idx 5');
    r.assertEq(peta.col.totalHarga, 6, 'Total Harga tetap di idx 6');
    r.assertEq(peta.col.modal, 11, 'Modal ikut geser ke idx 11');
    r.assertEq(peta.col.labaBersih, 13, 'Laba bersih ikut geser ke idx 13');
  });

  r.test('getPenjualanReport: qty & omset benar untuk sheet 13 kolom', () => {
    const { backend } = setupNyata();
    const rep = backend.getPenjualanReport(null, null);
    // 4 baris punya id+nama (2 di antaranya kolom finansial kosong), 2 terisi.
    r.assertEq(rep.txCount, 4, 'semua baris ber-ID dihitung sebagai transaksi');
    r.assertEq(rep.grossTotal, 76000, 'omset = 36000 + 40000 (Total Harga, BUKAN HPP)');
  });
});

r.suite('Regresi Skema Penjualan — writer berbasis NAMA HEADER (Fix 3)', () => {

  r.test('prosesCheckout menulis ke kolom yang benar, Laba bersih TERTULIS', () => {
    const { backend, spreadsheet } = setupNyata();
    const sebelum = spreadsheet.__penjualan.__rows().length;

    const res = backend.prosesCheckout(
      [{ id: 'SL0002', nama: 'Semangci 350 ml', jumlah: 2, hpp: 9000 }],
      'CASH', 50000
    );
    r.assertEq(res.status, 'success', 'checkout sukses');
    r.assertEq(res.total, 28000, 'total = 14000 x 2');

    const rows = spreadsheet.__penjualan.__rows();
    r.assertEq(rows.length, sebelum + 1, 'tepat 1 baris baru');
    const t = rows[sebelum];
    r.assertEq(t.length, 13, 'baris selebar header');
    r.assertEq(t[3], 350, 'kolom D Volume (ml) = 350 (dari kolom volume_ml produk)');
    r.assertEq(t[4], 9000, 'kolom E HPP Satuan = 9000');
    r.assertEq(t[5], 2, 'kolom F Jumlah = 2 (BUKAN volume)');
    r.assertEq(t[6], 28000, 'kolom G Total Harga = 28000 (BUKAN HPP 9000)');
    r.assertEq(t[7], 'CASH', 'kolom H Metode (BUKAN qty)');
    r.assertEq(t[10], 18000, 'kolom K Modal = 9000 x 2');
    r.assertEq(t[11], 0, 'kolom L Biaya Operasional');
    r.assertEq(t[12], 10000, 'kolom M Laba bersih = 28000 - 18000');
  });

  r.test('stok produk turun di kolom Stok (bukan asumsi kolom 3)', () => {
    const { backend, spreadsheet } = setupNyata();
    backend.prosesCheckout([{ id: 'WNA0002', nama: 'Wonapel 350 ml', jumlah: 2, hpp: 10500 }], 'QRIS', 0);
    const wna2 = spreadsheet.__produk.__rows().filter(x => x[0] === 'WNA0002')[0];
    r.assertEq(wna2[2], -1, 'stok 1 - 2 = -1 (dicatat, tidak diblokir)');
  });

  r.test('header Penjualan tanpa kolom wajib -> transaksi DIBATALKAN, tidak menulis dengan posisi keliru', () => {
    // Header ini sengaja TIDAK punya kolom "Laba bersih" — kasus nyata saat
    // sheet masih 11 kolom. Menulis diam-diam akan menggeser/membuang data.
    const gas = createGasMock();
    const spreadsheet = gas.createSpreadsheetMock([HEADER_PRODUK_NYATA].concat(PRODUK_NYATA), {
      penjualanRows: [
        ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Jumlah', 'Total Harga', 'Metode Pembayaran',
          'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional']
      ]
    });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackend(gas);
    const sebelum = spreadsheet.__penjualan.__rows().length;

    const res = backend.prosesCheckout(
      [{ id: 'SL0002', nama: 'Semangci 350 ml', jumlah: 2, hpp: 9000 }], 'CASH', 50000
    );
    r.assertEq(res.status, 'error', 'ditolak, bukan ditulis sembarangan');
    r.assertIncludes(res.message, 'labaBersih', 'pesan menyebut kolom yang hilang');
    r.assertEq(spreadsheet.__penjualan.__rows().length, sebelum, 'tidak ada baris yang ditulis');
  });

  r.test('header 11 kolom LAMA (tanpa Volume/HPP) -> Volume & HPP dilewati, kolom lain tetap benar', () => {
    // Regresi arah lain: kolom Volume/HPP tidak ada di sheet, jadi writer
    // harus LEWATI keduanya (tidak menggeser kolom lain ke tempat salah).
    const gas = createGasMock();
    const spreadsheet = gas.createSpreadsheetMock([HEADER_PRODUK_NYATA].concat(PRODUK_NYATA), {
      penjualanRows: [
        ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Jumlah', 'Total Harga', 'Metode Pembayaran',
          'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih']
      ]
    });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackend(gas);

    const res = backend.prosesCheckout(
      [{ id: 'SL0002', nama: 'Semangci 350 ml', jumlah: 2, hpp: 9000 }], 'CASH', 50000
    );
    r.assertEq(res.status, 'success', 'tetap boleh jalan');
    const t = spreadsheet.__penjualan.__rows()[1];
    r.assertEq(t.length, 11, 'baris mengikuti lebar header');
    r.assertEq(t[2], 'Semangci 350 ml', 'Nama Produk di idx 2');
    r.assertEq(t[3], 2, 'Jumlah di idx 3 (bukan volume)');
    r.assertEq(t[4], 28000, 'Total Harga di idx 4');
    r.assertEq(t[5], 'CASH', 'Metode di idx 5');
    r.assertEq(t[8], 18000, 'Modal di idx 8');
    r.assertEq(t[10], 10000, 'Laba bersih di idx 10');
    r.assertIncludes(gas.Logger.logs.join('\n'), 'volumeMl', 'field tanpa kolom dilaporkan, bukan di-shift');
  });
});

r.suite('Regresi Skema Penjualan — HPP & Volume dari sheet Produk (Fix 3 + Fix 4)', () => {

  r.test('HPP dibaca dari kolom "HPP" (F), bukan fallback ke kolom foto_url/Modal', () => {
    const { backend } = setupNyata();
    const p = backend.getProdukData();
    const byId = {};
    p.slice(1).forEach(x => { byId[x[0]] = x; });
    r.assertEq(byId['WNA0001'][5], 9500, 'HPP Wonapel 250 ml = 9500 (dari kolom HPP)');
    r.assertEq(byId['SL0002'][5], 9000, 'HPP Semangci 350 ml = 9000');
    r.assertEq(byId['WNA0003'][5], 17500, 'HPP Wonapel 500 ml = 17500');
  });

  r.test('volume_ml dibaca dari kolom G, bukan regex dari nama produk', () => {
    const { backend } = setupNyata();
    const p = backend.getProdukData();
    const byId = {};
    p.slice(1).forEach(x => { byId[x[0]] = x; });
    r.assertEq(p[0].length, 7, 'payload produk 7 kolom (ada volume_ml)');
    r.assertEq(byId['SL0001'][6], 250, 'Semangci 250 ml');
    r.assertEq(byId['SL0002'][6], 350, 'Semangci 350 ml');
    r.assertEq(byId['SL0003'][6], 500, 'Semangci 500 ml');
    r.assertEq(byId['WNA0001'][6], 250, 'Wonapel 250 ml');
    r.assertEq(byId['WNA0002'][6], 350, 'Wonapel 350 ml');
    r.assertEq(byId['WNA0003'][6], 500, 'Wonapel 500 ml');
    r.assertEq(byId['MO0001'][6], 350, 'Semangsu 350 ml');
  });

  r.test('kolom volume_ml kosong -> turun ke hitungVolumeMl(nama) (produk baru tetap punya volume)', () => {
    const gas = createGasMock();
    const spreadsheet = gas.createSpreadsheetMock([
      ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'],
      ['BARU01', 'Jeruk 500 ml', 5, 18000, '', 12000, '']
    ], {});
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackend(gas);
    const p = backend.getProdukData();
    r.assertEq(p[1][6], 500, 'turunan dari nama = 500');
  });

  r.test('Volume di sheet Penjualan memakai volume_ml produk, bukan regex nama cart', () => {
    const { backend, spreadsheet } = setupNyata();
    const sebelum = spreadsheet.__penjualan.__rows().length;
    // Nama cart sengaja TIDAK mengandung angka volume.
    backend.prosesCheckout([{ id: 'WNA0003', nama: 'Wonapel', jumlah: 1, hpp: 17500 }], 'QRIS', 0);
    const t = spreadsheet.__penjualan.__rows()[sebelum];
    r.assertEq(t[3], 500, 'Volume = 500 dari kolom volume_ml Though nama cart = "Wonapel"');
    r.assertEq(t[4], 17500, 'HPP dari kolom HPP = 17500');
    r.assertEq(t[6], 23000, 'Total Harga = harga 23000 x 1');
  });
});

r.suite('Alias nama produk (Semangka Leci -> Semangci)', () => {

  r.test('"Semangka Leci 350 ml" dipetakan ke master "Semangci 350 ml"', () => {
    const { backend } = setupNyata();
    const nama = PRODUK_NYATA.map(x => x[1]);
    r.assertEq(backend.selaraskanNamaProduk('Semangka Leci 350 ml', nama), 'Semangci 350 ml', 'alias dipakai');
  });

  r.test('variasi spasi & huruf besar tetap cocok', () => {
    const { backend } = setupNyata();
    const nama = PRODUK_NYATA.map(x => x[1]);
    r.assertEq(backend.selaraskanNamaProduk('semangci 350 ml', nama), 'Semangci 350 ml', 'lowercase');
    r.assertEq(backend.selaraskanNamaProduk('Semangci  350 ml', nama), 'Semangci 350 ml', 'spasi ganda');
    r.assertEq(backend.selaraskanNamaProduk('  Wonapel 250 ml  ', nama), 'Wonapel 250 ml', 'spasi tepi');
  });

  r.test('produk yang benar-benar tidak ada tetap null (tidak dipaksa cocok)', () => {
    const { backend } = setupNyata();
    const nama = PRODUK_NYATA.map(x => x[1]);
    r.assertEq(backend.selaraskanNamaProduk('Menu Opsional', nama), null, 'Menu Opsional bukan produk');
    r.assertEq(backend.selaraskanNamaProduk('Produk Hantu', nama), null, 'tidak ada master-nya');
  });
});

r.suite('Fix 4 — isiVolumeMlProduk() mengisi kolom G dari nama produk', () => {

  function setupVolume(barisProduk) {
    const gas = createGasMock();
    const spreadsheet = gas.createSpreadsheetMock([HEADER_PRODUK_NYATA].concat(barisProduk), {});
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    return { gas, backend: loadBackend(gas), spreadsheet };
  }

  const KOSONG = [
    ['SL0001', 'Semangci 250 ml', 0, 10000, '', 7500, ''],
    ['SL0002', 'Semangci 350 ml', 9, 14000, '', 9000, ''],
    ['SL0003', 'Semangci 500 ml', 4, 20000, '', 11000, ''],
    ['WNA0001', 'Wonapel 250 ml', 3, 12000, '', 9500, ''],
    ['WNA0002', 'Wonapel 350 ml', 1, 15000, '', 10500, ''],
    ['WNA0003', 'Wonapel 500 ml', 0, 23000, '', 17500, ''],
    ['MO0001', 'Semangsu 350 ml', 0, 15000, '', 10000, '']
  ];

  r.test('isi 7 produk nyata dengan volume yang sesuai nama', () => {
    const { backend, spreadsheet } = setupVolume(KOSONG);
    const res = backend.isiVolumeMlProduk(false);
    r.assertEq(res.status, 'success', 'berhasil');
    r.assertEq(res.terisi, 7, '7 produk terisi');

    const harap = { SL0001: 250, SL0002: 350, SL0003: 500, WNA0001: 250, WNA0002: 350, WNA0003: 500, MO0001: 350 };
    const rows = spreadsheet.__produk.__rows();
    Object.keys(harap).forEach(id => {
      const row = rows.filter(x => x[0] === id)[0];
      r.assertEq(row[6], harap[id], id + ' (' + row[1] + ') volume_ml = ' + harap[id]);
    });
  });

  r.test('SIMULASI (arg true) tidak menulis apa pun ke sheet', () => {
    const { backend, spreadsheet } = setupVolume(KOSONG);
    const res = backend.isiVolumeMlProduk(true);
    r.assertEq(res.simulasi, true, 'ditandai simulasi');
    r.assertEq(res.terisi, 7, '7 akan diisi');
    spreadsheet.__produk.__rows().slice(1).forEach(row => {
      r.assertEq(row[6], '', row[0] + ' kolom G tetap kosong');
    });
  });

  r.test('idempoten: isian manual TIDAK ditimpa, dipanggil 2x aman', () => {
    const { backend, spreadsheet } = setupVolume([
      ['SL0001', 'Semangci 250 ml', 0, 10000, '', 7500, ''],   // kosong -> diisi
      ['SL0002', 'Semangci 350 ml', 9, 14000, '', 9000, 999],  // manual -> JAGA
      ['BARU1', 'Jeruk Sirop 750 ml', 5, 18000, '', 12000, '']
    ]);
    backend.isiVolumeMlProduk(false);
    backend.isiVolumeMlProduk(false);
    const rows = spreadsheet.__produk.__rows();
    r.assertEq(rows[1][6], 250, 'SL0001 diisi 250');
    r.assertEq(rows[2][6], 999, 'SL0002 isian manual 999 dipertahankan');
    r.assertEq(rows[3][6], 750, 'produk baru Jeruk Sirop 750 ml -> 750');
  });

  r.test('volume_ml tidak ada di header -> menolak, tidak menebak posisi', () => {
    const gas = createGasMock();
    const spreadsheet = gas.createSpreadsheetMock([
      ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP'],
      ['SL0001', 'Semangci 250 ml', 0, 10000, '', 7500]
    ], {});
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackend(gas);
    const res = backend.isiVolumeMlProduk(false);
    r.assertEq(res.status, 'error', 'ditolak');
    r.assertIncludes(res.message, 'volume_ml', 'pesan menyebut kolom yang hilang');
  });

  r.test('produk tanpa angka volume -> DILEWATI, dilaporkan alasannya', () => {
    const { backend, spreadsheet } = setupVolume([
      ['SL0001', 'Semangci 250 ml', 0, 10000, '', 7500, ''],
      ['XX0001', 'Kopi Susu', 5, 15000, '', 9000, '']
    ]);
    const res = backend.isiVolumeMlProduk(false);
    const dilewati = res.rencana.filter(p => p.aksi === 'DILEWATI');
    r.assertEq(dilewati.length, 1, '1 produk dilewati');
    r.assertIncludes(dilewati[0].alasan, 'tidak terbaca dari nama', 'alasan jelas');
    const rows = spreadsheet.__produk.__rows();
    r.assertEq(rows[1][6], 250, 'produk yang bisa dibaca tetap diisi');
    r.assertEq(rows[2][6], '', 'produk tanpa volume tetap kosong');
  });
});

r.suite('Staging — ujiStagingPenjualan (fungsi uji tulis ke sheet dev)', () => {

  const H13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
    'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];
  const H11 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Jumlah', 'Total Harga', 'Metode Pembayaran',
    'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];

  function buatPenjualan(n, header) {
    const rows = [header];
    for (let i = 0; i < n; i++) {
      rows.push(['FR-' + i, '15/09/2026 10:00', 'Semangci 250 ml', 250, 7500, 2, 20000, 'CASH', 20000, 0, 15000, 0, 5000]);
    }
    return rows;
  }

  function setupStaging(header, nBaris, ssId, opts) {
    const gas = createGasMock();
    gas.scriptRuntime.props.ENV = 'production';   // kondisi user saat ini
    const spreadsheet = gas.createSpreadsheetMock([
      ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'],
      ['SL0002', 'Semangci 350 ml', 9, 14000, '', 9000, 350]
    ], Object.assign({
      penjualanRows: buatPenjualan(nBaris, header),
      penjualanMinRows: 10000,
      ssId: ssId || '1CVrF7B3TfTF8LYM5neg14gHfhgRS5O7hELlEMwCAWzk',
      ssName: 'POS - Staging Dev'
    }, opts || {}));
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackend(gas);
    return { gas, backend, spreadsheet };
  }

  r.test('sheet 13 kolom -> menulis ke baris kosong jauh, verifikasi LULUS, lalu bersih', () => {
    const { backend, spreadsheet } = setupStaging(H13, 523);
    const res = backend.ujiStagingPenjualan();
    r.assertEq(res.status, 'success', 'status success');
    r.assertEq(res.error, undefined, 'tidak ada error tersembunyi yang ditelan catch');
    r.assertEq(res.ditulis, true, 'dummy tertulis');
    r.assertEq(res.semuaLulus, true, 'verifikasi semua lulus');
    r.assertEq(res.bersih, true, 'baris uji dibersihkan');
    r.assertEq(res.barisUji, 9000, 'baris uji = 9000 (jauh dari 523 baris data)');
    // Jangan tinggalkan jejak di sheet
    const sisa = spreadsheet.__penjualan.__rows().filter((row, i) =>
      i > 523 && row.some(c => String(c == null ? '' : c).trim() !== ''));
    r.assertEq(sisa.length, 0, 'tidak ada jejak dummy tersisa di baris > 523');
  });

  r.test('sheet masih 11 kolom -> tetap menulis benar di layout lama & bersih', () => {
    const { backend, spreadsheet } = setupStaging(H11, 523);
    const res = backend.ujiStagingPenjualan();
    r.assertEq(res.status, 'success', 'status success');
    r.assertEq(res.semuaLulus, true, 'verifikasi (opsional dilewati sebagai N/A)');
    r.assertEq(res.bersih, true, 'baris uji dibersihkan');
    // Field yang TIDAK ada di header dilewati, bukan digeser. res.rows[0] =
    // baris yang dibaca-balik SEBELUM dibersihkan.
    const row = res.rows[0];
    r.assertEq(row[3], 2, 'kolom D (Jumlah) = 2, bukan volume 350');
    r.assertEq(row[4], 28000, 'kolom E (Total Harga) = 28000, bukan HPP');
    r.assertEq(row[8], 18000, 'kolom I (Modal) = 18000 = qty x HPP, bukan tergeser');
    r.assertEq(row[10], 10000, 'kolom K (Laba bersih) ada di posisi kolom ke-11');
    r.assertEq(row.indexOf(350), -1, 'nilai volume 350 tidak bocor ke kolom lain');
    // Pembersihan benar-benar menghapus jejak
    const sisa = spreadsheet.__penjualan.__rows().filter((r2, i) =>
      i > 523 && r2.some(c => String(c == null ? '' : c).trim() !== ''));
    r.assertEq(sisa.length, 0, 'tidak ada jejak dummy tersisa');
  });

  r.test('kolom wajib (Laba bersih) hilang -> fail-safe, TIDAK ada yang ditulis', () => {
    const headerKurang = H13.filter(h => h !== 'Laba bersih');
    const { backend, spreadsheet } = setupStaging(headerKurang, 523);
    const res = backend.ujiStagingPenjualan();
    r.assertEq(res.status, 'error', 'ditolak');
    r.assertEq(res.ditulis, undefined, 'tidak ada penulisan');
    r.assertEq(res.kolomHilang.join(','), 'labaBersih', 'kolom hilang teridentifikasi');
    const sisa = spreadsheet.__penjualan.__rows().filter((row, i) =>
      i > 523 && row.some(c => String(c == null ? '' : c).trim() !== ''));
    r.assertEq(sisa.length, 0, 'tidak ada jejak');
  });

  r.test('GUARD: menolak menulis ke sheet PRODUCTION tanpa izin eksplisit', () => {
    const ssProd = '17nWhZx32MhOWI6OnADqisHwjsmAYrBug4-rRT_CjUJQ';
    const { backend } = setupStaging(H13, 523, ssProd);
    const res = backend.ujiStagingPenjualan(ssProd);
    r.assertEq(res.status, 'error', 'ditolak');
    r.assertIncludes(res.message, 'production', 'pesan menyebut production');
    // Izin eksplisit tetap dihormati
    const izin = backend.ujiStagingPenjualan(ssProd, true);
    r.assertEq(izin.status, 'success', 'dengan argumen true, uji boleh jalan');
    r.assertEq(izin.ditulis, true, 'ditulis');
    r.assertEq(izin.bersih, true, 'dibersihkan');
  });

  r.test('sheet tidak punya ruang kosong yang aman -> batalkan, jangan memaksa', () => {
    const { backend, spreadsheet } = setupStaging(H13, 523, undefined, { penjualanMinRows: 574 });
    const res = backend.ujiStagingPenjualan();
    r.assertEq(res.status, 'error', 'ditolak');
    r.assertIncludes(String(res.message), 'ruang', 'pesan menjelaskan soal ruang');
    const sisa = spreadsheet.__penjualan.__rows().filter((row, i) =>
      i > 523 && row.some(c => String(c == null ? '' : c).trim() !== ''));
    r.assertEq(sisa.length, 0, 'tidak ada jejak');
  });
});

r.suite('Diagnostik — parseAngkaToleran (parser angka format Indonesia)', () => {
  function setup() {
    const gas = createGasMock();
    const backend = loadBackendDiagnostik(gas);
    return { gas, backend };
  }

  r.test('titik = pemisah ribuan, koma = desimal, Rp/spasi dibuang', () => {
    const { backend } = setup();
    r.assertEq(backend.parseAngkaToleran('12.000'), 12000, '12.000 -> 12000');
    r.assertEq(backend.parseAngkaToleran('Rp 12.000'), 12000, 'Rp 12.000 -> 12000');
    r.assertEq(backend.parseAngkaToleran('1.234,56'), 1234.56, '1.234,56 -> 1234.56');
    r.assertEq(backend.parseAngkaToleran('10,5'), 10.5, '10,5 -> 10.5');
    r.assertEq(backend.parseAngkaToleran('10500'), 10500, '10500 -> 10500');
    r.assertEq(backend.parseAngkaToleran(9500), 9500, 'angka murni');
  });

  r.test('tidak bisa diurai -> NaN', () => {
    const { backend } = setup();
    r.assertOk(Number.isNaN(backend.parseAngkaToleran('abc')), 'teks murni -> NaN');
    r.assertOk(Number.isNaN(backend.parseAngkaToleran('')), 'string kosong -> NaN');
    r.assertOk(Number.isNaN(backend.parseAngkaToleran(null)), 'null -> NaN');
  });
});

r.suite('Diagnostik — diagnostikModalTerakhir (baca & klasifikasi baris)', () => {
  const H13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
    'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];
  const HPP = ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'];

  function setup(penjualanRows) {
    const gas = createGasMock();
    gas.scriptRuntime.props.ENV = 'production';
    const spreadsheet = gas.createSpreadsheetMock([
      [HPP[0], HPP[1], HPP[2], HPP[3], HPP[4], HPP[5], HPP[6]],
      ['PD001', 'Wonapel 250 ml', 50, 15000, '', 9500, 250],
      ['PD002', 'Semangci 350 ml', 9, 14000, '', '10.500', 350]  // HPP sebagai TEKS format id
    ], { penjualanRows: penjualanRows, penjualanMinRows: 1000 });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackendDiagnostik(gas);
    return { gas, backend, spreadsheet };
  }

  const BARIS_BARU = ['FR-NEW1', '20/09/2026 10:00', 'Wonapel 250 ml', 250, 9500, 1, 15000, 'QRIS', 15000, 0, 9500, 0, 5500];
  const BARIS_LAMA = ['FR-1790513368295', '15/09/2026 09:30', 'Wonapel 250 ml', 1, 12000, 250, 9500, 'QRIS', 12000, 0, 9500, '', '']; // D=jumlah E=total F=volume G=HPP
  const BARIS_HPP_TEKS = ['FR-TEKS1', '21/09/2026 11:00', 'Semangci 350 ml', 350, '10.500', 2, 28000, 'CASH', 28000, 0, 21000, 0, 7000];

  r.test('baris BARU (13 kolom benar) -> modal-sesuai, perluRemap TIDAK', () => {
    const { backend } = setup([H13, BARIS_BARU]);
    const logs = backend.diagnostikModalTerakhir(5);
    const obj = logs.slice(0, -1).map(s => JSON.parse(s));
    const b = obj.find(o => o.id === 'FR-NEW1');
    r.assertEq(b.status, 'modal-sesuai', 'modal cocok jumlah x HPP');
    r.assertIncludes(b.perluRemap, 'TIDAK', 'L&M terisi -> kode baru');
    r.assertEq(b.hppProdukRaw, 9500, 'HPP master terbaca');
    r.assertEq(b.hitungUlangModal, 9500, '1 x 9500');
  });

  r.test('baris LAMA (writer hybrid tergeser) -> terdeteksi + cetak Kolom A-M mentah', () => {
    const { backend } = setup([H13, BARIS_LAMA]);
    const logs = backend.diagnostikModalTerakhir('FR-1790513368295');
    const obj = logs.slice(0, -1).map(s => JSON.parse(s));
    const b = obj.find(o => o.id === 'FR-1790513368295');
    r.assertOk(b, 'baris dengan ID itu ditemukan');
    r.assertIncludes(b.perluRemap, 'YA', 'L&M kosong -> ditulis writer lama');
    // Kolom A-M RAW membuktikan pergeseran: F(=jumlah) berisi 250 (volume),
    // G(=totalHarga) berisi 9500 (HPP), D berisi 1 (jumlah sebenarnya).
    r.assertEq(b.kolomA_M.jumlah, 250, 'Kolom F (Jumlah) = 250 = volume, bukan qty');
    r.assertEq(b.kolomA_M.totalHarga, 9500, 'Kolom G (Total Harga) = 9500 = HPP');
    r.assertEq(b.kolomA_M.volumeMl, 1, 'Kolom D (Volume) = 1 = jumlah sebenarnya');
    r.assertEq(b.kolomA_M.hppSatuan, 12000, 'Kolom E (HPP Satuan) = 12000 = total sebenarnya');
    r.assertEq(b.status, 'modal-beda', 'posisi sekarang (F=250) menyebabkan modal "beda"');
    // Dengan asumsi remap D=jumlah: modal target = 1 x 9500 = 9500 = K sheet.
    r.assertEq(b.hitungUlangModalRemap, 9500, 'D x HPP master cocok dengan K sheet -> hipotesis tegak');
  });

  r.test('HPP sheet bertipe TEKS "10.500" tetap terbaca toleran (10500)', () => {
    const { backend } = setup([H13, BARIS_HPP_TEKS]);
    const logs = backend.diagnostikModalTerakhir('FR-TEKS1');
    const obj = logs.slice(0, -1).map(s => JSON.parse(s));
    const b = obj.find(o => o.id === 'FR-TEKS1');
    r.assertEq(b.hppProdukRaw, '10.500', 'nilai mentah teks dipertahankan');
    r.assertEq(b.hppProdukAngka, 10500, 'parser toleran mengubah menjadi 10500');
    r.assertEq(b.status, 'modal-sesuai', 'modal 2 x 10500 = 21000 cocok');
  });

  r.test('produk tidak dikenal -> status produk-tidak-ditemukan', () => {
    const { backend } = setup([H13, ['FR-XXX1', '20/09/2026 10:00', 'Produk Khayalan 999 ml', 999, 1, 1, 5000, 'CASH', 5000, 0, 1, 0, 1]]);
    const logs = backend.diagnostikModalTerakhir('FR-XXX1');
    const obj = logs.slice(0, -1).map(s => JSON.parse(s));
    const b = obj.find(o => o.id === 'FR-XXX1');
    r.assertEq(b.status, 'produk-tidak-ditemukan', 'dilaporkan, bukan modal 0 diam-diam');
  });
});

r.suite('Diagnostik — rencanaBackfillHistori (dry-run, tanpa menulis)', () => {
  const H13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
    'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];
  const HPP = ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'];

  function setup() {
    const gas = createGasMock();
    gas.scriptRuntime.props.ENV = 'production';
    const spreadsheet = gas.createSpreadsheetMock([
      [HPP[0], HPP[1], HPP[2], HPP[3], HPP[4], HPP[5], HPP[6]],
      ['PD001', 'Wonapel 250 ml', 50, 15000, '', 9500, 250],
      ['PD002', 'Semangci 350 ml', 9, 14000, '', 8000, 350],
      ['PD003', 'Produk Tanpa HPP 500 ml', 3, 20000, '', '', 500]
    ], { penjualanRows: [
      H13,
      // baris BARU benar (harus ok, TIDAK dicetak di mode ringkas)
      ['FR-BARU1', '22/09/2026 10:00', 'Semangci 350 ml', 350, 8000, 2, 28000, 'CASH', 28000, 0, 16000, 0, 12000],
      // baris LAMA tergeser: D=jumlah(1) E=total(12000) F=volume(250) G=hpp(9500) H=QRIS I=12000 J=0 K=9500 L,M=''
      ['FR-LAMA1', '10/09/2026 09:00', 'Wonapel 250 ml', 1, 12000, 250, 9500, 'QRIS', 12000, 0, 9500, '', ''],
      // produk tidak ditemukan
      ['FR-HANTU1', '11/09/2026 08:00', 'Minuman Ajaib 300 ml', 1, 5000, 300, 4000, 'CASH', 5000, 0, 0, '', ''],
      // HPP master kosong -> hpp-tidak-tersedia
      ['FR-KOSONG1', '12/09/2026 07:00', 'Produk Tanpa HPP 500 ml', 1, 20000, 500, 16000, 'CASH', 20000, 0, 0, '', '']
    ], penjualanMinRows: 1000 });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackendDiagnostik(gas);
    return { gas, backend, spreadsheet };
  }

  r.test('mode default (ringkas): ringkasan + HANYA baris non-ok, ok hanya di contohOk', () => {
    const { backend } = setup();
    const logs = backend.rencanaBackfillHistori();
    const obj = logs.map(s => JSON.parse(s));
    const ring = obj.find(o => o.RINGKASAN);
    r.assertEq(ring.RINGKASAN.totalBaris, 4, '4 baris data diproses');
    r.assertEq(ring.RINGKASAN.ok_tanpa_perubahan, 1, '1 baris baru sudah benar');
    r.assertEq(ring.RINGKASAN.layout_tergeser, 1, '1 baris lama tergeser');
    r.assertEq(ring.RINGKASAN.produk_tidak_ditemukan, 1, '1 produk tidak ditemukan');
    r.assertEq(ring.RINGKASAN.hpp_tidak_tersedia, 1, '1 HPP master kosong');
    r.assertEq(ring.RINGKASAN.barisNonOk, 3, '3 non-ok dicetak rinci');
    const cetak = obj.filter(o => o.barisSheet);
    r.assertEq(cetak.length, 3, 'hanya non-ok yang dicetak di mode ringkas');
    r.assertEq(cetak.every(o => o.status !== 'ok-tanpa-perubahan'), true, 'tidak ada baris ok ikut tercetak');
  });

  r.test('baris LAMA -> sesudah = layout 13 kolom yg benar (volume 250, hpp 9500, modal 9500, laba 2500)', () => {
    const { backend } = setup();
    // Cari baris lama di log mode ringkas
    const logs = backend.rencanaBackfillHistori([2, 10]);   // mode detail, semua baris dicetak
    const obj = logs.map(s => JSON.parse(s));
    // RINGKASAN terlebih dahulu
    const b = obj.find(o => o.status === 'layout-tergeser' && o.id === 'FR-LAMA1');
    r.assertOk(b, 'baris lama berstatus layout-tergeser');
    r.assertEq(b.era, 'BARU13', 'writer lama masih tampak bentuk BARU13 (metode di H)');
    // Nilai MENTAH yang tersimpan (kondisi saat ini, sebelum remap):
    r.assertEq(b.sebelum.sheetPerKolom.D, 1, 'kolom D tersimpan 1 = jumlah sebenarnya');
    r.assertEq(b.sebelum.sheetPerKolom.E, 12000, 'kolom E tersimpan 12000 = total sebenarnya');
    r.assertEq(b.sebelum.sheetPerKolom.F, 250, 'kolom F tersimpan 250 = volume (bukan qty)');
    r.assertEq(b.sebelum.sheetPerKolom.G, 9500, 'kolom G tersimpan 9500 = HPP (bukan total)');
    r.assertEq(b.sebelum.sheetPerKolom.K, 9500, 'kolom K tersimpan 9500 = modal (bener)');
    // Interpretasi semantik (dari posisi terukur D=jumlah dst.):
    r.assertEq(b.sebelum.jumlah, 1, 'jumlah = 1 (dari D)');
    r.assertEq(b.sebelum.totalHarga, 12000, 'total = 12000 (dari E)');
    r.assertEq(b.sesudah.volumeMl, 250, 'target Volume = 250 (dari F)');
    r.assertEq(b.sesudah.hppSatuan, 9500, 'target HPP = 9500 (dari master)');
    r.assertEq(b.sesudah.jumlah, 1, 'target Jumlah = 1 (dari D)');
    r.assertEq(b.sesudah.totalHarga, 12000, 'target Total = 12000 (dari E)');
    r.assertEq(b.sesudah.metode, 'QRIS', 'target metode = H');
    r.assertEq(b.sesudah.modal, 9500, 'target Modal = 1 x 9500');
    r.assertEq(b.sesudah.labaBersih, 2500, 'target Laba = 12000 - 9500');
  });

  r.test('produk tidak ditemukan & HPP kosong -> DIKECUALIKAN, bukan dihitung paksa', () => {
    const { backend } = setup();
    const logs = backend.rencanaBackfillHistori([2, 10]);
    const obj = logs.map(s => JSON.parse(s));
    const hantu = obj.find(o => o.id === 'FR-HANTU1');
    r.assertEq(hantu.status, 'produk-tidak-ditemukan', 'tidak dihitung paksa');
    r.assertEq(hantu.sesudah.modal, null, 'modal target kosong (tidak mengarang)');
    const kosong = obj.find(o => o.id === 'FR-KOSONG1');
    r.assertEq(kosong.status, 'hpp-tidak-tersedia', 'HPP master kosong -> dikecualikan');
    r.assertEq(kosong.sesudah.hppSatuan, null, 'HPP target kosong (tidak mengarang)');
  });

  r.test('baris BARU ok tidak masuk rencana tulis', () => {
    const { backend } = setup();
    const logs = backend.rencanaBackfillHistori([2, 10]);
    const obj = logs.map(s => JSON.parse(s));
    const baru = obj.find(o => o.id === 'FR-BARU1');
    r.assertEq(baru.status, 'ok-tanpa-perubahan', 'baris baru sudah benar, tanpa tulis ulang');
    r.assertEq(baru.sesudah.modal, 16000, '2 x 8000 = 16000 sesuai sheet');
  });
});

r.suite('Diagnostik — pembungkus tanpa parameter (dropdown editor Apps Script)', () => {
  const H13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
    'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];
  const HPP = ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'];

  function setup() {
    const gas = createGasMock();
    gas.scriptRuntime.props.ENV = 'production';
    const spreadsheet = gas.createSpreadsheetMock([
      [HPP[0], HPP[1], HPP[2], HPP[3], HPP[4], HPP[5], HPP[6]],
      ['PD001', 'Wonapel 250 ml', 50, 15000, '', 9500, 250]
    ], { penjualanRows: [
      H13,
      ['FR-1790566607168', '20/09/2026 10:00', 'Wonapel 250 ml', 250, 9500, 1, 15000, 'QRIS', 15000, 0, 9500, 0, 5500]
    ], penjualanMinRows: 1000 });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    return { gas, backend: loadBackendDiagnostik(gas), spreadsheet };
  }

  r.test('cekModalTransaksiBaru() -> baris FR-1790566607168 terdeteksi, tanpa perlu argumen', () => {
    const { backend } = setup();
    const logs = backend.cekModalTransaksiBaru();
    r.assertArray(logs, 'mengembalikan array log');
    const obj = logs.slice(0, -1).map(s => JSON.parse(s));
    const b = obj.find(o => o.id === 'FR-1790566607168');
    r.assertOk(b, 'baris baru ditemukan');
    r.assertEq(b.status, 'modal-sesuai', '1 x 9500 cocok dengan sheet');
    r.assertEq(b.perluRemap, 'TIDAK (kolom L&M terisi = kode baru)', 'dikenali sebagai baris kode baru');
  });

  r.test('cekModalTransaksiLama() -> tidak crash walau ID tidak ada di mock (status tidak-ditemukan)', () => {
    const { backend } = setup();
    const logs = backend.cekModalTransaksiLama();
    const obj = logs.map(s => JSON.parse(s));
    r.assertOk(obj.some(o => o.status === 'tidak-ditemukan'), 'dilaporkan tidak-ditemukan, bukan error');
  });

  r.test('cekRencanaBackfill() -> berisi RINGKASAN, tanpa perlu argumen', () => {
    const { backend } = setup();
    const logs = backend.cekRencanaBackfill();
    const obj = logs.map(s => JSON.parse(s));
    r.assertOk(obj.some(o => o.RINGKASAN && o.RINGKASAN.totalBaris === 1), 'RINGKASAN memuat 1 baris data');
  });
});

r.run('Backend Code.js').then(ok => { process.exit(ok ? 0 : 1); });
