/**
 * BackfillKolomBaru.js - penulis kolom staging N..R.
 *
 * BERBEDA dari backend.test.js: file itu menguji kode produksi yang dipakai
 * kasir setiap hari. File ini menguji SEKALI-SEKALI alat yang menyentuh
 * spreadsheet produksi, jadi standarnya lebih ketat:
 *
 *   - G-0..G-4  guard: batal tanpa menulis SATU PUN sel kalau prasyarat tidak terpenuhi.
 *   - V-1..V-7  verifikasi: kalau gagal, blok dibalik OTOMATIS.
 *   - Kolom A..M harus terbukti tidak berubah (V-2).
 *   - Tidak ada pembungkus "tulis semua blok" - satu blok satu pemanggilan.
 *
 * Semua test memakai fixture 525 baris supaya batas blok yang sebenarnya
 * (2..101, 102..201, ... 502..525) ikut teruji.
 */
const { createGasMock, loadBackendBackfill, createRunner } = require('./helpers');
const r = createRunner();

const H13 = ['ID Transaksi', 'Tanggal', 'Nama Produk', 'Volume (ml)', 'HPP Satuan', 'Jumlah', 'Total Harga',
  'Metode Pembayaran', 'Uang Dibayar', 'Uang Kembali', 'Modal', 'Biaya Operasional', 'Laba bersih'];

const PRODUK = [
  ['ID Produk', 'Nama Produk', 'Stok', 'Harga', 'foto_url', 'HPP', 'volume_ml'],
  ['SL0001', 'Semangci 250 ml', 50, 10000, '', 7500, 250],
  ['MO0001', 'Semangsu 350 ml', 20, 15000, '', 10000, 350],
  ['WO0001', 'Wonapel 350 ml', 20, 15000, '', 10500, 350]
];

/**
 * 525 baris (1 header + 524 data) supaya lastRow = 525 dan keenam blok
 * terisi.:
 *   baris 2   TERCATAT     (Semangci 250, kolom E 7500 = master)
 *   baris 3   KOREKSI      (Semangsu, kolom E 9000 vs keputusan 10000)
 *   baris 4   ESTIMASI     (Wonapel, kolom E kosong)
 *   baris 5   DIKECUALIKAN (Semangka Potong, tidak ada di master)
 *   baris 502 TERCATAT     (di blok 6 - membuktikan V-5 tetap berlaku per blok)
 *   baris 503 KOREKSI      (di blok 6 - V-5 TIDAK boleh pakai N==K di sini)
 *   sisanya    ESTIMASI
 */
function penjualanRows() {
  const rows = [H13.slice()];
  const est = (i) => ['FR-EST-' + i, '01/09/2026 08:00', 'Semangci 250 ml', '', '', 1, 10000, 'CASH', 10000, 0, 0, 0, 10000];
  rows.push(['FR-TER-1', '28/09/2026 07:00', 'Semangci 250 ml', 250, 7500, 1, 10000, 'CASH', 10000, 0, 7500, 0, 2500]);
  rows.push(['FR-KOR-1', '27/09/2026 07:00', 'Semangsu 350 ml', 350, 9000, 3, 45000, 'CASH', 45000, 0, 27000, 0, 18000]);
  rows.push(['FR-EST-1', '26/09/2026 11:34', 'Wonapel 350 ml', '', '', 1, 15000, 'CASH', 15000, 0, 0, 0, 15000]);
  rows.push(['FR-DIKE-1', '05/09/2026 09:00', 'Semangka Potong', '', '', 1, 10000, 'QRIS', 10000, 0, 0, 0, 10000]);
  for (let n = 6; n <= 501; n++) rows.push(est(n));
  rows.push(['FR-TER-6', '28/09/2026 09:00', 'Semangci 250 ml', 250, 7500, 1, 10000, 'CASH', 10000, 0, 7500, 0, 2500]);
  rows.push(['FR-KOR-6', '27/09/2026 09:00', 'Semangsu 350 ml', 350, 9000, 1, 15000, 'CASH', 15000, 0, 9000, 0, 6000]);
  for (let n = 504; n <= 525; n++) rows.push(est(n));
  return rows;
}

function setup(opts) {
  const o = opts || {};
  const gas = createGasMock();
  gas.scriptRuntime.props.ENV = 'production';
  const spreadsheet = gas.createSpreadsheetMock(PRODUK, {
    penjualanRows: penjualanRows(),
    penjualanMinRows: o.minRows || 600,
    // Sheet live punya grid 29 kolom padahal isinya baru 13. Fixture
    // menirunya supaya V-4 (lebar grid tak berubah) benar-benar diuji:
    // menulis ke kolom 18 DI DALAM grid 29 tidak boleh mengubahnya.
    penjualanGridCols: 29
  });
  gas.scriptRuntime.activeSpreadsheet = spreadsheet;
  const backend = loadBackendBackfill(gas);
  return { gas, backend, spreadsheet, sh: spreadsheet.__penjualan };
}

const call = (fn) => JSON.parse(fn());

/**
 * Snapshot yang benar-benar bisa diamati manusia, untuk membandingkan
 * "tidak ada yang berubah". Bukan dump internal mock: sel di luar lebar
 * yang belum pernah diisi tidak boleh dihitung sebagai perubahan.
 * Cakupannya sengaja lengkap - isi kolom inti A..M, kolom staging N..R,
 * dan bentuk sheet (jumlah baris, kolom terisi, lebar grid).
 */
function snap(sh) {
  const n = Math.max(sh.getLastRow(), 1);
  return JSON.stringify({
    lastRow: sh.getLastRow(),
    lastColumn: sh.getLastColumn(),
    maxColumns: sh.getMaxColumns(),
    inti: sh.getRange(1, 1, n, 13).getValues(),
    staging: sh.getRange(1, 14, n, 5).getValues()
  });
}

