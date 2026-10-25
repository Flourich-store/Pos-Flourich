'use strict';

/**
 * ============================================================
 * Lintas Cek Mutasi QRIS Merchant ↔ Sheet Penjualan
 * ============================================================
 * Untuk pengujian selisih harian: setiap rupiah yang di-settle
 * di aplikasi merchant (jam + nominal) dicocokkan ke baris QRIS
 * di sheet Penjualan POS.
 *
 * Tiga temuan:
 *   A. sheet QRIS tanpa mutasi  -> dana tidak masuk (lapor merchant)
 *   B. mutasi tanpa QRIS sheet  -> transaksi tidak tercatat (cek antrian offline)
 *   C. mutasi tanpa pasangan TAPI ada baris CASH nominal sama & jam dekat
 *      -> dugaan metode salah pilih CASH
 *
 * Murni READ-ONLY (GET getInitialData). Tidak menulis sheet.
 * Latar penulisan panduan: CEK_SELISIH_QRIS.md.
 * ============================================================
 */

const API_URL_UTAMA = 'https://script.google.com/macros/s/AKfycbyQlMrQNdoXrfT63Q1Y_m1lRiB10mJ35tAKbq26y4WaFNXqhbImM4zZF4eYgd64DaDxaw/exec';
const TOL_MENIT_DEFAULT = 5;

// ------------------------------------------------------------------
// Parser nominal: "Rp 20.000", "15000", "15,000", " 10 000 " -> number
// ------------------------------------------------------------------
function parseNominal(s) {
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  if (s == null) return NaN;
  let t = String(s).toLowerCase().replace(/rp/g, '').trim();
  // "Rp 20.000" (id) dan "15,000" (en): titik/koma RIBUAN, bukan desimal.
  t = t.replace(/[.\s\u00a0]/g, '').replace(/,/g, '');
  if (!/^\d+$/.test(t)) return NaN;
  return Number(t);
}

// ------------------------------------------------------------------
// Parser "dd/mm/yyyy HH:mm" (sheet, formatTanggalRow) -> {tanggal, menit}
// menit = menit sejak tengah malam (per tanggal), jadi pencocokan
// bebas masalah zona waktu: pasangan HARUS di tanggal yang sama.
// ------------------------------------------------------------------
function parseTanggalRow(v) {
  if (v instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    const tanggal = `${('0' + v.getDate()).slice(-2)}/${pad(v.getMonth() + 1)}/${v.getFullYear()}`;
    return { tanggal, menit: v.getHours() * 60 + v.getMinutes(), seri: `${tanggal} ${pad(v.getHours())}:${pad(v.getMinutes())}` };
  }
  const s = String(v == null ? '' : v).trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hari = Number(m[1]), bulan = Number(m[2]), tahun = Number(m[3]);
  const mm = Number(m[4]), mi = Number(m[5]);
  const pad = n => String(n).padStart(2, '0');
  const tanggal = `${pad(hari)}/${pad(bulan)}/${tahun}`;
  return { tanggal, menit: mm * 60 + mi, seri: `${tanggal} ${pad(mm)}:${pad(mi)}` };
}

