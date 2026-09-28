// ════════════════════════════════════════════════════════════════
// Diagnostik.js — fungsi READ-ONLY untuk investigasi & rencana
// backfill. Tidak satu pun fungsi di file ini menulis ke sheet.
//
// File TERPISAH dari Code.js supaya push berikutnya hanya MENAMBAH
// fungsi diagnostik tanpa menyentuh kode produksi.
//
// Ketergantungan: helper dari Code.js (satu project Apps Script —
// seluruh file .js digabung saat deploy):
//   petaKolomPenjualanSheet, petaKolomProdukSheet, ambilKolom,
//   ambilKolomAngka, ambilKolomAngkaToleran, parseAngkaToleran,
//   hitungVolumeMl, formatVolumeMl,
//   selaraskanNamaProduk, getSpreadsheet,
//   PETA_KOLOM_PENJUALAN, PETA_KOLOM_PRODUK
// ════════════════════════════════════════════════════════════════

/** Bunyikan nilai mentah jadi teks rapi untuk laporan (Date -> string). */
function _fmt(v, tz) {
  if (v instanceof Date) {
    try { return Utilities.formatDate(v, tz || 'Asia/Jakarta', 'dd/MM/yyyy HH:mm'); }
    catch (e) { return String(v); }
  }
  return (v === undefined || v === null) ? '' : v;
}

/**
 * Deteksi baris yang ditulis writer LAMA (urutan posisi tergeser):
 * kolom L (Biaya Operasional) & M (Laba bersih) KOSONG karena writer
 * lama menulis maksimal 11 nilai ke A..K. Baris kode BARU selalu
 * menulis L & M — jadi kosongnya L/M = penanda andal baris tergeser.
 *
 * WAJIB ditambah syarat kolom D & E terisi. Kosongnya L/M saja
 * TIDAK cukup: baris "kelas A" (D & E memang kosong, L & M juga
 * belum pernah diisi financials) juga punya L/M kosong, padahal
 * layout-nya SUDAH benar. Tanpa syarat ini baris kelas A salah
 * dibaca writer-lama lalu proposes remap dengan jumlah=0 & total=0.
 *
 * Bukti writer-lama selalu mengisi D (=jumlah) & E (=total harga),
 * jadi baris tergeser PASTI punya kedua kolom itu terisi.
 */
function _perluRemap(row) {
  if (!row) return false;
  const txt = (x) => String(x == null ? '' : x).trim();
  if (txt(row[11]) !== '' || txt(row[12]) !== '') return false;
  return txt(row[3]) !== '' && txt(row[4]) !== '';
}