// ════════════════════════════════════════════════════════════════
r.suite('Backfill - pembungkus tanpa parameter (dropdown Apps Script)', () => {
  r.test('entry point ada & bisa dipanggil TANPA argumen', () => {
    const { backend } = setup();
    for (const n of ['tulisBlok1', 'tulisBlok2', 'tulisBlok3', 'tulisBlok4', 'tulisBlok5', 'tulisBlok6']) {
      r.assertEq(typeof backend[n], 'function', n + ' ada');
      r.assertEq(backend[n].length, 0, n + ' tidak menerima parameter');
    }
    for (const n of ['rollbackBlok1', 'rollbackBlok2', 'rollbackBlok3', 'rollbackBlok4', 'rollbackBlok5', 'rollbackBlok6']) {
      r.assertEq(backend[n].length, 0, n + ' tidak menerima parameter');
    }
    r.assertEq(backend.cekBlokTersedia.length, 0, 'cekBlokTersedia tanpa parameter');
  });

  r.test('TIDAK ada pembungkus "tulis semua blok" (permukaan dikecilkan)', () => {
    const sb = setup().backend.__sandbox;
    r.assertEq(sb.tulisSemuaBlok, undefined, 'tidak ada jalan sekali jalan untuk 6 blok');
    r.assertEq(sb.tulisSemua, undefined, 'tidak ada alias lain');
    r.assertEq(sb.backfillSemua, undefined, 'tidak ada alias lain');
  });
});

// ════════════════════════════════════════════════════════════════
r.suite('Backfill - cekBlokTersedia() READ-ONLY', () => {
  r.test('melaporkan bentuk sheet dan mencatat baseline tanpa menulis', () => {
    const { backend, sh } = setup();
    const sebelum = snap(sh);
    const out = call(backend.cekBlokTersedia);
    r.assertEq(out.status, 'ok', 'berhasil');
    r.assertEq(out.sheet.lastRow, 525, 'lastRow terbaca');
    r.assertEq(out.sheet.jumlahBarisData, 524, '524 baris data');
    r.assertEq(out.sheet.lastColumn, 13, 'used range masih 13 kolom (A..M)');
    r.assertEq(out.sheet.headerInti.length, 13, 'header inti 13 kolom');
    r.assertOk(out.baseline && out.baseline.ssid, 'baseline tercatat');
    r.assertEq(snap(sh), sebelum, 'sheet tak tersentuh sama sekali');
  });

  r.test('mencetak sidik jari yang bisa disetujui pemilik dengan membaca satu baris', () => {
    const s = setup();
    const out = call(s.backend.cekBlokTersedia);
    r.assertOk(out.sidikJari, 'sidikJari ada di hasil');
    r.assertIncludes(out.sidikJari, '525r/524d/29c/',
      'bentuknya <lastRow>r/<jumlahBarisData>d/<maxColumns>c/<hash>');
    r.assertEq(out.sidikJari.split('/').pop().length, 8, 'hash 8 hex');
    r.assertIncludes(out.caraMenyetujui, 'sidikJari', 'ada penjelasan cara membandingkan');
    const barisLog = s.gas.Logger.logs.filter(l => l.indexOf('=== SIDIK JARI: ') === 0);
    r.assertEq(barisLog.length, 1, 'tepat satu baris SIDIK JARI di log');
    r.assertIncludes(barisLog[0], out.sidikJari, 'nilai di log sama dengan nilai di hasil');
  });

  r.test('sidikJari tulisBlokN() = sidikJari cekBlokTersedia()', () => {
    const s = setup();
    const cek = call(s.backend.cekBlokTersedia);
    const tulis = call(s.backend.tulisBlok1);
    r.assertEq(tulis.status, 'ok', 'blok 1 tertulis');
    r.assertEq(tulis.sidikJari, cek.sidikJari,
      'sidik jari yang dicetak tulisBlok1() sama persis dengan yang Anda periksa');
    const barisLog = s.gas.Logger.logs.filter(l => l.indexOf('=== SIDIK JARI: ') === 0);
    r.assertEq(barisLog.length, 2, 'satu dari cek, satu dari tulis');
    r.assertIncludes(barisLog[1], cek.sidikJari, 'kedua baris log bring sidik jari yang sama');
  });

  r.test('sidikJari SENGAJA tidak berubah setelah kolom N..R terisi (lastColumn tak ikut)', () => {
    // Ini yang membuat sidik jari bisa dipakai ulang di blok 2..6. Kalau
    // lastColumn ikut, sidik jari berubah begitu blok 1 ditulis - padahal
    // sheet-nya sama persis - dan persetujuan blk 2 jadi tidak berguna.
    const s = setup();
    const sebelum = call(s.backend.cekBlokTersedia);
    call(s.backend.tulisBlok1);
    r.assertEq(s.sh.getLastColumn(), 18, 'kolom teripe sudah tumbuh ke 18 (N..R)');
    const sesudah = call(s.backend.cekBlokTersedia);
    r.assertEq(sesudah.sheet.lastColumn, 18, 'sekarang lastColumn 18');
    r.assertEq(sesudah.sidikJari, sebelum.sidikJari, 'sidik jari tetap sama walau lastColumn berubah');
  });

  r.test('sidikJari BERUBAH kalau header inti berubah', () => {
    const s = setup();
    const awal = call(s.backend.cekBlokTersedia).sidikJari;
    s.sh.getRange(1, 11).setValue('Modal Disesuaikan');   // kolom K = "Modal"
    const baru = call(s.backend.cekBlokTersedia).sidikJari;
    r.assertNotIncludes(baru, awal, 'perubahan header inti mengubah sidik jari');
  });

  r.test('sidikJari BERUBAH kalau spreadsheet yang dibuka berbeda', () => {
    const s = setup();
    const awal = call(s.backend.cekBlokTersedia).sidikJari;
    s.spreadsheet.getId = () => 'SPREADSHEET-LAIN-999';
    const baru = call(s.backend.cekBlokTersedia).sidikJari;
    r.assertNotIncludes(baru, awal, 'ssid berbeda menghasilkan sidik jari berbeda');
  });

  r.test('mem Breakdown 6 blok dengan rentang baris sheet yang benar', () => {
    const { backend } = setup();
    const out = call(backend.cekBlokTersedia);
    r.assertEq(out.blok.length, 6, '6 blok');
    const rentang = out.blok.map(b => b.dari + '..' + b.sampai).join(',');
    r.assertEq(rentang, '2..101,102..201,202..301,302..401,402..501,502..525', 'batas blok sesuai sheet 525 baris');
    r.assertEq(out.blok.reduce((a, b) => a + b.baris, 0), 524, 'total baris blok = 524');
  });

  r.test('setiap blok melaporkan komposisi flag sesuai Ohioan', () => {
    const { backend } = setup();
    const out = call(backend.cekBlokTersedia);
    const b1 = out.blok[0];
    r.assertEq(b1.komposisi.TERCATAT, 1, 'blok 1 punya 1 TERCATAT (baris 2)');
    r.assertEq(b1.komposisi.KOREKSI, 1, 'blok 1 punya 1 KOREKSI (baris 3)');
    r.assertEq(b1.komposisi.DIKECUALIKAN, 1, 'blok 1 punya 1 DIKECUALIKAN (baris 5)');
    r.assertEq(b1.komposisi.ESTIMASI, 97, 'blok 1 sisanya ESTIMASI');
    const b6 = out.blok[5];
    r.assertEq(b6.komposisi.TERCATAT, 1, 'blok 6 punya 1 TERCATAT (baris 502)');
    r.assertEq(b6.komposisi.KOREKSI, 1, 'blok 6 punya 1 KOREKSI (baris 503)');
    r.assertEq(b6.komposisi.DIKECUALIKAN, 0, 'blok 6 tanpa DIKECUALIKAN');
  });

  r.test('menyertakan ringkasan & rekonsiliasi rencana (bukan hanya bentuk sheet)', () => {
    const { backend } = setup();
    const out = call(backend.cekBlokTersedia);
    r.assertEq(out.rencana.ringkasan.totalBaris, 524, '524 baris direncanakan');
    r.assertEq(out.rencana.ringkasan.tercatat, 2, '2 TERCATAT');
    r.assertEq(out.rencana.ringkasan.koreksi, 2, '2 KOREKSI');
    r.assertEq(out.rencana.ringkasan.dikecualikan, 1, '1 DIKECUALIKAN');
    r.assertEq(typeof out.rencana.rekonsiliasi.sigmaModalBaru, 'number', 'sigma Modal tersedia');
  });
});

