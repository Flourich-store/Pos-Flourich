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

  r.test('P2 (jalur nyata): getInitialData juga baca stok/harga/HPP toleran', () => {
    // getInitialData punya loop sendiri (bukan memanggil getProdukData) dan
    // inilah yang dipakai kasir saat login. Kalau loop ini masih Number(),
    // HPP/harga berformat teks di sheet jadi terpotong di titik.
    const gas = createGasMock();
    const spreadsheet = gas.createSpreadsheetMock([
      HEADER_PRODUK_NYATA,
      ['SL0002', 'Semangci 350 ml', '9', '14.000', '', '9.500', '350']
    ], { penjualanRows: [HEADER_PENJUALAN_13] });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackend(gas);

    const p = backend.getInitialData(60).produk;
    const row = p[1];
    r.assertEq(row[2], 9, 'Stok teks "9" -> 9');
    r.assertEq(row[3], 14000, 'Harga teks "14.000" -> 14000 (bukan 14)');
    r.assertEq(row[5], 9500, 'HPP teks "9.500" -> 9500 (bukan 9.5)');
    r.assertEq(row[6], 350, 'volume_ml teks "350" -> 350');
  });

  r.test('P5: HPP/Modal/Biaya/Laba yang KOSONG diteruskan sebagai "" (bukan 0 diam-diam)', () => {
    // P3 menulis sel kosong sebagai penanda "HPP tak terbaca". Payload ke
    // frontend harus ikut kosong supaya tampilan bisa membedakan
    // "tidak dihitung" dari "nol" — kalau dipaksa 0, kasir mengira laba 0.
    const { backend } = setupNyata();
    const out = backend.getPenjualanData();

    const kosong = out[1]; // FR-0001 sparse: kolom finansial kosong semua
    r.assertEq(kosong[4], '', 'HPP Satuan kosong -> "" (bukan 0)');
    r.assertEq(kosong[10], '', 'Modal kosong -> "" (bukan 0)');
    r.assertEq(kosong[11], '', 'Biaya Operasional kosong -> "" (bukan 0)');
    r.assertEq(kosong[12], '', 'Laba bersih kosong -> "" (bukan 0)');

    // Kolom yang TIDAK pernah dikosongkan P3 tetap angka (tanpa regresi).
    r.assertEq(kosong[5], 0, 'Jumlah kosong tetap 0');
    r.assertEq(kosong[6], 0, 'Total Harga kosong tetap 0');

    // Baris yang terisi tetap angka utuh.
    const isi = out[3]; // FR-0003
    r.assertEq(isi[4], 9500, 'HPP Satuan terisi tetap angka');
    r.assertEq(isi[10], 28500, 'Modal terisi tetap angka');
    r.assertEq(isi[11], 0, 'Biaya Operasional 0 (terisi) tetap angka 0, bukan ""');
    r.assertEq(isi[12], 7500, 'Laba terisi tetap angka');

    // Bentuk payload tetap 13 kolom & JSON-aman.
    r.assertEq(out[0].length, 13, 'header tetap 13 kolom');
    r.assertDoesNotThrow(() => JSON.parse(JSON.stringify(out)), 'payload tetap JSON-valid');
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
    // Lebar baris mengikuti LEBAR BACA header, yaitu max(getMaxColumns(), 13).
    // getRange(1,1,1,13) di Sheets asli mengembalikan 13 sel walau header cuma
    // menamai 11, jadi baris ternilai 13 juga di produksi - yang penting
    // semua sel di luar 11 kolom itu KOSONG, bukan berisi data karangan.
    r.assertEq(t.length, 13, 'lebar baris = max(getMaxColumns(), 13)');
    r.assertEq(t.slice(11).join(''), '', 'tidak ada isi di kolom yang tidak dinamai header');
    r.assertEq(t[2], 'Semangci 350 ml', 'Nama Produk di idx 2');
    r.assertEq(t[3], 2, 'Jumlah di idx 3 (bukan volume)');
    r.assertEq(t[4], 28000, 'Total Harga di idx 4');
    r.assertEq(t[5], 'CASH', 'Metode di idx 5');
    r.assertEq(t[8], 18000, 'Modal di idx 8');
    r.assertEq(t[10], 10000, 'Laba bersih di idx 10');
    r.assertIncludes(gas.Logger.logs.join('\n'), 'volumeMl', 'field tanpa kolom dilaporkan, bukan di-shift');
  });
});

// ════════════════════════════════════════════════════════════════
// P1-P3 — Checkout: parsing angka toleran format id-ID, baca HPP
// toleran, dan Modal/Laba KOSONG (bukan 0) bila HPP tak terbaca.
// ════════════════════════════════════════════════════════════════

r.suite('P1-P2 — Checkout menerima angka format Indonesia (parseAngkaToleran)', () => {

  r.test('P1: jumlah string, hpp string, uang bayar "Rp 50.000" -> transaksi tetap benar', () => {
    const { backend, spreadsheet } = setupNyata();
    const sebelum = spreadsheet.__penjualan.__rows().length;

    const res = backend.prosesCheckout(
      [{ id: 'SL0002', nama: 'Semangci 350 ml', jumlah: '2', hpp: '9.500' }],
      'CASH',
      'Rp 50.000'
    );

    r.assertEq(res.status, 'success', 'checkout sukses dengan angka berformat id-ID');
    r.assertEq(res.total, 28000, 'total = 14000 x 2');
    r.assertEq(res.bayar, 50000, '"Rp 50.000" terurai jadi 50000');
    r.assertEq(res.kembali, 22000, 'kembali = 50000 - 28000');

    const rows = spreadsheet.__penjualan.__rows();
    r.assertEq(rows.length, sebelum + 1, 'tepat 1 baris baru');
    const t = rows[sebelum];
    r.assertEq(t[4], 9500, 'kolom E HPP Satuan = 9500 (dari string "9.500")');
    r.assertEq(t[5], 2, 'kolom F Jumlah = 2 (dari string "2")');
    r.assertEq(t[6], 28000, 'kolom G Total Harga = 28000');
    r.assertEq(t[8], 50000, 'kolom I Uang Dibayar = 50000');
    r.assertEq(t[10], 19000, 'kolom K Modal = 9500 x 2');
    r.assertEq(t[12], 9000, 'kolom M Laba bersih = 28000 - 19000');
  });

  r.test('P2: HPP TEKS "10.500" di sheet Produk -> Modal tertulis BENAR, bukan 10.5 dan bukan kosong', () => {
    // Number("10.500") = 10.5 (memotong di titik) — bug yang dicegah parser toleran.
    const gas = createGasMock();
    const spreadsheet = gas.createSpreadsheetMock([
      HEADER_PRODUK_NYATA,
      ['SL0002', 'Semangci 350 ml', 9, 14000, '', '10.500', 350]
    ], { penjualanRows: [HEADER_PENJUALAN_13] });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackend(gas);

    // Payload produk juga harus membawa HPP sebagai ANGKA utuh, bukan 10.5.
    const byId = {};
    backend.getProdukData().slice(1).forEach(x => { byId[x[0]] = x; });
    r.assertEq(byId['SL0002'][5], 10500, 'payload produk HPP = 10500 (bukan 10.5)');

    const res = backend.prosesCheckout(
      [{ id: 'SL0002', nama: 'Semangci 350 ml', jumlah: 2 }],
      'CASH', 50000
    );
    r.assertEq(res.status, 'success', 'checkout sukses');

    const t = spreadsheet.__penjualan.__rows()[1];
    r.assertEq(t[4], 10500, 'kolom E HPP Satuan = 10500 (HPP sheet dibaca toleran)');
    r.assertEq(t[10], 21000, 'kolom K Modal = 10500 x 2 = 21000');
    r.assertEq(t[12], 7000, 'kolom M Laba bersih = 28000 - 21000');
  });

  r.test('P2: HPP dari frontend menang & tetap toleran ("Rp 9.500")', () => {
    const { backend, spreadsheet } = setupNyata();
    const sebelum = spreadsheet.__penjualan.__rows().length;

    const res = backend.prosesCheckout(
      [{ id: 'SL0002', nama: 'Semangci 350 ml', jumlah: 2, hpp: 'Rp 9.500' }],
      'QRIS', 0
    );
    r.assertEq(res.status, 'success', 'checkout sukses');

    const t = spreadsheet.__penjualan.__rows()[sebelum];
    r.assertEq(t[4], 9500, 'kolom E HPP Satuan = 9500 (hpp frontend "Rp 9.500")');
    r.assertEq(t[10], 19000, 'kolom K Modal = 9500 x 2');
  });
});