// ════════════════════════════════════════════════════════════════
// diagnostikModalTerakhir(nAtauId)
//
//   diagnostikModalTerakhir()                  -> 10 baris PENJUALAN terakhir
//   diagnostikModalTerakhir(30)                -> 30 baris terakhir
//   diagnostikModalTerakhir('FR-1790513368295')-> baris dengan ID tsb
//
// Mencetak per baris (Logger.log(JSON.stringify(...))):
//   - kolomA_M : nilai MENTAH kolom A..M (per nama header sheet). Untuk
//     baris lama (tergeser) nilai di kolom D..K MEMANG salah posisi —
//     di sinilah terlihat D=Jumlah, E=Total Harga, F=Volume(ml),
//     G=HPP Satuan, H=Metode, dst.
//   - hppProdukRaw/Angka dari sheet Produk (via selaraskanNamaProduk)
//   - hitungUlangModal       = Jumlah x HPP   (posisi header saat ini)
//   - hitungUlangModalRemap  = D x HPP master (bila baris tergeser)
//   - verdict status.
// READ-ONLY.
// ════════════════════════════════════════════════════════════════
function diagnostikModalTerakhir(nAtauId) {
  const ss = getSpreadsheet();
  const shJual = ss.getSheetByName('Penjualan');
  const shProduk = ss.getSheetByName('Produk');
  const log = [];
  const cetak = (o) => { const s = JSON.stringify(o); log.push(s); Logger.log(s); };

  if (!shJual) { cetak({ status: 'error', pesan: 'Sheet Penjualan tidak ada.' }); return log; }

  const petaJ = petaKolomPenjualanSheet(shJual);
  const lastRow = shJual.getLastRow();
  const maxCols = Math.max(shJual.getMaxColumns ? shJual.getMaxColumns() : 0, 13);
  const semua = shJual.getRange(1, 1, Math.max(lastRow, 1), maxCols).getValues();
  // semua[0]      = baris header (baris sheet 1)
  // semua[k]      = baris sheet k+1  →  kegunaan: semua[barisSheet - 1]
  const tz = ss.getSpreadsheetTimeZone();

  // ── master produk: nama -> [{nama, hppRaw, hppAngka}] (boleh kembar) ──
  let produkRef = [];
  let sheetProdukTerbaca = 'TIDAK';
  if (shProduk) {
    try {
      const lr = shProduk.getLastRow();
      if (lr > 1) {
        sheetProdukTerbaca = 'YA';
        const petaP = petaKolomProdukSheet(shProduk);
        const lebarP = Math.max(shProduk.getMaxColumns ? shProduk.getMaxColumns() : 0, 7);
        const rowsP = shProduk.getRange(2, 1, lr - 1, lebarP).getValues();
        for (let i = 0; i < rowsP.length; i++) {
          const r = rowsP[i];
          const hppRaw = ambilKolom(r, petaP, 'hpp', '');
          const hppAngka = parseAngkaToleran(hppRaw);
          produkRef.push({
            barisSheet: i + 2,
            nama: String(ambilKolom(r, petaP, 'nama', '') || '').trim(),
            hppRaw: hppRaw,
            hppAngka: Number.isFinite(hppAngka) ? hppAngka : null
          });
        }
      }
    } catch (e) {
      cetak({ status: 'error-baca-produk', pesan: String(e) });
    }
  }
  const daftarNama = Array.from(new Set(produkRef.map(p => p.nama)));

  // ── pilih baris target (semua dalam SEMUA SATUAN "nomor baris sheet") ──
  const barisSheetTarget = [];
  if (typeof nAtauId === 'string' && nAtauId.trim() !== '') {
    const cari = String(nAtauId).trim();
    for (let barisSheet = 2; barisSheet <= lastRow; barisSheet++) {
      const row = semua[barisSheet - 1];
      if (row && String(ambilKolom(row, petaJ, 'id', '') || '').trim() === cari) {
        barisSheetTarget.push(barisSheet);
      }
    }
    if (!barisSheetTarget.length) cetak({ status: 'tidak-ditemukan', idDicari: cari, lastRow: lastRow });
  } else {
    const maxN = Math.max(0, lastRow - 1);
    const n = Math.min(Number(nAtauId) || 10, maxN);
    const mulai = Math.max(2, lastRow - n + 1);
    for (let barisSheet = mulai; barisSheet <= lastRow; barisSheet++) barisSheetTarget.push(barisSheet);
  }

  // ── klasifikasi era (bentuk nilai — sama dengan diagnostikPenjualan v1) ──
  const txt = (x) => String(x == null ? '' : x).trim();
  const isTeks = (x) => txt(x) !== '' && isNaN(Number(x));
  const eraBaris = (row) => (txt(row[12]) !== '' || isTeks(row[7])) ? 'BARU13' : (isTeks(row[5]) ? 'LAMA11' : 'LAMA8');

  const bulatkan = _bulat;
  const ringkasan = { total: 0, ok: 0, modal_kosong: 0, modal_beda: 0, hpp_kosong: 0, hpp_teks: 0, hpp_nol: 0, produk_tidak_ditemukan: 0, perlu_remap: 0 };

  for (const barisSheet of barisSheetTarget) {
    const row = semua[barisSheet - 1];
    const mentah = {};
    for (const field of Object.keys(PETA_KOLOM_PENJUALAN)) {
      mentah[field] = _fmt(ambilKolom(row, petaJ, field, ''), tz);
    }
    const namaJual = txt(mentah.namaProduk);
    const jumlah = Number.isFinite(parseAngkaToleran(mentah.jumlah)) ? parseAngkaToleran(mentah.jumlah) : null;
    const modalRaw = mentah.modal;
    const modalNum = Number.isFinite(parseAngkaToleran(modalRaw)) ? parseAngkaToleran(modalRaw) : null;
    const remap = _perluRemap(row);

    const masterNama = selaraskanNamaProduk(namaJual, daftarNama);
    const master = masterNama ? produkRef.filter(p => p.nama === masterNama) : [];
    const hppRaw = master.length ? master[0].hppRaw : null;
    const hppAngka = master.length ? master[0].hppAngka : null;

    const o = {
      barisSheet: barisSheet,
      era: eraBaris(row),
      perluRemap: remap ? 'YA (kolom L&M kosong & D/E terisi = ditulis writer lama)'
        : 'TIDAK (kolom L&M terisi = kode baru)',
      id: String(mentah.id || ''),
      namaProduk: namaJual,
      jumlah: jumlah,
      totalHarga: (() => { const t = parseAngkaToleran(mentah.totalHarga); return Number.isFinite(t) ? t : null; })(),
      kolomA_M: mentah,
      produkMaster: masterNama || null,
      hppProdukRaw: hppRaw,
      hppProdukAngka: hppAngka,
      hitungUlangModal: (jumlah != null && hppAngka != null) ? bulatkan(jumlah * hppAngka) : null,
      // Baris tergeser: D=Jumlah (bukan F). Bukti QTY=250 & Total=HPP.
      hitungUlangModalRemap: (remap && hppAngka != null && row[3] !== undefined && row[3] !== null && Number.isFinite(parseAngkaToleran(row[3])))
        ? bulatkan(parseAngkaToleran(row[3]) * hppAngka) : null,
      modalSheetRaw: modalRaw,
      labaSheetRaw: mentah.labaBersih
    };

    let status;
    if (!master.length) {
      status = 'produk-tidak-ditemukan'; ringkasan.produk_tidak_ditemukan++;
    } else if (hppRaw === '' || hppRaw == null) {
      status = 'hpp-kosong'; ringkasan.hpp_kosong++;
    } else if (hppAngka === null) {
      status = 'hpp-teks'; ringkasan.hpp_teks++;
    } else if (hppAngka === 0) {
      status = 'hpp-nol'; ringkasan.hpp_nol++;
    } else if (modalNum === null) {
      status = 'modal-kosong'; ringkasan.modal_kosong++;
    } else if (jumlah != null && modalNum === bulatkan(jumlah * hppAngka)) {
      status = 'modal-sesuai'; ringkasan.ok++;
    } else {
      status = 'modal-beda'; ringkasan.modal_beda++;
    }
    if (remap) ringkasan.perlu_remap++;
    o.status = status;
    cetak(o);
    ringkasan.total++;
  }

  ringkasan.sheetProdukTerbaca = sheetProdukTerbaca;
  ringkasan.lastRowPenjualan = lastRow;
  cetak({ RINGKASAN: ringkasan });
  return log;
}

