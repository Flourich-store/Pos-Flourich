// ════════════════════════════════════════════════════════════════
// BACKFIL KOLOM STAGING N..R  (Revisi Modal / Revisi Laba / Flag /
// Sumber HPP / Catatan Estimasi)
//
// File ini SATU-SATUNYA yang menulis ke spreadsheet produksi, dan hanya
// untuk kolom N..R. Kolom A..M tidak pernah disentuh — nilai lamanya harus
// tetap bisa dibandingkan dengan nilai revisinya.
//
// ══ ATURAN PEMAKAIAN ═══════════════════════════════════════════
// 1. cekBlokTersedia()   -> READ-ONLY. Merangkum shape sheet, mencatat
//                           baseline, dan mengaktifkan izin.
// 2. tulisBlok1()        -> blok 1 saja. BERHENTI, cek manual di sheet.
// 3. tulisBlok2() ...    -> satu blok per izin, setelah Anda cek manual.
// 4. rollbackBlokN()     -> hanya bila Anda memutuskan membatalkan.
//
// TIDAK ADA fungsi "tulis semua blok". Permukaan yang bisa salah ditekan
// sengaja dikecilkan: enam blok harus six kali dipilih satu per satu.
//
// ══ GUARD (batal tanpa menulis satu sel pun) ═════════════════════
//  G-0  izin aktif & baseline milik spreadsheet yang sedang dibuka
//  G-1  bentuk sheet sama persis dengan baseline (jumlah baris, lebar)
//  G-2  header inti A1:M1 sama persis dengan baseline
//  G-3  kolom N..R kosong, atau sudah persis sama dengan hasil rencana
//  G-4  kunci tulis script-wide DIDAPAT (bukan jalan tanpa lock)
//
// ══ VERIFIKASI (gagal = blok dibalik otomatis) ══════════════════
//  V-1  bentuk sheet tetap sama setelah menulis
//  V-2  kolom A..M terbukti identik sebelum/sesudah
//  V-3  getLastColumn() tidak tumbuh melewati kolom R
//  V-4  getMaxColumns() tidak berubah sama sekali
//  V-5  rekonsiliasi SESUAI FLAG (lihat catatan panjang di bawah)
//  V-6  kolom P & Q sesuai flag; kolom R tidak pernah berisi angka
//  V-7  baca balik dari sheet cocok dengan rencana, sel per sel
//
// ── V-5 per flag (INI yang berubah setelah keputusan HPP pemilik) ──
//  TERCATAT     N harus SAMA dengan K dan O SAMA dengan M. Modal hasil
//               hitung ulang harus jatuh persis di nilai yang sudah ada —
//               itulah bukti tidak ada perubahan. Kalau K kosong, tidak
//               ada yang bisa direkonsiliasi -> falls back ke rumus.
//  KOREKSI      N SENGAJA BERBEDA dari K (HPP kolom E dikoreksi ke HPP
//               yang dikonfirmasi pemilik). Jadi aturan N==K TIDAK BOLEH
//               dipakai. Yang diperiksa: N == jumlah x hppDipakai dan
//               O == totalHarga - N - biaya.
//  ESTIMASI     sama seperti KOREKSI: diperiksa dari rumus, bukan N==K.
//  DIKECUALIKAN N dan O keduanya harus kosong (bukan 0).
//
// ══ CATATAN KUNCI ══════════════════════════════════════════════
//  Kunci tulis yang dipakai adalah LockService.getScriptLock() — objek
//  yang SAMA dengan yang dipakai prosesCheckout & tambahStokProduk, jadi
//  backfill dan checkout benar-benar saling menunggu. Bedanya hanya:
//  denganKunciTulis() (Code.js) MENERUSKAN jalan tanpa lock agar kasir
//  tidak pernah tertahan; di sini itu justru berbahaya, jadi kunci
//  dipakai fail-CLOSED: tidak didapat = batal, bukan dipaksa jalan.
//
//  Catatan operasional: rentang filter sheet harus diperluas dari A:M
//  ke A:R SEBELUM ada sort/filter apa pun. Sort yang masih ter-anchor
//  di A:M bisa menggeser baris relatif terhadap kolom N..R, dan baris
//  backfill tidak punya kolom pengenal — hanya terikat nomor baris.
//  Kunci tulis tidak melindungi dari ini karena itu pekerjaan interaktif.
// ════════════════════════════════════════════════════════════════

/** Kunci aktifasi izin. Nilai persis, copied by cekBlokTersedia(). */
const IJIN_TULIS_NOPQR = 'TULIS-N-O-P-Q-R-V1';
const PROPS_BASELINE_NOPQR = 'BACKFILL_BASELINE_NOPQR';
const PROPS_IJIN_NOPQR = 'BACKFILL_IJIN_NOPQR';

/**
 * Batas blok, dalam NOMOR BARIS SHEET (bukan indeks data).
 * `sampai: null` = sampai baris terakhir sheet, supaya baris yang
 * menyusul tetap tertangani kalau baseline dicatat ulang.
 */
const BLOK_NOPQR = [
  { no: 1, dari: 2, sampai: 101 },
  { no: 2, dari: 102, sampai: 201 },
  { no: 3, dari: 202, sampai: 301 },
  { no: 4, dari: 302, sampai: 401 },
  { no: 5, dari: 402, sampai: 501 },
  { no: 6, dari: 502, sampai: null }
];

/** Tunggu paling lama kunci tulis. Lebih lama dari satu checkout. */
const KUNCI_TULIS_MS = 60000;

// ── utilitas kecil ───────────────────────────────────────────────

/** null/undefined -> '' supaya perbandingan konsisten dengan getValues(). */
function _bfSel(v) { return (v === null || v === undefined) ? '' : v; }

/** Apakah sel dianggap kosong (tidak ada isi). */
function _bfKosong(v) {
  const s = _bfSel(v);
  return s === '' || (typeof s === 'string' && s.trim() === '');
}

/**
 * Perbandingan angka yang TEGAS: nilai kosong tidak pernah dianggap
 * sama dengan angka (bukan 0). Ini yang mencegah "0" lolos sebagai
 * hasil hitung yang benar.
 */
function _bfNumEq(a, b) {
  const an = typeof a === 'number' && isFinite(a);
  const bn = typeof b === 'number' && isFinite(b);
  if (an && bn) return Math.abs(a - b) < 1e-9;
  return !an && !bn && _bfKosong(a) && _bfKosong(b);
}

function _bfCariBlok(no) {
  for (const b of BLOK_NOPQR) if (b.no === no) return b;
  return null;
}

function _bfSheet() {
  const ss = getSpreadsheet();
  const sh = ss ? ss.getSheetByName('Penjualan') : null;
  return { ss: ss, sh: sh };
}

/** Cetak ke Logger dan kembalikan string JSON (dipakai editor Apps Script). */
function _bfJson(o) {
  const s = JSON.stringify(o, null, 2);
  try { Logger.log(s); } catch (e) { /* Logger tak tersedia di uji */ }
  return s;
}

/** Jumlah baris data = baris yang kolom A-nya tidak kosong. */
function _bfHitungBarisData(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const vals = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  let n = 0;
  for (const v of vals) if (String(_bfSel(v[0])).trim() !== '') n++;
  return n;
}

/**
 * Shape sheet saat ini. Ini yang dibandingkan dengan baseline (G-1/G-2)
 * dan yang diulang setelah menulis (V-1).
 */
function _bfBentukSheet(ss, sh) {
  const lastRow = sh.getLastRow();
  const maxColumns = sh.getMaxColumns ? sh.getMaxColumns() : 0;
  const lastColumn = typeof sh.getLastColumn === 'function' ? sh.getLastColumn() : maxColumns;
  const headerInti = (sh.getRange(1, 1, 1, 13).getValues()[0] || [])
    .map(x => String(_bfSel(x)).trim());
  return {
    ssid: ss.getId(),
    lastRow: lastRow,
    jumlahBarisData: _bfHitungBarisData(sh),
    maxColumns: maxColumns,
    lastColumn: lastColumn,
    headerInti: headerInti
  };
}

/**
 * SIDIK JARI sheet: satu string pendek yang harus PERSIS SAMA di log
 * cekBlokTersedia() dan di log tulisBlokN(). Owners membacanya sekilas
 * untuk menyetujui "sheet yang saya lihat" = "sheet yang akan ditulis",
 * tanpa harus membaca angka panjang di dua tempat.
 *
 * Yang SENGAJA TIDAK ikut: lastColumn. Kolom terisi memang bertambah
 * 13 -> 18 begitu blok 1 ditulis, jadi masukkannya akan membuat sidik
 * jari berubah di tengah jalan padahal sheet-nya tidak berubah sama
 * sekali - persis IDFK yang tidak boleh terjadi. Yang masuk hanya
 * hal-hal yang WAJIB tidak berubah, yaitu yang dijaga G-1/G-2.
 *
 * Bentuknya: <lastRow>r/<jumlahBarisData>d/<maxColumns>c/<hash>
 */