// ════════════════════════════════════════════════════════════════
r.suite('Backfill - guard G-0..G-4', () => {
  r.test('G-0: tanpa cekBlokTersedia() tidak ada satu sel pun ditulis', () => {
    const { backend, sh } = setup();
    const sebelum = snap(sh);
    const out = call(backend.tulisBlok1);
    r.assertEq(out.status, 'batal', 'batal');
    r.assertFalse(out.guard.G0.ok, 'G-0 gagal');
    r.assertEq(out.tulis.selDitulis, 0, 'nol sel ditulis');
    r.assertEq(snap(sh), sebelum, 'sheet tak tersentuh');
  });

  r.test('G-0: baseline dari spreadsheet LAIN ditolak', () => {
    const { backend, gas, sh } = setup();
    call(backend.cekBlokTersedia);
    // Spreadsheet ditukar setelah baseline dicatat.
    const lain = gas.createSpreadsheetMock(PRODUK, { penjualanRows: penjualanRows(), penjualanMinRows: 600 });
    lain.getId = () => 'MOCK-SS-LAIN';
    gas.scriptRuntime.activeSpreadsheet = lain;
    const sebelum = snap(lain.__penjualan);
    const out = call(backend.tulisBlok1);
    r.assertEq(out.status, 'batal', 'batal');
    r.assertFalse(out.guard.G0.ok, 'G-0 gagal: baseline bukan untuk spreadsheet ini');
    r.assertEq(snap(lain.__penjualan), sebelum, 'sheet tak tersentuh');
  });

  r.test('G-1: lastRow berubah setelah baseline -> batal', () => {
    const { backend, gas, sh } = setup();
    call(backend.cekBlokTersedia);
    sh.appendRow(['FR-BARU', '29/09/2026 10:00', 'Semangci 250 ml', '', '', 1, 10000, 'CASH', 10000, 0, 0, 0, 10000]);
    const out = call(backend.tulisBlok1);
    r.assertEq(out.status, 'batal', 'batal');
    r.assertFalse(out.guard.G1.ok, 'G-1 gagal');
    r.assertEq(out.tulis.selDitulis, 0, 'nol sel ditulis');
  });

  r.test('G-2: header inti A1:M1 berubah -> batal', () => {
    const { backend, sh } = setup();
    call(backend.cekBlokTersedia);
    sh.getRange(1, 11).setValue('Modal BARU'); // kolom K
    const out = call(backend.tulisBlok1);
    r.assertEq(out.status, 'batal', 'batal');
    r.assertFalse(out.guard.G2.ok, 'G-2 gagal');
    r.assertEq(out.tulis.selDitulis, 0, 'nol sel ditulis');
  });

  r.test('G-3: nilai asing di kolom staging -> batal, tidak ditimpa diam-diam', () => {
    const { backend, sh } = setup();
    call(backend.cekBlokTersedia);
    sh.getRange(50, 14).setValue(999999); // N50 milik orang lain
    const out = call(backend.tulisBlok1);
    r.assertEq(out.status, 'batal', 'batal');
    r.assertFalse(out.guard.G3.ok, 'G-3 gagal');
    r.assertEq(out.tulis.selDitulis, 0, 'nol sel ditulis');
    r.assertEq(sh.getRange(50, 14).getValue(), 999999, 'nilai milik orang lain UTUH');
  });

  r.test('G-3: blok 2..6 wajib punya header N1:R1 hasil blok 1', () => {
    const { backend, sh } = setup();
    call(backend.cekBlokTersedia);
    const out = call(backend.tulisBlok2);
    r.assertEq(out.status, 'batal', 'batal');
    r.assertFalse(out.guard.G3.ok, 'G-3 gagal: header belum ada');
    r.assertEq(out.tulis.selDitulis, 0, 'nol sel ditulis');
  });

  r.test('G-4: kunci tulis tidak diperoleh -> batal (bukan jalan tanpa lock)', () => {
    const { backend, gas, sh } = setup();
    call(backend.cekBlokTersedia);
    gas.__lockState.gagalkanLock = true;
    const sebelum = snap(sh);
    const out = call(backend.tulisBlok1);
    r.assertEq(out.status, 'batal', 'batal');
    r.assertFalse(out.guard.G4.ok, 'G-4 gagal');
    r.assertEq(out.tulis.selDitulis, 0, 'nol sel ditulis');
    r.assertEq(snap(sh), sebelum, 'sheet tak tersentuh');
    r.assertEq(gas.__lockState.released, 0, 'tidak ada lock yang sempat diperoleh, lalu dilepas');
  });

  r.test('G-4 memakai kunci script yang SAMA dengan prosesCheckout', () => {
    const { backend, gas } = setup();
    call(backend.cekBlokTersedia);
    const sebelum = gas.__lockState.acquired;
    call(backend.tulisBlok1);
    r.assertEq(gas.__lockState.acquired, sebelum + 1, 'satu kunci diambil');
    r.assertEq(gas.__lockState.released, sebelum + 1, 'dan dilepas kembali');
  });
});

