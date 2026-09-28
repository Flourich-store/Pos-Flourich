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
//   ambilKolomAngka, hitungVolumeMl, formatVolumeMl,
//   selaraskanNamaProduk, getSpreadsheet,
//   PETA_KOLOM_PENJUALAN, PETA_KOLOM_PRODUK
// ════════════════════════════════════════════════════════════════

/**
 * Parsing angka toleran format Indonesia:
 *   - "Rp 12.000" / "12.000"  -> 12000    (titik = pemisah ribuan)
 *   - "1.234,56"              -> 1234.56  (koma = desimal)
 *   - "10,5"                  -> 10.5
 *   - "10500"                 -> 10500
 * @param {*} v nilai mentah sel
 * @return {number} NaN bila tidak bisa diurai sama sekali.
 * Catatan konteks: nilai harga/HPP di POS ini utuh (rupiah), jadi
 * titik tunggal dianggap pemisah ribuan, bukan desimal.
 */
function parseAngkaToleran(v) {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  let s = String(v).trim();
  if (s === '') return NaN;
  s = s.replace(/[Rp\s]/gi, '');
  const adaTitik = s.indexOf('.') !== -1;
  const adaKoma = s.indexOf(',') !== -1;
  if (adaKoma) {
    const bagian = s.split(',');
    const utuh = bagian[0].replace(/\./g, '');
    const pecahan = bagian.slice(1).join('');
    s = utuh + (pecahan ? '.' + pecahan : '');
  } else if (adaTitik) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

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
 */
function _perluRemap(row) {
  if (!row) return false;
  const txt = (x) => String(x == null ? '' : x).trim();
  return txt(row[11]) === '' && txt(row[12]) === '';
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

  const bulatkan = (x) => (Math.abs(x - Math.round(x)) < 0.01 ? Math.round(x) : x);
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
      perluRemap: remap ? 'YA (kolom L&M kosong = ditulis writer lama)' : 'TIDAK (kolom L&M terisi = kode baru)',
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
function rencanaBackfillHistori(arg) {
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
  const bulatkan = (x) => (Math.abs(x - Math.round(x)) < 0.01 ? Math.round(x) : x);

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
    return { era, id: txt(ambilKolom(row, petaJ, 'id', '')),
      tanggal: _fmt(ambilKolom(row, petaJ, 'tanggal', ''), tz),
      nama: txt(ambilKolom(row, petaJ, 'namaProduk', '')),
      jumlah: ambilKolomAngka(row, petaJ, 'jumlah', 0),
      totalHarga: ambilKolomAngka(row, petaJ, 'totalHarga', 0),
      metode: txt(ambilKolom(row, petaJ, 'metode', '')),
      uangDibayar: ambilKolomAngka(row, petaJ, 'uangDibayar', 0),
      uangKembali: ambilKolomAngka(row, petaJ, 'uangKembali', 0),
      modalLama: (() => { const n = parseAngkaToleran(ambilKolom(row, petaJ, 'modal', '')); return Number.isFinite(n) ? n : NaN; })(),
      biayaOp: ambilKolomAngka(row, petaJ, 'biayaOperasional', 0),
      labaLama: ambilKolom(row, petaJ, 'labaBersih', ''),
      volumeKolom: formatVolumeMl(ambilKolom(row, petaJ, 'volumeMl', '')),
      hppKolom: ambilKolomAngka(row, petaJ, 'hppSatuan', 0),
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
    layout_tergeser: 0, produk_tidak_ditemukan: 0, hpp_tidak_tersedia: 0,
    contohOk: [], daftarProdukTidakDitemukan: [] };
  const barisNonOk = [];

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
    const modalBaru = (Number.isFinite(b.jumlah) && hppAngka != null) ? bulatkan(b.jumlah * hppAngka) : null;
    const labaBaru = (Number.isFinite(b.totalHarga) && modalBaru != null) ? bulatkan(b.totalHarga - modalBaru) : null;

    const o = {
      barisSheet: barisSheet,
      era: b.era,
      perluRemap: _perluRemap(row) ? 'YA' : 'TIDAK',
      id: b.id,
      namaProduk: b.nama,
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
        hppSatuan: hppAngka,
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
      if (ringkasan.daftarProdukTidakDitemukan.length < 20) ringkasan.daftarProdukTidakDitemukan.push(b.nama);
      ringkasan.produk_tidak_ditemukan++;
    } else if (hppRaw === '' || hppRaw == null || hppAngka === null) {
      status = 'hpp-tidak-tersedia';
      o.alasan = 'HPP master kosong/teks — tidak bisa dihitung ulang sampai kolom HPP diisi.';
      ringkasan.hpp_tidak_tersedia++;
    } else if (_perluRemap(row)) {
      status = 'layout-tergeser';
      o.alasan = 'Kolom L&M kosong (writer lama) — seluruh baris ditulis ulang ke 13 kolom + Modal/Laba dihitung ulang.';
      ringkasan.layout_tergeser++;
    } else if (Number.isFinite(b.modalLama) && b.modalLama !== modalBaru) {
      status = 'perbaiki-modal';
      o.alasan = 'Modal sheet (' + b.modalLama + ') != Jumlah x HPP (' + modalBaru + ') — dihitung ulang.';
      ringkasan.perbaiki_modal++;
    } else {
      status = 'ok-tanpa-perubahan';
      ringkasan.ok_tanpa_perubahan++;
      if (ringkasan.contohOk.length < 2) ringkasan.contohOk.push({ barisSheet: barisSheet, id: b.id });
    }
    o.status = status;
    ringkasan.totalBaris++;

    if (status !== 'ok-tanpa-perubahan' || mode === 'detail') {
      barisNonOk.push(o);
    }
  }
  ringkasan.barisNonOk = barisNonOk.length;

  // Output. Mode ringkas: ringkasan + baris non-ok (di-cap BATAS_RINCI)
  // supaya tidak melebihi batas log untuk 523 baris. Sisanya lewat
  // rencanaBackfillHistori([dari, sampai]).
  cetak({ RINGKASAN: ringkasan });
  let dicetak = 0;
  for (const o of barisNonOk) {
    if (mode === 'ringkas' && dicetak >= BATAS_RINCI) break;
    cetak(o);
    dicetak++;
  }
  if (barisNonOk.length > dicetak) {
    cetak({ info: 'Masih ada ' + (barisNonOk.length - dicetak) + ' baris non-ok belum dicetak rinci. ' +
      'Panggil rencanaBackfillHistori([dari, sampai]) untuk melihat rentang berikutnya.' });
  }
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