// ════════════════════════════════════════════════════════════════
// rencanaBackfillHistori([arg]) — DRY-RUN MURNI (tidak menulis).
//
//   rencanaBackfillHistori()          -> ringkasan + baris non-ok
//                                        (maks BATAS_RINCI baris rinci;
//                                        sisanya via parameter rentang)
//   rencanaBackfillHistori(50)        -> 50 baris TERAKHIR, rinci
//   rencanaBackfillHistori([2, 250])  -> baris sheet 2..250, rinci
//
// Setiap baris diklasifikasikan & dihitung "sebelum -> sesudah" menuju
// layout 13 kolom. Baris yang TIDAK bisa dihitung ulang dicap alasannya
// (produk tidak ditemukan / HPP tidak tersedia) dan DIKECUALIKAN dari
// rencana tulis. Output Logger.log(JSON.stringify(...)), READ-ONLY.
// ════════════════════════════════════════════════════════════════
function _hitungRencanaHistori(arg) {
  const ss = getSpreadsheet();
  const shJual = ss.getSheetByName('Penjualan');
  const shProduk = ss.getSheetByName('Produk');

  if (!shJual) return { ok: false, pesan: 'Sheet Penjualan tidak ada.' };

  const petaJ = petaKolomPenjualanSheet(shJual);
  const lastRow = shJual.getLastRow();
  const maxCols = Math.max(shJual.getMaxColumns ? shJual.getMaxColumns() : 0, 13);
  const semua = shJual.getRange(1, 1, Math.max(lastRow, 1), maxCols).getValues();
  const tz = ss.getSpreadsheetTimeZone();

  // ── master produk ──
  const produkRef = [];
  if (shProduk && shProduk.getLastRow() > 1) {
    const petaP = petaKolomProdukSheet(shProduk);
    const rowsP = shProduk.getRange(2, 1, shProduk.getLastRow() - 1,
      Math.max(shProduk.getMaxColumns ? shProduk.getMaxColumns() : 0, 7)).getValues();
    for (let i = 0; i < rowsP.length; i++) {
      const r = rowsP[i];
      const hppRaw = ambilKolom(r, petaP, 'hpp', '');
      const hppAngka = parseAngkaToleran(hppRaw);
      produkRef.push({
        nama: String(ambilKolom(r, petaP, 'nama', '') || '').trim(),
        hppRaw: hppRaw,
        hppAngka: Number.isFinite(hppAngka) ? hppAngka : null
      });
    }
  }
  const daftarNama = Array.from(new Set(produkRef.map(p => p.nama)));

  const txt = (x) => String(x == null ? '' : x).trim();
  const isTeks = (x) => txt(x) !== '' && isNaN(Number(x));
  const eraBaris = (row) => (txt(row[12]) !== '' || isTeks(row[7])) ? 'BARU13' : (isTeks(row[5]) ? 'LAMA11' : 'LAMA8');
  const bulatkan = _bulat;

  // ── rentang & mode output (satuan: NOMOR BARIS SHEET) ──
  let dari = 2, sampai = lastRow, mode = 'ringkas';
  if (typeof arg === 'number' && Number.isFinite(arg) && arg > 0) {
    dari = Math.max(2, lastRow - Math.floor(arg) + 1);
    mode = 'detail';
  } else if (Array.isArray(arg) && arg.length >= 2) {
    dari = Math.max(2, Number(arg[0]) || 2);
    sampai = Math.min(lastRow, Number(arg[1]) || lastRow);
    mode = 'detail';
  }

  // ── baca nilai per era ──
  // BARU13-tergeser (writer lama hybrid, terukur dari bukti QTY=250 &
  //   Total=HPP): D=jumlah, E=Total Harga, F=Volume(ml), G=HPP Satuan,
  //   H=Metode, I=Uang Dibayar, J=Uang Kembali, K=Modal; L,M kosong.
  // LAMA11 (writer @86, 11 nilai posisional [id,tanggal,nama,jumlah,total,
  //   metode,bayar,kembali,modal,bo,laba] -> A..K): D=jumlah,E=total,
  //   F=metode(teks),G=bayar,H=kembali,I=modal,J=bo,K=laba.
  // LAMA8  (writer tertua, 8 nilai -> A..H): D=jumlah,E=total,F=metode,
  //   G=bayar,H=kembali.
  // BARU13-aligned (kode fix): posisi sudah benar sesuai header.
  const bacaBaris = (row) => {
    const era = eraBaris(row);
    if (era === 'LAMA11' || era === 'LAMA8') {
      if (era === 'LAMA11') {
        return { era, id: txt(row[0]), tanggal: _fmt(row[1], tz), nama: txt(row[2]),
          jumlah: parseAngkaToleran(row[3]), totalHarga: parseAngkaToleran(row[4]),
          metode: txt(row[5]), uangDibayar: parseAngkaToleran(row[6]), uangKembali: parseAngkaToleran(row[7]),
          modalLama: parseAngkaToleran(row[8]), biayaOp: parseAngkaToleran(row[9]), labaLama: row[10],
          volumeKolom: NaN, hppKolom: NaN,
          sheetPerKolom: { A: row[0], B: _fmt(row[1], tz), C: row[2], D: row[3], E: row[4],
            F: row[5], G: row[6], H: row[7], I: row[8], J: row[9], K: row[10] } };
      }
      return { era, id: txt(row[0]), tanggal: _fmt(row[1], tz), nama: txt(row[2]),
        jumlah: parseAngkaToleran(row[3]), totalHarga: parseAngkaToleran(row[4]),
        metode: txt(row[5]), uangDibayar: parseAngkaToleran(row[6]), uangKembali: parseAngkaToleran(row[7]),
        modalLama: NaN, biayaOp: 0, labaLama: '',
        volumeKolom: NaN, hppKolom: NaN,
        sheetPerKolom: { A: row[0], B: _fmt(row[1], tz), C: row[2], D: row[3], E: row[4],
          F: row[5], G: row[6], H: row[7] } };
    }
    if (_perluRemap(row)) {
      return { era, id: txt(row[0]), tanggal: _fmt(row[1], tz), nama: txt(row[2]),
        jumlah: parseAngkaToleran(row[3]), totalHarga: parseAngkaToleran(row[4]),
        metode: txt(row[7]), uangDibayar: parseAngkaToleran(row[8]), uangKembali: parseAngkaToleran(row[9]),
        modalLama: parseAngkaToleran(row[10]), biayaOp: 0, labaLama: '',
        volumeKolom: parseAngkaToleran(row[5]), hppKolom: parseAngkaToleran(row[6]),
        sheetPerKolom: { A: row[0], B: _fmt(row[1], tz), C: row[2], D: row[3], E: row[4],
          F: row[5], G: row[6], H: row[7], I: row[8], J: row[9], K: row[10], L: row[11], M: row[12] } };
    }
    // BARU13 & L/M terisi → posisi header benar.
    // Kolom E (HPP) & Modal Dibaca "atau kosong": sel kosong HARUS
    // tetap '' supaya bisa dibedakan dari angka 0. Tanpa ini aturan
    // "HPP kolom-E didahulukan" tidak bisa membedakan baris yang
    // kolom E-nya kosong dari baris yang HPP-nya benar-benar 0.
    return { era, id: txt(ambilKolom(row, petaJ, 'id', '')),
      tanggal: _fmt(ambilKolom(row, petaJ, 'tanggal', ''), tz),
      nama: txt(ambilKolom(row, petaJ, 'namaProduk', '')),
      jumlah: ambilKolomAngka(row, petaJ, 'jumlah', 0),
      totalHarga: ambilKolomAngka(row, petaJ, 'totalHarga', 0),
      metode: txt(ambilKolom(row, petaJ, 'metode', '')),
      uangDibayar: ambilKolomAngka(row, petaJ, 'uangDibayar', 0),
      uangKembali: ambilKolomAngka(row, petaJ, 'uangKembali', 0),
      modalLama: ambilKolomAngkaAtauKosong(row, petaJ, 'modal'),
      biayaOp: ambilKolomAngka(row, petaJ, 'biayaOperasional', 0),
      labaLama: ambilKolom(row, petaJ, 'labaBersih', ''),
      volumeKolom: formatVolumeMl(ambilKolom(row, petaJ, 'volumeMl', '')),
      hppKolom: ambilKolomAngkaAtauKosong(row, petaJ, 'hppSatuan'),
      sheetPerKolom: (() => {
        const o = {};
        for (const field of Object.keys(PETA_KOLOM_PENJUALAN)) {
          o[String.fromCharCode(65 + petaJ.col[field])] = ambilKolom(row, petaJ, field, '');
        }
        return o;
      })() };
  };

  const BATAS_RINCI = 200; // di mode ringkas: batas baris non-ok yang dicetak rinci
  const ringkasan = { totalBaris: 0, ok_tanpa_perubahan: 0, perbaiki_modal: 0,
    perbaiki_modal_estimasi: 0, layout_tergeser: 0, produk_tidak_ditemukan: 0,
    hpp_tidak_tersedia: 0, hpp_dari_kolom_E: 0, estimasi_dari_master: 0,
    contohOk: [], daftarProdukTidakDitemukan: [] };
  const barisNonOk = [];
  const semuaBaris = [];

  for (let barisSheet = dari; barisSheet <= sampai; barisSheet++) {
    const row = semua[barisSheet - 1];
    if (!row || txt(row[0]) === '') continue;
    const b = bacaBaris(row);
    if (txt(b.id) === '') continue;

    const masterNama = selaraskanNamaProduk(b.nama, daftarNama);
    const master = masterNama ? produkRef.filter(p => p.nama === masterNama) : [];
    const hppRaw = master.length ? master[0].hppRaw : null;
    const hppAngka = master.length ? master[0].hppAngka : null;
    const volumeTarget = formatVolumeMl((Number.isFinite(b.volumeKolom) && b.volumeKolom > 0) ? b.volumeKolom : hitungVolumeMl(b.nama));

    // ── ATURAN SUMBER HPP (WAJIB BERURUTAN) ──────────────────────
    // 1. HPP yang TERCATAT di baris itu sendiri (kolom E untuk
    //    layout aligned; kolom G untuk baris writer-lama yang
    //    tergeser, karena di situ HPP pernah ditulis). INI yang
    //    benar: HPP master berubah seiring waktu, jadi master TIDAK
    //    boleh menimpa angka yang tercatat (mis. Semangsu 9.000).
    // 2. Hanya bila kolom E benar-benar kosong: pakai HPP master
    //    dan TANDAI ESTIMASI — nilainya bisa berbeda dari HPP
    //    waktu transaksi.
    // 3. Tidak ada sumber -> baris DIKECUALIKAN, bukan dikarang.
    const hppKolomAngka = (Number.isFinite(b.hppKolom) && b.hppKolom > 0) ? b.hppKolom : null;
    let sumberHpp = null, estimasi = false, hppDipakai = null, peringatan = null;
    if (hppKolomAngka != null) {
      sumberHpp = 'kolom-E';
      hppDipakai = hppKolomAngka;
    } else if (hppAngka != null) {
      sumberHpp = 'ESTIMASI-master';
      estimasi = true;
      hppDipakai = hppAngka;
      peringatan = 'ESTIMASI: kolom E baris ini kosong, jadi Modal dihitung dari HPP master SEKARANG (' +
        String(hppRaw) + '), bukan HPP waktu transaksi. Perlu dikonfirmasi sebelum ditulis.';
    }
    const modalBaru = (Number.isFinite(b.jumlah) && hppDipakai != null) ? bulatkan(b.jumlah * hppDipakai) : null;
    const biaya = Number.isFinite(b.biayaOp) ? b.biayaOp : 0;
    const labaBaru = (Number.isFinite(b.totalHarga) && modalBaru != null)
      ? bulatkan(b.totalHarga - modalBaru - biaya) : null;
    // Sumber HPP yang dipakai untuk MENGHITUNG nilai target. Berbeda dari
    // o.sumberHpp: baris yang DIKECUALIKAN (produk tak ditemukan / HPP
    // master kosong) tidak masuk rencana tulis, jadi tidak dihitung di
    // ringkasan walau kolom E-nya kebetulan terisi.
    let sumberRencana = sumberHpp;

    const o = {
      barisSheet: barisSheet,
      era: b.era,
      perluRemap: _perluRemap(row) ? 'YA' : 'TIDAK',
      id: b.id,
      tanggal: b.tanggal,
      namaProduk: b.nama,
      sumberHpp: sumberHpp,
      estimasi: estimasi,
      peringatan: peringatan,
      sebelum: {
        sheetPerKolom: b.sheetPerKolom,
        volumeKolom: Number.isFinite(b.volumeKolom) ? b.volumeKolom : null,
        hppKolom: Number.isFinite(b.hppKolom) ? b.hppKolom : null,
        jumlah: Number.isFinite(b.jumlah) ? b.jumlah : null,
        totalHarga: Number.isFinite(b.totalHarga) ? b.totalHarga : null,
        metode: b.metode,
        modalSheet: Number.isFinite(b.modalLama) ? b.modalLama : '(kosong)',
        labaSheet: (b.labaLama === '' || b.labaLama == null) ? '(kosong)' : b.labaLama
      },
      sesudah: {
        volumeMl: volumeTarget,
        hppSatuan: hppDipakai,
        jumlah: Number.isFinite(b.jumlah) ? b.jumlah : null,
        totalHarga: Number.isFinite(b.totalHarga) ? b.totalHarga : null,
        metode: b.metode,
        uangDibayar: Number.isFinite(b.uangDibayar) ? b.uangDibayar : null,
        uangKembali: Number.isFinite(b.uangKembali) ? b.uangKembali : null,
        modal: modalBaru,
        biayaOperasional: b.biayaOp,
        labaBersih: labaBaru
      },
      produkMaster: masterNama || null,
      hppProdukRaw: hppRaw
    };

    let status;
    if (!master.length) {
      status = 'produk-tidak-ditemukan';
      o.alasan = 'HPP tidak bisa dihitung ulang (nama tidak ada di master Produk, juga setelah alias).';
      o.sumberHpp = hppKolomAngka != null ? 'kolom-E' : null;
      o.hppKolomTersedia = hppKolomAngka != null ? hppKolomAngka : null;
      if (ringkasan.daftarProdukTidakDitemukan.length < 20) ringkasan.daftarProdukTidakDitemukan.push(b.nama);
      ringkasan.produk_tidak_ditemukan++;
      sumberRencana = null;
    } else if (hppRaw === '' || hppRaw == null || hppAngka === null) {
      status = 'hpp-tidak-tersedia';
      o.alasan = 'HPP master kosong/teks — tidak bisa dihitung ulang sampai kolom HPP diisi.';
      o.sumberHpp = hppKolomAngka != null ? 'kolom-E' : null;
      o.hppKolomTersedia = hppKolomAngka != null ? hppKolomAngka : null;
      ringkasan.hpp_tidak_tersedia++;
      sumberRencana = null;
    } else if (_perluRemap(row)) {
      status = 'layout-tergeser';
      o.alasan = 'Kolom L&M kosong (writer lama) — seluruh baris ditulis ulang ke 13 kolom + Modal/Laba dihitung ulang.';
      ringkasan.layout_tergeser++;
    } else if (!Number.isFinite(b.modalLama) || b.modalLama !== modalBaru) {
      // Modal kosong juga "perlu diisi" — bukan dianggap sudah benar.
      const modalKosong = !Number.isFinite(b.modalLama);
      const dari = (modalKosong ? 'Modal sheet KOSONG' : 'Modal sheet (' + b.modalLama + ')');
      if (estimasi) {
        status = 'perbaiki-modal-estimasi';
        o.alasan = dari + ' != Jumlah x HPP master (' + modalBaru + ') — diisi dari ESTIMASI master.';
        ringkasan.perbaiki_modal_estimasi++;
      } else {
        status = 'perbaiki-modal';
        o.alasan = dari + ' != Jumlah x HPP tercatat (' + modalBaru + ') — dihitung ulang dari kolom E.';
        ringkasan.perbaiki_modal++;
      }
    } else {
      status = 'ok-tanpa-perubahan';
      ringkasan.ok_tanpa_perubahan++;
      if (ringkasan.contohOk.length < 2) ringkasan.contohOk.push({ barisSheet: barisSheet, id: b.id });
    }
    o.status = status;
    semuaBaris.push(o);
    ringkasan.totalBaris++;
    if (sumberRencana === 'kolom-E') ringkasan.hpp_dari_kolom_E++;
    else if (sumberRencana === 'ESTIMASI-master') ringkasan.estimasi_dari_master++;

    if (status !== 'ok-tanpa-perubahan' || mode === 'detail') {
      barisNonOk.push(o);
    }
  }
  ringkasan.barisNonOk = barisNonOk.length;
  return {
    ok: true,
    ringkasan: ringkasan,
    barisNonOk: barisNonOk,
    semuaBaris: semuaBaris,
    mode: mode,
    BATAS_RINCI: BATAS_RINCI
  };
}