// ════════════════════════════════════════════════════════════════
r.suite('Backfill - menulis blok 1 (header + data)', () => {
  function menulis() {
    const s = setup();
    call(s.backend.cekBlokTersedia);
    const out = call(s.backend.tulisBlok1);
    return Object.assign({ out }, s);
  }

  r.test('berhasil menulis hanya kolom N..R baris 2..101', () => {
    const { out, sh } = menulis();
    r.assertEq(out.status, 'ok', 'status ok');
    r.assertEq(out.blok, 1, 'blok 1');
    r.assertEq(out.tulis.barisDitulis, 100, '100 baris ditulis');
    r.assertEq(out.tulis.headerDitulis, true, 'header ditulis blok 1');
    r.assertEq(out.tulis.selDitulis, 505, '100 baris x 5 kolom + 5 sel header');
    r.assertEq(sh.getRange(2, 14).getValue(), 7500, 'N2 = Revisi Modal TERCATAT');
    r.assertEq(sh.getRange(2, 16).getValue(), 'TERCATAT', 'P2 = flag');
    r.assertEq(sh.getRange(2, 17).getValue(), 'kolom E baris', 'Q2 = sumber HPP');
  });

  r.test('header N1:R1 persis Revisi Modal/Revisi Laba/Flag/Sumber HPP/Catatan Estimasi', () => {
    const { sh } = menulis();
    const h = sh.getRange(1, 14, 1, 5).getValues()[0];
    r.assertEq(JSON.stringify(h),
      JSON.stringify(['Revisi Modal', 'Revisi Laba', 'Flag', 'Sumber HPP', 'Catatan Estimasi']),
      'urutan header N,O,P,Q,R');
  });

  r.test('kolom A..M (termasuk K & M) TERBUKTI tidak berubah', () => {
    const s = setup();
    const sebelum = s.sh.__rows().map(row => row.slice(0, 13));
    call(s.backend.cekBlokTersedia);
    call(s.backend.tulisBlok1);
    const sesudah = s.sh.__rows().map(row => row.slice(0, 13));
    r.assertEq(JSON.stringify(sesudah), JSON.stringify(sebelum), 'A..M identik bit-per-bit');
    r.assertEq(s.sh.getRange(2, 11).getValue(), 7500, 'K2 tetap 7500');
    r.assertEq(s.sh.getRange(2, 13).getValue(), 2500, 'M2 tetap 2500');
  });

  r.test('baris KOREKSI ditulis dari HPP dikonfirmasi, BUKAN dari kolom E', () => {
    const { sh } = menulis();
    r.assertEq(sh.getRange(3, 14).getValue(), 30000, 'N3 = 10000 x 3');
    r.assertEq(sh.getRange(3, 15).getValue(), 15000, 'O3 = 45000 - 30000');
    r.assertEq(sh.getRange(3, 16).getValue(), 'KOREKSI', 'P3 = KOREKSI');
    r.assertEq(sh.getRange(3, 17).getValue(), 'dikonfirmasi pemilik', 'Q3 = sumber');
    r.assertEq(sh.getRange(3, 18).getValue(), '', 'R3 kosong');
    // K/M tetap angka lamanya.
    r.assertEq(sh.getRange(3, 11).getValue(), 27000, 'K3 tetap 27000');
    r.assertEq(sh.getRange(3, 13).getValue(), 18000, 'M3 tetap 18000');
  });

  r.test('baris DIKECUALIKAN ditulis kosong di kolom angka, bukan 0', () => {
    const { sh } = menulis();
    r.assertEq(sh.getRange(5, 14).getValue(), '', 'N5 kosong');
    r.assertEq(sh.getRange(5, 15).getValue(), '', 'O5 kosong');
    r.assertEq(sh.getRange(5, 16).getValue(), 'DIKECUALIKAN', 'P5 = DIKECUALIKAN');
    r.assertEq(sh.getRange(5, 17).getValue(), 'tidak ada padanan master', 'Q5 menjelaskan');
  });

  r.test('blok 2..6 BELUM tersentuh setelah blok 1', () => {
    const { sh } = menulis();
    r.assertEq(sh.getRange(150, 14).getValue(), '', 'N150 masih kosong');
    r.assertEq(sh.getRange(520, 14).getValue(), '', 'N520 masih kosong');
  });
});