function _bfSidikJari(bentuk) {
  const bahan = String(bentuk.ssid) + '\u2501' + String(bentuk.lastRow) + '\u2501' +
    String(bentuk.jumlahBarisData) + '\u2501' + String(bentuk.maxColumns) + '\u2501' +
    (bentuk.headerInti || []).join('\u2502');
  // FNV-1a 32-bit -> 8 hex. Cukup untuk membedakan shape yang berbeda
  // dan tetap pendek untuk dibandingkan mata.
  let h = 2166136261;
  for (let i = 0; i < bahan.length; i++) {
    h = (h ^ bahan.charCodeAt(i)) >>> 0;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return bentuk.lastRow + 'r/' + bentuk.jumlahBarisData + 'd/' + bentuk.maxColumns + 'c/' +
    ('00000000' + h.toString(16)).slice(-8);
}

/**
 * LockService script-wide — objek yang SAMA dengan yang dipakai
 * prosesCheckout. Fail-CLOSED: tidak dapat lock = null, bukan jalan
 * tanpa lock. Untuk backfill ini benar, karena lock tidak diperoleh
 * berarti ada operasis yang sedang mengubah sheet.
 */
function denganKunciTulisWajib(fn) {
  let kunci = null;
  try { kunci = LockService.getScriptLock(); } catch (e) { kunci = null; }
  let pegang = false;
  if (kunci && typeof kunci.tryLock === 'function') {
    try { pegang = kunci.tryLock(KUNCI_TULIS_MS); } catch (e) { pegang = false; }
  }
  if (!pegang) return null;
  try {
    return fn();
  } finally {
    try { kunci.releaseLock(); } catch (e) { /* abaikan */ }
  }
}

// ── rencana per blok ─────────────────────────────────────────────

/**
 * Susun nilai N..R untuk setiap baris dalam blok, sebagai larik 5 kolom.
 * Baris tanpa entri rencana tetap ditulis kosong — supaya tidak ada
 * sisa penulisan lama yang tertinggal di dalam rentang blok.
 */
function _bfNilaiBlok(peta, dari, sampai) {
  const out = [];
  for (let n = dari; n <= sampai; n++) {
    const r = peta[n];
    if (!r) { out.push(['', '', '', '', '']); continue; }
    out.push([
      r.nilai.revisiModal,
      r.nilai.revisiLaba,
      r.flag,
      r.nilai.sumberHpp,
      r.nilai.catatanEstimasi
    ]);
  }
  return out;
}

/** Satu blok "kosong total": tidak ada sel yang berubah dari ''. */
function _bfSamaKosong(baris) {
  for (const v of baris) if (!_bfKosong(v)) return false;
  return true;
}

/**
 * Apakah satu baris di sheet PERSIS sama dengan baris hasil rencana.
 *
 * Fungsi MURNI: tidak baca sheet, tidak menulis, tidak Logger. Dipakai
 * oleh dua pemakai yang KEHENDAK memberi jawaban sama:
 *   - G-3 di _bfTulisBlokTerpakai()  -> menolak nilai asing
 *   - status per blok di cekBlokTersedia() -> melaporkan yang sudah ditulis
 * Kalau dua pemakai punya salinan sendiri, suatu saat bisa berbeda dan
 * laporan "sudah ditulis" jadi tidak benar. Karena itu hanya ada satu.
 *
 * KEADAHULUAN PENTING - cabang ditentukan oleh TIPE NILAI RENCANA (y),
 * bukan tipe nilai yang dibaca dari sheet (x):
 *
 *   rencana angka (mis. 10000)
 *     -> _bfNumEq: banding ANGKA. Teks "10000" TIDAK dianggap sama dengan
 *        angka 10000, dan kosong TIDAK dianggap sama dengan 0.
 *        Selisih < 1e-9 dianggap sama, jadi 10000.5 == 10000.50.
 *   rencana teks/kosong (mis. '' atau null)
 *     -> banding TEKS setelah di-trim. null dan '' dianggap SAMA (keduanya
 *        tidak mengisi apa-apa), tapi angka 0 TIDAK sama dengan '' - 0
 *        adalah isi, bukan ketiadaan isi.
 *
 * Aturan kedua inilah yang membuat baris DIKECUALIKAN aman: nilai
 * rencana N/O-nya kosong, jadi sel yang berisi 0 tidak akan pernah lolos
 * sebagai "sudah benar" - ia masuk kategori nilai asing.
 */
/**
 * Lebar area staging N..R. Nilai ini SEHARUSNYA selalu sama dengan
 * HEADER_STAGING.length (Diagnostik.js) - kalau pernah berbeda, itu bug
 * layout, bukan hal yang boleh diselipkan diam-diam. Dideklarasikan di
 * modul (bukan di dalam _bfTulisBlokTerpakai) karena dipakai beberapa
 * fungsi murni yang tingkat modul.
 */
const LEBAR = 5;

function _bfSamaBaris(aktual, rencana) {
  for (let j = 0; j < LEBAR; j++) {
    const x = aktual[j], y = rencana[j];
    const ok = (typeof y === 'number')
      ? _bfNumEq(x, y)
      : String(_bfSel(x)).trim() === String(_bfSel(y)).trim();
    if (!ok) return false;
  }
  return true;
}

/** Batas nomor baris yang ikut dicetak di contohAsing. */
const MAKS_CONTOH_ASING = 10;

/**
 * Status tulis satu blok: sudah ditulis, belum, atau perlu diperiksa.
 *
 * READ-ONLY dan MURNI - tidak menyentuh sheet, tidak Logger. Menerima
 * nilai N..R yang SUDAH dibaca dari sheet, lalu mengelompokkan tiap baris
 * ke dalam tiga keadaan dengan pembanding yang sama persis seperti G-3
 * (_bfSamaBaris), sehingga laporan "SUDAH DITULIS" berarti hal yang sama
 * dengan "_bfTulisBlokTerpakai() tidak akan menulis apa pun".
 *
 * Keadaan:
 *   kosong        - kelima sel kosong; belum ditulis
 *   sudahBenar    - persis sama dengan rencana; ditulis dan benar
 *   asing         - berisi sesuatu yang BUKAN hasil rencana. G-3 akan
 *                   menolak menimpanya, jadi status blok jadi PERIKSA dan
 *                   nomor barisnya dicetak supaya bisa langsung dibuka.
 */
function _bfStatusBlok(nilaiSekarang, rencanaNilai, dari) {
  let barisKosong = 0, barisSudahBenar = 0, barisAsing = 0;
  const contohAsing = [];
  const n = Math.min(nilaiSekarang.length, rencanaNilai.length);
  for (let i = 0; i < n; i++) {
    const a = nilaiSekarang[i] || [];
    if (_bfSamaKosong(a)) { barisKosong++; continue; }
    if (_bfSamaBaris(a, rencanaNilai[i])) { barisSudahBenar++; continue; }
    barisAsing++;
    if (contohAsing.length < MAKS_CONTOH_ASING) {
      contohAsing.push({ baris: dari + i, aktual: a.map(_bfSel) });
    }
  }
  const status = (n === 0) ? 'TIDAK ADA BARIS'
    : (barisAsing > 0) ? 'PERIKSA'
      : (barisKosong > 0) ? 'BELUM'
        : 'SUDAH DITULIS';
  return {
    status: status,
    barisKosong: barisKosong,
    barisSudahBenar: barisSudahBenar,
    barisAsing: barisAsing,
    contohAsing: contohAsing
  };
}

/**
 * Satu kalimat: apa yang harus dilakukan selanjutnya.
 *
 * Dihitung dari status tulis, bukan dari urutan blok. Ini memperbaiki
 * kalimat lama "langkahBerikutnya selalu menyuruh tulisBlok1()" yang
 * tetap muncul bahkan setelah semua blok selesai - persis kondisi yang
 * baru saja terjadi di produksi.
 */
function _bfLangkahBerikutnya(blok) {
  const semua = blok || [];
  const asing = semua.filter(b => b.tulis && b.tulis.barisAsing > 0);
  if (asing.length) {
    return 'ADA NILAI ASING di blok ' + asing.map(b => b.no).join(', ') +
      ' - lihat contohAsing. JANGAN tulis blok mana pun: G-3 akan menolak menimpanya, ' +
      'dan nilai itu bukan hasil rencana.';
  }
  const belum = semua.filter(b => b.tulis && b.tulis.barisKosong > 0);
  if (belum.length) {
    const n = belum[0].no;
    return 'Blok ' + (semua.length - belum.length) +
      ' sudah tertulis. Lalu tulis blok ' + n + ' saja: tulisBlok' + n + '().';
  }
  return 'Semua blok sudah persis sama dengan rencana. TIDAK ADA yang perlu ditulis lagi - ' +
    'cukup jalankan hapusIzinBackfill() untuk mencabut izin tulis.';
}

// ════════════════════════════════════════════════════════════════
// PEMBUNGKUS TANPA PARAMETER
// Fungsi berparameter tidak muncul di dropdown "function" editor
// Apps Script, jadi tiap blok punya entry point sendiri.
// ════════════════════════════════════════════════════════════════

/**
 * READ-ONLY. Melaporkan bentuk sheet, komposisi tiap blok, dan rencana
 * lengkap — lalu mencatat baseline + mengaktifkan izin tulis.
 * Jalankan ini pertama, sebelum blok mana pun.
 */
function cekBlokTersedia() {
  const { ss, sh } = _bfSheet();
  if (!ss || !sh) return _bfJson({ status: 'error', pesan: 'Sheet Penjualan tidak ditemukan.' });

  const bentuk = _bfBentukSheet(ss, sh);
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROPS_BASELINE_NOPQR, JSON.stringify(bentuk));
  props.setProperty(PROPS_IJIN_NOPQR, IJIN_TULIS_NOPQR);

  const h = _hitungRencanaHistori();
  if (!h.ok) return _bfJson({ status: 'error', pesan: h.pesan });
  const rencana = _hitungRencanaKolomBaru(h);
  const peta = {};
  for (const b of rencana.baris) peta[b.barisSheet] = b;

  const blok = BLOK_NOPQR.map(function (def) {
    const sampai = (def.sampai == null) ? bentuk.lastRow : Math.min(def.sampai, bentuk.lastRow);
    const komposisi = { TERCATAT: 0, KOREKSI: 0, ESTIMASI: 0, DIKECUALIKAN: 0 };
    let baris = 0;
    for (let n = def.dari; n <= sampai; n++) {
      baris++;
      const b = peta[n];
      if (b && komposisi[b.flag] !== undefined) komposisi[b.flag]++;
    }
    // Baca N..R blok ini (READ-ONLY) lalu kelompokkan tiap baris.
    // Satu range per blok - bukan per baris - supaya tetap murah.
    const nBaris = Math.max(sampai - def.dari + 1, 0);
    const nilaiSekarang = nBaris > 0
      ? sh.getRange(def.dari, KOLOM_STAGING.N, nBaris, LEBAR).getValues().map(r => r.map(_bfSel))
      : [];
    return {
      no: def.no,
      dari: def.dari,
      sampai: sampai,
      baris: baris,
      komposisi: komposisi,
      tulis: _bfStatusBlok(nilaiSekarang, _bfNilaiBlok(peta, def.dari, sampai), def.dari)
    };
  });

  const headerSekarang = (sh.getRange(1, KOLOM_STAGING.N, 1, 5).getValues()[0] || []).map(_bfSel);
  const sidikJari = _bfSidikJari(bentuk);

  const hasil = {
    status: 'ok',
    readOnly: true,
    menulis: false,
    sheet: bentuk,
    baseline: bentuk,
    sidikJari: sidikJari,
    caraMenyetujui: 'Bandingkan sidikJari di atas dengan baris "SIDIK JARI:" di log tulisBlokN(). ' +
      'Kalau sama persis, sheet yang Anda periksa ini = sheet yang ditulis. lastColumn sengaja TIDAK ikut ' +
      'karena kolom N..R memang baru muncul setelah blok 1.',
    headerStagingSekarang: _bfSamaKosong(headerSekarang) ? '(kosong)' : headerSekarang,
    blok: blok,
    rencana: {
      ringkasan: rencana.ringkasan,
      rekonsiliasi: rencana.rekonsiliasi,
      keputusanHppPemilik: rencana.keputusanHppPemilik,
      produkHppMasterBerbeda: rencana.produkHppMasterBerbeda
    },
    langkahBerikutnya: _bfLangkahBerikutnya(blok)
  };
  Logger.log('=== SIDIK JARI: ' + sidikJari + ' | ' + ss.getName() +
    ' | ' + bentuk.lastRow + ' baris, ' + bentuk.jumlahBarisData + ' baris data, grid ' + bentuk.maxColumns +
    ' kolom | cocokkan dengan log tulisBlokN() ===');
  return _bfJson(hasil);
}