/** Wrapper yang mencetak hasil _hitungRencanaHistori ke Logger. */
function rencanaBackfillHistori(arg) {
  const log = [];
  const cetak = (o) => { const s = JSON.stringify(o); log.push(s); Logger.log(s); };

  const h = _hitungRencanaHistori(arg);
  if (!h.ok) { cetak({ status: 'error', pesan: h.pesan }); return log; }

  // Output. Mode ringkas: ringkasan + baris non-ok (di-cap BATAS_RINCI)
  // supaya tidak melebihi batas log untuk 523 baris. Sisanya lewat
  // rencanaBackfillHistori([dari, sampai]).
  cetak({ RINGKASAN: h.ringkasan });
  let dicetak = 0;
  for (const o of h.barisNonOk) {
    if (h.mode === 'ringkas' && dicetak >= h.BATAS_RINCI) break;
    cetak(o);
    dicetak++;
  }
  if (h.barisNonOk.length > dicetak) {
    cetak({ info: 'Masih ada ' + (h.barisNonOk.length - dicetak) + ' baris non-ok belum dicetak rinci. ' +
      'Panggil rencanaBackfillHistori([dari, sampai]) untuk melihat rentang berikutnya.' });
  }
  return log;
}

// ════════════════════════════════════════════════════════════════
// rencanaBackfillKolomBaru([arg]) — DRY-RUN MURNI staging kolom BARU.
//
//   rencanaBackfillKolomBaru()          -> ringkasan + 1 entri per baris
//   rencanaBackfillKolomBaru([2, 250])  -> baris sheet 2..250 saja
//
// Berbeda dari rencanaBackfillHistori yang menulis ulang 13 kolom A..M,
// fungsi ini MENYIAPKAN kolom staging N..R dan TIDAK menyentuh A..M sama
// sekali. Tujuannya supaya nilai lama (K/M) tetap bisa dibandingkan mata
// dengan nilai revisi, dan supaya rollback cukup dengan mengosongkan N..R.
//
//   N  Revisi Modal     -> Modal hasil hitung-ulang
//   O  Revisi Laba      -> Laba hasil hitung-ulang (KOSONG bila DIKECUALIKAN)
//   P  Flag             -> TERCATAT | ESTIMASI | DIKECUALIKAN
//   Q  Sumber HPP       -> kolom E baris | master produk | tidak ada padanan master
//   R  Catatan Estimasi -> teks penjelasan, HANYA untuk baris yang HPP
//                          master-nya diduga berbeda (curigaHppBerbeda)
//
// Kolom R sengaja bernama "Catatan Estimasi", BUKAN "Catatan HPP": nama
// yang memuat kata "hpp" berisiko ikut tertangkap alias longgar "HPP
// Satuan" (kolom E) bila header inti suatu saat berubah. Isi R juga teks
// bebas, tidak pernah angka hasil hitung, supaya kolom R boleh disaring
// tanpa merusak kolom angka.
// KOLOM BARU TIDAK PERNAH dimasukkan ke PETA_KOLOM_PENJUALAN: payload
// kasir harus tetap 13 kolom. Header staging pun dipilih bebas dari kata
// "Modal"/"Laba"/"hpp" supaya tidak bisa tertangkap fallback
// prefix-longgar buatPetaKolom kalau nanti header inti berubah.
//
// TIDAK ADA satu pun panggilan tulis di fungsi ini. READ-ONLY.
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// KEPUTUSAN PEMILIK — HPP produk yang sudah final
//
// Satu entri PER PRODUK, bukan angka yang disisipkan ke dalam logika.
// Setiap entri wajib mencantumkan nilai HPP final, tanggal keputusan,
// sumber keputusan, dan alasannya. Efeknya pada backfill:
//
//   (a) Baris TERCATAT yang HPP kolom E-nya BERBEDA dari nilai yang
//       dikonfirmasi tidak lagi dianggap benar apa adanya. Baris itu
//       dilabeli KOREKSI: Revisi Modal dihitung ulang dari nilai yang
//       dikonfirmasi, kolom Q diisi "dikonfirmasi pemilik". Kolom K/M
//       tetap TIDAK diubah supaya nilai lama masih bisa dibandingkan.
//   (b) Baris ESTIMASI produk ini TIDAK lagi dicurigai. Dulu selisih
//       antara master dan kolom E memicu catatan di kolom R; setelah
//       pemilik menyatakan angka master yang benar, kecurigaan selesai
//       dan catatan itu dihapus.
//
// PENTING: entri ini TIDAK mengubah aturan estimasi. Baris ESTIMASI
// tetap memakai HPP master persis seperti sebelumnya.
// ════════════════════════════════════════════════════════════════
const KEPUTUSAN_HPP_PEMILIK = {
  'Semangsu 350 ml': {
    hpp: 10000,
    tanggalKeputusan: '28/09/2026',
    sumber: 'pemilik',
    alasan: 'Dikonfirmasi pemilik 28/09/2026: HPP final Rp10.000.'
  }
};