// ════════════════════════════════════════════════════════════════
r.suite('Backfill - verifikasi V-1..V-7', () => {
  function semuaBlok() {
    const s = setup();
    call(s.backend.cekBlokTersedia);
    const outs = [1, 2, 3, 4, 5, 6].map(n => call(s.backend['tulisBlok' + n]));
    return Object.assign({ outs }, s);
  }

  r.test('V-1..V-7 semuanya lulus untuk keenam blok', () => {
    const { outs } = semuaBlok();
    for (const out of outs) {
      r.assertEq(out.status, 'ok', 'blok ' + out.blok + ' status ok');
      for (const v of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7']) {
        r.assertOk(out.verifikasi[v], 'blok ' + out.blok + ' punya ' + v);
        r.assertOk(out.verifikasi[v].ok, 'blok ' + out.blok + ' ' + v + ' lulus');
      }
    }
  });

  r.test('V-3: getLastColumn() tumbuh dari 13 ke 18 (batas kolom R), tidak lebih', () => {
    const { outs } = semuaBlok();
    r.assertEq(outs[0].verifikasi.V3.sebelum, 13, 'sebelum blok 1 masih 13');
    r.assertEq(outs[0].verifikasi.V3.sesudah, 18, 'sesudah blok 1 = 18 (kolom R)');
    for (const out of outs.slice(1)) {
      r.assertEq(out.verifikasi.V3.sesudah, 18, 'blok ' + out.blok + ' tetap 18');
      r.assertEq(out.verifikasi.V3.sesudah, out.verifikasi.V3.sebelum, 'tidak tumbuh lagi');
    }
  });

  r.test('V-4: getMaxColumns() tidak berubah sama sekali', () => {
    const { outs } = semuaBlok();
    for (const out of outs) {
      r.assertEq(out.verifikasi.V4.sesudah, out.verifikasi.V4.sebelum, 'lebar grid tak berubah di blok ' + out.blok);
    }
  });

  r.test('V-5: HANYA TERCATAT yang pakai N==K & O==M', () => {
    const { outs, sh } = semuaBlok();
    // Blok 1 punya keempat flag sekaligus.
    r.assertEq(outs[0].verifikasi.V5.tercatat.diperiksa, 1, 'TERCATAT diperiksa dengan N==K');
    r.assertEq(outs[0].verifikasi.V5.koreksi.diperiksa, 1, 'KOREKSI diperiksa dengan rumus sendiri');
    r.assertEq(outs[0].verifikasi.V5.estimasi.diperiksa, 97, 'ESTIMASI diperiksa dengan rumus sendiri');
    r.assertEq(outs[0].verifikasi.V5.dikecualikan.diperiksa, 1, 'DIKECUALIKAN diperiksa kosong');
    // KOREKSI TIDAK boleh dianes oleh aturan N==K: N sengaja beda K.
    r.assertEq(sh.getRange(3, 14).getValue(), 30000, 'N3 = 30000');
    r.assertEq(sh.getRange(3, 11).getValue(), 27000, 'K3 = 27000');
    r.assertFalse(outs[0].verifikasi.V5.koreksi.pakaiNvsK, 'KOREKSI tidak boleh pakai N==K');
  });

  r.test('V-5 KOREKSI di blok 6: N != K tapi rumusnya benar', () => {
    const { outs, sh } = semuaBlok();
    const b6 = outs[5];
    r.assertEq(b6.blok, 6, 'blok 6');
    r.assertEq(b6.verifikasi.V5.tercatat.diperiksa, 1, '1 TERCATAT di blok 6');
    r.assertEq(b6.verifikasi.V5.koreksi.diperiksa, 1, '1 KOREKSI di blok 6');
    r.assertEq(sh.getRange(503, 14).getValue(), 10000, 'N503 = 10000 (bukan 9000)');
    r.assertEq(sh.getRange(503, 11).getValue(), 9000, 'K503 tetap 9000');
    r.assertEq(sh.getRange(503, 15).getValue(), 5000, 'O503 dihitung ulang');
    r.assertEq(sh.getRange(503, 13).getValue(), 6000, 'M503 tetap 6000');
  });

  r.test('V-5 TERCATAT benar-benar setara K/M setelah ditulis', () => {
    const { sh } = semuaBlok();
    for (const row of [2, 502]) {
      r.assertEq(sh.getRange(row, 14).getValue(), sh.getRange(row, 11).getValue(), 'N' + row + ' == K' + row);
      r.assertEq(sh.getRange(row, 15).getValue(), sh.getRange(row, 13).getValue(), 'O' + row + ' == M' + row);
    }
  });

  r.test('V-6: kolom R kosong untuk semua baris di fixture ini (tidak ada curiga)', () => {
    const { sh } = semuaBlok();
    for (const row of [2, 3, 4, 5, 6, 502, 503, 525]) {
      r.assertEq(sh.getRange(row, 18).getValue(), '', 'R' + row + ' kosong');
    }
  });

  r.test('V-7: baca balik dari sheet cocok dengan rencana, bukan dengan cache', () => {
    const { outs } = semuaBlok();
    for (const out of outs) {
      r.assertEq(out.verifikasi.V7.cocok, out.tulis.barisDitulis, 'semua baris blok ' + out.blok + ' cocok');
      r.assertEq(out.verifikasi.V7.gagal, 0, 'nol sel menyimpang di blok ' + out.blok);
    }
  });

  r.test('getLastRow() tetap 525 setelah semua blok ditulis', () => {
    const { sh } = semuaBlok();
    r.assertEq(sh.getLastRow(), 525, 'jumlah baris tidak berubah');
  });
});

// ════════════════════════════════════════════════════════════════
r.suite('Backfill - kegagalan verifikasi memicu rollback otomatis', () => {
  r.test('nilai yang tidak cocok dengan rencana -> blok dibalik, tidak tertinggal', () => {
    const s = setup();
    call(s.backend.cekBlokTersedia);
    // Sabotase: penulisan data blok pertama menambah 1 ke kolom N, jadi
    // nilai yang benar-benar mendarat di sheet BERBEDA dari rencana.
    // Yang dikacaukan hanya pemanggilan setValues PERTAMA pada rentang itu
    // (rollback = pemanggilan kedua, jadi tidak ikut dikacaukan - kalau ikut,
    // test ini tidak membuktikan apa-apa soal kemampuan memulihkan).
    const asliGetRange = s.sh.getRange.bind(s.sh);
    let sudahSabotase = false;
    s.sh.getRange = function (row, col, numRows, numCols) {
      const rg = asliGetRange(row, col, numRows, numCols);
      if (row >= 2 && col === 14 && numCols === 5) {
        const asliSet = rg.setValues.bind(rg);
        rg.setValues = (vals) => {
          if (!sudahSabotase) {
            sudahSabotase = true;
            return asliSet(vals.map(v => v.map((c, i) => (i === 0 ? c + 1 : c))));
          }
          return asliSet(vals);
        };
      }
      return rg;
    };
    const out = call(s.backend.tulisBlok1);
    r.assertEq(out.status, 'gagal', 'status gagal');
    r.assertFalse(out.verifikasi.V7.ok, 'V-7 menangkap penyimpangan');
    r.assertOk(out.rollback.dijalankan, 'rollback dijalankan');
    r.assertOk(out.rollback.ok, 'rollback berhasil memulihkan keadaan semula');
    r.assertEq(s.sh.getRange(2, 14).getValue(), '', 'N2 dikosongkan kembali');
    r.assertEq(s.sh.getRange(1, 14).getValue(), '', 'header N1 ikut dikosongkan');
    r.assertEq(s.sh.getRange(2, 11).getValue(), 7500, 'K2 tetap utuh');
  });
});