r.suite('P3 — HPP tak terbaca: Modal/Laba KOSONG (bukan 0), transaksi tetap boleh selesai', () => {

  r.test('HPP kosong di sheet & payload -> Modal & Laba KOSONG, BUKAN 0, status tetap success', () => {
    // PRODUK_VALID tidak punya kolom HPP -> HPP tak terbaca.
    const { backend, spreadsheet } = setupBackend();
    const sebelum = spreadsheet.__penjualan.__rows().length;

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }],
      'CASH',
      50000
    );

    r.assertEq(res.status, 'success', 'kasir TETAP boleh menyelesaikan transaksi');
    r.assertEq(res.total, 30000, 'total tetap dihitung normal');
    r.assertEq(res.kembali, 20000, 'kembali tetap benar');

    const rows = spreadsheet.__penjualan.__rows();
    r.assertEq(rows.length, sebelum + 1, 'baris tetap tertulis (tidak diblokir)');
    const t = rows[sebelum];
    r.assertEq(t[4], '', 'kolom E HPP Satuan KOSONG (bukan 0)');
    r.assertEq(t[10], '', 'kolom K Modal KOSONG (bukan 0)');
    r.assertEq(t[12], '', 'kolom M Laba Bersih KOSONG (bukan 0)');
    r.assertFalse(t[10] === 0, 'Modal TIDAK boleh 0 diam-diam');
    r.assertFalse(t[12] === 0, 'Laba TIDAK boleh 0 diam-diam');
    // Kolom yang TIDAK bergantung HPP tetap terisi benar.
    r.assertEq(t[5], 2, 'kolom F Jumlah tetap 2');
    r.assertEq(t[6], 30000, 'kolom G Total Harga tetap 30000');
    r.assertEq(t[7], 'CASH', 'kolom H Metode tetap CASH');
  });

  r.test('HPP tak terbaca -> logger menjelaskan, dan stok produk tetap berkurang', () => {
    const { gas, backend, spreadsheet } = setupBackend();

    backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }],
      'CASH', 50000
    );

    r.assertIncludes(gas.Logger.logs.join('\n'), 'KOSONG', 'logger menyebut sel ditulis KOSONG');
    r.assertEq(spreadsheet.__produk.__rows()[1][2], 48, 'stok tetap berkurang 50->48');
  });

  r.test('HPP terbaca -> Modal/Laba tetap TERISI angka (tidak ikut jadi kosong)', () => {
    const { backend, spreadsheet } = setupNyata();
    const sebelum = spreadsheet.__penjualan.__rows().length;

    const res = backend.prosesCheckout(
      [{ id: 'WNA0001', nama: 'Wonapel 250 ml', jumlah: 3 }],
      'CASH', 50000
    );
    r.assertEq(res.status, 'success', 'checkout sukses');

    const t = spreadsheet.__penjualan.__rows()[sebelum];
    r.assertEq(t[4], 9500, 'kolom E HPP Satuan = 9500');
    r.assertEq(t[10], 28500, 'kolom K Modal = 9500 x 3');
    r.assertEq(t[12], 7500, 'kolom M Laba = 36000 - 28500');
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

  r.test('P1 jalan pintas: number (bukan string) langsung dikembalikan utuh', () => {
    const { backend } = setup();
    r.assertEq(backend.parseAngkaToleran(1234.5), 1234.5, 'number desimal 1234.5 utuh (bukan jadi 12345)');
    r.assertEq(backend.parseAngkaToleran(10500), 10500, 'number bulat 10500 utuh');
    r.assertEq(backend.parseAngkaToleran(0), 0, 'number 0 tetap 0');
    r.assertEq(backend.parseAngkaToleran(-2500), -2500, 'number negatif utuh');
  });

  r.test('P1 format Indonesia lengkap: "1.234,56", "Rp 10.500", "10500"', () => {
    const { backend } = setup();
    r.assertEq(backend.parseAngkaToleran('1.234,56'), 1234.56, '"1.234,56" -> 1234.56');
    r.assertEq(backend.parseAngkaToleran('Rp 10.500'), 10500, '"Rp 10.500" -> 10500');
    r.assertEq(backend.parseAngkaToleran('10500'), 10500, '"10500" -> 10500');
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
    // CATATAN PREMISE: baris ini writer-lama TERGESER (D=jumlah, E=total,
    // F=volume, G=HPP) jadi HPP-nya TERCATAT di kolom G = 4000. Angka
    // 4000 itu bukan dikarang dari master (produknya tidak ada di master),
    // melainkan dibaca dari baris itu sendiri -> sesuai aturan kolom-E
    // didahulukan. Yang dijamin: tidak pernah memakai HPP master.
    r.assertEq(hantu.sesudah.hppSatuan, 4000, 'HPP dari kolom G baris itu sendiri, bukan dari master');
    r.assertEq(hantu.produkMaster, null, 'tetap tidak ada di master');
    const kosong = obj.find(o => o.id === 'FR-KOSONG1');
    r.assertEq(kosong.status, 'hpp-tidak-tersedia', 'HPP master kosong -> dikecualikan');
    r.assertEq(kosong.sesudah.hppSatuan, 16000, 'HPP dari kolom G writer-lama (16000), bukan dikarang');
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

r.suite('Diagnostik — rencanaBackfillHistori (HPP kolom-E didahulukan, master HANYA estimasi)', () => {
  const H13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
    'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];

  function setup() {
    const gas = createGasMock();
    gas.scriptRuntime.props.ENV = 'production';
    // NOTE: HPP master 'Semangsu 350 ml' = 10000, sedangkan baris lamanya
    // tercatat 9000 di kolom E. Master dianggap SUDAH BERUBAH.
    const spreadsheet = gas.createSpreadsheetMock([
      ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'],
      ['PD001', 'Semangsu 350 ml', 20, 15000, '', 10000, 350],
      ['PD002', 'Semangci 350 ml', 20, 14000, '', 8000, 350],
      ['PD003', 'Tanpa HPP 500 ml', 3, 20000, '', '', 500]
    ], { penjualanRows: [
      H13,
      // (1) kelas E sehat: kolom E terisi 9000, master kini 10000. TIDAK boleh ditulis 10000.
      ['FR-KOLOME', '27/09/2026 06:16', 'Semangsu 350 ml', 350, 9000, 1, 15000, 'CASH', 15000, 0, 9000, 0, 6000],
      // (2) kolom E kosong, Modal ditulis 0 -> perlu estimasi dari master
      ['FR-MODAJA', '01/09/2026 10:00', 'Semangsu 350 ml', '', '', 1, 15000, 'CASH', 15000, 0, 0, 0, 15000],
      // (3) kelas A: L&M kosong TAPI D&E juga kosong -> BUKAN layout tergeser
      ['FR-KELAS-A', '28/06/2026 08:00', 'Semangci 350 ml', '', '', 2, 28000, 'CASH', 28000, 0, '', '', ''],
      // (4) kolom E berisi 0 -> bukan HPP valid, turun ke estimasi master
      ['FR-E-NOL', '02/09/2026 09:00', 'Semangci 350 ml', '', 0, 1, 14000, 'CASH', 14000, 0, 0, 0, 14000],
      // (5) produk tidak ada di master & kolom E kosong -> tanpa sumber HPP sama sekali
      ['FR-HANTU', '03/09/2026 09:00', 'Misteri 300 ml', '', '', 1, 5000, 'CASH', 5000, 0, 0, 0, 5000],
      // (5b) produk tidak ada di master, TAPI kolom E terisi -> tetap DIKECUALIKAN
      //      dari rencana tulis, tapi sumber HPP-nya dilaporkan supaya bisa ditinjau.
      ['FR-HANTU2', '05/09/2026 09:00', 'Misteri 300 ml', 300, 4000, 1, 5000, 'CASH', 5000, 0, 0, 0, 5000],
      // (6) HPP master kosong DAN kolom E kosong -> tidak ada sumber HPP sama sekali
      ['FR-HPPKOSONG', '04/09/2026 09:00', 'Tanpa HPP 500 ml', '', '', 1, 20000, 'CASH', 20000, 0, 0, 0, 20000]
    ], penjualanMinRows: 1000 });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackendDiagnostik(gas);
    return { gas, backend, spreadsheet };
  }

  function jalankan(backend) {
    const obj = backend.rencanaBackfillHistori([2, 20]).map(s => JSON.parse(s));
    return { ring: obj.find(o => o.RINGKASAN).RINGKASAN, semua: obj.filter(o => o.barisSheet) };
  }

  r.test('ATURAN INTI: kolom E yang terisi dipakai, master HPP TIDAK menimpanya', () => {
    const { backend } = setup();
    const { semua } = jalankan(backend);
    const b = semua.find(o => o.id === 'FR-KOLOME');
    r.assertEq(b.sumberHpp, 'kolom-E', 'sumber HPP = kolom E baris itu');
    r.assertEq(b.sesudah.hppSatuan, 9000, 'HPP target 9000 (tercatat), bukan 10000 dari master');
    r.assertEq(b.sesudah.modal, 9000, 'Modal = 1 x 9000 sesuai yang tercatat');
    r.assertEq(b.sesudah.labaBersih, 6000, 'Laba = 15000 - 9000');
    r.assertEq(b.estimasi, false, 'bukan estimasi');
    r.assertEq(b.status, 'ok-tanpa-perubahan', 'baris sehat tidak proposes ditulis ulang');
  });

  r.test('kolom E kosong -> ESTIMASI dari master + penanda eksplisit', () => {
    const { backend } = setup();
    const { semua } = jalankan(backend);
    const b = semua.find(o => o.id === 'FR-MODAJA');
    r.assertEq(b.sumberHpp, 'ESTIMASI-master', 'ditandai estimasi');
    r.assertEq(b.estimasi, true, 'flag estimasi true');
    r.assertIncludes(b.peringatan, 'ESTIMASI', 'ada penanda ESTIMASI di output');
    r.assertEq(b.sesudah.hppSatuan, 10000, 'HPP dari master');
    r.assertEq(b.sesudah.modal, 10000, 'Modal = 1 x 10000');
    r.assertEq(b.sesudah.labaBersih, 5000, 'Laba = 15000 - 10000');
    r.assertEq(b.sebelum.modalSheet, 0, 'sebelum: Modal 0');
  });

  r.test('L&M kosong tapi D&E kosong = kelas A, BUKAN layout tergeser', () => {
    const { backend } = setup();
    const { semua } = jalankan(backend);
    const b = semua.find(o => o.id === 'FR-KELAS-A');
    r.assertEq(b.perluRemap, 'TIDAK', 'tidak dikira writer lama');
    r.assertOk(b.status !== 'layout-tergeser', 'tidak proposes remap baris aligned');
    r.assertEq(b.sumberHpp, 'ESTIMASI-master', 'estimasi karena kolom E kosong');
    r.assertEq(b.sesudah.jumlah, 2, 'jumlah terbaca dari F (bukan D kosong)');
    r.assertEq(b.sesudah.totalHarga, 28000, 'total terbaca dari G');
    r.assertEq(b.sesudah.modal, 16000, 'Modal = 2 x 8000');
    r.assertEq(b.sesudah.labaBersih, 12000, 'Laba = 28000 - 16000');
    r.assertEq(b.sebelum.modalSheet, '(kosong)', 'sebelum: Modal kosong, bukan 0');
  });

  r.test('kolom E berisi 0 bukan HPP valid -> turun ke estimasi master', () => {
    const { backend } = setup();
    const { semua } = jalankan(backend);
    const b = semua.find(o => o.id === 'FR-E-NOL');
    r.assertEq(b.sumberHpp, 'ESTIMASI-master', 'HPP 0 tidak dipercaya');
    r.assertEq(b.sesudah.hppSatuan, 8000, 'ambil dari master');
  });

  r.test('produk tak ditemukan & HPP master kosong tetap DIKECUALIKAN (tak ada estimasi)', () => {
    const { backend } = setup();
    const { semua } = jalankan(backend);
    const hantu = semua.find(o => o.id === 'FR-HANTU');
    r.assertEq(hantu.status, 'produk-tidak-ditemukan', 'dikecualikan');
    r.assertEq(hantu.sumberHpp, null, 'tanpa sumber HPP');
    r.assertEq(hantu.estimasi, false, 'tidak diklaim estimasi');
    r.assertEq(hantu.sesudah.hppSatuan, null, 'tidak mengarang HPP');
    const kosong = semua.find(o => o.id === 'FR-HPPKOSONG');
    r.assertEq(kosong.status, 'hpp-tidak-tersedia', 'dikecualikan');
    r.assertEq(kosong.sumberHpp, null, 'tanpa sumber HPP');
    r.assertEq(kosong.sesudah.hppSatuan, null, 'tidak mengarang HPP');
  });

  r.test('produk tak ditemukan tapi kolom E terisi -> tetap dikecualikan, HPP-nya dilaporkan', () => {
    const { backend } = setup();
    const { semua, ring } = jalankan(backend);
    const b = semua.find(o => o.id === 'FR-HANTU2');
    r.assertEq(b.status, 'produk-tidak-ditemukan', 'tidak masuk rencana tulis');
    r.assertEq(b.sumberHpp, 'kolom-E', 'sumber HPP tetap dilaporkan');
    r.assertEq(b.hppKolomTersedia, 4000, 'angka HPP dari baris itu sendiri');
    r.assertEq(ring.hpp_dari_kolom_E, 1, 'baris DIKECUALIKAN tidak dihitung sbg kolom-E di ringkasan');
  });

  r.test('ringkasan memisahkan HPP dari kolom-E vs estimasi master', () => {
    const { backend } = setup();
    const { ring } = jalankan(backend);
    r.assertEq(ring.totalBaris, 7, '7 baris diproses');
    r.assertEq(ring.hpp_dari_kolom_E, 1, '1 baris pakai HPP kolom E');
    r.assertEq(ring.estimasi_dari_master, 3, '3 baris butuh estimasi master');
    r.assertEq(ring.layout_tergeser, 0, 'tidak ada layout tergeser di fixture');
    r.assertEq(ring.produk_tidak_ditemukan, 2, '2 produk tidak ditemukan');
    r.assertEq(ring.hpp_tidak_tersedia, 1, '1 HPP master kosong');
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

// ════════════════════════════════════════════════════════════════
// Alias produk: "Semangka Leci" -> "Semangci" untuk varian 250 & 500 ml.
//
// generalised: penamaan lama di sheet Penjualan adalah "Semangka Leci X ml",
// sedangkan master produk memakai "Semangci X ml". Varian 350 ml sudah
// punya alias; 250 & 500 mlblr. HPP dihitung dari katalog Dashboard
// (master Produk) — tidak dikarang.
// ════════════════════════════════════════════════════════════════
r.suite('Alias produk - Semangka Leci 250/500 ml -> Semangci', () => {
  const H13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
    'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];
  const PRODUK = [
    ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'],
    ['SL0001', 'Semangci 250 ml', 50, 10000, '', 7500, 250],
    ['SL0002', 'Semangci 350 ml', 50, 14000, '', 9000, 350],
    ['SL0003', 'Semangci 500 ml', 50, 20000, '', 11000, 500]
  ];

  function setup() {
    const gas = createGasMock();
    gas.scriptRuntime.props.ENV = 'production';
    const spreadsheet = gas.createSpreadsheetMock(PRODUK, { penjualanRows: [H13], penjualanMinRows: 50 });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackendDiagnostik(gas);
    const selaraskan = backend.__sandbox.selaraskanNamaProduk;
    return { backend, selaraskan, nama: PRODUK.slice(1).map(p => p[1]) };
  }

  r.test('"Semangka Leci 250 ml" resolve ke "Semangci 250 ml"', () => {
    const { selaraskan, nama } = setup();
    r.assertEq(selaraskan('Semangka Leci 250 ml', nama), 'Semangci 250 ml', 'varian 250 ml ikut ter-alias');
  });

  r.test('"Semangka Leci 500 ml" resolve ke "Semangci 500 ml"', () => {
    const { selaraskan, nama } = setup();
    r.assertEq(selaraskan('Semangka Leci 500 ml', nama), 'Semangci 500 ml', 'varian 500 ml ikut ter-alias');
  });

  r.test('alias lama "Semangka Leci 350 ml" tetap jalan (tanpa regresi)', () => {
    const { selaraskan, nama } = setup();
    r.assertEq(selaraskan('Semangka Leci 350 ml', nama), 'Semangci 350 ml', 'alias 350 ml tidak rusak');
  });

  r.test('pencocokan toleran huruf besar & sp berlebih tetap jalan', () => {
    const { selaraskan, nama } = setup();
    r.assertEq(selaraskan('  semangka   leci  500  ml ', nama), 'Semangci 500 ml', 'normalisasi kunci produk');
  });

  r.test('produk yang tidak ada padanannya tetap null (tidak dialiaskan asal)', () => {
    const { selaraskan, nama } = setup();
    r.assertEq(selaraskan('Menu Opsional', nama), null, 'Menu Opsional tetap tidak ditemukan');
    r.assertEq(selaraskan('Semangka Potong', nama), null, 'Semangka Potong tetap tidak ditemukan');
  });
});

// ════════════════════════════════════════════════════════════════
// Diagnostik - rencanaBackfillKolomBaru()
//
// Rencana staging ke 5 kolom BARU (N/O/P/Q/R). Kolom A..M TIDAK disentuh
// supaya nilai lama tetap bisa dibandingkan. Fungsi ini DRY-RUN: tidak
// boleh memanggil setValues/setValue/clearContent sama sekali.
//
// Header baru dipilih yang TIDAK bisa ikut tercocok ke alias
// PETA_KOLOM_PENJUALAN: "Revisi Modal"/"Revisi Laba" (bukan "Modal baru")
// karena nama yang diawali kata "Modal"/"Laba" bisa tertangkap fallback
// prefix-longgar buatPetaKolom. "Catatan Estimasi" (bukan "Catatan HPP")
// demi alasan yang sama terhadap alias "HPP Satuan".
// ════════════════════════════════════════════════════════════════
r.suite('Diagnostik - rencanaBackfillKolomBaru (staging N..R, DRY-RUN)', () => {
  const H13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
    'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];

  function setup() {
    const gas = createGasMock();
    gas.scriptRuntime.props.ENV = 'production';
    // Wonapel 350 ml: master 10500, tapi baris 27/09 tercatat 10000 ->
    // bukti HPP master sudah berubah. Estimasi 26/09 (sheet 8)-curiga.
    // PENTING: produk ini TIDAK punya keputusan HPP pemilik, jadi suite ini
    // menguji jalur "curiga" yang belum diputuskan manusia. Jalur yang sudah
    // diputuskan (KOREKSI + catatan dihapus) diuji suite terpisah.
    const spreadsheet = gas.createSpreadsheetMock([
      ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'],
      ['SL0001', 'Semangci 250 ml', 50, 10000, '', 7500, 250],
      ['SL0003', 'Semangci 500 ml', 50, 20000, '', 11000, 500],
      ['WO0001', 'Wonapel 350 ml', 20, 15000, '', 10500, 350]
    ], { penjualanRows: [
      H13,
      // (1) kolom E terisi & cocok -> TERCATAT
      ['FR-TERCATAT', '28/09/2026 07:00', 'Semangci 250 ml', 250, 7500, 1, 10000, 'CASH', 10000, 0, 7500, 0, 2500],
      // (2) kolom E kosong -> ESTIMASI dari master
      ['FR-ESTIMASI', '01/09/2026 10:00', 'Semangci 250 ml', '', '', 2, 20000, 'CASH', 20000, 0, 0, 0, 20000],
      // (3) produk tak ada di master -> DIKECUALIKAN, kolom angka KOSONG
      ['FR-EKSKLUSI', '05/09/2026 09:00', 'Semangka Potong', '', '', 1, 10000, 'QRIS', 10000, 0, 0, 0, 10000],
      // (4) Semangka Leci 250 ml -> harus ikut ter-alias jadi ESTIMASI
      ['FR-LECI250', '12/07/2026 08:00', 'Semangka Leci 250 ml', '', '', 1, 10000, 'CASH', 10000, 0, '', '', ''],
      // (5) Semangka Leci 500 ml -> harus ikut ter-alias jadi ESTIMASI
      ['FR-LECI500', '12/07/2026 08:05', 'Semangka Leci 500 ml', '', '', 1, 20000, 'CASH', 20000, 0, '', '', ''],
      // (6) Wonapel TERCATAT dengan HPP 10000 (master 10500) -> bukti master berubah
      ['FR-WON-TER', '27/09/2026 07:00', 'Wonapel 350 ml', 350, 10000, 1, 15000, 'CASH', 15000, 0, 10000, 0, 5000],
      // (7) Wonapel ESTIMASI SEBELUM tanggal di (6) -> HPP-nya diduga berbeda
      ['FR-WON-EST', '26/09/2026 11:34', 'Wonapel 350 ml', '', '', 1, 15000, 'CASH', 15000, 0, 0, 0, 15000]
    ], penjualanMinRows: 1000 });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackendDiagnostik(gas);
    return { gas, backend, spreadsheet };
  }

  function jalankan(backend) {
    const obj = backend.rencanaBackfillKolomBaru().map(s => JSON.parse(s));
    return {
      rencana: obj.find(o => o.RENCANA).RENCANA,
      baris: obj.filter(o => o.barisSheet),
      semua: obj
    };
  }

  r.test('header kolom baru persis: Revisi Modal / Revisi Laba / Flag / Sumber HPP / Catatan Estimasi di N,O,P,Q,R', () => {
    const { backend } = setup();
    const { rencana } = jalankan(backend);
    r.assertEq(JSON.stringify(rencana.headerKolomBaru),
      JSON.stringify(['Revisi Modal', 'Revisi Laba', 'Flag', 'Sumber HPP', 'Catatan Estimasi']),
      'urutan header N,O,P,Q,R');
    r.assertEq(rencana.kolomBaru.N, 14, 'N = kolom ke-14');
    r.assertEq(rencana.kolomBaru.O, 15, 'O = kolom ke-15');
    r.assertEq(rencana.kolomBaru.P, 16, 'P = kolom ke-16');
    r.assertEq(rencana.kolomBaru.Q, 17, 'Q = kolom ke-17');
    r.assertEq(rencana.kolomBaru.R, 18, 'R = kolom ke-18');
    r.assertEq(Object.keys(rencana.kolomBaru).join(','), 'N,O,P,Q,R', 'tepat 5 kolom staging');
  });

  r.test('header R = "Catatan Estimasi" TIDAK memuat kata "hpp" (aman dari alias hpp)', () => {
    const { backend } = setup();
    const { rencana } = jalankan(backend);
    const headerR = rencana.headerKolomBaru[4];
    r.assertEq(headerR, 'Catatan Estimasi', 'nama header R disepakati pemilik');
    r.assertOk(!/hpp/i.test(headerR), 'header R tidak mengandung kata "hpp" sama sekali');
  });

  r.test('penambahan R TIDAK menggeser 13 kolom inti & TIDAK menimbulkan ambiguitas', () => {
    const { backend } = setup();
    const sb = backend.__sandbox;
    const { rencana } = jalankan(backend);
    const petas = backend.KONST.PETA_KOLOM_PENJUALAN;
    const fields = Object.keys(petas);
    // Pakai header ASLI dari rencana, bukan daftar hardcode: kalau
    // implementasi tidak menambah kolom R, test ini harus gagal.
    r.assertEq(rencana.headerKolomBaru.length, 5, 'rencana benar-benar punya 5 kolom staging');
    const headerLengkap = H13.concat(rencana.headerKolomBaru);
    r.assertEq(headerLengkap.length, 18, 'header sheet jadi 18 kolom (13 inti + 5 staging)');
    const peta = sb.buatPetaKolom(headerLengkap, petas);

    for (const f of fields) {
      r.assertEq(peta.col[f], fields.indexOf(f), '"' + f + '" tetap di indeks ' + fields.indexOf(f));
    }
    r.assertEq(Object.keys(petas).length, 13, 'peta inti tetap 13 field');
    r.assertEq(peta.ambigu.length, 0, '0 ambiguitas dengan 5 kolom tambahan');

    // Tidak boleh ada field inti yang TerISI oleh kolom staging.
    for (const f of fields) {
      r.assertOk(peta.col[f] <= 12, '"' + f + '" tidak menunjuk kolom staging (N..R)');
    }
    // Header lama (tanpa kolom staging) harus tetap dipetakan sama ->
    // berarti kolom baru benar-benar tidak ikut memengaruhi pembacaan.
    const petaLama = sb.buatPetaKolom(H13.slice(), petas);
    for (const f of fields) {
      r.assertEq(petaLama.col[f], peta.col[f], 'posisi "' + f + '" identik dengan & tanpa kolom staging');
    }
  });

  r.test('R terisi HANYA untuk baris yang dicurigai; baris lain kosong', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const curiga = baris.filter(o => o.nilai.curigaHppBerbeda);
    r.assertEq(curiga.length, 1, 'tepat 1 baris dicurigai di fixture');
    for (const o of curiga) {
      r.assertOk(typeof o.nilai.catatanEstimasi === 'string' && o.nilai.catatanEstimasi.length > 0,
        'baris dicurigai punya isi kolom R');
    }
    const bukanCuriga = baris.filter(o => !o.nilai.curigaHppBerbeda);
    r.assertOk(bukanCuriga.length > 0, 'ada baris lain untuk diperiksa');
    for (const o of bukanCuriga) {
      r.assertEq(o.nilai.catatanEstimasi, '', 'R kosong untuk baris tidak dicurigai (' + o.id + ')');
    }
  });

  r.test('kolom R tidak berisi kebocoran nilai HPP/angka untuk baris biasa', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    // R hanya boleh teks penjelasan; tidak boleh angka hasil hitung.
    for (const o of baris) {
      const v = o.nilai.catatanEstimasi;
      if (v === '') continue;
      r.assertEq(typeof v, 'string', 'R bertipe teks');
      r.assertOk(!/^-?\d+$/.test(v.trim()), 'R bukan angka mentah');
    }
  });

  r.test('baris dengan HPP kolom-E -> flag TERCATAT, Q = "kolom E baris"', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const b = baris.find(o => o.id === 'FR-TERCATAT');
    r.assertEq(b.flag, 'TERCATAT', 'HPP terbaca dari kolom E baris itu');
    r.assertEq(b.nilai.revisiModal, 7500, 'Modal dari HPP tercatat');
    r.assertEq(b.nilai.revisiLaba, 2500, 'Laba = 10000 - 7500');
    r.assertEq(b.nilai.sumberHpp, 'kolom E baris', 'Q mencatat asal HPP');
    r.assertEq(b.nilai.curigaHppBerbeda, false, 'tidak dicurigai');
  });

  r.test('baris kolom E kosong -> flag ESTIMASI, Q = "master produk"', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const b = baris.find(o => o.id === 'FR-ESTIMASI');
    r.assertEq(b.flag, 'ESTIMASI', 'HPP dari master (katalog), bukan historis');
    r.assertEq(b.nilai.revisiModal, 15000, '2 x 7500');
    r.assertEq(b.nilai.revisiLaba, 5000, '20000 - 15000');
    r.assertEq(b.nilai.sumberHpp, 'master produk', 'Q mencatat asal HPP');
  });

  r.test('produk tak ditemukan -> flag DIKECUALIKAN, Revisi Modal & Revisi Laba KOSONG', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const b = baris.find(o => o.id === 'FR-EKSKLUSI');
    r.assertEq(b.flag, 'DIKECUALIKAN', 'tidak ada padanan master');
    r.assertEq(b.nilai.revisiModal, '', 'Modal TIDAK dikarang');
    r.assertEq(b.nilai.revisiLaba, '', 'Laba TIDAK dikarang');
    r.assertEq(b.nilai.sumberHpp, 'tidak ada padanan master', 'Q menjelaskan alasan');
  });

  r.test('alias 250/500 membuat baris Semangka Leci jadi ESTIMASI (bukan dikecualikan)', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const a = baris.find(o => o.id === 'FR-LECI250');
    r.assertEq(a.flag, 'ESTIMASI', 'Semangka Leci 250 ml ketemu master via alias');
    r.assertEq(a.nilai.revisiModal, 7500, 'HPP katalog Semangci 250 ml = 7500');
    const b = baris.find(o => o.id === 'FR-LECI500');
    r.assertEq(b.flag, 'ESTIMASI', 'Semangka Leci 500 ml ketemu master via alias');
    r.assertEq(b.nilai.revisiModal, 11000, 'HPP katalog Semangci 500 ml = 11000');
  });

  r.test('produk TANPA keputusan pemilik: estimasi sebelum tanggal bukti -> curigaHppBerbeda', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const est = baris.find(o => o.id === 'FR-WON-EST');
    r.assertEq(est.nilai.curigaHppBerbeda, true, 'estimasi 26/09 dicurigai (master 10500, terekam 10000 di 27/09)');
    r.assertOk(String(est.nilai.catatanEstimasi).includes('Wonapel'), 'catatan R menyebut produknya');
    r.assertEq(est.nilai.revisiModal, 10500, 'HPP TETAP master 10500 - aturan estimasi tidak diubah');
    const ter = baris.find(o => o.id === 'FR-WON-TER');
    r.assertEq(ter.nilai.curigaHppBerbeda, false, 'baris TERCATAT tidak dicurigai');
  });

  r.test('produk lain TIDAK ikut ditandai (Semangci HPP master cocok dengan yang terekam)', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const est = baris.find(o => o.id === 'FR-ESTIMASI');
    r.assertEq(est.nilai.curigaHppBerbeda, false, 'Semangci 250 ml master 7500 = terekam 7500');
  });

  r.test('ringkasan menghitung tiap flag', () => {
    const { backend } = setup();
    const { rencana, baris } = jalankan(backend);
    const R = rencana.ringkasan;
    r.assertEq(R.totalBaris, 7, '7 baris diproses');
    r.assertEq(R.tercatat, 2, 'FR-TERCATAT + FR-WON-TER');
    r.assertEq(R.koreksi, 0, 'tidak ada produk berkeputusan pemilik di fixture ini');
    r.assertEq(R.estimasi, 4, 'FR-ESTIMASI + 2 alias + FR-WON-EST');
    r.assertEq(R.dikecualikan, 1, 'FR-EKSKLUSI');
    r.assertEq(baris.length, 7, 'setiap baris punya entri rencana');
    r.assertEq(R.curigaHppBerbeda, 1, '1 baris dicurigai');
    r.assertEq(R.denganCatatan, 1, 'tepat 1 baris punya isi kolom R');
  });

  r.test('DRY-RUN: tidak ada satu sel pun berubah di sheet Penjualan', () => {
    const { backend, spreadsheet } = setup();
    const sebelum = JSON.stringify(spreadsheet.__penjualan.__rows());
    jalankan(backend);
    const sesudah = JSON.stringify(spreadsheet.__penjualan.__rows());
    r.assertEq(sesudah, sebelum, 'sheet Penjualan tak tersentuh');
    r.assertEq(spreadsheet.__penjualan.getMaxColumns(), 13, 'kolom N..R belum ada di sheet');
  });
});