/** Indeks kolom staging, 1-based. N..R = kolom ke-14..18. */
const KOLOM_STAGING = { N: 14, O: 15, P: 16, Q: 17, R: 18 };
/**
 * Header kolom staging, urutan N, O, P, Q, R.
 *
 * "Revisi Modal"/"Revisi Laba" sengaja TIDAK berawalan "Modal"/"Laba"
 * supaya mustahil ikut tertangkap fallback prefix-longgar buatPetaKolom.
 * "Catatan Estimasi" sengaja TIDAK memuat kata "hpp" (padanannya "HPP
 * Satuan" di kolom E) demi alasan yang sama.
 */
const HEADER_STAGING = ['Revisi Modal', 'Revisi Laba', 'Flag', 'Sumber HPP', 'Catatan Estimasi'];

/** Flag per baris. TERCATAT = HPP dari kolom E baris itu (bukan estimasi). */
const FLAG_TERCATAT = 'TERCATAT';
/**
 * TERCATAT yang HPP kolom E-nya dibantah KEPUTUSAN_HPP_PEMILIK.
 * Nilai ditulis ulang dari HPP yang dikonfirmasi pemilik; K/M tetap utuh.
 */
const FLAG_KOREKSI = 'KOREKSI';
const FLAG_ESTIMASI = 'ESTIMASI';
const FLAG_DIKECUALIKAN = 'DIKECUALIKAN';