// ════════════════════════════════════════════════════════════════
r.suite('Backfill - idempoten & rollback manual', () => {
  r.test('menjalankan blok yang sama dua kali tidak mengubah apa pun', () => {
    const s = setup();
    call(s.backend.cekBlokTersedia);
    call(s.backend.tulisBlok1);
    const setelahPertama = snap(s.sh);
    const out = call(s.backend.tulisBlok1);
    r.assertEq(out.status, 'ok', 'status ok');
    r.assertEq(out.tulis.selDitulis, 0, 'tidak ada sel yang ditulis ulang');
    r.assertEq(out.sudahDitulis, true, 'dilaporkan sudah ditulis');
    r.assertEq(snap(s.sh), setelahPertama, 'sheet tidak berubah');
  });

  r.test('rollbackBlok1 mengosongkan N..R blok itu DAN header', () => {
    const s = setup();
    call(s.backend.cekBlokTersedia);
    call(s.backend.tulisBlok1);
    const out = call(s.backend.rollbackBlok1);
    r.assertEq(out.status, 'ok', 'rollback berhasil');
    const sel = s.sh.getRange(1, 14, 101, 5).getValues()
      .reduce((a, row) => a.concat(row), []).filter(v => String(v == null ? '' : v) !== '');
    r.assertEq(sel.length, 0, 'seluruh N1:R101 kosong kembali');
  });

  r.test('rollback hanya menyentuh bloknya sendiri', () => {
    const s = setup();
    call(s.backend.cekBlokTersedia);
    [1, 2, 3].forEach(n => call(s.backend['tulisBlok' + n]));
    call(s.backend.rollbackBlok2);
    r.assertEq(s.sh.getRange(150, 14).getValue(), '', 'N150 (blok 2) kosong');
    r.assertEq(s.sh.getRange(60, 14).getValue(), 7500, 'N60 (blok 1) UTUH');
    r.assertEq(s.sh.getRange(250, 14).getValue(), 7500, 'N250 (blok 3) UTUH');
    r.assertEq(s.sh.getRange(1, 14).getValue(), 'Revisi Modal', 'header UTUH');
  });

  r.test('rollback blok yang belum ditulis tidak merusak apa pun', () => {
    const s = setup();
    call(s.backend.cekBlokTersedia);
    const sebelum = snap(s.sh);
    const out = call(s.backend.rollbackBlok4);
    r.assertEq(out.status, 'ok', 'ok');
    r.assertEq(snap(s.sh), sebelum, 'sheet tidak berubah');
  });
});

// ═══════════════════════════════════════════════════════════════════
r.suite('Backfill - _bfSamaBaris (satu-satunya pembanding baris)', () => {
  // Fungsi ini dipakai G-3 (menolak nilai asing) DAN status per blok di
  // cekBlokTersedia(). Kalau keduanya punya salinan sendiri, laporan
  // "SUDAH DITULIS" bisa berarti berbeda dari "tulisBlokN() tidak akan
  // menulis apa pun". Karena itu test ini mengunci KEADILUAN pembanding
  // secara terpisah dari bentuk baris.
  const sama = (sb) => (a, b) => sb._bfSamaBaris(a, b);
  const sb = () => setup().backend.__sandbox;

  r.test('EKSAK: array kosong vs 0 TIDAK boleh dianggap sama', () => {
    // Ini aturan keselamatan baris DIKECUALIKAN: nilai rencana N/O-nya
    // kosong, jadi sel berisi 0 adalah ISI, bukan ketiadaan isi.
    const f = sama(sb());
    r.assertFalse(f([0, 0, 'DIKECUALIKAN', 'tidak ada padanan master', ''],
      ['', '', 'DIKECUALIKAN', 'tidak ada padanan master', '']),
      'N=0 tidak boleh lolos sebagai "sudah benar"');
    r.assertFalse(f(['', 0, 'DIKECUALIKAN', 'tidak ada padanan master', ''],
      ['', '', 'DIKECUALIKAN', 'tidak ada padanan master', '']),
      'O=0 tidak boleh lolos sebagai "sudah benar"');
    r.assertFalse(f(['0', '', 'DIKECUALIKAN', 'tidak ada padanan master', ''],
      ['', '', 'DIKECUALIKAN', 'tidak ada padanan master', '']),
      'teks "0" juga tidak boleh lolos');
  });

  r.test('EKSAK: null dan "" dianggap SAMA (keduanya tidak mengisi apa-apa)', () => {
    const f = sama(sb());
    r.assertOk(f([null, '', null, '', null], ['', '', '', '', '']), 'null == kosong');
    r.assertOk(f([undefined, '', '', null, ''], ['', '', '', '', '']), 'undefined == kosong');
    r.assertFalse(f([0, '', '', null, ''], ['', '', '', '', '']), 'tapi 0 != kosong');
  });

  r.test('EKSAK: angka 10000 dan teks "10000" TIDAK sama', () => {
    // Cabang pembanding ditentukan oleh TIPE NILAI RENCANA. Rencana angka
    // -> _bfNumEq, yang hanya mau banding angka. Teks tidak di-cast.
    const f = sama(sb());
    r.assertFalse(f(['10000', 5000, 'ESTIMASI', 'master produk', ''],
      [10000, 5000, 'ESTIMASI', 'master produk', '']),
      'teks "10000" != angka 10000');
    r.assertFalse(f(['10000.5', 0, 'ESTIMASI', 'master produk', ''],
      [10000.5, 0, 'ESTIMASI', 'master produk', '']),
      'teks "10000.5" != angka 10000.5');
    r.assertOk(f([10000, 5000, 'ESTIMASI', 'master produk', ''],
      [10000, 5000, 'ESTIMASI', 'master produk', '']),
      'angka vs angka yang sama: SAMA');
  });

  r.test('EKSAK: presisi desimal memakai toleransi 1e-9', () => {
    const f = sama(sb());
    r.assertOk(f([10000.5, 0, 'ESTIMASI', 'master produk', ''],
      [10000.50, 0, 'ESTIMASI', 'master produk', '']),
      '10000.5 == 10000.50 (beda representasi, angka sama)');
    r.assertOk(f([0.1 + 0.2, 0, 'ESTIMASI', 'master produk', ''],
      [0.3, 0, 'ESTIMASI', 'master produk', '']),
      '0.1+0.2 == 0.3');
    r.assertFalse(f([10000.5, 0, 'ESTIMASI', 'master produk', ''],
      [10000.51, 0, 'ESTIMASI', 'master produk', '']),
      'tapi beda 0.01 TIDAK dianggap sama');
    r.assertFalse(f([10000.5000001, 0, 'ESTIMASI', 'master produk', ''],
      [10000.5, 0, 'ESTIMASI', 'master produk', '']),
      'selisih di bawah 1e-9 tetap dianggap sama');
  });

  r.test('EKSAK: teks compared setelah di-trim, whitespace tidak berpengaruh', () => {
    const f = sama(sb());
    r.assertOk(f(['', '', ' ESTIMASI ', 'master produk', ''],
      ['', '', 'ESTIMASI', 'master produk', '']),
      'spasi tepi diabaikan untuk kolom teks');
    r.assertFalse(f(['', '', 'TERCATAT', 'master produk', ''],
      ['', '', 'ESTIMASI', 'master produk', '']),
      'flag berbeda tetap tidak sama');
  });
});