/** Tulis satu blok. Parameter dipakai hanya oleh wrapper di bawah. */
function tulisBlok(no) {
  const def = _bfCariBlok(Number(no));
  if (!def) return _bfJson({ status: 'error', pesan: 'Nomor blok tidak dikenal: ' + no });
  const hasil = denganKunciTulisWajib(function () { return _bfTulisBlokTerpakai(def); });
  if (hasil === null) {
    return _bfJson({
      status: 'batal',
      blok: def.no,
      guard: { G4: { ok: false, pesan: 'Kunci tulis script-wide tidak diperoleh dalam ' + KUNCI_TULIS_MS + ' ms. Ada operasis lain yang sedang berjalan. TIDAK ADA sel yang ditulis — coba lagi nanti.' } },
      tulis: { barisDitulis: 0, headerDitulis: false, selDitulis: 0 },
      verifikasi: {},
      sudahDitulis: false
    });
  }
  return _bfJson(hasil);
}

/** Kosongkan kolom N..R satu blok. Blok 1 ikut mengosongkan header. */
function rollbackBlok(no) {
  const def = _bfCariBlok(Number(no));
  if (!def) return _bfJson({ status: 'error', pesan: 'Nomor blok tidak dikenal: ' + no });

  const hasil = denganKunciTulisWajib(function () {
    const ctx = _bfSheet();
    if (!ctx.ss || !ctx.sh) return { status: 'error', pesan: 'Sheet Penjualan tidak ditemukan.' };
    const sh = ctx.sh;
    const bentuk = _bfBentukSheet(ctx.ss, sh);
    const sampai = (def.sampai == null) ? bentuk.lastRow : Math.min(def.sampai, bentuk.lastRow);
    const n = Math.max(sampai - def.dari + 1, 0);

    let selDikosongkan = 0;
    if (n > 0) {
      sh.getRange(def.dari, KOLOM_STAGING.N, n, 5)
        .setValues(_bfKosongkan(n, 5));
      selDikosongkan += n * 5;
    }
    let headerDikosongkan = false;
    if (def.no === 1) {
      sh.getRange(1, KOLOM_STAGING.N, 1, 5).setValues([['', '', '', '', '']]);
      headerDikosongkan = true;
      selDikosongkan += 5;
    }
    return {
      status: 'ok',
      blok: def.no,
      rentang: def.dari + '..' + sampai,
      selDikosongkan: selDikosongkan,
      headerDikosongkan: headerDikosongkan,
      getLastColumn: sh.getLastColumn ? sh.getLastColumn() : null
    };
  });

  if (hasil === null) {
    return _bfJson({ status: 'batal', blok: def.no, pesan: 'Kunci tulis tidak diperoleh. TIDAK ADA sel yang dikosongkan.' });
  }
  return _bfJson(hasil);
}

/** Matikan izin tulis tanpa menyentuh sheet. */
function hapusIzinBackfill() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROPS_IJIN_NOPQR);
  props.deleteProperty(PROPS_BASELINE_NOPQR);
  return _bfJson({
    status: 'ok', menulis: false,
    pesan: 'Izin & baseline dihapus. Semua blok akan menolak jalan sampai cekBlokTersedia() dipanggil lagi.'
  });
}