/** Urutan flag pada ringkasan & rekonsiliasi. */
const URUTAN_FLAG = [FLAG_TERCATAT, FLAG_KOREKSI, FLAG_ESTIMASI, FLAG_DIKECUALIKAN];

/** Teks kolom Q per asal HPP. */
const SUMBER_TERCATAT = 'kolom E baris';
const SUMBER_KOREKSI = 'dikonfirmasi pemilik';
const SUMBER_ESTIMASI = 'master produk';
const SUMBER_TIDAK_ADA = 'tidak ada padanan master';

/** Status baris yang TIDAK bisa dihitung ulang -> kolom angka dikosongkan. */
const STATUS_TERKUNCI = ['produk-tidak-ditemukan', 'hpp-tidak-tersedia'];

/**
 * Bulatkan ke bilangan bulat bila selisihnya < 0,01. Dipakai BOTH oleh
 * _hitungRencanaHistori dan rencanaBackfillKolomBaru supaya kolom
 * "Revisi Laba" yang dihitung ulang untuk flag KOREKSI dibulatkan dengan
 * aturan yang sama persis dengan Modal asalnya.
 */
function _bulat(x) {
  return (Math.abs(x - Math.round(x)) < 0.01 ? Math.round(x) : x);
}

/** "26/09/2026 11:34" -> kunci angka urut; null kalau format tak dikenali. */
function _kunciTanggal(tanggal) {
  const m = String(tanggal == null ? '' : tanggal).trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return Number(m[3]) * 1e8 + Number(m[2]) * 1e6 + Number(m[1]) * 1e4 +
    Number(m[4] || 0) * 100 + Number(m[5] || 0);
}

/**
 * Perhitungan rencana kolom N..R yang MURNI: tanpa Logger, tanpa string,
 * tanpa menulis apa pun. Mengembalikan objek biasa.
 *
 * Dipakai oleh dua pemanggil yang WAJIB melihat hasil yang sama persis:
 *   1. rencanaBackfillKolomBaru() - dry-run yang dicetak ke Logger.
 *   2. BackfillKolomBaru.js       - penulis sungguhan.
 *
 * Kalau perhitungan ini diduplikasi di dua tempat, dry-run bisa saja
 * terlihat benar sementara penulisnya menulis nilai lain. Karena itu
 * TIDAK ada duplikasi: pemanggil hanya mencetak/menulis hasilnya.
 *
 * `h` = hasil _hitungRencanaHistori() (argumen blok diteruskan apa adanya).
 */