// ═══════════════════════════════════════════════════════════════════
r.suite('Backfill - status tulis per blok (diagnostik cekBlokTersedia)', () => {
  const sb = () => setup().backend.__sandbox;
  const RENCANA = [
    [18000, 10000, 'ESTIMASI', 'master produk', ''],
    ['', '', 'DIKECUALIKAN', 'tidak ada padanan master', ''],
    [10000, 5000, 'KOREKSI', 'dikonfirmasi pemilik', '']
  ];
  const KOSONG = [['', '', '', '', '']];

  r.test('semua baris kosong -> status BELUM', () => {
    const s = sb()._bfStatusBlok(KOSONG, [RENCANA[0]], 2);
    r.assertEq(s.status, 'BELUM', 'BELUM');
    r.assertEq(s.barisKosong, 1, 'barisKosong 1');
    r.assertEq(s.barisSudahBenar, 0, 'barisSudahBenar 0');
    r.assertEq(s.barisAsing, 0, 'barisAsing 0');
    r.assertEq(s.contohAsing.length, 0, 'tidak ada contoh asing');
  });

  r.test('semua baris cocok rencana -> status SUDAH DITULIS', () => {
    const s = sb()._bfStatusBlok([RENCANA[0].slice()], [RENCANA[0]], 2);
    r.assertEq(s.status, 'SUDAH DITULIS', 'SUDAH DITULIS');
    r.assertEq(s.barisSudahBenar, 1, 'barisSudahBenar 1');
    r.assertEq(s.barisKosong, 0, 'barisKosong 0');
  });

  r.test('baris DIKECUALIKAN dengan 0 di N/O dihitung ASING, bukan kosong', () => {
    // Ini permintaan eksplisit pemilik: 0 adalah isi, jadi tidak boleh
    // lolos sebagai "sudah benar" DAN tidak boleh dilaporkan sebagai kosong
    // (kalau dianggap kosong, penulis akan menimpanya dengan string kosong).
    const s = sb()._bfStatusBlok(
      [[0, 0, 'DIKECUALIKAN', 'tidak ada padanan master', '']],
      [RENCANA[1]], 471);
    r.assertEq(s.barisAsing, 1, '0 dihitung asing');
    r.assertEq(s.barisKosong, 0, 'BUKAN kosong');
    r.assertEq(s.barisSudahBenar, 0, 'dan bukan juga sudah benar');
    r.assertEq(s.status, 'PERIKSA', 'status PERIKSA');
    r.assertEq(s.contohAsing[0].baris, 471, 'nomor baris ikut dicetak');
  });

  r.test('nilai asing dicatat dengan nomor baris + isi aktual', () => {
    const s = sb()._bfStatusBlok(
      [[99999, '', 'ESTIMASI', 'master produk', ''], RENCANA[0].slice()],
      [RENCANA[0], RENCANA[0]], 2);
    r.assertEq(s.status, 'PERIKSA', 'PERIKSA');
    r.assertEq(s.barisAsing, 1, 'satu baris asing');
    r.assertEq(s.barisSudahBenar, 1, 'satu baris benar');
    r.assertEq(s.contohAsing.length, 1, 'satu contoh');
    r.assertEq(s.contohAsing[0].baris, 2, 'baris 2 (bukan indeks 0)');
    r.assertEq(s.contohAsing[0].aktual[0], 99999, 'isi aktual ikut dilaporkan');
  });

  r.test('contohAsing dipotong tepat 10 walau asingnya lebih banyak', () => {
    const banyak = [];
    for (let i = 0; i < 25; i++) banyak.push([i + 1, '', 'ESTIMASI', 'master produk', '']);
    const s = sb()._bfStatusBlok(banyak, banyak.map(() => RENCANA[0]), 2);
    r.assertEq(s.barisAsing, 25, '25 baris asing tercatat penuh');
    r.assertEq(s.contohAsing.length, 10, 'tapi hanya 10 contoh yang dicetak');
    r.assertEq(s.contohAsing[0].baris, 2, 'contoh pertama = baris sheet pertama');
    r.assertEq(s.contohAsing[9].baris, 11, 'contoh kesepuluh = baris sheet ke-10');
  });

  r.test('blok tanpa baris -> TIDAK ADA BARIS, bukan SUDAH DITULIS', () => {
    const s = sb()._bfStatusBlok([], [], 2);
    r.assertEq(s.status, 'TIDAK ADA BARIS', 'TIDAK ADA BARIS');
    r.assertEq(s.barisKosong, 0, 'tidak ada baris untuk dihitung');
  });
});