function _bfKosongkan(nBaris, nKolom) {
  const out = [];
  for (let i = 0; i < nBaris; i++) {
    const row = [];
    for (let j = 0; j < nKolom; j++) row.push('');
    out.push(row);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// INTI: menulis satu blok, lengkap dengan guard, verifikasi, dan
// rollback otomatis. Dijalankan DI BAWAH kunci tulis (denganKunciTulisWajib).
// ════════════════════════════════════════════════════════════════

function _bfTulisBlokTerpakai(def) {
  const out = {
    blok: def.no,
    rentang: null,
    status: 'batal',
    guard: {},
    verifikasi: {},
    komposisi: { TERCATAT: 0, KOREKSI: 0, ESTIMASI: 0, DIKECUALIKAN: 0 },
    tulis: { barisDitulis: 0, headerDitulis: false, selDitulis: 0 },
    rollback: { dijalankan: false, ok: null, pesan: null },
    sudahDitulis: false
  };
  const batal = (k, pesan) => { out.guard[k] = { ok: false, pesan: pesan }; return out; };

  // ── G-0: izin aktif & baseline milik spreadsheet ini ───────────
  const props = PropertiesService.getScriptProperties();
  let baseline = null;
  try { baseline = JSON.parse(props.getProperty(PROPS_BASELINE_NOPQR) || 'null'); } catch (e) { baseline = null; }
  if (!baseline || props.getProperty(PROPS_IJIN_NOPQR) !== IJIN_TULIS_NOPQR) {
    return batal('G0', 'Izin tulis belum aktif. Jalankan cekBlokTersedia() lebih dulu.');
  }
  const ctx = _bfSheet();
  if (!ctx.ss || !ctx.sh) return batal('G0', 'Spreadsheet / sheet Penjualan tidak ditemukan.');
  if (String(baseline.ssid) !== String(ctx.ss.getId())) {
    return batal('G0', 'Spreadsheet yang dibuka BUKAN spreadsheet yang dicatat baseline (' +
      baseline.ssid + '). Tidak ditulis.');
  }
  out.guard.G0 = { ok: true, ssid: baseline.ssid };

  // ── G-1: bentuk sheet sama persis dengan baseline ──────────────
  const bentuk = _bfBentukSheet(ctx.ss, ctx.sh);
  if (bentuk.lastRow !== baseline.lastRow) {
    return batal('G1', 'Jumlah baris berubah: baseline ' + baseline.lastRow +
      ', sekarang ' + bentuk.lastRow + '. Jalankan cekBlokTersedia() ulang.');
  }
  if (bentuk.jumlahBarisData !== baseline.jumlahBarisData) {
    return batal('G1', 'Jumlah baris data berubah: baseline ' + baseline.jumlahBarisData +
      ', sekarang ' + bentuk.jumlahBarisData + '.');
  }
  if (bentuk.maxColumns !== baseline.maxColumns) {
    return batal('G1', 'Lebar kolom sheet berubah: baseline ' + baseline.maxColumns +
      ', sekarang ' + bentuk.maxColumns + '.');
  }
  out.guard.G1 = {
    ok: true, lastRow: bentuk.lastRow,
    jumlahBarisData: bentuk.jumlahBarisData, maxColumns: bentuk.maxColumns
  };

  // ── G-2: header inti A1:M1 sama persis dengan baseline ────────
  if (JSON.stringify(bentuk.headerInti) !== JSON.stringify(baseline.headerInti)) {
    return batal('G2', 'Header inti A1:M1 berbeda dari baseline (' +
      JSON.stringify(bentuk.headerInti) + '). Ada yang mengubah header sheet.');
  }
  out.guard.G2 = { ok: true };

  // Sidik jari DICETAK DI SINI - setelah G-0..G-2 lulus, SEBELUM satu sel pun
  // ditulis. Kalau baris "SIDIK JARI:" ini berbeda dari yang Anda lihat di
  // log cekBlokTersedia(), maka sheet yang akan ditulis bukan sheet yang
  // Anda periksa: tekan Ctrl+Z di sheet dan jangan paru. Sebaliknya, kalau
  // sama persis, Anda tahu persis apa yang sedang ditulis.
  out.sidikJari = _bfSidikJari(bentuk);
  Logger.log('=== SIDIK JARI: ' + out.sidikJari + ' | blok ' + def.no + ' | ' +
    'menulis ' + (def.dari + '..' + Math.min(def.sampai == null ? bentuk.lastRow : def.sampai, bentuk.lastRow)) +
    ' | cocokkan dengan log cekBlokTersedia() ===');

  // ── rencana (dihitung ULANG di sini, bukan dari cache) ─────────
  const h = _hitungRencanaHistori();
  if (!h.ok) return batal('G2', h.pesan);
  const rencana = _hitungRencanaKolomBaru(h);
  const peta = {};
  for (const b of rencana.baris) peta[b.barisSheet] = b;

  const sampai = (def.sampai == null) ? bentuk.lastRow : Math.min(def.sampai, bentuk.lastRow);
  const nBaris = Math.max(sampai - def.dari + 1, 0);
  out.rentang = def.dari + '..' + sampai;
  if (nBaris === 0) {
    out.status = 'ok';
    out.pesan = 'Blok ini tidak punya baris pada sheet saat ini.';
    return out;
  }

  const COL = KOLOM_STAGING.N;

  // ── G-3: kolom N..R kosong, atau sudah persis hasil rencana ────
  const headerSebelum = (ctx.sh.getRange(1, COL, 1, LEBAR).getValues()[0] || []).map(_bfSel);
  const headerKosong = _bfSamaKosong(headerSebelum);
  const headerBenar = headerSebelum.length === HEADER_STAGING.length &&
    headerSebelum.every((v, i) => String(_bfSel(v)).trim() === HEADER_STAGING[i]);
  if (def.no === 1) {
    // Blok 1 satu-satunya yang boleh menulis header. Kalau isinya header
    // yang tidak dikenal, itu milik orang lain - jangan ditimpa.
    if (!headerKosong && !headerBenar) {
      return batal('G3', 'N1:R1 berisi header yang TIDAK dikenal: ' +
        JSON.stringify(headerSebelum) + '. Tidak ditimpa.');
    }
  } else if (!headerBenar) {
    return batal('G3', 'N1:R1 belum berisi header hasil blok 1 (sekarang ' +
      JSON.stringify(headerSebelum) + '). Jalankan blok 1 lebih dulu.');
  }

  const rencanaNilai = _bfNilaiBlok(peta, def.dari, sampai);
  const nilaiSebelum = ctx.sh.getRange(def.dari, COL, nBaris, LEBAR).getValues()
    .map(row => row.map(_bfSel));

  let sudah = 0, belum = 0;
  const beda = [];
  for (let i = 0; i < nBaris; i++) {
    if (_bfSamaKosong(nilaiSebelum[i])) belum++;
    else if (_bfSamaBaris(nilaiSebelum[i], rencanaNilai[i])) sudah++;
    else beda.push({ baris: def.dari + i, aktual: nilaiSebelum[i], rencana: rencanaNilai[i] });
  }
  if (beda.length > 0) {
    return batal('G3', 'Kolom N..R di baris ' +
      beda.slice(0, 5).map(b => b.baris + ' ' + JSON.stringify(b.aktual)).join(' | ') +
      ' berisi nilai yang BUKAN hasil rencana. Tidak ditimpa.');
  }
  out.guard.G3 = {
    ok: true,
    header: headerKosong ? '(kosong - akan ditulis)' : (headerBenar ? 'sudah benar' : '?'),
    barisKosong: belum, barisSudahBenar: sudah
  };

  const butuhData = belum > 0;
  const butuhHeader = (def.no === 1 && headerKosong);

  // Idempoten: blok ini sudah persis sama. Tidak ada yang perlu ditulis.
  if (!butuhData && !butuhHeader) {
    out.status = 'ok';
    out.sudahDitulis = true;
    out.pesan = 'Blok ' + def.no + ' sudah persis sama dengan rencana. Tidak ada sel yang ditulis.';
    for (let i = 0; i < nBaris; i++) {
      const b = peta[def.dari + i];
      if (b && out.komposisi[b.flag] !== undefined) out.komposisi[b.flag]++;
    }
    return out;
  }

  // ── rekam keadaan pra-tulis (dipakai V-2 dan rollback) ─────────
  const lcSebelum = ctx.sh.getLastColumn ? ctx.sh.getLastColumn() : bentuk.maxColumns;
  const mcSebelum = ctx.sh.getMaxColumns ? ctx.sh.getMaxColumns() : bentuk.maxColumns;
  const intiSebelum = ctx.sh.getRange(1, 1, bentuk.lastRow, 13).getValues();

  // ── TULIS ──────────────────────────────────────────────────────
  // Header lebih dulu. Kalau tahap ini gagal, yang tertinggal hanya
  // header tanpa data - keadaan yang jelas dan tidak menyesatkan,
  // bukan data tanpa label yang tidak bisa dibaca siapa pun.
  if (butuhHeader) {
    ctx.sh.getRange(1, COL, 1, LEBAR).setValues([HEADER_STAGING.slice()]);
    out.tulis.headerDitulis = true;
    out.tulis.selDitulis += LEBAR;
  }
  if (butuhData) {
    ctx.sh.getRange(def.dari, COL, nBaris, LEBAR).setValues(rencanaNilai);
    out.tulis.barisDitulis = belum;
    out.tulis.selDitulis += nBaris * LEBAR;
  }
  if (sudah > 0) out.sudahDitulis = true;

  // ── VERIFIKASI ─────────────────────────────────────────────────
  const v = out.verifikasi;

  const bentukSesudah = _bfBentukSheet(ctx.ss, ctx.sh);
  v.V1 = {
    ok: bentukSesudah.lastRow === baseline.lastRow &&
      bentukSesudah.jumlahBarisData === baseline.jumlahBarisData,
    lastRow: bentukSesudah.lastRow, jumlahBarisData: bentukSesudah.jumlahBarisData,
    pesan: 'jumlah baris & baris data harus tetap sama dengan baseline'
  };

  const intiSesudah = ctx.sh.getRange(1, 1, bentuk.lastRow, 13).getValues();
  v.V2 = {
    ok: JSON.stringify(intiSesudah) === JSON.stringify(intiSebelum),
    kolom: 'A..M',
    pesan: 'kolom A..M harus terbukti identik sebelum & sesudah'
  };

  // getLastColumn() adalah kolom TERAKHIR BERISI, bukan lebar grid.
  // Live: getMaxColumns 29 sementara isinya baru 13 kolom — makanya
  // lebar sheet TIDAK bisa dipakai sebagai verifikasi. Yang dijaga
  // di sini: tidak menyusut, dan tidak tumbuh melewati kolom R.
  const lcSesudah = ctx.sh.getLastColumn ? ctx.sh.getLastColumn() : bentukSesudah.maxColumns;
  const batasMaks = Math.max(lcSebelum, KOLOM_STAGING.R);
  v.V3 = {
    ok: lcSesudah >= lcSebelum && lcSesudah <= batasMaks,
    sebelum: lcSebelum, sesudah: lcSesudah, batasMaks: batasMaks,
    pesan: 'getLastColumn() tidak boleh menyusut dan tidak boleh tumbuh melewati kolom R (18)'
  };

  const mcSesudah = ctx.sh.getMaxColumns ? ctx.sh.getMaxColumns() : bentukSesudah.maxColumns;
  v.V4 = {
    ok: mcSesudah === mcSebelum, sebelum: mcSebelum, sesudah: mcSesudah,
    pesan: 'lebar grid sheet (getMaxColumns) tidak boleh berubah'
  };

  const bacaBalik = ctx.sh.getRange(def.dari, COL, nBaris, LEBAR).getValues().map(r => r.map(_bfSel));

  const kelas = {
    tercatat: { diperiksa: 0, cocok: 0, gagal: 0, pakaiNvsK: true, tanpaNilaiSheet: 0, contohGagal: [] },
    koreksi: { diperiksa: 0, cocok: 0, gagal: 0, pakaiNvsK: false, contohGagal: [] },
    estimasi: { diperiksa: 0, cocok: 0, gagal: 0, pakaiNvsK: false, contohGagal: [] },
    dikecualikan: { diperiksa: 0, cocok: 0, gagal: 0, pakaiNvsK: false, contohGagal: [] }
  };
  const v6 = { diperiksa: 0, gagal: 0, rBerisi: 0, contohGagal: [] };

  for (let i = 0; i < nBaris; i++) {
    const no = def.dari + i;
    const sel = bacaBalik[i];
    const r = peta[no];
    const N = sel[0], O = sel[1], P = String(_bfSel(sel[2])).trim(), Q = _bfSel(sel[3]), R = _bfSel(sel[4]);

    if (!r) {
      // Baris tanpa entri rencana: kolom staging-nya harus benar-benar kosong.
      if (!_bfSamaKosong(sel)) {
        v6.gagal++;
        if (v6.contohGagal.length < 3) v6.contohGagal.push({ baris: no, alasan: 'baris tanpa rencana tapi staging berisi' });
      }
      continue;
    }
    out.komposisi[r.flag]++;
    const n = r.nilai;

    // ── V-5: rekonsiliasi SESUAI FLAG ───────────────────────────
    const namaKelas = r.flag === FLAG_TERCATAT ? 'tercatat'
      : r.flag === FLAG_KOREKSI ? 'koreksi'
        : r.flag === FLAG_ESTIMASI ? 'estimasi' : 'dikecualikan';
    const k = kelas[namaKelas];
    k.diperiksa++;
    let okV5;
    if (r.flag === FLAG_TERCATAT && Number.isFinite(r.sebelum.modal) && Number.isFinite(r.sebelum.laba)) {
      // TERCATAT murni: nilai hitung ulang harus jatuh PERSIS di K & M.
      okV5 = _bfNumEq(N, r.sebelum.modal) && _bfNumEq(O, r.sebelum.laba);
    } else if (r.flag === FLAG_DIKECUALIKAN) {
      // Tidak ada yang boleh dikarang - dan 0 bukan jawaban yang sah.
      okV5 = _bfKosong(N) && _bfKosong(O);
    } else if (n.jumlah !== null && n.hppDipakai !== null && n.totalHarga !== null) {
      // KOREKSI & ESTIMASI: diperiksa dari RUMUS, bukan N==K. Untuk KOREKSI
      // aturan N==K justru SALAH karena N memang harus berbeda dari K.
      const modalHarus = _bulat(n.jumlah * n.hppDipakai);
      okV5 = _bfNumEq(N, modalHarus) &&
        _bfNumEq(O, _bulat(n.totalHarga - modalHarus - n.biayaOperasional));
    } else {
      // Tidak ada bahan hitung -> kolom angka harus kosong.
      okV5 = _bfKosong(N) && _bfKosong(O);
      k.tanpaNilaiSheet++;
    }
    if (okV5) k.cocok++;
    else {
      k.gagal++;
      if (k.contohGagal.length < 3) k.contohGagal.push({ baris: no, id: r.id, flag: r.flag, N: N, O: O });
    }

    // ── V-6: P & Q sesuai flag, R tidak pernah angka ────────────
    v6.diperiksa++;
    let okV6 = (P === r.flag) && (String(_bfSel(Q)).trim() === String(_bfSel(n.sumberHpp)).trim());
    if (!_bfKosong(R) && /^-?[\d.,]+$/.test(String(R).trim())) okV6 = false;
    if (okV6) { if (!_bfKosong(R)) v6.rBerisi++; }
    else {
      v6.gagal++;
      if (v6.contohGagal.length < 3) v6.contohGagal.push({ baris: no, id: r.id, P: P, Q: Q, R: R });
    }
  }

  v.V5 = {
    ok: kelas.tercatat.gagal === 0 && kelas.koreksi.gagal === 0 &&
      kelas.estimasi.gagal === 0 && kelas.dikecualikan.gagal === 0,
    tercatat: kelas.tercatat, koreksi: kelas.koreksi,
    estimasi: kelas.estimasi, dikecualikan: kelas.dikecualikan,
    pesan: 'TERCATAT: N==K & O==M. KOREKSI & ESTIMASI: N==jumlah x HPP dan O==total-N-biaya. ' +
      'DIKECUALIKAN: N & O kosong. Baris per flag yang nol di blok ini tidak dihitung sebagai gagal.'
  };
  v.V6 = {
    ok: v6.gagal === 0, diperiksa: v6.diperiksa, gagal: v6.gagal,
    rBerisi: v6.rBerisi, contohGagal: v6.contohGagal,
    pesan: 'kolom P & Q sesuai flag; kolom R tidak boleh berisi angka'
  };

  // ── V-7: baca balik dari sheet vs rencana, sel per sel ────────
  let v7Cocok = 0, v7Gagal = 0;
  const v7Contoh = [];
  for (let i = 0; i < nBaris; i++) {
    if (_bfSamaBaris(bacaBalik[i], rencanaNilai[i])) v7Cocok++;
    else {
      v7Gagal++;
      if (v7Contoh.length < 5) v7Contoh.push({ baris: def.dari + i, dapat: bacaBalik[i], harus: rencanaNilai[i] });
    }
  }
  v.V7 = {
    ok: v7Gagal === 0, cocok: v7Cocok, gagal: v7Gagal, contohGagal: v7Contoh,
    pesan: 'nilai yang dibaca BALIK dari sheet harus sama persis dengan rencana'
  };

  const gagal = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7'].filter(k2 => !v[k2].ok);
  if (gagal.length === 0) {
    out.status = 'ok';
    return out;
  }

  // ── ROLLBACK otomatis ──────────────────────────────────────────
  out.status = 'gagal';
  out.pesan = 'Verifikasi ' + gagal.join(', ') + ' gagal. Blok dikembalikan ke keadaan semula.';
  try {
    if (butuhData) ctx.sh.getRange(def.dari, COL, nBaris, LEBAR).setValues(nilaiSebelum);
    if (butuhHeader) ctx.sh.getRange(1, COL, 1, LEBAR).setValues([headerSebelum]);
    out.rollback.dijalankan = true;

    const intiAkhir = ctx.sh.getRange(1, 1, bentuk.lastRow, 13).getValues();
    const stagingAkhir = ctx.sh.getRange(def.dari, COL, nBaris, LEBAR).getValues().map(r => r.map(_bfSel));
    const headerAkhir = (ctx.sh.getRange(1, COL, 1, LEBAR).getValues()[0] || []).map(_bfSel);
    const pulih = JSON.stringify(intiAkhir) === JSON.stringify(intiSebelum) &&
      JSON.stringify(stagingAkhir) === JSON.stringify(nilaiSebelum) &&
      JSON.stringify(headerAkhir) === JSON.stringify(headerSebelum);
    out.rollback.ok = pulih;
    out.rollback.pesan = pulih
      ? 'Kolom N..R blok ini & header sudah kembali persis seperti semula.'
      : 'Rollback TIDAK berhasil memulihkan keadaan semula. Periksa sheet SEBELUM menjalankan blok berikutnya.';
  } catch (e) {
    out.rollback.ok = false;
    out.rollback.pesan = 'Rollback melempar error: ' + (e && e.message ? e.message : String(e));
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// PEMBUNGKUS BLOK — tanpa parameter, untuk dropdown editor
// ════════════════════════════════════════════════════════════════

function tulisBlok1() { return tulisBlok(1); }
function tulisBlok2() { return tulisBlok(2); }
function tulisBlok3() { return tulisBlok(3); }
function tulisBlok4() { return tulisBlok(4); }
function tulisBlok5() { return tulisBlok(5); }
function tulisBlok6() { return tulisBlok(6); }

function rollbackBlok1() { return rollbackBlok(1); }
function rollbackBlok2() { return rollbackBlok(2); }
function rollbackBlok3() { return rollbackBlok(3); }
function rollbackBlok4() { return rollbackBlok(4); }
function rollbackBlok5() { return rollbackBlok(5); }
function rollbackBlok6() { return rollbackBlok(6); }

// ════════════════════════════════════════════════════════════════
// MIGRASI MULTI-CABANG — SEKALI JALAN, ADITIF, TANPA MENGGESER KOLOM
//
// Yang dilakukan (dan HANYA ini):
//  1) Penjualan   : + header "Cabang" di kolom paling KANAN, semua baris
//                   lama diisi "PUSAT". Tidak ada nilai lama diubah.
//  2) User        : + header "Cabang" di kolom paling KANAN, semua baris
//                   lama diisi "PUSAT".
//  3) Stok_Cabang : sheet BARU berisi ID Produk | PUSAT, disalin dari kolom
//                   Stok di sheet Produk. Sheet Produk TIDAK diubah.
//
// KENAPA DI PALING KANAN, BUKAN DISISIPKAN SETELAH "Tanggal":
//  Kolom N..R di Penjualan dipakai staging backfill (file ini). Menyisipkan
//  kolom di tengah menggeser blok itu satu kolom dan membuat semua aturan
//  posisional di atas salah. Menambah di ujung tidak menggeser apa pun, dan
//  pemetaan kolom Code.js berbasis NAMA HEADER sehingga posisi tidak penting.
//
// ATURAN PAKAI (permukaan yang bisa salah ditekan sengaja dikecilkan):
//  1. pratinjauMigrasiMultiCabang()      READ-ONLY. Tunjukkan rencana.
//  2. siapkanSalinanMigrasiMultiCabang() buat salinan spreadsheet & catat
//     ID-nya. TANPA salinan tercatat, migrasi MENOLAK jalan.
//     Bila scope Drive belum tersedia: salin manual (File > Make a copy),
//     lalu catat lewat catatSalinanMigrasiManual('<ID salinan>').
//  3. migrasiMultiCabang()               jalankan SEKALI. Idempoten: bila
//     penanda selesai sudah ada, batal tanpa menulis.
//
// Sifat fail-CLOSED: kunci tulis tidak didapat = batal, bukan dipaksa jalan
// (berbeda dari denganKunciTulis() di Code.js yang demi kasir tetap lanjut).
// ════════════════════════════════════════════════════════════════

/** Kode cabang untuk seluruh data lama. */
const MC_CABANG_AWAL = 'PUSAT';
const MC_HEADER_CABANG = 'Cabang';
const MC_NAMA_SHEET_STOK = 'Stok_Cabang';
const MC_PROPS_SALINAN = 'MC_SALINAN_SPREADSHEET';
const MC_PROPS_SELESAI = 'MC_MIGRASI_SELESAI';
const MC_KUNCI_MS = 60000;

/** Indeks kolom (0-based) dari nama header; -1 bila tidak ada. */
function _mcIdxHeader(header, nama) {
  const target = String(nama).toLowerCase().trim();
  for (let i = 0; i < header.length; i++) {
    if (String(_bfSel(header[i])).toLowerCase().trim() === target) return i;
  }
  return -1;
}

/** Header baris 1 + lebar kolom terakhir yang berisi. */
function _mcHeader(sh) {
  const lebar = Math.max(1, sh.getLastColumn());
  const baris = sh.getRange(1, 1, 1, lebar).getValues()[0] || [];
  return { header: baris, lebar: lebar };
}

/**
 * Rencana migrasi — HANYA MEMBACA. Tidak ada setValue/setValues di sini.
 */
function _mcPratinjau(ss) {
  const out = {
    status: 'ok',
    spreadsheet: { nama: ss.getName(), id: ss.getId() },
    salinanTercatat: '',
    sudahMigrasi: '',
    langkah: [],
    peringatan: [],
    penghalang: []
  };

  try {
    const props = PropertiesService.getScriptProperties();
    out.salinanTercatat = props.getProperty(MC_PROPS_SALINAN) || '';
    out.sudahMigrasi = props.getProperty(MC_PROPS_SELESAI) || '';
  } catch (e) { /* props tidak tersedia di uji */ }

  // ── Penjualan ──
  const shJual = ss.getSheetByName('Penjualan');
  if (!shJual) {
    out.penghalang.push('Sheet Penjualan tidak ditemukan');
  } else {
    const h = _mcHeader(shJual);
    const idxCab = _mcIdxHeader(h.header, MC_HEADER_CABANG);
    const barisData = _bfHitungBarisData(shJual);
    out.penjualan = {
      kolomSekarang: h.lebar,
      header: h.header.map(_bfSel),
      kolomCabang: idxCab < 0 ? 'BELUM ADA' : (idxCab + 1),
      barisData: barisData,
      aksi: idxCab < 0
        ? 'Tambah header "' + MC_HEADER_CABANG + '" di kolom ' + (h.lebar + 1) +
          ', isi ' + barisData + ' baris lama dengan "' + MC_CABANG_AWAL + '"'
        : 'Tidak diubah (kolom Cabang sudah ada)'
    };
    out.langkah.push('Penjualan: ' + out.penjualan.aksi);
  }

  // ── User ──
  const shUser = ss.getSheetByName('User');
  if (!shUser) {
    out.penghalang.push('Sheet User tidak ditemukan');
  } else {
    const h = _mcHeader(shUser);
    const idxCab = _mcIdxHeader(h.header, MC_HEADER_CABANG);
    const lastRow = shUser.getLastRow();
    const jumlahUser = Math.max(0, lastRow - 1);
    out.user = {
      kolomSekarang: h.lebar,
      header: h.header.map(_bfSel),
      kolomCabang: idxCab < 0 ? 'BELUM ADA' : (idxCab + 1),
      jumlahUser: jumlahUser,
      aksi: idxCab < 0
        ? 'Tambah header "' + MC_HEADER_CABANG + '" di kolom ' + (h.lebar + 1) +
          ', isi ' + jumlahUser + ' user lama dengan "' + MC_CABANG_AWAL + '"'
        : 'Tidak diubah (kolom Cabang sudah ada)'
    };
    out.langkah.push('User: ' + out.user.aksi);

    // SUPER_ADMIN biasanya TIDAK terikat satu cabang. Migrasi ini tetap
    // mengisi PUSAT (sesuai permintaan), jadi daftarnya dilaporkan agar
    // pemilik bisa mengosongkannya sendiri bila perlu.
    if (lastRow >= 2) {
      const rows = shUser.getRange(2, 1, lastRow - 1, Math.max(3, h.lebar)).getValues();
      const superAdmin = [];
      for (const r of rows) {
        const nama = String(_bfSel(r[0])).trim();
        const role = String(_bfSel(r[2])).toUpperCase().trim();
        if (nama && role === 'SUPER_ADMIN') superAdmin.push(nama);
      }
      if (superAdmin.length) {
        out.peringatan.push('Baris SUPER_ADMIN ikut terisi "' + MC_CABANG_AWAL + '": ' +
          superAdmin.join(', ') + ' — kosongkan kolom Cabang-nya bila user ini harus lintas cabang.');
      }
    }
  }

  // ── Produk & Stok_Cabang ──
  const shProduk = ss.getSheetByName('Produk');
  const shStok = ss.getSheetByName(MC_NAMA_SHEET_STOK);
  if (!shProduk) {
    out.penghalang.push('Sheet Produk tidak ditemukan');
  } else {
    const peta = petaKolomProdukSheet(shProduk);
    if (peta.col.id === undefined || peta.col.stok === undefined) {
      out.penghalang.push('Header sheet Produk tidak lengkap (butuh "ID Produk" dan "Stok")');
    } else {
      const data = shProduk.getDataRange().getValues();
      let jumlah = 0;
      let total = 0;
      const contoh = [];
      for (let i = 1; i < data.length; i++) {
        const id = String(ambilKolom(data[i], peta, 'id', '')).trim();
        if (!id) continue;
        const stok = ambilKolomAngka(data[i], peta, 'stok', 0);
        jumlah++;
        total += stok;
        if (contoh.length < 3) contoh.push({ id: id, stok: stok });
      }
      out.produk = {
        jumlahProduk: jumlah,
        kolomStok: peta.col.stok + 1,
        totalStok: total,
        contoh: contoh
      };
      out.stokCabang = {
        sheetAda: !!shStok,
        header: shStok ? _mcHeader(shStok).header.map(_bfSel) : null,
        aksi: shStok
          ? (shStok.getLastRow() >= 2
            ? 'DIBATALKAN: sheet ' + MC_NAMA_SHEET_STOK + ' sudah berisi data (tidak akan ditimpa)'
            : 'Isi sheet ' + MC_NAMA_SHEET_STOK + ' yang sudah ada dengan ' + jumlah + ' produk')
          : 'Buat sheet ' + MC_NAMA_SHEET_STOK + ' (ID Produk | ' + MC_CABANG_AWAL + ') berisi ' + jumlah + ' produk'
      };
      if (shStok && shStok.getLastRow() >= 2) {
        out.penghalang.push('Sheet ' + MC_NAMA_SHEET_STOK + ' sudah berisi data');
      }
      out.langkah.push('Stok_Cabang: ' + out.stokCabang.aksi + ', total stok ' + total);
    }
  }

  return out;
}

/** Pratinjau READ-ONLY untuk dijalankan dari dropdown editor. */
function pratinjauMigrasiMultiCabang() {
  return _bfJson(_mcPratinjau(getSpreadsheet()));
}

/**
 * Langkah 1: buat salinan spreadsheet & catat ID-nya.
 * Menolak (tidak menimpa) bila salinan sudah tercatat.
 */
function siapkanSalinanMigrasiMultiCabang() {
  const out = { status: 'batal', langkah: [], peringatan: [] };
  try {
    const ss = getSpreadsheet();
    const props = PropertiesService.getScriptProperties();

    const sudah = props.getProperty(MC_PROPS_SALINAN);
    if (sudah) {
      out.status = 'sudah-ada';
      out.salinan = sudah;
      out.pesan = 'Salinan migrasi sudah tercatat (' + sudah + '). Tidak dibuat salinan baru. ' +
        'Bila ingin salinan baru, hapus property ' + MC_PROPS_SALINAN + ' lebih dulu.';
      return _bfJson(out);
    }

    const zona = ss.getSpreadsheetTimeZone ? ss.getSpreadsheetTimeZone() : 'Asia/Jakarta';
    let stamp = '';
    try { stamp = Utilities.formatDate(new Date(), zona, 'dd-MM-yyyy HH.mm'); } catch (e) { stamp = String(new Date().getTime()); }
    const nama = 'SALINAN migrasi multi-cabang - ' + ss.getName() + ' - ' + stamp;

    // makeCopy butuh scope tulis Drive. appsscript.json proyek ini hanya
    // punya drive.readonly, jadi jalur ini bisa gagal — dan bila gagal,
    // migrasi TIDAK boleh jalan (lihat guard di migrasiMultiCabang).
    const berkas = DriveApp.getFileById(ss.getId()).makeCopy(nama);
    const id = berkas.getId();
    props.setProperty(MC_PROPS_SALINAN, id);

    out.status = 'ok';
    out.salinan = id;
    out.nama = nama;
    out.url = (typeof berkas.getUrl === 'function')
      ? berkas.getUrl()
      : ('https://docs.google.com/spreadsheets/d/' + id);
    out.pesan = 'Salinan dibuat & ID-nya dicatat. Migrasi boleh dijalankan.';
  } catch (e) {
    out.status = 'error';
    out.pesan = 'Gagal membuat salinan otomatis: ' + (e && e.message ? e.message : String(e)) +
      '. appsscript.json proyek ini hanya punya scope "drive.readonly", sedangkan makeCopy butuh scope tulis Drive. ' +
      'Pilihan: (a) salin manual lewat File > Make a copy lalu jalankan catatSalinanMigrasiManual("<ID salinan>"), ' +
      'atau (b) tambahkan "https://www.googleapis.com/auth/drive" ke oauthScopes lalu setujui ulang izin script.';
  }
  return _bfJson(out);
}

/**
 * Catat salinan yang dibuat MANUAL (File > Make a copy).
 * Menerima ID maupun URL spreadsheet salinan.
 *
 * VERIFIKASI — dulu ID apa pun diterima apa adanya, sehingga migrasi bisa
 * lolos guard cadangan dengan ID salah, file terhapus, atau file lain:
 *  1. salinan benar-benar ADA & bisa DIBUKA sebagai spreadsheet (openById)
 *  2. bukan spreadsheet sumber itu sendiri
 *  3. bentuknya memang salinan POS ini: sheet Penjualan/Produk/User ada dan
 *     header Penjualan identik dengan sumber
 *  4. jumlah baris penjualan TIDAK lebih sedikit dari sumber (salinan yang
 *     lebih lama tidak bisa memulihkan data sekarang)
 * Hanya bila keempatnya lolos, ID disimpan di Script Properties.
 */
function catatSalinanMigrasiManual(idAtauUrl) {
  const out = { status: 'batal' };
  const teks = String(idAtauUrl == null ? '' : idAtauUrl).trim();
  if (!teks) {
    out.pesan = 'Sebutkan ID atau URL spreadsheet salinan, mis. catatSalinanMigrasiManual("1AbC...").';
    return _bfJson(out);
  }
  // Ambil ID dari URL bentuk /spreadsheets/d/<ID>/...
  let id = teks;
  const cocok = teks.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (cocok) id = cocok[1];

  try {
    const ss = getSpreadsheet();

    // (1) Nyata & bisa dibuka. openById butuh scope "spreadsheets" (sudah ada
    // di appsscript.json) dan TIDAK butuh izin tulis Drive — jadi salinan
    // manual tetap bisa diverifikasi meski makeCopy belum diizinkan.
    let salinan = null;
    try {
      salinan = SpreadsheetApp.openById(id);
    } catch (bukaErr) {
      out.status = 'error';
      out.pesan = 'ID "' + id + '" tidak bisa dibuka sebagai spreadsheet (' +
        (bukaErr && bukaErr.message ? bukaErr.message : String(bukaErr)) + '). ' +
        'Periksa: salinannya benar-benar ada, tidak ada di Trash, dan akun yang menjalankan script ini punya akses ke file itu.';
      return _bfJson(out);
    }
    if (!salinan) {
      out.status = 'error';
      out.pesan = 'ID "' + id + '" terbuka tanpa objek spreadsheet. Salinan tidak dicatat.';
      return _bfJson(out);
    }

    // (2) Bukan sumber.
    if (salinan.getId() === ss.getId()) {
      out.pesan = 'ID yang dicatat adalah spreadsheet SUMBER, bukan salinan. Migrasi butuh cadangan terpisah.';
      return _bfJson(out);
    }

    // (3) Bentuk & (4) kelengkapan baris.
    const cek = _mcBandingkanBentuk(ss, salinan);
    if (!cek.ok) {
      out.status = 'error';
      out.pesan = 'Salinan tidak dicatat: ' + cek.alasan;
      out.calonSalinan = cek.info;
      return _bfJson(out);
    }

    PropertiesService.getScriptProperties().setProperty(MC_PROPS_SALINAN, id);
    out.status = 'ok';
    out.salinan = id;
    out.nama = cek.info.nama;
    out.jumlahBarisPenjualan = cek.info.jumlahBarisPenjualan;
    out.jumlahBarisProduk = cek.info.jumlahBarisProduk;
    out.terakhirDiubah = cek.info.terakhirDiubah;
    out.pesan = 'Salinan terverifikasi bisa dibuka, berbeda dari sumber, dan bentuknya cocok. ID dicatat; migrasi boleh dijalankan.';
  } catch (e) {
    out.status = 'error';
    out.pesan = 'Gagal mencatat salinan: ' + (e && e.message ? e.message : String(e));
  }
  return _bfJson(out);
}

/**
 * Bandingkan bentuk spreadsheet sumber vs calon salinan.
 * Tujuan: ID acak / file lain / salinan basi tidak lolos sebagai cadangan.
 */
function _mcBandingkanBentuk(sumber, salinan) {
  const info = { nama: '', jumlahBarisPenjualan: 0, jumlahBarisProduk: 0, terakhirDiubah: '' };
  try { info.nama = String(salinan.getName()); } catch (e) { info.nama = ''; }

  const perlu = ['Penjualan', 'Produk', 'User'];
  const hilang = [];
  for (const nama of perlu) {
    if (!salinan.getSheetByName(nama)) hilang.push(nama);
  }
  if (hilang.length) {
    return {
      ok: false,
      alasan: 'calon salinan tidak punya sheet ' + hilang.join(', ') + ' — bukan salinan spreadsheet POS ini.',
      info: info
    };
  }

  const normal = (h) => h.map(x => String(_bfSel(x)).toLowerCase().trim()).filter(x => x !== '');
  const hSumber = normal(_mcHeader(sumber.getSheetByName('Penjualan')).header);
  const hSalinan = normal(_mcHeader(salinan.getSheetByName('Penjualan')).header);
  if (JSON.stringify(hSumber) !== JSON.stringify(hSalinan)) {
    return {
      ok: false,
      alasan: 'header sheet Penjualan calon salinan berbeda dari sumber (sumber: ' + hSumber.join(' | ') + ').',
      info: info
    };
  }

  info.jumlahBarisPenjualan = _bfHitungBarisData(salinan.getSheetByName('Penjualan'));
  info.jumlahBarisProduk = _bfHitungBarisData(salinan.getSheetByName('Produk'));
  try { info.terakhirDiubah = String(salinan.getLastUpdated()); } catch (e) { info.terakhirDiubah = ''; }

  const barisSumber = _bfHitungBarisData(sumber.getSheetByName('Penjualan'));
  if (info.jumlahBarisPenjualan < barisSumber) {
    return {
      ok: false,
      alasan: 'calon salinan hanya punya ' + info.jumlahBarisPenjualan + ' baris penjualan sedangkan sumber sudah ' +
        barisSumber + ' baris. Salinan itu lebih lama daripada data sekarang — buat salinan baru (File > Make a copy).',
      info: info
    };
  }

  return { ok: true, alasan: '', info: info };
}

/**
 * Tambah kolom Cabang di kolom paling kanan sebuah sheet + isi baris lama.
 * Idempoten: bila header Cabang sudah ada, tidak menulis apa pun.
 */
function _mcTambahKolomCabang(sh) {
  if (!sh) throw new Error('Sheet tidak ditemukan');
  const h = _mcHeader(sh);
  const idxAda = _mcIdxHeader(h.header, MC_HEADER_CABANG);
  if (idxAda >= 0) {
    return { sudahAda: true, kolom: idxAda + 1, diisi: 0 };
  }

  const kolom = h.lebar + 1;
  sh.getRange(1, kolom).setValue(MC_HEADER_CABANG);

  const lastRow = sh.getLastRow();
  let diisi = 0;
  if (lastRow >= 2) {
    const n = lastRow - 1;
    const nilai = [];
    for (let i = 0; i < n; i++) nilai.push([MC_CABANG_AWAL]);
    sh.getRange(2, kolom, n, 1).setValues(nilai);
    diisi = n;
  }
  return { sudahAda: false, kolom: kolom, diisi: diisi };
}

/**
 * Buat/isi sheet Stok_Cabang dari kolom Stok di sheet Produk.
 * Menolak menimpa bila sheet sudah berisi data.
 */
function _mcSiapkanStokCabang(ss) {
  const shProduk = ss.getSheetByName('Produk');
  if (!shProduk) throw new Error('Sheet Produk tidak ditemukan');

  const peta = petaKolomProdukSheet(shProduk);
  if (peta.col.id === undefined || peta.col.stok === undefined) {
    throw new Error('Header sheet Produk tidak lengkap (butuh "ID Produk" dan "Stok")');
  }

  const data = shProduk.getDataRange().getValues();
  const baris = [['ID Produk', MC_CABANG_AWAL]];
  let total = 0;
  for (let i = 1; i < data.length; i++) {
    const id = String(ambilKolom(data[i], peta, 'id', '')).trim();
    if (!id) continue;
    const stok = ambilKolomAngka(data[i], peta, 'stok', 0);
    baris.push([id, stok]);
    total += stok;
  }

  let sh = ss.getSheetByName(MC_NAMA_SHEET_STOK);
  let dibuat = false;
  if (sh && sh.getLastRow() >= 2) {
    throw new Error('Sheet ' + MC_NAMA_SHEET_STOK + ' sudah berisi data — migrasi tidak menimpanya.');
  }
  if (!sh) {
    sh = ss.insertSheet(MC_NAMA_SHEET_STOK);
    dibuat = true;
  }
  sh.getRange(1, 1, baris.length, 2).setValues(baris);

  return { dibuat: dibuat, jumlahProduk: baris.length - 1, totalStok: total };
}

/** Baca balik hasil migrasi — bukan percaya pada nilai yang baru ditulis. */
function _mcVerifikasi(ss, kolomJual, kolomUser, hasilStok) {
  const v = {};

  const shJual = ss.getSheetByName('Penjualan');
  const hJual = _mcHeader(shJual);
  v.headerPenjualan = _mcIdxHeader(hJual.header, MC_HEADER_CABANG) >= 0;

  const lastRowJual = shJual.getLastRow();
  let terisiJual = 0;
  if (lastRowJual >= 2) {
    const vals = shJual.getRange(2, kolomJual, lastRowJual - 1, 1).getValues();
    for (const r of vals) if (String(_bfSel(r[0])).trim() !== '') terisiJual++;
  }
  v.barisPenjualanTerisi = terisiJual;
  v.isiPenjualanLengkap = (terisiJual === _bfHitungBarisData(shJual));

  const shUser = ss.getSheetByName('User');
  const hUser = _mcHeader(shUser);
  v.headerUser = _mcIdxHeader(hUser.header, MC_HEADER_CABANG) >= 0;

  const lastRowUser = shUser.getLastRow();
  let terisiUser = 0;
  if (lastRowUser >= 2) {
    const vals = shUser.getRange(2, kolomUser, lastRowUser - 1, 1).getValues();
    for (const r of vals) if (String(_bfSel(r[0])).trim() !== '') terisiUser++;
  }
  v.barisUserTerisi = terisiUser;
  v.isiUserLengkap = (terisiUser === Math.max(0, lastRowUser - 1));

  const shStok = ss.getSheetByName(MC_NAMA_SHEET_STOK);
  if (!shStok) {
    v.sheetStokAda = false;
    v.totalStokCocok = false;
    v.jumlahProdukCocok = false;
  } else {
    v.sheetStokAda = true;
    const lastRow = shStok.getLastRow();
    let total = 0;
    let jumlah = 0;
    if (lastRow >= 2) {
      const vals = shStok.getRange(2, 1, lastRow - 1, 2).getValues();
      for (const r of vals) {
        if (String(_bfSel(r[0])).trim() === '') continue;
        jumlah++;
        total += Number(r[1]) || 0;
      }
    }
    v.jumlahProdukStok = jumlah;
    v.jumlahProdukCocok = (jumlah === hasilStok.jumlahProduk);
    v.totalStokCocok = (total === hasilStok.totalStok);
  }

  v.ok = !!(v.headerPenjualan && v.headerUser && v.sheetStokAda &&
    v.isiPenjualanLengkap && v.isiUserLengkap &&
    v.jumlahProdukCocok && v.totalStokCocok);
  return v;
}

/**
 * Langkah 2 (SEKALI JALAN): migrasi multi-cabang.
 *
 * Urutan: guard kunci tulis (fail-CLOSED) -> guard salinan -> guard
 * idempoten -> pratinjau -> tulis -> verifikasi baca-balik.
 * Tidak ada rollback otomatis: kalau verifikasi gagal, laporan menyuruh
 * memulihkan dari salinan yang sudah dibuat di langkah 1.
 */
function migrasiMultiCabang() {
  const laporan = { status: 'batal', langkah: [], peringatan: [], verifikasi: {} };

  let kunci = null;
  let pegang = false;
  try {
    kunci = LockService.getScriptLock();
    pegang = !!(kunci && typeof kunci.tryLock === 'function' && kunci.tryLock(MC_KUNCI_MS));
  } catch (e) {
    pegang = false;
  }
  if (!pegang) {
    laporan.pesan = 'Kunci tulis script-wide TIDAK didapat dalam ' + (MC_KUNCI_MS / 1000) +
      ' detik. Migrasi DIBATALKAN tanpa menulis satu sel pun (fail-CLOSED). Coba lagi saat POS sepi.';
    return _bfJson(laporan);
  }

  try {
    const ss = getSpreadsheet();
    const props = PropertiesService.getScriptProperties();

    if (!props.getProperty(MC_PROPS_SALINAN)) {
      laporan.pesan = 'Belum ada salinan spreadsheet yang tercatat. Jalankan ' +
        'siapkanSalinanMigrasiMultiCabang() (atau catatSalinanMigrasiManual("<ID>")) lebih dulu. ' +
        'Migrasi menolak jalan tanpa cadangan.';
      return _bfJson(laporan);
    }

    const sudah = props.getProperty(MC_PROPS_SELESAI);
    if (sudah) {
      laporan.status = 'sudah-pernah';
      laporan.pesan = 'Migrasi sudah pernah dijalankan pada ' + sudah + '. Tidak ada yang ditulis.';
      return _bfJson(laporan);
    }

    const rencana = _mcPratinjau(ss);
    laporan.peringatan = rencana.peringatan.slice();
    if (rencana.penghalang.length) {
      laporan.pesan = 'Dibatalkan sebelum menulis: ' + rencana.penghalang.join('; ');
      return _bfJson(laporan);
    }

    // ── 1. Penjualan ──
    const jual = _mcTambahKolomCabang(ss.getSheetByName('Penjualan'));
    laporan.langkah.push('Penjualan: ' + (jual.sudahAda
      ? 'kolom "' + MC_HEADER_CABANG + '" sudah ada di kolom ' + jual.kolom + ' — tidak diubah'
      : 'header "' + MC_HEADER_CABANG + '" ditulis di kolom ' + jual.kolom + ', ' +
        jual.diisi + ' baris lama diisi "' + MC_CABANG_AWAL + '"'));

    // ── 2. User ──
    const user = _mcTambahKolomCabang(ss.getSheetByName('User'));
    laporan.langkah.push('User: ' + (user.sudahAda
      ? 'kolom "' + MC_HEADER_CABANG + '" sudah ada di kolom ' + user.kolom + ' — tidak diubah'
      : 'header "' + MC_HEADER_CABANG + '" ditulis di kolom ' + user.kolom + ', ' +
        user.diisi + ' baris lama diisi "' + MC_CABANG_AWAL + '"'));

    // ── 3. Stok_Cabang ──
    const stok = _mcSiapkanStokCabang(ss);
    laporan.langkah.push('Stok_Cabang: ' + (stok.dibuat ? 'sheet dibuat, ' : 'sheet sudah ada, ') +
      stok.jumlahProduk + ' produk disalin dari kolom Stok Produk (total ' + stok.totalStok + ')');

    // ── Verifikasi baca-balik ──
    laporan.verifikasi = _mcVerifikasi(ss, jual.kolom, user.kolom, stok);

    if (laporan.verifikasi.ok) {
      props.setProperty(MC_PROPS_SELESAI, new Date().toISOString());
      try { buangCacheAwal(); } catch (e) { /* cache tidak tersedia di uji */ }
      laporan.status = 'selesai';
      laporan.pesan = 'Migrasi selesai & terverifikasi. Data lama tidak berubah; hanya kolom Cabang dan sheet Stok_Cabang yang bertambah.';
    } else {
      laporan.status = 'perlu-diperiksa';
      laporan.pesan = 'Penulisan selesai tetapi verifikasi TIDAK lolos. Jangan jalankan ulang. ' +
        'Periksa laporan.verifikasi, lalu pulihkan sheet dari salinan ' + props.getProperty(MC_PROPS_SALINAN) + ' bila perlu.';
    }
  } catch (err) {
    laporan.status = 'error';
    laporan.pesan = 'Migrasi berhenti karena error: ' + (err && err.message ? err.message : String(err)) +
      '. Sebagian langkah mungkin sudah tertulis — periksa laporan.langkah sebelum mengulang, dan pulihkan dari salinan bila ragu.';
  } finally {
    try { if (pegang) kunci.releaseLock(); } catch (e) { /* abaikan */ }
  }

  return _bfJson(laporan);
}