function _hitungRencanaKolomBaru(h) {
  // ── Bukti HPP master yang sudah berubah ────────────────────────
  // Kalau ada baris TERCATAT (HPP diambil dari kolom E baris itu)
  // yang HPP terekamnya BERBEDA dari HPP master, maka HPP master
  // produk itu sudah tidak berlaku. Semua baris ESTIMASI produk itu
  // memakai angka master yang keliru — jadi ditandai perlu ditinjau.
  // Yang ESTIMASI danOccurs sebelum baris bukti pertama dicurigai
  // paling keras: sesudah tanggal itu ada catatan langsung (kolom E)
  // bahwa HPP-nya berbeda.
  //
  // PENTING: ini hanya PENANDAAN. Nilai Modal/Laba tetap memakai
  // aturan sumber HPP yang sudah ada — tidak ada yang diubah.
  //
  // PENGECUALIAN: produk yang HPP-nya sudah DIKONFIRMASI pemilik
  // (KEPUTUSAN_HPP_PEMILIK) tidak lagi dicurigai. Pemilik sudah
  // menyatakan angka master yang benar, jadi tidak ada lagi yang
  // perlu dicurigai; yang tersisa adalah baris TERCATAT-nya sendiri
  // yang dilabeli KOREKSI (lihat bawah).
  const bukti = {};
  for (const o of h.semuaBaris) {
    if (STATUS_TERKUNCI.indexOf(o.status) !== -1) continue;
    if (o.sumberHpp !== 'kolom-E' || !o.produkMaster) continue;
    if (KEPUTUSAN_HPP_PEMILIK[o.produkMaster]) continue; // sudah diputuskan manusia
    const terekam = Number.isFinite(o.sebelum.hppKolom) ? o.sebelum.hppKolom : null;
    const master = parseAngkaToleran(o.hppProdukRaw);
    if (terekam === null || !Number.isFinite(master) || terekam === master) continue;
    const t = _kunciTanggal(o.tanggal);
    const sbl = bukti[o.produkMaster];
    if (!sbl || (t !== null && (sbl.tanggalBukti === null || t < sbl.tanggalBukti))) {
      bukti[o.produkMaster] = {
        hppTerekam: terekam, hppMaster: master, tanggalBukti: t, barisBukti: o.barisSheet
      };
    }
  }

  const ringkasan = {
    totalBaris: 0, tercatat: 0, koreksi: 0, estimasi: 0, dikecualikan: 0,
    curigaHppBerbeda: 0, denganCatatan: 0
  };
  const daftarProdukBukti = [];
  const barisRencana = [];

  // Rekonsiliasi total per flag. "Baru" = kolom N/O yang direncanakan;
  // "Sheet" = kolom K/M yang sekarang ada di sheet. Diselisihkan di sini
  // supaya selisihnya terlihat SEBELUM apa pun ditulis.
  const rekonsiliasi = {
    totalBaris: 0, targetBaris: 0,
    sigmaModalBaru: 0, sigmaLabaBaru: 0, sigmaModalSheet: 0, sigmaLabaSheet: 0,
    perFlag: {}
  };
  for (const f of URUTAN_FLAG) {
    rekonsiliasi.perFlag[f] = {
      n: 0, sigmaModalBaru: 0, sigmaLabaBaru: 0, sigmaModalSheet: 0, sigmaLabaSheet: 0
    };
  }
  const num = (x) => (Number.isFinite(x) ? x : 0);

  for (const o of h.semuaBaris) {
    const terkunci = STATUS_TERKUNCI.indexOf(o.status) !== -1;
    // Keputusan pemilik untuk produk master baris ini (null bila belum ada).
    const keputusan = o.produkMaster ? (KEPUTUSAN_HPP_PEMILIK[o.produkMaster] || null) : null;
    const kolomE = Number.isFinite(o.sebelum.hppKolom) ? o.sebelum.hppKolom : null;

    let flag, sumberHppQ, revisiModal, revisiLaba;
    let curiga = false, catatanEstimasi = '';
    let koreksi = null;
    // Angka sumber hitung, diteruskan apa adanya supaya penulis (writer)
    // bisa MENGHITUNG ULANG sendiri alih-alih memercayai rencana.
    const jumlah = Number.isFinite(o.sesudah.jumlah) ? o.sesudah.jumlah : null;
    const totalHarga = Number.isFinite(o.sesudah.totalHarga) ? o.sesudah.totalHarga : null;
    const biayaOperasional = Number.isFinite(o.sesudah.biayaOperasional) ? o.sesudah.biayaOperasional : 0;
    let hppDipakai = null;

    if (terkunci) {
      // Tidak ada padanan master -> HPP tak bisa dihitung. Kolom angka
      // DIKOSONGKAN, bukan dikarang. Kolom E yang kebetulan terisi
      // dilaporkan di hppKolomTersedia supaya bisa ditinjau manual.
      flag = FLAG_DIKECUALIKAN;
      sumberHppQ = SUMBER_TIDAK_ADA;
      revisiModal = '';
      revisiLaba = '';
    } else if (o.sumberHpp === 'kolom-E') {
      // HPP terekam di baris itu. TAPI kalau produknya sudah punya
      // keputusan pemilik dan angka kolom E berbeda, kolom E yang
      // dikoreksi - bukan Conversely. Kolom K/M tetap dibiarkan utuh.
      const dibantah = keputusan !== null && kolomE !== null && kolomE !== keputusan.hpp;
      if (dibantah) {
        flag = FLAG_KOREKSI;
        sumberHppQ = SUMBER_KOREKSI;
        hppDipakai = keputusan.hpp;
        koreksi = {
          hppKolomE: kolomE,
          hppDikonfirmasi: keputusan.hpp,
          jumlah: jumlah,
          totalHarga: totalHarga,
          biayaOperasional: biayaOperasional,
          tanggalKeputusan: keputusan.tanggalKeputusan,
          sumberKeputusan: keputusan.sumber,
          alasan: keputusan.alasan || null
        };
      } else {
        flag = FLAG_TERCATAT;
        sumberHppQ = SUMBER_TERCATAT;
        hppDipakai = o.sesudah.hppSatuan;
      }
      if (jumlah !== null && hppDipakai !== null) {
        revisiModal = _bulat(jumlah * hppDipakai);
        revisiLaba = (totalHarga !== null) ? _bulat(totalHarga - revisiModal - biayaOperasional) : '';
      } else {
        revisiModal = '';
        revisiLaba = '';
      }
    } else {
      flag = FLAG_ESTIMASI;
      sumberHppQ = SUMBER_ESTIMASI;
      hppDipakai = o.sesudah.hppSatuan;
      revisiModal = o.sesudah.modal;
      revisiLaba = o.sesudah.labaBersih;
      const b = (o.produkMaster && !keputusan) ? bukti[o.produkMaster] : null;
      if (b) {
        const t = _kunciTanggal(o.tanggal);
        if (t !== null && (b.tanggalBukti === null || t < b.tanggalBukti)) {
          curiga = true;
          // Isi kolom R. Teks bebas, BUKAN angka hasil hitung — supaya
          // kolom R bisa disaring/diurutkan tanpa merusak kolom angka.
          catatanEstimasi = o.produkMaster + ': HPP master (' + b.hppMaster + ') berbeda dari yang TERCATAT ' +
            'di baris ' + b.barisBukti + ' (' + b.hppTerekam + '). Baris ini memakai HPP master, jadi Modal ' +
            'revisi kemungkinan meleset. Perlu dikonfirmasi manual.';
        }
      }
    }

    if (curiga) ringkasan.curigaHppBerbeda++;
    if (catatanEstimasi !== '') ringkasan.denganCatatan++;
    ringkasan[flag === FLAG_TERCATAT ? 'tercatat' : flag === FLAG_KOREKSI ? 'koreksi'
      : flag === FLAG_ESTIMASI ? 'estimasi' : 'dikecualikan']++;
    ringkasan.totalBaris++;

    const pf = rekonsiliasi.perFlag[flag];
    pf.n++;
    if (flag !== FLAG_DIKECUALIKAN) rekonsiliasi.targetBaris++;
    pf.sigmaModalBaru += num(revisiModal);
    pf.sigmaLabaBaru += num(revisiLaba);
    pf.sigmaModalSheet += num(o.sebelum.modalSheet);
    pf.sigmaLabaSheet += num(o.sebelum.labaSheet);

    barisRencana.push({
      barisSheet: o.barisSheet,
      id: o.id,
      tanggal: o.tanggal,
      namaProduk: o.namaProduk,
      produkMaster: o.produkMaster,
      status: o.status,
      flag: flag,
      kolomBaru: KOLOM_STAGING,
      nilai: {
        revisiModal: revisiModal,
        revisiLaba: revisiLaba,
        sumberHpp: sumberHppQ,
        curigaHppBerbeda: curiga,
        // Isi kolom R. String kosong = sel R dibiarkan kosong, bukan
        // diisi 0/- yang bisa salah dibaca sebagai "catatan ada".
        catatanEstimasi: catatanEstimasi,
        // Bahan baku verifikasi mandiri: writer boleh menghitung ulang
        // N & O dari angka-angka ini, bukan sekadar memercayai rencana.
        hppDipakai: hppDipakai,
        jumlah: jumlah,
        totalHarga: totalHarga,
        biayaOperasional: biayaOperasional
      },
      // null kecuali flag KOREKSI: dari angka mana -> ke angka mana.
      koreksi: koreksi,
      sebelum: {
        modal: o.sebelum.modalSheet,
        laba: o.sebelum.labaSheet,
        hppSatuanKolom: o.sebelum.hppKolom
      },
      hppKolomTersedia: o.hppKolomTersedia !== undefined ? o.hppKolomTersedia : null,
      alasan: o.alasan || null
    });
  }

  for (const nama of Object.keys(bukti)) {
    daftarProdukBukti.push({
      produkMaster: nama,
      hppMaster: bukti[nama].hppMaster,
      hppTerekam: bukti[nama].hppTerekam,
      barisBukti: bukti[nama].barisBukti
    });
  }

  for (const f of URUTAN_FLAG) {
    const pf = rekonsiliasi.perFlag[f];
    rekonsiliasi.totalBaris += pf.n;
    rekonsiliasi.sigmaModalBaru += pf.sigmaModalBaru;
    rekonsiliasi.sigmaLabaBaru += pf.sigmaLabaBaru;
    rekonsiliasi.sigmaModalSheet += pf.sigmaModalSheet;
    rekonsiliasi.sigmaLabaSheet += pf.sigmaLabaSheet;
  }
  rekonsiliasi.deltaModal = rekonsiliasi.sigmaModalBaru - rekonsiliasi.sigmaModalSheet;
  rekonsiliasi.deltaLaba = rekonsiliasi.sigmaLabaBaru - rekonsiliasi.sigmaLabaSheet;

  return {
    baris: barisRencana,
    ringkasan: ringkasan,
    rekonsiliasi: rekonsiliasi,
    produkHppMasterBerbeda: daftarProdukBukti,
    kolomBaru: KOLOM_STAGING,
    headerKolomBaru: HEADER_STAGING,
    keputusanHppPemilik: KEPUTUSAN_HPP_PEMILIK
  };
}