// ------------------------------------------------------------------
// Parser CSV mutasi: delimiter ; atau , (deteksi per baris dominan),
// baris `#...` = komentar, header jam/nominal opsional.
// Satu baris: jam(HH:mm) + nominal(wajib); tanggal dd/mm/yyyy opsional.
// Lampau-i-tanggal: default disuplai pemanggil (argumen --date CLI).
// ------------------------------------------------------------------
function parseMutasiCsv(text) {
  const hasil = [];
  const baris = String(text == null ? '' : text).split(/\r?\n/);
  for (let i = 0; i < baris.length; i++) {
    let line = baris[i].trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (i === 0 && /^jam\s*([;,])\s*nominal/i.test(line)) continue; // header CSV opsional
    const delim = (line.split(';').length > line.split(',').length) ? ';' : ',';
    // Tanpa quotes: nilai nominal bebas tanda baca, jam tidak pernah kelimu.
    const sel = line.split(delim).map(s => s.trim().replace(/^"|"$/g, ''));
    // jam bisa "HH:mm" saja atau lengkap "dd/mm/yyyy HH:mm" (lintas hari).
    let selJam = sel.find(c => /^\d{1,2}:\d{2}/.test(c));
    let jamFull = null;
    if (!selJam) {
      jamFull = sel.find(c => /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/.test(c)) || null;
    }
    const polaNominal = /^\s*(rp)?\s*[\d.,\s]+$/i;
    const selNominal = sel.find(c => polaNominal.test(c) && /\d/.test(c) && c !== selJam) ||
      (jamFull ? sel.find(c => polaNominal.test(c) && /\d/.test(c)) : undefined);
    if (!selJam && !jamFull) throw new Error(`CSV mutasi baris ${i + 1}: jam tidak ditemukan ("${line}")`);
    const nominal = parseNominal(selNominal);
    if (!Number.isFinite(nominal)) throw new Error(`CSV mutasi baris ${i + 1}: nominal tidak valid ("${line}")`);
    // tanggal opsional: sel berformat dd/mm/yyyy (bukan bagian dari sel jam)
    const selTanggal = sel.find(c => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c));
    hasil.push({ jam: selJam || (jamFull ? jamFull.replace(/^.*?(\d{1,2}:\d{2}).*$/, '$1') : ''), jam_full: jamFull, nominal, tanggal: selTanggal || null, baris: i + 1 });
    if (!hasil[hasil.length - 1].jam) throw new Error(`CSV mutasi baris ${i + 1}: jam tidak bisa dibaca ("${line}")`);
  }
  return hasil;
}

/** Ambil "dd/mm/yyyy" untuk mutasi: dari sel tanggal, atau dari proposisi jam "dd/mm/yyyy HH:mm". */
function tanggalMutasi(m, tanggalDefault) {
  if (m.tanggal) return m.tanggal;
  const t = parseTanggalRow(m.jam_full || m.jam);
  if (t) return t.tanggal;
  return tanggalDefault || null;
}

// ------------------------------------------------------------------
// Pencocok greedy: kandidat pasangan (tanggal sama, BEDAKAAN jam <= tol)
// diurutkan dari selisih terkecil, satu-satu diikat 1:1.
// ------------------------------------------------------------------
function pasangkan(rules, mutasi, tolMenit) {
  const kandidat = [];
  rules.forEach((rw, i) => {
    mutasi.forEach((mu, j) => {
      const dTan = rw.tanggal === tanggalMutasi(mu, rw.tanggal);
      if (!dTan) return;
      const jm = String(mu.jam || '').match(/(\d{1,2}):(\d{2})/);
      const menitMu = Number(jm[1]) * 60 + Number(jm[2]);
      const delta = Math.abs(rw.menit - menitMu);
      if (delta <= tolMenit) kandidat.push({ i, j, delta });
    });
  });
  kandidat.sort((a, b) => a.delta - b.delta || a.i - b.i || a.j - b.j);
  const diikatR = new Set(), diikatM = new Set(), pasangan = [];
  for (const k of kandidat) {
    if (diikatR.has(k.i) || diikatM.has(k.j)) continue;
    diikatR.add(k.i); diikatM.add(k.j);
    pasangan.push(k);
  }
  return {
    pasangan,
    sisaSheet: rules.filter((_, i) => !diikatR.has(i)),
    sisaMutasi: mutasi.filter((_, j) => !diikatM.has(j))
  };
}

// ------------------------------------------------------------------
// Ekstraksi baris Penjualan dari payload getInitialData:
// { penjualan: [header, ...rows] } — posisi kolom dikenalinya lewat
// HEADER (bukan index tetap), sama seperti inti reader backend.
// ------------------------------------------------------------------
const IDX_BY_HEADER = (() => {
  const header = ['id', 'tanggal', 'namaProduk', 'volumeMl', 'hppSatuan', 'jumlah', 'totalHarga',
    'metode', 'uangDibayar', 'uangKembali', 'modal', 'biayaOperasional', 'labaBersih'];
  const m = {};
  header.forEach((h, i) => { m[h] = i; });
  return m;
})();

function extractPenjualanRows(payload) {
  const pj = payload && Array.isArray(payload.penjualan) ? payload.penjualan : null;
  if (!pj || pj.length < 2) return [];
  const rows = pj.slice(1).filter(r => r && String(r[IDX_BY_HEADER.id] || '').trim() !== '');
  return rows.map(r => {
    const t = parseTanggalRow(r[IDX_BY_HEADER.tanggal]);
    return {
      id: String(r[IDX_BY_HEADER.id] || ''),
      nama: String(r[IDX_BY_HEADER.namaProduk] || ''),
      tanggal: t ? t.tanggal : String(r[IDX_BY_HEADER.tanggal] || ''),
      menit: t ? t.menit : NaN,
      seri: t ? t.seri : String(r[IDX_BY_HEADER.tanggal] || ''),
      nominal: Number(r[IDX_BY_HEADER.totalHarga]) || 0,
      metode: String(r[IDX_BY_HEADER.metode] || '').toUpperCase().trim()
    };
  });
}