// ════════════════════════════════════════════════════════════════
// Diagnostik - KEPUTUSAN PEMILIK: HPP Semangsu 350 ml = 10.000
//
// Keputusan pemilik (28/09/2026): HPP Semangsu 350 ml final 10.000.
// Damanya di backfill:
//   (a) baris TERCATAT yang kolom E-nya BERBEDA dari 10.000 -> flag KOREKSI,
//       Revisi Modal = 10.000 x jumlah, Revisi Laba dihitung ulang,
//       Sumber HPP = "dikonfirmasi pemilik". K/M tetap utuh.
//   (b) catatan "curiga" di kolom R untuk baris ESTIMASI produk ini DIHAPUS,
//       karena master sudah dinyatakan benar oleh pemilik.
// Suite di atas (tanpa keputusan pemilik) tetap menguji jalur (b)-yang-belum-
// diputuskan supaya mekanisme curiga tidak ikut mati.
// ════════════════════════════════════════════════════════════════
r.suite('Diagnostik - KOREKSI: keputusan HPP pemilik Semangsu 350 ml = 10000', () => {
  const H13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
    'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];

  function setup() {
    const gas = createGasMock();
    gas.scriptRuntime.props.ENV = 'production';
    const spreadsheet = gas.createSpreadsheetMock([
      ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'],
      ['SL0001', 'Semangci 250 ml', 50, 10000, '', 7500, 250],
      ['MO0001', 'Semangsu 350 ml', 20, 15000, '', 10000, 350],
      ['WO0001', 'Wonapel 350 ml', 20, 15000, '', 10500, 350]
    ], { penjualanRows: [
      H13,
      // Semangsu: kolom E 9000 (dulu tertawa 9000) vs keputusan pemilik 10000
      ['FR-SEM-K1', '27/09/2026 07:00', 'Semangsu 350 ml', 350, 9000, 1, 15000, 'CASH', 15000, 0, 9000, 0, 6000],
      ['FR-SEM-K3', '27/09/2026 08:00', 'Semangsu 350 ml', 350, 9000, 3, 45000, 'CASH', 45000, 0, 27000, 0, 18000],
      // dengan Biaya Operasional, supaya laba KOREKSI ikut memotongnya
      ['FR-SEM-KOP', '30/09/2026 07:00', 'Semangsu 350 ml', 350, 9000, 1, 15000, 'CASH', 15000, 0, 9000, 500, 5500],
      // kolom E SUDAH 10000 -> bukan KOREKSI, tetap TERCATAT
      ['FR-SEM-T10', '29/09/2026 07:00', 'Semangsu 350 ml', 350, 10000, 2, 30000, 'CASH', 30000, 0, 20000, 0, 10000],
      // Semangsu ESTIMASI (kolom E kosong) -> catatan curiga harus DIHAPUS
      ['FR-SEM-E01', '26/09/2026 11:34', 'Semangsu 350 ml', '', '', 1, 15000, 'CASH', 15000, 0, 0, 0, 15000],
      // Wonapel: TIDAK ada keputusan pemilik -> tidak boleh jadi KOREKSI
      ['FR-WON-T10', '27/09/2026 07:00', 'Wonapel 350 ml', 350, 10000, 1, 15000, 'CASH', 15000, 0, 10000, 0, 5000],
      // Wonapel ESTIMASI -> mekanisme curiga TETAP jalan (tanpa keputusan)
      ['FR-WON-E01', '26/09/2026 11:34', 'Wonapel 350 ml', '', '', 1, 15000, 'CASH', 15000, 0, 0, 0, 15000],
      ['FR-EKSKLUSI', '05/09/2026 09:00', 'Semangka Potong', '', '', 1, 10000, 'QRIS', 10000, 0, 0, 0, 10000]
    ], penjualanMinRows: 1000 });
    gas.scriptRuntime.activeSpreadsheet = spreadsheet;
    const backend = loadBackendDiagnostik(gas);
    return { gas, backend, spreadsheet };
  }

  function jalankan(backend) {
    const obj = backend.rencanaBackfillKolomBaru().map(s => JSON.parse(s));
    return {
      rencana: obj.find(o => o.RENCANA).RENCANA,
      baris: obj.filter(o => o.barisSheet),
      semua: obj
    };
  }

  // ── Titik 1: konstanta terdokumentasi, bukan angka tersebar ────────
  r.test('keputusan HPP pemilik disimpan sebagai KONSTANTA terdokumentasi', () => {
    const gas = createGasMock();
    gas.scriptRuntime.props.ENV = 'production';
    const backend = loadBackendDiagnostik(gas);
    const K = backend.KONST.KEPUTUSAN_HPP_PEMILIK;
    r.assertOk(K, 'konstanta KEPUTUSAN_HPP_PEMILIK ada (bukan angka hardcode di dalam logika)');
    const s = K['Semangsu 350 ml'];
    r.assertOk(s, 'produk Semangsu 350 ml punya entri keputusan');
    r.assertEq(s.hpp, 10000, 'HPP final = 10000');
    r.assertEq(s.sumber, 'pemilik', 'sumber keputusan dicatat: pemilik');
    r.assertOk(String(s.tanggalKeputusan).length >= 8, 'tanggal keputusan dicatat (' + s.tanggalKeputusan + ')');
    r.assertOk(String(s.alasan || '').length > 0, 'alasan/versi dicatat');
  });

  r.test('HPP yang dikonfirmasi owners = HPP master (tidak ada dua angka kebenaran)', () => {
    const { backend } = setup();
    const K = backend.KONST.KEPUTUSAN_HPP_PEMILIK;
    const master = { 'Semangsu 350 ml': 10000, 'Wonapel 350 ml': 10500, 'Semangci 250 ml': 7500 };
    for (const nama of Object.keys(K)) {
      r.assertOk(master[nama] !== undefined, 'produk "' + nama + '" benar-benar ada di master');
      r.assertEq(K[nama].hpp, master[nama], 'HPP dikonfirmasi "' + nama + '" sama dengan master');
    }
  });

  // ── Titik 2: flag KOREKSI ────────────────────────────────────────
  r.test('baris TERCATAT dengan kolom E != HPP dikonfirmasi -> flag KOREKSI', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    for (const id of ['FR-SEM-K1', 'FR-SEM-K3', 'FR-SEM-KOP']) {
      const b = baris.find(o => o.id === id);
      r.assertEq(b.flag, 'KOREKSI', id + ' -> KOREKSI');
      r.assertEq(b.nilai.sumberHpp, 'dikonfirmasi pemilik', id + ' Q = "dikonfirmasi pemilik"');
      r.assertEq(b.koreksi.hppKolomE, 9000, id + ' mencatat kolom E lama = 9000');
      r.assertEq(b.koreksi.hppDikonfirmasi, 10000, id + ' mencatat HPP dikonfirmasi = 10000');
      r.assertEq(b.koreksi.sumberKeputusan, 'pemilik', id + ' mencatat sumber keputusan');
    }
  });

  r.test('KOREKSI: Revisi Modal = HPP dikonfirmasi x jumlah', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const k1 = baris.find(o => o.id === 'FR-SEM-K1');
    r.assertEq(k1.nilai.revisiModal, 10000, '1 x 10000');
    const k3 = baris.find(o => o.id === 'FR-SEM-K3');
    r.assertEq(k3.nilai.revisiModal, 30000, '3 x 10000');
    const kop = baris.find(o => o.id === 'FR-SEM-KOP');
    r.assertEq(kop.nilai.revisiModal, 10000, 'Biaya Operasional TIDAK ikut memotong Modal');
  });

  r.test('KOREKSI: Revisi Laba dihitung ulang dari HPP yang dikonfirmasi', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    r.assertEq(baris.find(o => o.id === 'FR-SEM-K1').nilai.revisiLaba, 5000, '15000 - 10000 - 0');
    r.assertEq(baris.find(o => o.id === 'FR-SEM-K3').nilai.revisiLaba, 15000, '45000 - 30000 - 0');
    r.assertEq(baris.find(o => o.id === 'FR-SEM-KOP').nilai.revisiLaba, 4500, '15000 - 10000 - 500 (biaya op ikut dipotong)');
  });

  r.test('KOREKSI BEDA dari kolom lama: N != K (inilah inti flag baru)', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const k3 = baris.find(o => o.id === 'FR-SEM-K3');
    r.assertEq(k3.sebelum.modal, 27000, 'K lama = 9000 x 3');
    r.assertEq(k3.nilai.revisiModal, 30000, 'N baru = 10000 x 3');
    r.assertEq(k3.sebelum.laba, 18000, 'M lama tercatat');
    r.assertEq(k3.nilai.revisiLaba, 15000, 'O baru dihitung ulang');
    r.assertOk(k3.nilai.revisiModal !== k3.sebelum.modal, 'N sengaja TIDAK sama dengan K');
    r.assertOk(k3.nilai.revisiLaba !== k3.sebelum.laba, 'O sengaja TIDAK sama dengan M');
  });

  r.test('kolom E yang SUDAH sama dengan HPP dikonfirmasi -> tetap TERCATAT (bukan KOREKSI)', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const b = baris.find(o => o.id === 'FR-SEM-T10');
    r.assertEq(b.flag, 'TERCATAT', 'tidak ada yang dikoreksi');
    r.assertEq(b.nilai.sumberHpp, 'kolom E baris', 'Q tetap asal kolom E');
    r.assertEq(b.nilai.revisiModal, 20000, '2 x 10000 dari kolom E');
    r.assertEq(b.koreksi, null, 'tidak ada metadata koreksi');
  });

  r.test('produk TANPA keputusan pemilik tidak boleh jadi KOREKSI', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const b = baris.find(o => o.id === 'FR-WON-T10');
    r.assertEq(b.flag, 'TERCATAT', 'kolom E 10000 dipakai apa adanya walau master 10500');
    r.assertEq(b.nilai.sumberHpp, 'kolom E baris', 'bukan "dikonfirmasi pemilik"');
    r.assertEq(b.nilai.revisiModal, 10000, 'N mengikuti kolom E');
    r.assertEq(b.koreksi, null, 'tanpa metadata koreksi');
  });

  // ── Titik 3: catatan curiga produk terkonfirmasi dihapus ──────────
  r.test('ESTIMASI produk terkonfirmasi: catatan curiga kolom R DIHAPUS', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const b = baris.find(o => o.id === 'FR-SEM-E01');
    r.assertEq(b.flag, 'ESTIMASI', 'tetap ESTIMASI');
    r.assertEq(b.nilai.curigaHppBerbeda, false, 'tidak dicurigai - 10000 sudah dikonfirmasi benar');
    r.assertEq(b.nilai.catatanEstimasi, '', 'kolom R KOSONG');
    r.assertEq(b.nilai.revisiModal, 10000, 'HPP master tidak berubah');
  });

  r.test('baris KOREKSI sendiri tidak punya catatan di kolom R', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    for (const o of baris.filter(x => x.flag === 'KOREKSI')) {
      r.assertEq(o.nilai.curigaHppBerbeda, false, o.id + ' tidak dicurigai');
      r.assertEq(o.nilai.catatanEstimasi, '', o.id + ' kolom R kosong');
    }
  });

  r.test('tanpa regresi: produk BELUM diputuskan tetap dapat catatan curiga', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const b = baris.find(o => o.id === 'FR-WON-E01');
    r.assertEq(b.flag, 'ESTIMASI', 'tetap ESTIMASI');
    r.assertEq(b.nilai.curigaHppBerbeda, true, 'mekanisme curiga masih hidup');
    r.assertOk(String(b.nilai.catatanEstimasi).length > 0, 'kolom R terisi');
    r.assertEq(b.nilai.revisiModal, 10500, 'HPP master, aturan estimasi tidak diubah');
  });

  // ── Titip 4: nilai untuk verifikasi mandiri (dipakai writer) ──────
  r.test('setiap baris non-DIKECUALIKAN punya angka sumber hitungannya', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const target = baris.filter(o => o.flag !== 'DIKECUALIKAN');
    r.assertOk(target.length > 0, 'ada baris untuk diperiksa');
    for (const o of target) {
      const n = o.nilai;
      r.assertEq(typeof n.hppDipakai, 'number', o.id + ' hppDipakai adalah angka');
      r.assertEq(typeof n.jumlah, 'number', o.id + ' jumlah adalah angka');
      r.assertEq(typeof n.totalHarga, 'number', o.id + ' totalHarga adalah angka');
      r.assertEq(typeof n.biayaOperasional, 'number', o.id + ' biayaOperasional adalah angka');
      // Writer harus bisa MENGHITUNG ULANG, bukan sekadar percaya rencana.
      r.assertEq(n.revisiModal, n.jumlah * n.hppDipakai, o.id + ' N = jumlah x HPP');
      r.assertEq(n.revisiLaba, n.totalHarga - n.revisiModal - n.biayaOperasional, o.id + ' O = total - N - biaya');
    }
  });

  r.test('baris DIKECUALIKAN tetap kosong di kolom angka', () => {
    const { backend } = setup();
    const { baris } = jalankan(backend);
    const b = baris.find(o => o.id === 'FR-EKSKLUSI');
    r.assertEq(b.flag, 'DIKECUALIKAN', 'tetap terkunci');
    r.assertEq(b.nilai.revisiModal, '', 'tidak dikarang');
    r.assertEq(b.nilai.revisiLaba, '', 'tidak dikarang');
    r.assertEq(b.koreksi, null, 'tanpa metadata koreksi');
  });

  r.test('ringkasan menghitung keempat flag', () => {
    const { backend } = setup();
    const { rencana } = jalankan(backend);
    const R = rencana.ringkasan;
    r.assertEq(R.totalBaris, 8, '8 baris diproses');
    r.assertEq(R.tercatat, 2, 'FR-SEM-T10 + FR-WON-T10');
    r.assertEq(R.koreksi, 3, 'FR-SEM-K1 + FR-SEM-K3 + FR-SEM-KOP');
    r.assertEq(R.estimasi, 2, 'FR-SEM-E01 + FR-WON-E01');
    r.assertEq(R.dikecualikan, 1, 'FR-EKSKLUSI');
    r.assertEq(R.curigaHppBerbeda, 1, 'hanya Wonapel yang dicurigai');
    r.assertEq(R.denganCatatan, 1, 'hanya 1 baris punya isi kolom R');
  });

  r.test('rekonsiliasi per flag tersedia untuk audit', () => {
    const { backend } = setup();
    const { rencana, baris } = jalankan(backend);
    const rf = rencana.rekonsiliasi.perFlag;
    for (const f of ['TERCATAT', 'KOREKSI', 'ESTIMASI', 'DIKECUALIKAN']) {
      r.assertOk(rf[f], 'perFlag ada untuk ' + f);
    }
    // Sigma KOREKSI harus sama dengan jumlah x 10000 dari fixture.
    r.assertEq(rf.KOREKSI.n, 3, '3 baris KOREKSI');
    r.assertEq(rf.KOREKSI.sigmaModalBaru, 10000 + 30000 + 10000, 'sigma Revisi Modal KOREKSI');
    r.assertEq(rf.KOREKSI.sigmaLabaBaru, 5000 + 15000 + 4500, 'sigma Revisi Laba KOREKSI');
    r.assertEq(rf.KOREKSI.sigmaModalSheet, 9000 + 27000 + 9000, 'sigma K lama KOREKSI');
    // Sigma total harus sama dengan penjumlahan sigma per flag (tak ada baris hilang).
    const total = rencana.rekonsiliasi.sigmaModalBaru;
    r.assertEq(total,
      rf.TERCATAT.sigmaModalBaru + rf.KOREKSI.sigmaModalBaru + rf.ESTIMASI.sigmaModalBaru + rf.DIKECUALIKAN.sigmaModalBaru,
      'sigma total = jumlah sigma per flag');
    r.assertEq(rencana.rekonsiliasi.totalBaris, baris.length, 'totalBaris rekonsiliasi = jumlah entri rencana');
  });

  r.test('DRY-RUN: K/M dan seluruh sheet Penjualan tak tersentuh', () => {
    const { backend, spreadsheet } = setup();
    const sebelum = JSON.stringify(spreadsheet.__penjualan.__rows());
    jalankan(backend);
    const sesudah = JSON.stringify(spreadsheet.__penjualan.__rows());
    r.assertEq(sesudah, sebelum, 'sheet Penjualan tak tersentuh');
    const rows = spreadsheet.__penjualan.__rows();
    r.assertEq(rows[1][10], 9000, 'K baris 1 tetap 9000');
    r.assertEq(rows[1][12], 6000, 'M baris 1 tetap 6000');
    r.assertEq(rows[4][10], 20000, 'K baris TERCATAT Semangsu tetap 20000');
  });
});