/**
 * Rencana backfill kolom baru N..R — DRY-RUN, TIDAK menulis apa pun.
 * `arg` diteruskan ke _hitungRencanaHistori (angka = jumlah baris terakhir
 * yang dirinci; [dari, sampai] = nomor baris sheet).
 */
function rencanaBackfillKolomBaru(arg) {
  const log = [];
  const cetak = (o) => { const s = JSON.stringify(o); log.push(s); Logger.log(s); };

  const h = _hitungRencanaHistori(arg);
  if (!h.ok) { cetak({ status: 'error', pesan: h.pesan }); return log; }

  const r = _hitungRencanaKolomBaru(h);
  for (const b of r.baris) cetak(b);

  cetak({
    RENCANA: {
      mode: 'dry-run',
      menulis: false,
      kolomBaru: r.kolomBaru,
      headerKolomBaru: r.headerKolomBaru,
      kolomYangDisentuh: 'N,O,P,Q,R',
      kolomUtuh: 'A..M (tidak ditimpa)',
      keputusanHppPemilik: r.keputusanHppPemilik,
      ringkasan: r.ringkasan,
      rekonsiliasi: r.rekonsiliasi,
      produkHppMasterBerbeda: r.produkHppMasterBerbeda
    }
  });
  return log;
}

// ════════════════════════════════════════════════════════════════
// PEMBUNGKUS TANPA PARAMETER — untuk dropdown "function" di editor
// Apps Script (fungsi berparameter tidak bisa dipilih di sana).
// Ketiganya READ-ONLY; hanya meneruskan ke fungsi utama.
// ════════════════════════════════════════════════════════════════

/** Periksa transaksi BARU FR-1790566607168 (Modal tampil Rp0). */
function cekModalTransaksiBaru() {
  return diagnostikModalTerakhir('FR-1790566607168');
}

/** Periksa transaksi LAMA FR-1790513368295 (cetak kolom A-M mentah). */
function cekModalTransaksiLama() {
  return diagnostikModalTerakhir('FR-1790513368295');
}

/** Rencana backfill historis (dry-run): ringkasan + baris non-ok. */
function cekRencanaBackfill() {
  return rencanaBackfillHistori();
}