/**
 * Laporan lengkap untuk satu pasang (sheet rows, mutasi).
 * rules = baris sheet QRIS untuk tanggal terpilih; mutasi = daftar CSV.
 * Pasangan utama: QRIS sheet ↔ mutasi. Sisa mutasi yang tidak punya
 * pasangan dicek ke baris CASH (dugaan salah metode, kategori C).
 */
function buatLaporan(rowsPenjualan, mutasi, tolMenit, tanggalDefault) {
  const isQris = r => r.metode === 'QRIS';
  const isCash = r => r.metode === 'CASH';
  const qrisRows = rowsPenjualan.filter(isQris);
  const hasil = pasangkan(qrisRows, mutasi, tolMenit);

  // Kategori B: mutasi tanpa QRIS sheet. Cek dugaan C terhadap CASH.
  const temuanC = [];
  const sisaMutasi = hasil.sisaMutasi.filter(mu => {
    const tanggal = tanggalMutasi(mu, tanggalDefault || null);
    const jm = String(mu.jam).match(/(\d{1,2}):(\d{2})/);
    const menitMu = Number(jm[1]) * 60 + Number(jm[2]);
    const tolC = Math.max(tolMenit * 2, 15);
    const cocok = rowsPenjualan.filter(r => isCash(r) && r.tanggal === tanggal &&
      r.nominal === mu.nominal && Number.isFinite(r.menit) &&
      Math.abs(r.menit - menitMu) <= tolC);
    if (cocok.length) {
      temuanC.push({ mutasi: mu, sheet: cocok[0] });
      return false; // sudah "dipakai" oleh dugaan C
    }
    return true; // tetap temuan B murni
  });

  return {
    pasangan: hasil.pasangan,
    temuanA: hasil.sisaSheet,           // QRIS sheet tanpa mutasi
    temuanB: sisaMutasi,                // mutasi tanpa pasangan apa pun
    temuanC
  };
}

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------
function parseCliArgv(argv) {
  const o = { tanggal: null, mutasi: null, tol: TOL_MENIT_DEFAULT, limit: 3000, api: API_URL_UTAMA, simpan: null, data: null, strict: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') o.strict = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--date') o.tanggal = argv[++i];
    else if (a === '--mutasi') o.mutasi = argv[++i];
    else if (a === '--selfil') o.selfil = argv[++i];   // alias lama
    else if (a === '--tol') o.tol = Number(argv[++i]);
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--api') o.api = argv[++i];
    else if (a === '--simpan') o.simpan = argv[++i];
    else if (a === '--data') o.data = argv[++i];
    else if (!o.file) o.file = a;
    else throw new Error('Argumen tidak dikenal: ' + a);
  }
  if (o.selfil) o.tanggalText = o.selfil;   // diteruskan agar dipakai sebagai filter tanggal
  return o;
}

function bantuTeks() {
  return [
    'Pencocok mutasi QRIS merchant ↔ sheet Penjualan POS (READ-ONLY).',
    '',
    'Pakai:',
    '  node tools/cek_mutasi_qris.js --date 25/10/2026 --mutasi mutasi.csv',
    '  node tools/cek_mutasi_qris.js --date 25/10/2026 --mutasi m.csv --tol 10 --strict',
    '  node tools/cek_mutasi_qris.js --date 25/10/2026 --mutasi m.csv --simpan snap.json',
    '  node tools/cek_mutasi_qris.js --date 25/10/2026 --mutasi m.csv --data snap.json',
    '',
    'Tanpa --tanggal, sheet tidak difilter (semua baris ikut dipasangkan — masih aman).'
  ].join('\n');
}