// ============================================================
// P5 — getSpreadsheet tidak membanjiri log server
// ============================================================
// getSpreadsheet() dipanggil hampir di SETIAP aksi server (baca produk,
// riwayat, checkout, stok, laporan). Dua Logger.log "untuk debugging" di
// dalamnya ikut jalan di setiap panggilan, padahal nilai ENV dan ssId
// praktis tidak pernah berubah. Akibatnya log yang benar-benar berguna
// (HPP kosong, kolom tidak ketemu, idempotensi) drowned among baris
// yang isinya sama persis setiap kali.
r.suite('Backend - P5: getSpreadsheet tidak menulis log per-panggilan', () => {

  r.test('jalur normal: nol baris log, spreadsheet tetap dikembalikan', () => {
    const { gas, backend, spreadsheet } = setupBackend();
    gas.Logger.logs.length = 0;

    const ss = backend.getSpreadsheet();

    r.assertEq(ss, spreadsheet, 'spreadsheet yang benar dikembalikan');
    r.assertEq(gas.Logger.logs.length, 0,
      'getSpreadsheet tidak boleh menulis log pada jalur normal');
  });

  r.test('20 panggilan beruntun tetap nol baris log (bukan 1 per panggilan)', () => {
    const { gas, backend } = setupBackend();
    gas.Logger.logs.length = 0;

    for (let i = 0; i < 20; i++) backend.getSpreadsheet();

    r.assertEq(gas.Logger.logs.length, 0,
      'getSpreadsheet dipanggil sangat sering; log per-panggilan akan menimpa log penting');
  });

  r.test('jalur error tetap dicatat, dan menyebut ssId yang dicoba', () => {
    const { gas, backend, spreadsheet } = setupBackend();
    gas.scriptRuntime.props['ENV'] = 'production';
    gas.scriptRuntime.props['SS_ID_PROD'] = 'ID-UJI-PROD';
    gas.Logger.logs.length = 0;
    gas.SpreadsheetApp.openById = function () { throw new Error('spreadsheet tidak bisa dibuka'); };

    const ss = backend.getSpreadsheet();

    r.assertEq(ss, spreadsheet, 'fallback getActiveSpreadsheet tetap dipakai');
    r.assertEq(gas.Logger.logs.length, 1, 'error dicatat tepat sekali, tidak dibungkam');
    const teks = gas.Logger.logs.join('\n');
    r.assertIncludes(teks, 'spreadsheet tidak bisa dibuka', 'pesan error ikut tercatat');
    r.assertIncludes(teks, 'ID-UJI-PROD',
      'ssId yang dicoba ikut disebut di jalur error, jadi tidak ada informasi yang hilang');
  });
});

