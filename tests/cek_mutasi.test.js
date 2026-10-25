'use strict';

/**
 * ============================================================
 * Unit test skrip lintas cek mutasi QRIS ↔ sheet Penjualan
 * (tools/cek_mutasi_qris.js) — murni fungsi murni, tanpa jaringan.
 * ============================================================
 */

const c = require('../tools/cek_mutasi_qris');
const { createRunner } = require('./helpers');

const r = createRunner();

r.suite('Parser nominal & tanggal', () => {
  r.test('parseNominal: format bebas Rp/titik/koma/space', () => {
    r.assertEq(c.parseNominal('Rp 20.000'), 20000);
    r.assertEq(c.parseNominal('15,000'), 15000);
    r.assertEq(c.parseNominal(' 15000 '), 15000);
    r.assertEq(c.parseNominal('10 000'), 10000);
    r.assertOk(Number.isNaN(c.parseNominal('abc')), 'teks non-angka NaN');
  });

  r.test('parseTanggalRow: string sheet "dd/MM/yyyy HH:mm" (dengan/tanpa koma)', () => {
    for (const s of ['25/10/2026 07:01', '25/10/2026, 07:01']) {
      const t = c.parseTanggalRow(s);
      r.assertEq(t.tanggal, '25/10/2026');
      r.assertEq(t.menit, 7 * 60 + 1);
    }
    r.assertEq(c.parseTanggalRow(''), null);
  });
});

r.suite('Parser CSV mutasi', () => {
  r.test('delimiter ; / , , komentar, header opsional, tanggal penuh', () => {
    const m = c.parseMutasiCsv([
      'jam;nominal',
      '# catatan pagi',
      '06:29;Rp 20.000',
      '06:49,10000',
      '25/10/2026 07:01;15000'
    ].join('\n'));
    r.assertEq(m.length, 3);
    r.assertEq(m[0].jam, '06:29');
    r.assertEq(m[0].nominal, 20000);
    r.assertEq(m[1].nominal, 10000);
    r.assertEq(m[2].jam_full, '25/10/2026 07:01');
    r.assertEq(m[2].jam, '07:01');
    r.assertEq(m[2].nominal, 15000);
  });

  r.test('baris tanpa jam / nominal rusak melempar error jelas', () => {
    let err = null;
    try { c.parseMutasiCsv('taks;rusak'); } catch (e) { err = e; }
    r.assertOk(err && /jam tidak/.test(err.message), 'error jam: ' + err);
    err = null;
    try { c.parseMutasiCsv('07:15;?'); } catch (e) { err = e; }
    r.assertOk(err && /nominal/.test(err.message), 'error nominal: ' + err);
  });
});