// ═══════════════════════════════════════════════════════════════════
r.suite('Backfill - langkahBerikutnya tidak lagi terkunci ke tulisBlok1()', () => {
  const sb = () => setup().backend.__sandbox;
  const B = (no, t) => ({ no: no, tulis: t });
  const T = (o) => Object.assign(
    { status: 'BELUM', barisKosong: 10, barisSudahBenar: 0, barisAsing: 0, contohAsing: [] }, o);
  const ditulis = (n) => T({ status: 'SUDAH DITULIS', barisKosong: 0, barisSudahBenar: n });

  r.test('semua belum -> menyebut blok 1', () => {
    const s = sb()._bfLangkahBerikutnya([B(1, T({})), B(2, T({})), B(3, T({}))]);
    r.assertIncludes(s, 'blok 1', 'menunjuk blok 1');
    r.assertIncludes(s, 'tulisBlok1()', 'menyebut entry point blok 1');
  });

  r.test('blok 1 sudah -> menyebut blok 2, BUKAN blok 1 lagi', () => {
    const s = sb()._bfLangkahBerikutnya([B(1, ditulis(100)), B(2, T({})), B(3, T({}))]);
    r.assertIncludes(s, 'tulisBlok2()', 'menunjuk blok 2');
    r.assertNotIncludes(s, 'tulisBlok1()', 'tidak menyuruh blok 1 lagi');
    r.assertIncludes(s, '1 sudah tertulis', 'menyebut blok yang sudah selesai');
  });

  r.test('SEMUA blok sudah tertulis -> tidak menyuruh menulis apa pun', () => {
    // Ini kondisi nyata di produksi sekarang: keenam blok selesai, tapi
    // kalimat lama tetap menyuruh tulisBlok1(). Bug yang diperbaiki.
    const s = sb()._bfLangkahBerikutnya([B(1, ditulis(100)), B(2, ditulis(100)),
      B(3, ditulis(100)), B(4, ditulis(100)), B(5, ditulis(100)), B(6, ditulis(24))]);
    r.assertNotIncludes(s, 'tulisBlok', 'tidak ada entry point tulis yang disebut');
    r.assertIncludes(s, 'TIDAK ADA yang perlu ditulis', 'katakan selesai');
    r.assertIncludes(s, 'hapusIzinBackfill()', 'menunjuk langkah penutup');
  });

  r.test('ada nilai asing -> PERINGATAN, jangan menyuruh menulis', () => {
    const asing = T({ status: 'PERIKSA', barisKosong: 0, barisAsing: 3 });
    const s = sb()._bfLangkahBerikutnya([B(1, ditulis(100)), B(2, asing), B(3, T({}))]);
    r.assertIncludes(s, 'ADA NILAI ASING', 'peringatan naik');
    r.assertIncludes(s, 'blok 2', 'menyebut blok yang bermasalah');
    r.assertNotIncludes(s, 'tulisBlok', 'tidak menyuruh menulis blok mana pun');
  });
});

// ═══════════════════════════════════════════════════════════════════
r.suite('Backfill - cekBlokTersedia() melaporkan status tulis SETIAP blok', () => {
  r.test('keenam blok punya status tulis; awal: semua BELUM', () => {
    const s = setup();
    const sebelum = snap(s.sh);
    const out = call(s.backend.cekBlokTersedia);
    r.assertEq(out.blok.length, 6, 'enam blok dilaporkan');
    for (const b of out.blok) {
      r.assertOk(b.tulis, 'blok ' + b.no + ' punya status tulis');
      r.assertEq(b.tulis.status, 'BELUM', 'blok ' + b.no + ' belum ditulis');
      r.assertEq(b.tulis.barisKosong, b.baris, 'blok ' + b.no + ' semua kosong');
      r.assertEq(b.tulis.barisSudahBenar, 0, 'blok ' + b.no + ' belum ada yang benar');
      r.assertEq(b.tulis.barisAsing, 0, 'blok ' + b.no + ' tidak ada asing');
    }
    r.assertEq(snap(s.sh), sebelum, 'masih READ-ONLY: sheet tidak berubah');
  });

  r.test('setelah blok ditulis: SUDAH DITULIS, blok berikutnya BELUM', () => {
    const s = setup();
    call(s.backend.cekBlokTersedia);
    [1, 2].forEach(n => call(s.backend['tulisBlok' + n]));
    const out = call(s.backend.cekBlokTersedia);
    r.assertEq(out.blok[0].tulis.status, 'SUDAH DITULIS', 'blok 1 ditulis');
    r.assertEq(out.blok[0].tulis.barisSudahBenar, 100, '100 baris cocok');
    r.assertEq(out.blok[1].tulis.status, 'SUDAH DITULIS', 'blok 2 ditulis');
    r.assertEq(out.blok[2].tulis.status, 'BELUM', 'blok 3 belum');
    r.assertEq(out.blok[5].tulis.status, 'BELUM', 'blok 6 belum');
    r.assertIncludes(out.langkahBerikutnya, 'tulisBlok3()', 'langkah berikutnya = blok 3');
  });

  r.test('semua blok ditulis -> status semua SUDAH DITULIS & tidak ada lagi langkah tulis', () => {
    const s = setup();
    call(s.backend.cekBlokTersedia);
    for (let n = 1; n <= 6; n++) call(s.backend['tulisBlok' + n]);
    const out = call(s.backend.cekBlokTersedia);
    for (const b of out.blok) r.assertEq(b.tulis.status, 'SUDAH DITULIS', 'blok ' + b.no);
    r.assertNotIncludes(out.langkahBerikutnya, 'tulisBlok', 'tidak ada blok tersisa');
  });

  r.test('kolom R terisi angka -> PERIKSA, bukan "sudah ditulis"', () => {
    // Status SUDAH DITULIS berarti _bfTulisBlokTerpakai() tidak akan
    // menulis apa pun. Kalau baris dengan isi tak terduga ikut terhitung
    // "sudah benar", status itu berbohong. Test ini menjaga kejujuran itu.
    const s = setup();
    call(s.backend.cekBlokTersedia);
    call(s.backend.tulisBlok1);
    s.sh.getRange(50, 18).setValue('isi tak terduga');
    const out = call(s.backend.cekBlokTersedia);
    r.assertEq(out.blok[0].tulis.status, 'PERIKSA', 'blok 1 PERIKSA');
    r.assertEq(out.blok[0].tulis.barisAsing, 1, 'satu baris asing');
    r.assertEq(out.blok[0].tulis.contohAsing[0].baris, 50, 'nomor baris 50');
    r.assertIncludes(out.langkahBerikutnya, 'ADA NILAI ASING', 'peringatan naik');
  });

  r.test('caraMenyetujui merujuk tulisBlokN(), bukan tulisBlok1()', () => {
    const s = setup();
    const out = call(s.backend.cekBlokTersedia);
    r.assertIncludes(out.caraMenyetujui, 'tulisBlokN()', 'rujukan umum');
    r.assertNotIncludes(out.caraMenyetujui, 'tulisBlok1()', 'tidak terkunci ke blok 1');
  });
});

r.run('Backfill Kolom N..R').then(ok => { process.exit(ok ? 0 : 1); });