// ============================================================
// v89: cache baca getInitialData (CacheService, 60 dtk, dibuang saat tulis)
// ============================================================

r.suite('Backend — cache baca getInitialData (v89)', () => {

  function setup() {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);
    return { gas, backend, cache: gas.scriptRuntime.__cacheStore };
  }

  r.test('panggilan berulang dalam 60 dtk memakai cache (payload identik)', () => {
    const { backend, cache } = setup();

    const a = backend.getInitialDataBerCache(60);
    const b = backend.getInitialDataBerCache(60);
    r.assertEq(JSON.stringify(b), JSON.stringify(a), 'hasil panggilan kedua identik (dari cache)');
    r.assertOk(cache['pos_awal_v1'], 'cache terisi setelah panggilan pertama');
  });

  r.test('eksekusiAksi getInitialData memakai jalur cache', () => {
    const { backend, cache } = setup();
    const res = backend.eksekusiAksi({ action: 'getInitialData', args: [60] });
    r.assertArray(res.produk, 'payload utuh');
    r.assertOk(cache['pos_awal_v1'], 'cache terisi via eksekusiAksi');
  });

  r.test('checkout MENGHAPUS cache — data stok/riwayat berikutnya selalu segar', () => {
    const { backend, cache } = setup();
    backend.eksekusiAksi({ action: 'getInitialData', args: [60] });
    r.assertOk(cache['pos_awal_v1'], 'cache terisi dulu');

    backend.eksekusiAksi({ action: 'prosesCheckout', args: [
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }], 'CASH', 20000
    ] });
    r.assertOk(!cache['pos_awal_v1'], 'cache dibuang setelah checkout');
  });

  r.test('tambahStokProduk MENGHAPUS cache', () => {
    const { backend, cache } = setup();
    backend.eksekusiAksi({ action: 'getInitialData', args: [60] });
    r.assertOk(cache['pos_awal_v1'], 'cache terisi dulu');

    backend.eksekusiAksi({ action: 'tambahStokProduk', args: ['1', 5, 'KASIR'] });
    r.assertOk(!cache['pos_awal_v1'], 'cache dibuang setelah tambah stok');
  });

  r.test('cache korup dibuang aman — baca ulang sheet tetap benar', () => {
    const { backend, cache } = setup();
    cache['pos_awal_v1'] = '{bukan json';
    const hasil = backend.getInitialDataBerCache(60);
    r.assertArray(hasil.produk, 'fallback baca sheet tetap utuh');
  });

  r.test('checkLogin sukses dicatat; gagal sesaat setelah sukses dicoba sekali lagi', () => {
    const { backend, cache } = setup();
    const ok = backend.checkLoginBerCache('admin', 'password');
    r.assertEq(ok.status, true, 'login sukses');
    r.assertEq(cache['pos_login_admin'], '1', 'penanda sukses tercatat');
  });

  r.test('login dengan password salah tetap ditolak (tidak ada pintas keamanan)', () => {
    const { backend } = setup();
    backend.checkLoginBerCache('admin', 'password'); // catat sukses dulu
    const gagal = backend.checkLoginBerCache('admin', 'SALAH');
    r.assertEq(gagal.status, false, 'kredensial salah tetap ditolak');
  });

  r.test('ping: probe ringan tanpa menyentuh spreadsheet (untuk halaman status)', () => {
    const { gas, backend } = setup();
    // Tanpa spreadsheet aktif sekalipun, ping harus tetap sukses.
    gas.scriptRuntime.activeSpreadsheet = null;
    const res = backend.eksekusiAksi({ action: 'ping', args: [] });
    r.assertEq(res.status, 'success', 'ping sukses tanpa sheet');
    r.assertEq(res.pong, true, 'pong bernilai true');
    r.assertOk(typeof res.waktu === 'number' && res.waktu > 0, 'waktu (timestamp) terisi');
  });

});

r.run('Backend Code.js').then(ok => { process.exit(ok ? 0 : 1); });