// Baris palenujual payload (format getInitialData): header + rows.
// Header: id, tanggal, namaProduk, ..., totalHarga(6), metode(7), ...
const HEADER_PENJUALAN = ['id', 'tanggal', 'namaProduk', 'volumeMl', 'hppSatuan', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali', 'modal', 'biayaOperasional', 'labaBersih'];
function rowPenjualan(id, tanggal, nama, total, metode) {
  return [id, tanggal, nama, 250, '', 1, total, metode, 0, 0, '', ''];
}
/** Bungkus baris mentah gaya payload getInitialData, lalu ekstrak gaya skrip. */
function rowsDariPayload(rows) {
  return c.extractPenjualanRows({ penjualan: [HEADER_PENJUALAN, ...rows] });
}r.suite('Pencocok pasangan & laporan A/B/C', () => {
  const sheetRows = rowsDariPayload([
    rowPenjualan('FR-1', '25/10/2026 06:29', 'Semangci 500ml', 20000, 'QRIS'),
    rowPenjualan('FR-2', '25/10/2026 06:49', 'Semangci 250ml', 10000, 'QRIS'),
    rowPenjualan('FR-3', '25/10/2026 07:01', 'Semangci 250ml', 10000, 'CASH')
  ]);
  r.assertOk(sheetRows[0].metode === 'QRIS', 'sanity: baris ter-ekstrak punya metode QRIS');

  r.test('mutasi lengkap: QRIS pasang penuh, mutasi 07:01 jatuh ke dugaan C (FR-3 CASH)', () => {
    const mut = c.parseMutasiCsv('03:29 Out;Rp 20.000\n06:49;10.000\n07:01;10000'.replace('03:29', '06:29'));
    const lap = c.buatLaporan(sheetRows, mut, 5, '25/10/2026');
    r.assertEq(lap.pasangan.length, 2, 'FR-1 & FR-2 pasang');
    r.assertEq(lap.temuanA.length, 0, 'A kosong');
    r.assertEq(lap.temuanB.length, 0, 'B kosong');
    r.assertEq(lap.temuanC.length, 1, 'mu 07:01 dugaan C ke FR-3');
  });

  r.test('temuan B: mutasi tanpa QRIS sheet, tanpa CASH dekat', () => {
    const mut = c.parseMutasiCsv('08:02;5000');
    const lap = c.buatLaporan(sheetRows, mut, 5, '25/10/2026');
    r.assertEq(lap.temuanB.length, 1, 'B ada');
    r.assertEq(lap.temuanB[0].nominal, 5000);
  });

  r.test('temuan C: mutasi QRIS padahal sheet CASH nominal sama jam dekat', () => {
    const mut = c.parseMutasiCsv('07:02;10000');
    const lap = c.buatLaporan(sheetRows, mut, 5, '25/10/2026');
    r.assertEq(lap.temuanC.length, 1, 'C ada');
    r.assertEq(lap.temuanC[0].sheet.id, 'FR-3');
    r.assertEq(lap.temuanB.length, 0, 'tidak dobel ke B');
  });

  r.test('temuan A: QRIS sheet tanpa mutasi merchant', () => {
    const mut = c.parseMutasiCsv('06:49;10.000');
    const lap = c.buatLaporan(sheetRows, mut, 5, '25/10/2026');
    // Yang QRIS hanya FR-1 & FR-2; FR-2 cocok mutasi, jadi sisanya FR-1 saja
    r.assertEq(lap.temuanA.length, 1, 'hanya FR-1 sisa (FR-3 berrmetode CASH)');
    r.assertEq(lap.temuanA.filter(a => a.id === 'FR-1').length, 1);
    r.assertEq(lap.temuanA.filter(a => a.id === 'FR-2').length, 0);
  });

  r.test('toleransi jam memastikan settle telat tetap pasang', () => {
    const mut = c.parseMutasiCsv('06:31;20000');
    const lap = c.buatLaporan(rowsDariPayload([rowPenjualan('FR-1', '25/10/2026 06:29', 'x', 20000, 'QRIS')]), mut, 5);
    r.assertEq(lap.pasangan.length, 1);
    r.assertEq(lap.temuanB.length, 0);
  });

  r.test('tanggal beda tidak boleh terpasang lintas hari', () => {
    const mut = c.parseMutasiCsv('24/10/2026 06:29;20000');
    const lap = c.buatLaporan(rowsDariPayload([rowPenjualan('FR-1', '25/10/2026 06:29', 'x', 20000, 'QRIS')]), mut, 5);
    r.assertEq(lap.pasangan.length, 0, 'lintas hari ditolak');
    r.assertEq(lap.temuanB.length, 1);
  });

  r.test('extractPenjualanRows: peta header + baris kosong id dilewati', () => {
    const payload = {
      penjualan: [
        ['id', 'tanggal', 'namaProduk', 'volumeMl', 'hppSatuan', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali', 'modal', 'biayaOperasional', 'labaBersih'],
        ['FR-9', '25/10/2026 06:29', 'x', '', '', 1, 20000, 'QRIS'],
        ['', '', '', '', '', '', '', '']
      ]
    };
    const rows = c.extractPenjualanRows(payload);
    r.assertEq(rows.length, 1);
    r.assertEq(rows[0].metode, 'QRIS');
    r.assertEq(rows[0].nominal, 20000);
    r.assertEq(rows[0].menit, 6 * 60 + 29);
  });

  r.test('parseCliArgv: flag utama terbaca', () => {
    const o = c.parseCliArgv(['--date', '25/10/2026', '--mutasi', 'm.csv', '--tol', '10', '--strict']);
    r.assertEq(o.tanggal, '25/10/2026');
    r.assertEq(o.mutasi, 'm.csv');
    r.assertEq(o.tol, 10);
    r.assertEq(o.strict, true);
  });
});

r.run('Lintas Cek Mutasi QRIS ↔ Sheet Penjualan').then(ok => { process.exit(ok ? 0 : 1); });