async function ambilPayload(o) {
  const fs = require('fs');
  if (o.data) {
    const j = JSON.parse(fs.readFileSync(o.data, 'utf8'));
    if (j.payload) return j.payload;
    return j;
  }
  const url = o.api + '?action=getInitialData&args=' + encodeURIComponent(JSON.stringify([o.limit]));
  const res = await fetch(url);
  if (!res.ok) throw new Error('GET endpoint gagal: HTTP ' + res.status);
  const payload = await res.json();
  if (payload && payload.status === 'error') throw new Error('Endpoint GAS: ' + (payload.message || 'error'));
  if (o.simpan) fs.writeFileSync(o.simpan, JSON.stringify({ diambilSaat: new Date().toISOString(), payload }, null, 2));
  return payload;
}

async function main(argv) {
  const o = parseCliArgv(argv);
  if (o.help) { console.log(bantuTeks()); return 0; }
  if (!o.mutasi) { console.error('Wajib flag --mutasi <file.csv> (lihat --help).'); return 2; }
  const fs = require('fs');
  const teksMutasi = fs.readFileSync(o.mutasi, 'utf8');
  const mutasi = parseMutasiCsv(teksMutasi);
  const payload = await ambilPayload(o);
  const rows = extractPenjualanRows(payload);
  let rowsUntukLaporan = rows;
  if (o.tanggal) {
    rowsUntukLaporan = rows.filter(r => r.tanggal === o.tanggal ||
      String(r.tanggal).startsWith(o.tanggal));
  }
  const lap = buatLaporan(rowsUntukLaporan, mutasi, o.tol, o.tanggal);
  cetakLaporan(lap, { mutasi: mutasi.length, rows: rowsUntukLaporan.length, qris: rowsUntukLaporan.filter(r => r.metode === 'QRIS').length, tol: o.tol, tanggal: o.tanggal || '(semua)' });
  return (o.strict && (lap.temuanA.length || lap.temuanB.length)) ? 1 : 0;
}

function fmt(n) { return 'Rp ' + Number(n).toLocaleString('id-ID'); }

function cetakLaporan(lap, st) {
  console.log('=== Lintas Cek Mutasi QRIS ↔ Sheet Penjualan ===');
  console.log(`Sheet utk tanggal ${st.tanggal}: ${st.rows} baris (QRIS: ${st.qris}) | mutasi CSV: ${st.mutasi} | tol ±${st.tol} menit`);
  console.log(`Cocok (${lap.pasangan.length}) pasangan QRIS sheet ↔ mutasi — transaksi QRIS ini tercatat.`);
  console.log('');
  if (lap.temuanA.length) {
    console.log(`--- A. QRIS di sheet TANPA mutasi merchant (${lap.temuanA.length}) — lapor merchant/dana tidak masuk:`);
    lap.temuanA.forEach(r => console.log(`  (${r.id}) sheet ${r.tanggal} ${String(r.seri).split(' ').pop()} ${fmt(r.nominal)} (${r.nama})`));
    console.log('');
  } else console.log('A. ✔ Tidak ada QRIS sheet tanpa mutasi.');
  if (lap.temuanB.length) {
    console.log(`--- B. Mutasi merchant TANPA QRIS sheet (${lap.temuanB.length}) — transaksi tidak tercatat:`);
    lap.temuanB.forEach(m => console.log(`  mutasi ${fmt(m.nominal)} @${m.jam} (baris CSV #${m.baris})`));
    console.log('   Cek: badge/pos_offline_queue device kasir, devtools console sandbox. (CEK_SELISIH_QRIS.md)');
    console.log('');
  } else console.log('B. ✔ Tidak ada mutasi tanpa transaksi sheet.');
  if (lap.temuanC.length) {
    console.log(`--- C. Dugaan salah metode: CASH nominal sama & jam dekat (${lap.temuanC.length}):`);
    lap.temuanC.forEach(c => console.log(`  ? mutasi ${c.mutasi.jam} ${fmt(c.mutasi.nominal)} ↔ sheet FR (${c.sheet.id}) TERCATAT CASH ${c.sheet.seri} ${fmt(c.sheet.nominal)}`));
    console.log('');
  } else console.log('C. ✔ Tidak ada dugaan salah metode.');
}

module.exports = {
  parseNominal,
  parseTanggalRow,
  parseMutasiCsv,
  parseCliArgv,
  extractPenjualanRows,
  buatLaporan,
  pasangkan,
  tanggalMutasi,
  API_URL_UTAMA,
  TOL_MENIT_DEFAULT
};

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
    console.error('Gagal: ' + (err && err.message || err));
    process.exit(2);
  });
}
