/**
 * UJI MIGRASI MULTI-CABANG DI KOMPUTER LOKAL (tanpa Sheets sungguhan)
 *
 * Menjalankan rantai yang sama dengan yang dipanggil dari editor Apps Script:
 *
 *   ujiMigrasiMultiCabangDiSalinan('<SALINAN>', '<CADANGAN>')
 *
 * dengan tiga spreadsheet tiruan:
 *   SUMBER-1   = berdiri sebagai spreadsheet PRODUKSI (harus tidak berubah)
 *   SALINAN-1  = salinan tempat migrasi dijalankan
 *   CADANGAN-1 = salinan dari SALINAN-1, dipakai guard cadangan
 *
 * Produk dan baris penjualan memakai fixture BERSAMA dari tests/helpers.js —
 * data yang sama dengan tests/backfill.test.js, jadi runner ini tidak bisa
 * "lulus" pada bentuk data yang berbeda dari test.
 *
 * Tidak ada kredensial, tidak ada Drive, tidak ada spreadsheet asli yang
 * dibuka. Untuk mencobanya pada salinan SUNGGUHAN, buat dua salinan lewat
 * File > Make a copy lalu panggil fungsi yang sama dari editor Apps Script
 * dengan ID kedua salinan itu.
 *
 * Pakai: node tools/uji_migrasi_lokal.js
 */
const { createGasMock, loadBackendBackfill, PRODUK, penjualanRows } = require('../tests/helpers');

// Sheet User sengaja ditulis di sini: fixture bersama hanya mengatur
// PRODUK + Penjualan, sedangkan mock User default tidak punya SUPER_ADMIN
// yang ingin ditunjukkan peringatannya pada pratinjau.
const USER = [
  ['Nama', 'PIN', 'Role'],
  ['Pemilik', '1234', 'SUPER_ADMIN'],
  ['Kasir Pagi', '1111', 'KASIR']
];

function bangun() {
  const gas = createGasMock();
  gas.scriptRuntime.props.ENV = 'production';
  gas.scriptRuntime.props.SS_ID_PROD = 'SUMBER-1';

  const opsi = (id, nama) => ({
    ssId: id, ssName: nama, userRows: USER,
    penjualanRows: penjualanRows(), penjualanGridCols: 29
  });

  const sumber = gas.createSpreadsheetMock(PRODUK, opsi('SUMBER-1', 'POS Flourich (PRODUKSI)'));
  const salinan = gas.createSpreadsheetMock(PRODUK, opsi('SALINAN-1', 'SALINAN migrasi multi-cabang'));
  const cadangan = gas.createSpreadsheetMock(PRODUK, opsi('CADANGAN-1', 'SALINAN cadangan'));

  gas.scriptRuntime.activeSpreadsheet = sumber;
  gas.scriptRuntime.spreadsheets = {
    'SUMBER-1': sumber, 'SALINAN-1': salinan, 'CADANGAN-1': cadangan
  };

  return { gas, sumber, salinan, cadangan, backend: loadBackendBackfill(gas) };
}

const garis = (t) => console.log('\n' + '─'.repeat(72) + (t ? '\n' + t : ''));
const cuplik = (sh) => JSON.stringify({
  lastRow: sh.getLastRow(), lastColumn: sh.getLastColumn(), maxColumns: sh.getMaxColumns()
});

console.log('UJI MIGRASI MULTI-CABANG — MODE LOKAL (MOCK), PRODUKSI TIDAK DISENTUH');
console.log('fixture: ' + (PRODUK.length - 1) + ' produk, ' + (penjualanRows().length - 1) + ' baris penjualan (bersama dengan tests/backfill.test.js)');

const { gas, sumber, salinan, backend } = bangun();
const sb = backend.sandbox;

garis('0. KEADAAN AWAL');
console.log('produksi SUMBER-1  Penjualan:', cuplik(sumber.__penjualan));
console.log('salinan  SALINAN-1 Penjualan:', cuplik(salinan.__penjualan));
console.log('salinan  SALINAN-1 sheet Stok_Cabang:', salinan.getSheetByName('Stok_Cabang'));

garis('1. GUARD: produksi sebagai target');
const tolak = JSON.parse(sb.ujiMigrasiMultiCabangDiSalinan('SUMBER-1', 'CADANGAN-1'));
console.log('status:', tolak.status);
console.log('pesan :', tolak.pesan);

garis('2. RANTAI PENUH: pratinjau -> catat salinan -> migrasi -> jalan kedua');
const out = JSON.parse(sb.ujiMigrasiMultiCabangDiSalinan('SALINAN-1', 'CADANGAN-1'));

console.log('status keseluruhan :', out.status);
console.log('target / cadangan  :', out.target, '/', out.cadangan);
console.log('');
console.log('PRATINJAU');
console.log('  spreadsheet      :', out.pratinjau.spreadsheet.nama, '(' + out.pratinjau.spreadsheet.id + ')');
console.log('  salinan tercatat :', out.pratinjau.salinanTercatat || '(belum ada)');
for (const l of out.pratinjau.langkah) console.log('  -', l);
for (const p of out.pratinjau.peringatan) console.log('  !', p);

console.log('');
console.log('CATAT SALINAN (verifikasi 4 syarat)');
console.log('  status           :', out.catatSalinan.status);
console.log('  pesan            :', out.catatSalinan.pesan);
console.log('  tercatat di props:', out.salinanTercatatDiPropsUji);

console.log('');
console.log('MIGRASI');
console.log('  status           :', out.migrasi.status);
for (const l of out.migrasi.langkah) console.log('  -', l);
console.log('  verifikasi.ok    :', out.migrasi.verifikasi.ok);
console.log('  verifikasi       :', JSON.stringify(out.migrasi.verifikasi));

console.log('');
console.log('JALAN KEDUA (idempoten)');
console.log('  status           :', out.migrasiKedua.status);
console.log('  pesan            :', out.migrasiKedua.pesan);

garis('3. BUKTI: SALINAN BERUBAH, PRODUKSI TIDAK');
console.log('salinan  sebelum :', JSON.stringify(out.sebelum));
console.log('salinan  sesudah :', JSON.stringify(out.sesudah));
console.log('');
console.log('produksi Penjualan sesudah :', cuplik(sumber.__penjualan), '(harus sama dengan keadaan awal)');
console.log('produksi sheet Stok_Cabang :', sumber.getSheetByName('Stok_Cabang'));
console.log('properties produksi berubah:', out.propertyProduksiTersentuh);
console.log('MC_SALINAN_SPREADSHEET     :', gas.scriptRuntime.props.MC_SALINAN_SPREADSHEET);
console.log('MC_MIGRASI_SELESAI         :', gas.scriptRuntime.props.MC_MIGRASI_SELESAI);

console.log('');
process.exit(out.status === 'ok' && out.propertyProduksiTersentuh === false && !sumber.getSheetByName('Stok_Cabang') ? 0 : 1);
