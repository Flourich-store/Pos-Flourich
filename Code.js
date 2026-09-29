/*************************************************
 * FLOU RICH POS
 * Code.gs
 * Version : 1.0 Final
 *************************************************/

/**
 * Menampilkan halaman utama (POS-only entrypoint) + API GET (fallback jaringan).
 * - Tanpa parameter ?action=...  -> sajikan halaman web app (HTML, perilaku asli).
 * - Dengan ?action=...           -> API JSON (aksi baca saja; aksi tulis ditolak).
 * Penting: hindari routing page=dashboard di file POS agar login POS tidak bentrok.
 */
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const action = String(params.action || '').trim();

  // === Mode API GET (fallback jaringan) ===
  if (action) {
    try {
      // Pengaman: aksi tulis TIDAK BOLEH lewat GET (mencegah transaksi ganda via
      // URL yang ter-catat di history/refresh, dan menjaga aksi tetap idempoten).
      if (AKSI_TULIS.indexOf(action) !== -1) {
        throw new Error('Aksi "' + action + '" hanya diizinkan lewat POST (keamanan transaksi).');
      }
      const requestData = sisipkanKoneksiIdDariQuery({
        action: action,
        args: params.args ? JSON.parse(params.args) : []
      }, e);
      return ContentService.createTextOutput(JSON.stringify(eksekusiAksi(requestData)))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (error) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: error && error.message ? error.message : String(error)
      }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // === Mode halaman web app (perilaku asli) ===
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('FLOU RICH - POS')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}// Router aksi bersama: dipakai doPost DAN doGet (fallback jaringan).
// Hanya aksi yang TIDAK mengubah data yang boleh lewat doGet — aksi tulis
// (prosesCheckout, tambahStokProduk, dsb.) WAJIB lewat POST.
const AKSI_TULIS = ['prosesCheckout', 'tambahStokProduk'];

// Ambil koneksiId dari payload frontend (idempotensi transaksi offline).
// Nilai dibersihkan: dibatasi 100 karakter, hanya alfanumerik + '-' + '_'.
// (Bukan sanitasi keamanan — spreadsheet menerima string apa pun — melainkan
// normalisasi agar kunci idempotensi konsisten.)
function ambilKoneksiId(requestData) {
  const raw = requestData && requestData.koneksiId != null ? String(requestData.koneksiId) : '';
  // Bersihkan DULU baru potong, agar dua varian input yang "setara" selalu
  // menghasilkan kunci idempotensi yang identik.
  const bersih = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  return bersih || null;
}

function eksekusiAksi(requestData) {
  const action = String(requestData.action || '').trim();
  const args = Array.isArray(requestData.args) ? requestData.args : [];

  // koneksiId tidak pernah sampai ke fungsi backend — dipakai khusus oleh
  // prosesCheckout untuk idempotensi, diambil via ambilKoneksiId(requestData).

  if (!action) {
    throw new Error('Action tidak ditemukan.');
  }

  let result;
  if (action === 'ping') {
    // Probe latensi paling ringan: TANPA menyentuh spreadsheet sama sekali —
    // murni mengukur jalan pulang-pergi HTTP + eksekusi skrip. Dipakai halaman
    // status untuk memantau kapan Google sedang lambat (routing internal),
    // terpisah dari beban data aplikasi.
    result = ping();
  } else if (action === 'getInitialData') {
    // Baca berulang (login/sinkron berkala multi-perangkat) memakai cache 60 dtk;
    // dibuang paksa setiap aksi tulis (lihat buangCacheAwal).
    result = getInitialDataBerCache.apply(null, args);
  } else if (action === 'checkLogin') {
    result = checkLoginBerCache.apply(null, args);
  } else {
    const backendFunction = globalThis[action] || this[action];
    if (typeof backendFunction !== 'function') {
      throw new Error('Fungsi ' + action + ' tidak tersedia.');
    }
    // prosesCheckout menerima requestData sebagai argumen ke-4 (koneksiId untuk
    // idempotensi antrian offline). Aksi lain tidak berubah.
    if (action === 'prosesCheckout') {
      result = backendFunction.apply(null, args.concat([requestData]));
    } else {
      result = backendFunction.apply(null, args);
    }
  }

  return result;
}

/**
 * Jalankan fn di bawah kunci tulis script-wide (LockService, v81).
 * Mencegah dua checkout/tambah-stok yang tiba BERSAMAAN dari perangkat berbeda
 * membaca stok yang sama lalu saling menimpa (race condition multi-perangkat —
 * jaringan mobile yang lambat memperbesar peluang tumpang-tindih). Lock menunggu
 * maks 20 dtk; bila tidak diperoleh, fn tetap dijalankan TANPA lock agar
 * transaksi kasir tidak pernah diblokir hanya karena lock.
 */
function denganKunciTulis(fn) {
  let kunci = null;
  try {
    kunci = LockService.getScriptLock();
  } catch (e) {
    kunci = null; // LockService tidak tersedia (mis. lingkungan uji)
  }
  let pegang = false;
  if (kunci && typeof kunci.tryLock === 'function') {
    try { pegang = kunci.tryLock(20000); } catch (e) { pegang = false; }
  }
  if (!pegang) {
    Logger.log('denganKunciTulis: lock tidak diperoleh, lanjut tanpa lock.');
    return fn();
  }
  try {
    return fn();
  } finally {
    try { kunci.releaseLock(); } catch (e) { }
  }
}

// prosesCheckout & tambahStokProduk dieksekusi berurutan di bawah kunci tulis
// (fungsi inti di-rename dengan akhiran "Inti"; deklarasi function hoist
// sehingga wrapper boleh didefinisikan sebelum intinya).
function prosesCheckout(cart, metode, uangDibayar, requestData) {
  return denganKunciTulis(function () {
    return prosesCheckoutInti(cart, metode, uangDibayar, requestData);
  });
}

function tambahStokProduk(idProduk, qtyTambah, role) {
  return denganKunciTulis(function () {
    return tambahStokProdukInti(idProduk, qtyTambah, role);
  });
}

// Salin koneksiId dari query string (?koneksiId=...) ke requestData sebelum
// diteruskan ke eksekusiAksi, agar idempotensi juga bekerja di jalur GET.
function sisipkanKoneksiIdDariQuery(requestData, e) {
  const dariQuery = e && e.parameter && e.parameter.koneksiId;
  if (dariQuery && !requestData.koneksiId) {
    requestData.koneksiId = String(dariQuery);
  }
  return requestData;
}

function doPost(e) {
  try {
    const rawBody = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const requestData = JSON.parse(rawBody);
    return ContentService.createTextOutput(JSON.stringify(eksekusiAksi(sisipkanKoneksiIdDariQuery(requestData, e))))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error && error.message ? error.message : String(error)
    }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Probe kesehatan paling ringan untuk halaman status: tidak membaca/menulis
 * sheet, tidak menyentuh kuota data — cukup untuk mengukur latency jalan
 * pulang-pergi ke endpoint (yang dominan ditentukan routing Google).
 */
function ping() {
  return {
    status: 'success',
    pong: true,
    waktu: new Date().getTime()
  };
}

/**
 * Wrapper checkLogin dengan ingatan sukses (CacheService, 120 detik):
 * - Sukses → catat penanda per-username, kembalikan apa adanya.
 * - Gagal → bila penanda sukses ADA (berarti kredensial username ini pernah
 *   benar beberapa saat lalu), coba SEKALI lagi sebelum menyerah — menolong
 *   kasir dari kegagalan baca User sheet sesaat (terasa sebagai "password
 *   salah" padahal kredensial benar). Percobaan ulang TETAP memvalidasi
 *   kredensial penuh — tidak ada pintas keamanan.
 */
function checkLoginBerCache(username, password) {
  const hasil = checkLogin(username, password);
  if (hasil && hasil.status === true) {
    try {
      const cache = CacheService.getScriptCache();
      if (cache && typeof cache.put === 'function') {
        cache.put('pos_login_' + String(username || '').trim().toLowerCase(), '1', 120);
      }
    } catch (e) { }
    return hasil;
  }
  let penandaSukses = false;
  try {
    const cache = CacheService.getScriptCache();
    if (cache && typeof cache.get === 'function') {
      penandaSukses = cache.get('pos_login_' + String(username || '').trim().toLowerCase()) === '1';
    }
  } catch (e) { }
  if (penandaSukses) {
    Logger.log('checkLogin: gagal padahal sukses baru saja — coba sekali lagi (kemungkinan baca sheet sesaat gagal).');
    const ulang = checkLogin(username, password);
    if (ulang && ulang.status === true) return ulang;
  }
  return hasil;
}

/**
 * Login POS
 * OPTIMASI: login sukses SEKALIGUS mengembalikan data awal (produk + penjualan
 * terbaru) dalam respons yang sama — frontend tidak perlu roundtrip kedua
 * (getInitialData) yang menambah satu kali overhead HTTP/cold start Apps Script
 * (bisa belasan detik di jaringan lambat).
 */
function checkLogin(username, password) {

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName("User");

  if (!sheet) return { status: false, message: "Sheet User tidak ditemukan" };

  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {

    const user = String(data[i][0]).trim();
    const pass = String(data[i][1]).trim();

    if (
      user === String(username).trim() &&
      pass === String(password).trim()
    ) {
      // Data awal ikut dalam respons login = 1 roundtrip (bukan 2).
      // Bila gagal (sheet bermasalah), kirim tanpa dataAwal — frontend
      // otomatis memakai jalur getInitialData terpisah.
      let dataAwal = null;
      try {
        // Lewat cache 60 dtk: login perangkat kedua/ketiga dalam semenit tidak
        // membaca ulang sheet Produk + Penjualan (instan, beban sheet turun).
        dataAwal = getInitialDataBerCache(60);
      } catch (dataErr) {
        Logger.log("checkLogin: gagal memuat data awal (frontend akan fallback): " + dataErr);
      }
      return {
        status: true,
        username: user,
        role: data[i][2] || "KASIR",
        dataAwal: dataAwal
      };
    }

  }

  return { status: false, message: "Username atau password salah" };
}



// ID Folder Google Drive untuk Foto Produk
const FOLDER_FOTO_ID = "1l6nzRw-zHCuSlE7tFfl1xPTFvvZZn_sU";

/**
 * Membaca daftar foto dari folder Google Drive secara otomatis (Read-Only)
 */
function getDrivePhotoList() {
  const filesList = [];
  try {
    const folder = DriveApp.getFolderById(FOLDER_FOTO_ID);
    const files = folder.getFiles();

    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();
      const fileId = file.getId();
      // Gunakan URL CDN LH3 Google yang langsung dapat dirender di tag img
      const directUrl = "https://lh3.googleusercontent.com/d/" + fileId;

      // Bersihkan nama file: hilangkan ekstensi (.png, .jpg, .jpeg, .webp, dll)
      const baseName = fileName.replace(/\.[^/.]+$/, "").trim();
      const cleanName = baseName.toLowerCase().replace(/[^a-z0-9]/g, "");

      filesList.push({
        fileName: fileName,
        baseName: baseName.toLowerCase(),
        cleanName: cleanName,
        fileId: fileId,
        url: directUrl
      });
    }
  } catch (err) {
    Logger.log("Info/Error getDrivePhotoList: " + err);
  }
  return filesList;
}

/**
 * Mencocokkan foto untuk produk berdasarkan Kolom "Nama Produk" di Spreadsheet
 * Contoh: file "Semangci 250 ml.png" dicocokkan dengan produk "Semangci 250 ml"
 */
function matchPhotoForProduct(id, nama, photoList) {
  if (!photoList || photoList.length === 0) return '';

  const rawNama = String(nama || '').trim();
  const lowerNama = rawNama.toLowerCase();
  const cleanNama = lowerNama.replace(/[^a-z0-9]/g, '');

  const rawId = String(id || '').trim();
  const cleanId = rawId.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. Exact match Nama Produk (misal "semangci 250 ml" === "semangci 250 ml")
  for (let i = 0; i < photoList.length; i++) {
    const f = photoList[i];
    if (lowerNama && f.baseName === lowerNama) return f.url;
  }

  // 2. Exact match cleanName (menghapus spasi/tanda baca: "semangci250ml" === "semangci250ml")
  for (let i = 0; i < photoList.length; i++) {
    const f = photoList[i];
    if (cleanNama && f.cleanName === cleanNama) return f.url;
    if (cleanId && f.cleanName === cleanId) return f.url;
  }

  // 3. Substring / Prefix match (misal "Semangci 250 ml" vs "Semangci" atau "Wonapel 250 ml" vs "Wonapel")
  for (let i = 0; i < photoList.length; i++) {
    const f = photoList[i];
    if (cleanNama.length >= 3 && f.cleanName.length >= 3) {
      if (cleanNama.includes(f.cleanName) || f.cleanName.includes(cleanNama)) {
        return f.url;
      }
    }
  }

  // 4. Token / kata demi kata
  const words = lowerNama.split(/[\s_-]+/);
  for (let w of words) {
    const cleanW = w.replace(/[^a-z0-9]/g, '');
    if (cleanW.length >= 3) {
      for (let i = 0; i < photoList.length; i++) {
        const f = photoList[i];
        if (f.cleanName.includes(cleanW) || cleanW.includes(f.cleanName)) {
          return f.url;
        }
      }
    }
  }

  return '';
}

/**
 * Ambil Data Produk (Foto otomatis terpasang dari Drive / Spreadsheet)
 */
function getProdukData() {

  const sheet = getSpreadsheet().getSheetByName("Produk");

  if (!sheet) {
    return [['id', 'nama', 'stok', 'harga', 'foto_url']];
  }

  const data = sheet.getDataRange().getValues();

  if (data.length === 0) {
    return [headerProdukPayload()];
  }

  // Ambil daftar foto dari Google Drive secara otomatis
  const photoList = getDrivePhotoList();

  const peta = petaKolomProdukSheet(sheet);
  const iFoto = peta.col.foto_url;
  if (iFoto === undefined) {
    Logger.log('getProdukData: kolom foto_url tidak ditemukan di header sheet Produk: ' +
      JSON.stringify(peta.header));
  }

  // Pastikan header memiliki kolom foto_url (posisi TIDAK diasumsikan —
  // cari kolom kosong pertama setelah kolom yang sudah terisi).
  if (iFoto === undefined) {
    try {
      let kosong = peta.header.length;
      for (let c = 0; c < peta.header.length; c++) {
        if (peta.header[c] === '') { kosong = c + 1; break; }
      }
      if (kosong < 1) kosong = 5;
      sheet.getRange(1, kosong).setValue("foto_url");
    } catch (e) { }
  }

  // Setiap row dibaca lewat peta header; payload selalu punya 7 kolom
  // (id, nama, stok, harga, foto_url, hpp, volume_ml) supaya frontend
  // tidak perlu tahu posisi kolom di sheet.
  const result = [headerProdukPayload()];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const id = String(ambilKolom(row, peta, 'id', '') || '').trim();
    const nama = String(ambilKolom(row, peta, 'nama', '') || '').trim();
    // P2: angka di sheet boleh tersimpan sebagai TEKS format id-ID
    // ("10.500", "Rp 12.000"). Number() akan memotong jadi 10.5, jadi
    // stok/harga/HPP harus dibaca dengan parser toleran. Payload ini
    // di-carry frontend ke keranjang lalu ikut ke prosesCheckout.
    const stok = ambilKolomAngkaToleran(row, peta, 'stok', 0);
    const harga = ambilKolomAngkaToleran(row, peta, 'harga', 0);
    let fotoUrl = String(ambilKolom(row, peta, 'foto_url', '') || '').trim();
    const hpp = ambilKolomAngkaToleran(row, peta, 'hpp', 0);

    let volumeMl = ambilKolom(row, peta, 'volume_ml', '');
    if (volumeMl === '' || volumeMl == null) volumeMl = hitungVolumeMl(nama);

    // Cocokkan foto dari Google Drive berdasarkan Nama Produk
    const kosongDiSheet = !String(ambilKolom(row, peta, 'foto_url', '') || '').trim();
    const matchedDriveUrl = matchPhotoForProduct(id, nama, photoList);
    if (matchedDriveUrl) {
      fotoUrl = matchedDriveUrl;
      // Auto simpan ke spreadsheet HANYA kalau selnya masih kosong — URL yang
      // sudah diisi manual tidak boleh ditimpa tebakan pencocokan.
      if (kosongDiSheet && iFoto !== undefined) {
        try {
          sheet.getRange(i + 1, iFoto + 1).setValue(fotoUrl);
        } catch (e) { }
      }
    }

    result.push([
      id,
      nama,
      stok,
      harga,
      fotoUrl,
      hpp,
      formatVolumeMl(volumeMl)
    ]);
  }

  return result;

}

/**
 * Tambah Stok
 */
function tambahStokProdukInti(idProduk, qtyTambah, role) {

  // Enforce permission on server side
  if (role !== 'SUPER_ADMIN' && role !== 'KASIR') {
    return 'Anda tidak memiliki hak akses untuk menambah stok.';
  }

  qtyTambah = Number(qtyTambah);

  if (qtyTambah <= 0 || !Number.isFinite(qtyTambah)) {
    return "Jumlah stok harus lebih dari 0.";
  }


  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName("Produk");

  if (!sheet) {
    return "Sheet Produk tidak ditemukan.";
  }

  const data = sheet.getDataRange().getValues();

  if (!Array.isArray(data) || data.length < 2) {
    return "Data produk tidak terbaca dari sheet.";
  }

  const peta = petaKolomProdukSheet(sheet);
  if (peta.col.id === undefined || peta.col.stok === undefined) {
    return "Header sheet Produk tidak lengkap (butuh kolom '" +
      (peta.col.id === undefined ? 'ID Produk' : '') +
      (peta.col.id === undefined && peta.col.stok === undefined ? "' dan '" : "'") +
      (peta.col.stok === undefined ? 'Stok' : '') + "').";
  }

  for (let i = 1; i < data.length; i++) {

    // trim() agar ID dengan spasi tak sengaja tetap cocok
    if (String(ambilKolom(data[i], peta, 'id', '')).trim() === String(idProduk).trim()) {

      const stok = ambilKolomAngka(data[i], peta, 'stok', 0) + qtyTambah;

      sheet.getRange(i + 1, peta.col.stok + 1).setValue(stok);

      // Cache payload baca tidak lagi valid (stok berubah di sheet).
      buangCacheAwal();

      return "Berhasil menambah stok " +
        ambilKolom(data[i], peta, 'nama', '') +
        " sebanyak " +
        qtyTambah;

    }

  }

  return "ID Produk tidak ditemukan.";

}

/**
 * Ambil Riwayat Penjualan.
 *
 * SEMUA kolom diambil lewat NAMA HEADER (lihat PETA_KOLOM_PENJUALAN),
 * bukan index tetap. Versi lama memakai `getRange(..., 11)` + posisi
 * 3/4/8/9/10 yang jatuh ke kolom yang salah begitu sheet jadi 13 kolom.
 * Baris data yang panjangnya BEDA dengan header juga sudah tidak mungkin
 * terjadi: setiap baris disusun dari peta yang sama.
 */
function getPenjualanData() {

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName("Penjualan");
  const headerPayload = headerPenjualanPayload();

  if (!sheet) {
    return [headerPayload];
  }

  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return [headerPayload];
  }

  const peta = petaKolomPenjualanSheet(sheet);
  catatPetaPeringatan('getPenjualanData', peta);

  const maxCols = Math.max(sheet.getMaxColumns ? sheet.getMaxColumns() : 0, 13);
  const data = sheet.getRange(1, 1, lastRow, maxCols).getValues();

  const hasil = [headerPayload];
  const timezone = ss.getSpreadsheetTimeZone();

  for (let i = 1; i < data.length; i++) {

    const row = data[i];

    if (row[0] == "" || row[1] == "") continue;

    const tanggal = formatTanggalRow(ambilKolom(row, peta, 'tanggal', ''), timezone);

    hasil.push([
      String(ambilKolom(row, peta, 'id', '')),                                    // ID Transaksi
      tanggal,                                                                    // Tanggal
      ambilKolomTeks(row, peta, 'namaProduk', ''),                                // Nama Produk
      formatVolumeMl(ambilKolom(row, peta, 'volumeMl', '')),                      // Volume (ml)
      ambilKolomAngkaAtauKosong(row, peta, 'hppSatuan'),                         // HPP Satuan (kosong = HPP tak terbaca)
      ambilKolomAngka(row, peta, 'jumlah', 0),                                    // Jumlah
      ambilKolomAngka(row, peta, 'totalHarga', 0),                                // Total Harga
      ambilKolomTeks(row, peta, 'metode', ''),                                    // Metode Pembayaran
      ambilKolomAngka(row, peta, 'uangDibayar', 0),                               // Uang Dibayar
      ambilKolomAngka(row, peta, 'uangKembali', 0),                               // Uang Kembali
      ambilKolomAngkaAtauKosong(row, peta, 'modal'),                              // Modal (kosong = tidak dihitung)
      ambilKolomAngkaAtauKosong(row, peta, 'biayaOperasional'),                   // Biaya Operasional
      ambilKolomAngkaAtauKosong(row, peta, 'labaBersih')                          // Laba Bersih
    ]);

  }

  return hasil;

}

/**
 * ============================================================
 * getInitialData()
 * Mengambil SELURUH data (Produk + Penjualan) dalam SATU kali
 * eksekusi. Spreadsheet hanya dibuka satu kali.
 * Mengurangi jumlah google.script.run dari 2 menjadi 1.
 * ============================================================
 */
/**
 * Cache pendek (60 detik) untuk payload pembacaan berulang (getInitialData).
 *
 * Ukuran live: login kasir = checkLogin yang di dalamnya memanggil
 * getInitialData(60) — membaca sheet Produk + jendela 60 baris Penjualan.
 * Beberapa perangkat kasir + sinkronisasi berkala dapat memanggil ini berkali-
 * kali dalam semenit; cache membuat panggilan berulang selesai hampir instan
 * (bukan membaca ulang seluruh sheet).
 *
 * Keamanan data: cache HANYA untuk aksi baca, TTL 60 detik, dan DIBUANG paksa
 * setiap kali prosesCheckout / tambahStokProduk menulis ke sheet (buangCacheAwal)
 * — jadi stok/riwayat di layar tidak pernah basi oleh cache.
 * CacheService tidak tersedia (mock uji / lingkungan terbatas) → fallback aman:
 * lewat saja (perilaku sama seperti sebelumnya, tanpa cache).
 */
var KUNCI_CACHE_AWAL = 'pos_awal_v1';
var TTL_CACHE_AWAL = 60; // detik

function bacaCacheAwal() {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache || typeof cache.get !== 'function') return null;
    const raw = cache.get(KUNCI_CACHE_AWAL);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && Array.isArray(parsed.produk) && Array.isArray(parsed.penjualan)) ? parsed : null;
  } catch (e) {
    return null; // cache korup/tidak tersedia → abaikan
  }
}

function simpanCacheAwal(payload) {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache || typeof cache.put !== 'function') return;
    cache.put(KUNCI_CACHE_AWAL, JSON.stringify(payload), TTL_CACHE_AWAL);
  } catch (e) {
    // Payload > 100KB atau cache tidak tersedia → lewati, jangan gagalkan request
  }
}

function buangCacheAwal() {
  try {
    const cache = CacheService.getScriptCache();
    if (cache && typeof cache.remove === 'function') cache.remove(KUNCI_CACHE_AWAL);
  } catch (e) { }
}

/**
 * Wrapper getInitialData dengan cache baca 60 detik.
 * HASIL IDENTIK dengan getInitialData biasa — hanya lebih cepat untuk
 * panggilan berulang dalam semenit.
 */
function getInitialDataBerCache(limitPenjualan) {
  const hit = bacaCacheAwal();
  if (hit) return hit;
  const hasil = getInitialData(limitPenjualan);
  if (hasil && Array.isArray(hasil.produk) && Array.isArray(hasil.penjualan)) {
    simpanCacheAwal(hasil);
  }
  return hasil;
}

function getInitialData(limitPenjualan) {
  const ss = getSpreadsheet();
  const timezone = ss.getSpreadsheetTimeZone();

  // Batasi jumlah baris riwayat yang dikirim ke klien (baris TERBARU dulu).
  // Riwayat penuh (bisa ribuan baris) membuat payload membengkak & refresh lambat;
  // POS hanya menampilkan halaman terbaru di layar.
  limitPenjualan = Number(limitPenjualan);
  if (!Number.isFinite(limitPenjualan) || limitPenjualan <= 0) limitPenjualan = 60;

  // ─── 1. PRODUK DATA (batch getValues) ───
  const shProduk = ss.getSheetByName("Produk");
  // Kolom HPP & volume_ml dibaca lewat NAMA HEADER, bukan posisi. Sheet Produk
  // live punya header "ID Produk","Nama Produk","Stok","Harga","foto_url","HPP"
  // — nama kolomnya TIDAK sama dengan header payload, jadi asumsi posisi rapi
  // hanya kebetulan cocok. Dengan peta header, "HPP" vs "hpp" tidak masalah.
  const produkResult = [headerProdukPayload()];

  if (shProduk) {
    const dataProduk = shProduk.getDataRange().getValues();

    if (dataProduk.length > 0) {
      const petaProduk = petaKolomProdukSheet(shProduk);
      if (petaProduk.col.hpp === undefined) {
        Logger.log('getInitialData: kolom HPP tidak ditemukan di header sheet Produk — HPP akan 0 (cek nama header: ' +
          JSON.stringify(petaProduk.header) + ')');
      }

      // Fast path: jika SEMUA produk sudah punya foto_url tersimpan, JANGAN panggil
      // DriveApp (bisa 3-10 detik per pemanggilan). Pencocokan Drive hanya perlu
      // dilakukan saat ada produk dengan foto kosong (produk baru).
      const iFoto = petaProduk.col.foto_url;
      let perluCocokkanDrive = false;
      if (iFoto !== undefined) {
        for (let i = 1; i < dataProduk.length; i++) {
          if (!String(dataProduk[i][iFoto] || '').trim()) { perluCocokkanDrive = true; break; }
        }
      } else {
        Logger.log('getInitialData: kolom foto_url tidak ditemukan di header sheet Produk');
      }

      const photoList = perluCocokkanDrive ? getDrivePhotoList() : [];
      const updatesFoto = [];
      let needsUpdate = false;

      for (let i = 1; i < dataProduk.length; i++) {
        const row = dataProduk[i];
        const id = String(ambilKolom(row, petaProduk, 'id', '') || '').trim();
        const nama = String(ambilKolom(row, petaProduk, 'nama', '') || '').trim();
        // Sama seperti getProdukData: angka di sheet boleh TEKS format id-ID
        // ("14.000"), jadi harus dibaca parser toleran. Jalur ini yang dipakai
        // kasir saat login (getInitialData), jadi WAJIB konsisten dengan
        // getProdukData atau kasir menerima angka terpotong.
        const stok = ambilKolomAngkaToleran(row, petaProduk, 'stok', 0);
        const harga = ambilKolomAngkaToleran(row, petaProduk, 'harga', 0);
        let fotoUrl = String(ambilKolom(row, petaProduk, 'foto_url', '') || '').trim();

        // Cocokkan foto dari Google Drive hanya bila ada foto yang belum terisi
        if (perluCocokkanDrive) {
          const kosongDiSheet = !String(ambilKolom(row, petaProduk, 'foto_url', '') || '').trim();
          const matchedDriveUrl = matchPhotoForProduct(id, nama, photoList);
          if (matchedDriveUrl) {
            fotoUrl = matchedDriveUrl;
            // Hanya sel yang KOSONG yang ditulis. Kalau sel sudah berisi URL
            // manual, tebakannya tidak boleh menimpa pilihan kasir/admin.
            if (kosongDiSheet) needsUpdate = true;
          }
        }

        updatesFoto.push([fotoUrl]);

        // HPP: kolom HPP produk. TIDAK ada fallback ke kolom lain — kolom
        // foto_url pernah berisi angka Modal batch sisa dan bocor ke
        // Laba Bersih (bug Modal 15.000 vs 50.000 untuk produk yang sama).
        const hppProduk = ambilKolomAngkaToleran(row, petaProduk, 'hpp', 0);

        // volume_ml: kolom volume_ml (G). Kosong -> turunan dari nama supaya
        // produk baru tetap punya volume, tapi kolom aslinya yang diutamakan.
        let volumeMl = ambilKolom(row, petaProduk, 'volume_ml', '');
        if (volumeMl === '' || volumeMl == null) volumeMl = hitungVolumeMl(nama);
        volumeMl = formatVolumeMl(volumeMl);

        produkResult.push([id, nama, stok, harga, fotoUrl, hppProduk, volumeMl]);
      }

      // Batch setValues untuk foto_url jika ada yang perlu diperbarui
      if (needsUpdate && iFoto !== undefined) {
        try {
          shProduk.getRange(1, iFoto + 1, updatesFoto.length, 1).setValues(updatesFoto);
        } catch (e) { }
      }
    }
  }

  // ─── 2. PENJUALAN DATA (batch getValues) ───
  const shPenjualan = ss.getSheetByName("Penjualan");
  // Header payload. Urutan kolom mengikuti struktur baris data di bawah;
  // baris data diisi lewat barisKeObjek() berdasar nama header NYATA di sheet
  // (anti-salah-posisi bila sheet berubah lagi), sehingga posisi kolom di
  // payload ini bebas.
  const penjualanHeader = headerPenjualanPayload();
  let penjualanResult = [penjualanHeader];

  if (shPenjualan) {
    const lastRow = shPenjualan.getLastRow();

    if (lastRow > 1) {
      // Baca HANYA jendela baris terbaru (terakhir `limitPenjualan` baris),
      // bukan seluruh sheet — baris 490+ per refresh memperlambat payload.
      const jumlahBaris = Math.min(lastRow, limitPenjualan + 1);
      const barisAwal = lastRow - jumlahBaris + 1;

      // Peta kolom dari header NYATA sheet (bukan posisi asumsi). Sheet sudah
      // beberapa kali berubah layout; setiap reader/writer memakai peta ini
      // supaya perubahan kolom berikutnya tidak lagi menggeser data.
      const peta = petaKolomPenjualanSheet(shPenjualan);
      catatPetaPeringatan('getInitialData', peta);

      // Lebar baca mengikuti header sebenarnya, minimal 13.
      const lebarBaca = Math.max(peta.header.length, 13);
      const dataJual = shPenjualan.getRange(barisAwal, 1, jumlahBaris, lebarBaca).getValues();

      penjualanResult = [penjualanHeader];

      for (let i = 1; i < dataJual.length; i++) {
        const row = dataJual[i];
        if (row[0] == "" || row[1] == "") continue;

        penjualanResult.push([
          String(ambilKolom(row, peta, 'id', '')),
          formatTanggalRow(ambilKolom(row, peta, 'tanggal', ''), timezone),
          ambilKolomTeks(row, peta, 'namaProduk', ''),
          formatVolumeMl(ambilKolom(row, peta, 'volumeMl', '')),
          ambilKolomAngkaAtauKosong(row, peta, 'hppSatuan'),
          ambilKolomAngka(row, peta, 'jumlah', 0),
          ambilKolomAngka(row, peta, 'totalHarga', 0),
          ambilKolomTeks(row, peta, 'metode', ''),
          ambilKolomAngka(row, peta, 'uangDibayar', 0),
          ambilKolomAngka(row, peta, 'uangKembali', 0),
          ambilKolomAngkaAtauKosong(row, peta, 'modal'),
          ambilKolomAngkaAtauKosong(row, peta, 'biayaOperasional'),
          ambilKolomAngkaAtauKosong(row, peta, 'labaBersih')
        ]);
      }
    }
  }

  // ─── 3. RETURN GABUNGAN ───
  return {
    produk: produkResult,
    penjualan: penjualanResult,
    timestamp: new Date().getTime()
  };
}

/**
 * Checkout
 */
function prosesCheckoutInti(cart, metode, uangDibayar, requestData) {
  try {
    if (!Array.isArray(cart) || cart.length === 0) {
      return { status: "error", message: "Keranjang masih kosong." };
    }

    const ss = getSpreadsheet();
    const shProduk = ss.getSheetByName("Produk");
    const shPenjualan = ss.getSheetByName("Penjualan");

    if (!shProduk || !shPenjualan) {
      return { status: "error", message: "Sheet 'Produk' atau 'Penjualan' tidak ditemukan." };
    }

    // Inisialisasi aman: selalu array, tidak pernah undefined/null.
    let dataProduk = [];
    try {
      const rawProduk = shProduk.getDataRange().getValues();
      dataProduk = Array.isArray(rawProduk) ? rawProduk : [];
    } catch (readErr) {
      Logger.log("prosesCheckout: gagal membaca sheet Produk: " + readErr);
    }

    // Type guard: jika dataProduk bukan array (gagal memuat data dari sheet/API),
    // fallback ke array kosong agar tidak crash dengan TypeError 'findIndex is not a function'.
    if (!Array.isArray(dataProduk)) {
      Logger.log("prosesCheckout: dataProduk bukan array, fallback ke array kosong.");
      dataProduk = [];
    }

    // Peta kolom Produk dari header NYATA (bukan posisi). Sheet live memakai
    // header "ID Produk","Nama Produk","Stok","Harga","foto_url","HPP" yang
    // namanya beda dengan header payload — asumsi index hanya kebetulan cocok.
    const petaProduk = petaKolomProdukSheet(shProduk);

    // Validasi data Produk: minimal harus ada baris header + kolom wajib
    // (id, nama, harga) supaya tidak menulis dengan harga 0.
    const wajibAda = ['id', 'nama', 'harga'];
    const kolomHilang = wajibAda.filter(f => petaProduk.col[f] === undefined);
    if (dataProduk.length < 2 || kolomHilang.length) {
      return {
        status: "error",
        message: "Data produk belum termuat dengan benar (sheet Produk kosong/header tidak lengkap: " +
          (kolomHilang.length ? kolomHilang.join(', ') + ' tidak ditemukan' : 'tidak ada baris data') +
          "). Muat ulang halaman lalu coba lagi."
      };
    }

    // Harga satuan, HPP & volume diambil dari data produk via Map (O(1) per item).
    // TANPA validasi stok (stok dikelola manual): penjualan tidak diblokir
    // meski angka stok di sheet basi. Stok tetap DIKURANGI di akhir proses.
    const indeksPerId = new Map(); // id produk -> indeks baris di dataProduk
    for (let i = 1; i < dataProduk.length; i++) {
      const kunci = String(ambilKolom(dataProduk[i], petaProduk, 'id', '') || '').trim();
      if (kunci) indeksPerId.set(kunci, i);
    }

    let grandTotal = 0;
    const validatedItems = [];

    for (const item of cart) {
      const itemId = String(item && item.id != null ? item.id : '').trim();
      const itemNama = String(item && item.nama ? item.nama : '').trim();
      const jumlah = parseAngkaToleran(item && item.jumlah != null ? item.jumlah : 0);

      if (!itemId) {
        return { status: "error", message: "ID produk tidak valid." };
      }

      if (!Number.isFinite(jumlah) || jumlah <= 0) {
        return { status: "error", message: "Jumlah item harus lebih dari 0." };
      }

      const idx = indeksPerId.get(itemId);
      if (idx === undefined) {
        return { status: "error", message: "Produk ID " + itemId + " tidak ditemukan." };
      }
      const produk = dataProduk[idx];

      const hargaSatuan = ambilKolomAngkaToleran(produk, petaProduk, 'harga', 0);
      const totalHargaItem = hargaSatuan * jumlah;
      grandTotal += totalHargaItem;

      // HPP = kolom HPP produk (F). TIDAK ada fallback ke kolom lain.
      // Fallback lama ke kolom E adalah sumber bug Modal tidak konsisten:
      // kolom E = foto_url, tapi pernah holds angka Modal per batch restock
      // sehingga Rp15.000 / Rp50.000 bocor ke Laba Bersih per transaksi.
      let modalSatuan = ambilKolomAngkaToleran(produk, petaProduk, 'hpp', 0);
      // HPP dari frontend (payload produk membawa kolom 'hpp') menang bila
      // valid & > 0 — praktis selalu terisi karena dibaca dari sheet yang sama.
      const hppFrontend = parseAngkaToleran(item && item.hpp != null ? item.hpp : 0);
      if (Number.isFinite(hppFrontend) && hppFrontend > 0) {
        modalSatuan = hppFrontend;
      }
      if (!(modalSatuan > 0)) {
        Logger.log('prosesCheckout: HPP produk ' + itemId + ' kosong/tidak terbaca — HPP Satuan, Modal & Laba Bersih akan ditulis KOSONG (bukan 0) sebagai penanda; transaksi tetap diproses.');
      }

      // volume_ml = kolom volume_ml (G). Kolom aslina diutamakan; hanya
      // kalau kosong baru diturunkan dari nama (produk baru belum diisi).
      let volumeMl = ambilKolom(produk, petaProduk, 'volume_ml', '');
      if (volumeMl === '' || volumeMl == null) volumeMl = hitungVolumeMl(itemNama || ambilKolom(produk, petaProduk, 'nama', ''));
      volumeMl = formatVolumeMl(volumeMl);

      validatedItems.push({
        id: itemId,
        nama: itemNama || String(ambilKolom(produk, petaProduk, 'nama', '') || ''),
        jumlah: jumlah,
        hargaSatuan: hargaSatuan,
        totalHarga: totalHargaItem,
        modalSatuan: modalSatuan,
        hppTerbaca: modalSatuan > 0,
        volumeMl: volumeMl
      });
    }

    // Idempotensi antrian offline: bawaan frontend berupa koneksiId unik per tekanan
    // tombol. Kalau koneksi putus SETELAH server mencatat transaksi (respon tidak
    // sampai ke kasir), pengiriman ulang dari antrian lokal TIDAK boleh dobel-catat.
    const koneksiId = requestData ? ambilKoneksiId(requestData) : null;
    if (koneksiId) {
      try {
        const props = PropertiesService.getScriptProperties();
        const tercatat = props.getProperty('idem_' + koneksiId);
        if (tercatat) {
          Logger.log("prosesCheckout: koneksiId " + koneksiId + " sudah pernah diproses (transaksi " + tercatat + "), kirim ulang hasil lama.");
          return JSON.parse(tercatat);
        }
      } catch (idemErr) {
        Logger.log("prosesCheckout: gagal cek idempotensi (lanjut normal): " + idemErr);
      }
    }

    const transaksi = "FR-" + new Date().getTime();
    const tanggal = new Date();
    let uangKembali = 0;
    let finalBayar = grandTotal;

    if (String(metode).toUpperCase() === "CASH") {
      finalBayar = parseAngkaToleran(uangDibayar);
      if (!Number.isFinite(finalBayar) || finalBayar <= 0) {
        return { status: "error", message: "Nominal pembayaran CASH tidak valid." };
      }
      uangKembali = finalBayar - grandTotal;
      if (uangKembali < 0) {
        return { status: "error", message: "Uang pembayaran kurang." };
      }
    }

    // Tulis semua baris penjualan & update stok sekaligus (batch), bukan per item.
    // appendRow/setValue per item = puluhan panggilan sheet -> checkout terasa lambat;
    // 2 operasi tulis batch (setValues) jauh lebih cepat & atomik.
    if (validatedItems.length > 0) {
      // Tulis mengikuti NAMA HEADER sheet Penjualan, bukan urutan array tetap.
      // Versi lama menulis 11 nilai posisional ke sheet 13 kolom: jumlah
      // mendarat di "Volume (ml)", totalHarga di "HPP Satuan", metode di
      // "Jumlah", dan "Laba bersih" TIDAK PERNAH ditulis sama sekali.
      // Sekarang setiap field dipetakan ke indeks kolom yang sesunggunya,
      // dan kolom yang tidak ada di header dilewati (bukan menggeser).
      const petaJual = petaKolomPenjualanSheet(shPenjualan);
      catatPetaPeringatan('prosesCheckout', petaJual);

      const kolomPenting = ['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'labaBersih'];
      const hilangPenting = kolomPenting.filter(f => petaJual.col[f] === undefined);
      if (hilangPenting.length) {
        return {
          status: "error",
          message: "Transaksi dibatalkan: header sheet Penjualan tidak lengkap (kolom " +
            hilangPenting.join(', ') + " tidak ditemukan). Data transaksi tidak boleh ditulis dengan posisi keliru."
        };
      }

      const barisPenjualan = validatedItems.map(item => {
        // P3: HPP tak terbaca -> HPP Satuan, Modal, dan Laba Bersih ditulis
        // KOSONG (bukan 0) sebagai penanda, supaya tidak terlihat seperti data
        // yang dihitung benar. Transaksi tetap boleh diselesaikan.
        const hppTerbaca = item.hppTerbaca === true;
        const totalModalNum = item.modalSatuan * item.jumlah;
        const totalModal = hppTerbaca ? totalModalNum : '';
        const biayaOperasional = 0;
        const labaBersih = hppTerbaca ? item.totalHarga - totalModalNum - biayaOperasional : '';
        return susunBarisKolom({
          id: transaksi,
          tanggal: tanggal,
          namaProduk: item.nama,
          volumeMl: item.volumeMl,
          hppSatuan: hppTerbaca ? item.modalSatuan : '',
          jumlah: item.jumlah,
          totalHarga: item.totalHarga,
          metode: metode,
          uangDibayar: finalBayar,
          uangKembali: uangKembali,
          modal: totalModal,
          biayaOperasional: biayaOperasional,
          labaBersih: labaBersih
        }, petaJual);
      });

      const kolomTanpaHeader = barisPenjualan[0].__tanpaKolom || [];
      if (kolomTanpaHeader.length) {
        Logger.log('prosesCheckout: field tidak ada di header sheet Penjualan, DILEWATI (tidak digeser): ' +
          kolomTanpaHeader.join(', '));
      }

      // Batch penjualan: semua item dalam SATU setValues setelah baris terakhir.
      const lastRowJual = shPenjualan.getLastRow();
      shPenjualan
        .getRange(lastRowJual + 1, 1, barisPenjualan.length, barisPenjualan[0].length)
        .setValues(barisPenjualan);

      // Stok ikut berkurang: agregasi qty per produk dulu (produk sama bisa
      // muncul beberapa kali di cart), lalu tulis setiap baris TEPAT SEKALI.
      // Rentang baris berurutan digabung menjadi SATU setValues — tanpa
      // validasi stok (stok manual): tidak memblokir penjualan.
      const penguranganPerBaris = new Map(); // nomor baris sheet (1-based) -> total qty
      for (const item of validatedItems) {
        const idx = indeksPerId.get(item.id);
        if (idx !== undefined) {
          const baris = idx + 1; // 0-based -> 1-based
          penguranganPerBaris.set(baris, (penguranganPerBaris.get(baris) || 0) + item.jumlah);
        }
      }
      const entriStok = Array.from(penguranganPerBaris.entries()).sort((a, b) => a[0] - b[0]);
      if (entriStok.length > 0) {
        // Kolom stok juga lewat peta header, bukan index tetap.
        const iStok = petaProduk.col.stok;
        if (iStok === undefined) {
          Logger.log('prosesCheckout: kolom Stok tidak ditemukan di header sheet Produk — stok TIDAK dikurangi (transaksi tetap tercatat).');
        } else {
          const indeksStok = entriStok.map(e => e[0]);
          const nilaiStok = entriStok.map(e => {
            const stokBaru = ambilKolomAngka(dataProduk[e[0] - 1], petaProduk, 'stok', 0) - e[1];
            dataProduk[e[0] - 1][iStok] = stokBaru;
            return [stokBaru];
          });
          let k = 0;
          while (k < indeksStok.length) {
            let m = k;
            while (m + 1 < indeksStok.length && indeksStok[m + 1] === indeksStok[m] + 1) m++;
            const jumlahBaris = m - k + 1;
            shProduk
              .getRange(indeksStok[k], iStok + 1, jumlahBaris, 1)
              .setValues(nilaiStok.slice(k, m + 1));
            k = m + 1;
          }
        }
      }

      // Cache payload baca dipakai ulang oleh login/refresh — tulis apa pun yang
      // mengubah stok/penjualan HARUS membatalkannya (lihat buangCacheAwal).
      buangCacheAwal();
    }

    const hasilSukses = {
      status: "success",
      transaksi: transaksi,
      total: grandTotal,
      bayar: finalBayar,
      kembali: uangKembali,
      metode: metode
    };

    // Simpan hasil sukses sebagai tanda idempotensi SEBELUM respons dikirim —
    // ini titik aman: respons hilang di jalan pun, kirim ulang tidak dobel-catat.
    if (koneksiId) {
      try {
        const props = PropertiesService.getScriptProperties();
        props.setProperty('idem_' + koneksiId, JSON.stringify(hasilSukses));
        bersihkanKunciIdempotensiTua(props);
      } catch (idemErr) {
        Logger.log("prosesCheckout: gagal simpan idempotensi (transaksi tetap sah): " + idemErr);
      }
    }

    return hasilSukses;

  } catch (err) {
    return {
      status: "error",
      message: "Error sistem: " + err.toString()
    };
  }
}

/**
 * Pembersih kunci idempotensi tua. PropertiesService di GAS punya batas total
 * (~9KB/properti, 500KB total) — biarkan menumpuk lama-lama memperlambat & bisa
 * penuh. Kunci dianggap kedaluwarsa setelah 24 jam (jendela aman kirim ulang
 * antrian offline; lewat dari itu, transaksi pasti sudah tersinkron).
 */
function bersihkanKunciIdempotensiTua(props) {
  try {
    const TTL_MS = 24 * 60 * 60 * 1000;
    const semua = props.getProperties();
    const kunciTua = [];
    for (const kunci in semua) {
      if (kunci.indexOf('idem_') !== 0) continue;
      try {
        const isi = JSON.parse(semua[kunci]);
        // hasilSukses tidak menyimpan waktu — bandingkan lewat ID transaksi FR-<ms>
        const ms = parseInt(String(isi && isi.transaksi || '').replace('FR-', ''), 10);
        if (Number.isFinite(ms) && (Date.now() - ms) > TTL_MS) kunciTua.push(kunci);
      } catch (e) { kunciTua.push(kunci); } // isi korup = aman dibuang
    }
    for (let i = 0; i < kunciTua.length; i++) props.deleteProperty(kunciTua[i]);
  } catch (e) {
    Logger.log("bersihkanKunciIdempotensiTua: " + e);
  }
}

/**
 * Reset stok harian
 */
function resetStokHarian() {

  const ss = getSpreadsheet();

  const sheet = ss.getSheetByName("Produk");

  if (!sheet) return;

  const data = sheet.getDataRange().getValues();

  // Struktur Produk sheet: [id, nama, stok, harga]
  // Kolom stok adalah index 2, tidak ada kolom stokAwal (index 4 tidak ada)
  // Fungsi ini seharusnya menggunakan stok awal dari suatu tempat atau dibuat dengan menambah kolom baru
  // Untuk sekarang, skip function ini atau tambahkan kolom stok_awal ke sheet Produk

  return true; // Placeholder agar tidak error

}

/**
 * Trigger Manual
 */
function createDailyTrigger() {

  ScriptApp.newTrigger("resetStokHarian")
    .timeBased()
    .everyDays(1)
    .atHour(0)
    .create();

}

/**
 * Fungsi untuk menangani proses logout di sisi server
 */
function logoutUser() {
  // Jika Anda menggunakan Session (PropertiesService), hapus di sini
  // PropertiesService.getUserProperties().deleteAllProperties();

  // Fungsi ini tidak wajib mengembalikan data, 
  // yang penting fungsi ini ADA agar tidak muncul error "is not a function"
  return true;
}

/**
 * Fungsi untuk mengambil ID Spreadsheet berdasarkan environment.
 * Ubah 'development' ke 'production' di Script Properties 
 * saat Anda siap untuk live.
 */
function getPenjualanReport(startDate, endDate) {

  // startDate/endDate format: YYYY-MM-DD

  // Ambil data dari sheet Penjualan lalu agregasi berdasarkan nama produk.
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName('Penjualan');

  if (!sheet) {
    return {
      txCount: 0,
      grossTotal: 0,
      netTotal: 0,
      topProducts: []
    };
  }

  const values = sheet.getDataRange().getValues();
  if (!values || values.length <= 1) {
    return {
      txCount: 0,
      grossTotal: 0,
      netTotal: 0,
      topProducts: []
    };
  }

  // Posisi kolom diambil dari peta header (lihat PETA_KOLOM_PENJUALAN) —
  // toleran alias & berubah urutan. Tanpa fallback posisi: bila kolom tidak
  // ketemu, report ini akan salah (bukan diam-diam salah baca).
  const petaRep = buatPetaKolom(values[0] || [], PETA_KOLOM_PENJUALAN);
  if (petaRep.col.jumlah === undefined || petaRep.col.totalHarga === undefined) {
    Logger.log('getPenjualanReport: kolom Jumlah/Total Harga tidak ditemukan di header — ' +
      'qty & omset akan 0. Header: ' + JSON.stringify(values[0]));
  }

  let start = null;
  let end = null;
  if (startDate) {
    start = new Date(startDate + 'T00:00:00');
  }
  if (endDate) {
    end = new Date(endDate + 'T23:59:59');
  }

  const map = {}; // namaProduk -> {namaProduk, qty, omset, metodeCount{}}
  let txCount = 0;
  let grossTotal = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const idTx = ambilKolom(row, petaRep, 'id', '');
    const tanggalCell = ambilKolom(row, petaRep, 'tanggal', '');
    const namaProduk = ambilKolomTeks(row, petaRep, 'namaProduk', '').trim();
    const jumlah = ambilKolomAngka(row, petaRep, 'jumlah', 0);
    const totalHarga = ambilKolomAngka(row, petaRep, 'totalHarga', 0);
    const metode = ambilKolomTeks(row, petaRep, 'metode', '').trim();

    if (!idTx || !namaProduk) continue;

    // filter tanggal
    let include = true;
    if (start || end) {
      let rowDate = null;

      if (tanggalCell instanceof Date) {
        rowDate = tanggalCell;
      } else {
        // Fallback jika stored sebagai string dd/MM/yyyy HH:mm
        const s = String(tanggalCell).replace(/,/g, '').trim();
        rowDate = new Date(s);
        if (isNaN(rowDate.getTime())) {
          // coba parse dd/MM/yyyy HH:mm
          const parts = s.split(' ');
          if (parts.length >= 2) {
            const dmy = parts[0].split('/');
            const hm = parts[1].split(':');
            if (dmy.length === 3 && hm.length >= 2) {
              rowDate = new Date(Number(dmy[2]), Number(dmy[1]) - 1, Number(dmy[0]), Number(hm[0]), Number(hm[1]));
            }
          }
        }
      }

      if (!rowDate || isNaN(rowDate.getTime())) {
        include = false;
      } else {
        if (start && rowDate < start) include = false;
        if (end && rowDate > end) include = false;
      }
    }

    if (!include) continue;

    txCount += 1;
    grossTotal += totalHarga;

    if (!map[namaProduk]) {
      map[namaProduk] = {
        namaProduk: namaProduk,
        qty: 0,
        omset: 0,
        metodeCount: {}
      };
    }

    map[namaProduk].qty += jumlah;
    map[namaProduk].omset += totalHarga;
    map[namaProduk].metodeCount[metode] = (map[namaProduk].metodeCount[metode] || 0) + totalHarga;
  }

  // post-process: metodeTerbanyak berdasarkan omset terbesar per metode
  const topProducts = Object.keys(map).map(k => {
    const p = map[k];
    let bestMethod = null;
    let bestVal = -Infinity;
    Object.keys(p.metodeCount).forEach(m => {
      const v = p.metodeCount[m];
      if (v > bestVal) { bestVal = v; bestMethod = m; }
    });

    return {
      namaProduk: p.namaProduk,
      qty: p.qty,
      omset: p.omset,
      metodeTerbanyak: bestMethod
    };
  });

  // sort by qty desc (top terlaris)
  topProducts.sort((a, b) => (b.qty - a.qty));

  return {
    txCount: txCount,
    grossTotal: grossTotal,
    netTotal: grossTotal,
    topProducts: topProducts.slice(0, 10)
  };
}

// DIAGNOSTIK READ-ONLY (hanya getValues, TANPA penulisan apa pun).
// Memeriksa Sheet 'Penjualan' & 'Produk' — jawaban 2 pertanyaan:
//   (1) apa layout kolom SEBENARNYA di sheet live sekarang?
//   (2) berapa baris historis yang ditulis dengan layout LAMA (8/11 kolom)
//       sehingga perlu backfill / flagging, dan apakah backfill-nya layak
//       (volume bisa diturunkan dari nama, HPP bisa dicocokkan ke produk)?
// Sepenuhnya read-only: aman dijalankan kapan saja.
function diagnostikPenjualan() {
  const ss = getSpreadsheet();
  const out = {};

  const fmtTanggal = (v) => {
    if (v instanceof Date) return Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'dd/MM/yyyy HH:mm');
    return String(v == null ? '' : v);
  };

  // ─── 1. SHEET PENJUALAN: LAYOUT + KLASIFIKASI BARIS HISTORIS ───
  const shJual = ss.getSheetByName('Penjualan');
  if (!shJual) {
    out.Penjualan = 'TIDAK ADA';
  } else {
    const lastRow = shJual.getLastRow();
    const maxCols = Math.max(shJual.getMaxColumns(), 13);
    const semua = shJual.getRange(1, 1, Math.max(lastRow, 1), maxCols).getValues();
    const header = (semua[0] || []).map(h => String(h == null ? '' : h).trim());

    out.Penjualan = {
      lastRow: lastRow,
      maxColumns: shJual.getMaxColumns(),
      jumlahKolomDipakai: header.filter(h => h !== '').length,
      header: header,
      posisiDikenal: {
        'Volume (ml)': header.indexOf('Volume (ml)'),
        'HPP Satuan': header.indexOf('HPP Satuan'),
        'Jumlah': header.indexOf('Jumlah'),
        'QTY': header.indexOf('QTY'),
        'Qty': header.indexOf('Qty'),
        'Total Harga': header.indexOf('Total Harga'),
        'Metode Pembayaran': header.indexOf('Metode Pembayaran'),
        'Modal': header.indexOf('Modal'),
        'Biaya Operasional': header.indexOf('Biaya Operasional'),
        'Laba bersih': header.indexOf('Laba bersih'),
        'Laba Bersih': header.indexOf('Laba Bersih')
      },
      contohBarisData: semua.slice(1, 4).map(r => r.map(c => c instanceof Date ? fmtTanggal(c) : c))
    };

    // Klasifikasi baris data berdasarkan BENTUK nilainya, bukan posisi tetap.
    //   - idx5 berupa TEKS ("CASH"/"QRIS")  -> layout LAMA 11 kolom (metode di idx5)
    //   - idx7 berupa TEKS                  -> layout BARU 13 kolom (metode di idx7)
    //   - idx12 terisi                      -> pasti sudah 13 kolom
    //   - idx7 kosong & idx5 angka          -> layout LAMA 8 kolom
    const buckets = { BARU13: [], LAMA11: [], LAMA8: [] };
    for (let i = 1; i < semua.length; i++) {
      const row = semua[i];
      if (row[0] === '' || row[0] == null) continue; // baris kosong
      const txt = (x) => String(x == null ? '' : x).trim();
      const isTeks = (x) => txt(x) !== '' && isNaN(Number(x));
      const ada12 = txt(row[12]) !== '';
      const key = (ada12 || isTeks(row[7])) ? 'BARU13' : (isTeks(row[5]) ? 'LAMA11' : 'LAMA8');
      buckets[key].push({ baris: i + 1, id: txt(row[0]), tanggal: fmtTanggal(row[1]), nama: txt(row[2]) });
    }

    const ringkas = (arr) => ({
      jumlah: arr.length,
      contoh: arr.slice(0, 3),
      barisTercua: arr.length ? arr[0].baris : null,
      barisTerakhir: arr.length ? arr[arr.length - 1].baris : null,
      tanggalTercua: arr.length ? arr[0].tanggal : null,
      tanggalTerakhir: arr.length ? arr[arr.length - 1].tanggal : null
    });

    out.Penjualan.klasifikasiBaris = {
      BARU13_layout13kolom: ringkas(buckets.BARU13),
      LAMA11_layout11kolom: ringkas(buckets.LAMA11),
      LAMA8_layout8kolom: ringkas(buckets.LAMA8)
    };

    // Kelayakan backfill untuk baris lama: Volume bisa diturunkan dari nama
    // produk (pola "250 ml"), HPP bisa dicocokkan ke sheet Produk by nama.
    const shProduk = ss.getSheetByName('Produk');
    const namaProdukTersedia = new Set();
    if (shProduk && shProduk.getLastRow() > 1) {
      const pRows = shProduk.getRange(2, 1, shProduk.getLastRow() - 1, 2).getValues();
      for (const r of pRows) {
        const n = String(r[1] == null ? '' : r[1]).trim();
        if (n) namaProdukTersedia.add(n.toLowerCase());
      }
    }
    const lama = buckets.LAMA11.concat(buckets.LAMA8);
    let volumeBisaDiturunkan = 0, namaAdaDiProduk = 0, namaTidakDitemukan = [];
    for (const b of lama) {
      if (hitungVolumeMl(b.nama) !== '') volumeBisaDiturunkan++;
      if (namaProdukTersedia.has(String(b.nama).toLowerCase())) namaAdaDiProduk++;
      else if (namaTidakDitemukan.length < 10) namaTidakDitemukan.push(b.nama);
    }
    out.Penjualan.kelayakanBackfill = {
      totalBarisLama: lama.length,
      volumeBisaDiturunkanDariNama: volumeBisaDiturunkan,
      volumeTidakBisaDiturunkan: lama.length - volumeBisaDiturunkan,
      namaProdukAdaDiSheetProduk: namaAdaDiProduk,
      namaProdukTidakDitemukan: namaTidakDitemukan
    };
  }

  // ─── 2. SHEET PRODUK: LAYOUT (untuk memastikan posisi HPP & Volume) ───
  const shProduk = ss.getSheetByName('Produk');
  if (!shProduk) {
    out.Produk = 'TIDAK ADA';
  } else {
    const lastRow = shProduk.getLastRow();
    const maxCols = Math.max(shProduk.getMaxColumns(), 8);
    const all = shProduk.getRange(1, 1, Math.max(lastRow, 1), maxCols).getValues();
    const header = (all[0] || []).map(h => String(h == null ? '' : h).trim());
    out.Produk = {
      lastRow: lastRow,
      maxColumns: shProduk.getMaxColumns(),
      jumlahKolomDipakai: header.filter(h => h !== '').length,
      header: header,
      posisiDikenal: {
        id: header.indexOf('id'),
        nama: header.indexOf('nama'),
        stok: header.indexOf('stok'),
        harga: header.indexOf('harga'),
        foto_url: header.indexOf('foto_url'),
        hpp: header.indexOf('hpp'),
        HPP: header.indexOf('HPP'),
        volume_ml: header.indexOf('volume_ml'),
        'Volume (ml)': header.indexOf('Volume (ml)')
      },
      // id, nama, stok, harga, hpp, volume_ml + volume turunan dari nama
      daftarProduk: all.slice(1).map(r => [
        String(r[0] == null ? '' : r[0]),
        String(r[1] == null ? '' : r[1]),
        r[2], r[3],
        header.indexOf('hpp') !== -1 ? r[header.indexOf('hpp')] : (header.indexOf('HPP') !== -1 ? r[header.indexOf('HPP')] : null),
        (header.indexOf('volume_ml') !== -1 || header.indexOf('Volume (ml)') !== -1)
          ? r[header.indexOf('volume_ml') !== -1 ? header.indexOf('volume_ml') : header.indexOf('Volume (ml)')]
          : hitungVolumeMl(r[1])
      ])
    };
  }

  return out;
}

/**
 * Analisis KELENGKAPAN data Penjualan (v2).
 *
 * v1 hanya melaporkan klasifikasi BARU13/LAMA11/LAMA8, yang menilai POSISI
 * kolom. Itu belum menjawab: dari 523 baris, berapa yang benar-benar punya
 * Volume/HPP/Modal/Laba terisi? Backfill hanya worthwhile kalau ada kekosongan.
 *
 * Read-only. Mengembalikan:
 *  - isiPerKolom  : jumlah baris terisi per kolom (indeks + nama header)
 *  - profil       : pola "kolom mana yang terisi" + berapa baris, desc
 *  - rekapBaris   : per ringkasan, berapa baris lengkap vs parsial
 *  - namaProduk   : distinct nama di Penjualan + kecocokan ke sheet Produk
 */
function analisisKelengkapanPenjualan() {
  const ss = getSpreadsheet();
  const sh = ss.getSheetByName('Penjualan');
  let out = { Penjualan: 'TIDAK ADA' };
  if (!sh) return out;

  const lastRow = sh.getLastRow();
  const maxCols = Math.max(sh.getMaxColumns(), 13);
  const all = sh.getRange(1, 1, Math.max(lastRow, 1), maxCols).getValues();
  const header = (all[0] || []).map(h => String(h == null ? '' : h).trim());
  const iVol = header.indexOf('Volume (ml)');
  const iHpp = header.indexOf('HPP Satuan');
  const iJml = header.indexOf('Jumlah');
  const iTot = header.indexOf('Total Harga');
  const iMod = header.indexOf('Modal');
  const iLab = header.indexOf('Laba bersih') !== -1 ? header.indexOf('Laba bersih') : header.indexOf('Laba Bersih');

  const txt = (x) => String(x == null ? '' : x).trim();
  const isi = (x) => txt(x) !== '';

  // Peta produk: nama (idx1, posisional) -> HPP (idx5) & volume turunan.
  const petaProduk = {};
  const shP = ss.getSheetByName('Produk');
  if (shP && shP.getLastRow() > 1) {
    const pRows = shP.getRange(2, 1, shP.getLastRow() - 1, 8).getValues();
    for (const r of pRows) {
      const n = txt(r[1]);
      if (n) petaProduk[n.toLowerCase()] = { nama: n, id: txt(r[0]), hpp: r[5], harga: r[3] };
    }
  }

  const N = 13;
  const isiPerKolom = [];
  for (let c = 0; c < N; c++) isiPerKolom.push(0);
  const profil = {};
  const namaDipakai = {};
  let barisTotal = 0, lengkapPenuh = 0, tanpaVolume = 0, tanpaHpp = 0, tanpaModal = 0, tanpaLaba = 0;

  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    if (!isi(row[0])) continue;
    barisTotal++;
    const pola = [];
    for (let c = 0; c < N; c++) {
      if (isi(row[c])) { isiPerKolom[c]++; pola.push(c); }
    }
    const kunci = pola.join(',');
    profil[kunci] = (profil[kunci] || 0) + 1;

    if (!isi(iVol === -1 ? '' : row[iVol])) tanpaVolume++;
    if (!isi(iHpp === -1 ? '' : row[iHpp])) tanpaHpp++;
    if (!isi(iMod === -1 ? '' : row[iMod])) tanpaModal++;
    if (!isi(iLab === -1 ? '' : row[iLab])) tanpaLaba++;
    if ([iVol, iHpp, iJml, iTot, iMod, iLab].every(c => c !== -1 && isi(row[c]))) lengkapPenuh++;

    const n = txt(row[2]);
    if (n) {
      const k = n.toLowerCase();
      if (!namaDipakai[k]) {
        const p = petaProduk[k];
        namaDipakai[k] = {
          nama: n,
          jumlahBaris: 0,
          cocokProduk: !!p,
          idProduk: p ? p.id : null,
          hppProduk: p ? p.hpp : null,
          hargaProduk: p ? p.harga : null,
          volumeDariNama: hitungVolumeMl(n)
        };
      }
      namaDipakai[k].jumlahBaris++;
    }
  }

  out = {
    barisData: barisTotal,
    isiPerKolom: isiPerKolom.map((n, c) => ({
      idx: c, header: header[c] || '(kosong)', terisi: n, kosong: barisTotal - n
    })),
    rekapBaris: {
      lengkapPenuh: lengkapPenuh,
      parsial: barisTotal - lengkapPenuh,
      kosongVolume: tanpaVolume,
      kosongHpp: tanpaHpp,
      kosongModal: tanpaModal,
      kosongLaba: tanpaLaba
    },
    profil: Object.keys(profil)
      .map(k => ({ kolomTerisiIdx: k, jumlah: profil[k] }))
      .sort((a, b) => b.jumlah - a.jumlah)
      .slice(0, 8),
    namaProdukDistinct: Object.keys(namaDipakai).map(k => namaDipakai[k]).sort((a, b) => b.jumlahBaris - a.jumlahBaris)
  };
  return out;
}

/**
 * Pembungkus diagnostik untuk dijalankan dari editor Apps Script.
 *
 * Kenapa perlu: `diagnostikPenjualan()` hanya MENGEMBALIKAN objek. Kalau
 * dijalankan langsung dari editor, return value berukuran besar tidak
 * reliable muncul di Execution log — yang terlihat hanya baris
 * "Execution started/finished". Fungsi ini karena itu mencetak hasilnya
 * ke log secara eksplisit.
 *
 * Jalankan fungsi INI (bukan diagnostikPenjualan) dari editor.
 * Tetap read-only: hanya memanggil getValues.
 */
function jalankanDiagnostik() {
  const data = diagnostikPenjualan();
  const json = JSON.stringify(data, null, 2);

  Logger.log('=== DIAGNOSTIK PENJUALAN: ' + json.length + ' karakter ===');

  // Ringkasan satu blok lebih dulu: angka yang paling penting supaya langsung
  // terlihat tanpa harus menggulir log panjang.
  const p = (data && typeof data === 'object') ? data.Penjualan : null;
  if (p && typeof p === 'object') {
    const k = p.klasifikasiBaris || {};
    const jml = (o) => (o && typeof o === 'object' && o.jumlah != null) ? o.jumlah : 0;
    Logger.log('RINGKASAN PENJUALAN | kolomDipakai=' + p.jumlahKolomDipakai +
      ' | lastRow=' + p.lastRow + ' | BARU13=' + jml(k.BARU13_layout13kolom) +
      ' LAMA11=' + jml(k.LAMA11_layout11kolom) + ' LAMA8=' + jml(k.LAMA8_layout8kolom));
    Logger.log('HEADER PENJUALAN | ' + JSON.stringify(p.header));
    Logger.log('POSISI DIKENAL | ' + JSON.stringify(p.posisiDikenal));
    if (p.kelayakanBackfill) {
      Logger.log('BACKFILL | ' + JSON.stringify(p.kelayakanBackfill));
    }
  }
  const pr = (data && typeof data === 'object') ? data.Produk : null;
  if (pr && typeof pr === 'object') {
    Logger.log('HEADER PRODUK | ' + JSON.stringify(pr.header));
    Logger.log('POSISI DIKENAL PRODUK | ' + JSON.stringify(pr.posisiDikenal));
    Logger.log('DAFTAR PRODUK [id,nama,stok,harga,hpp,volume] | ' + JSON.stringify(pr.daftarProduk));
  } else {
    Logger.log('PRODUK | ' + String(pr));
  }

  // Logger.log Apps Script dibatasi ~50KB per panggilan — potong jadi beberapa
  // bagian supaya output lengkap tidak terpotong diam-diam.
  const UKURAN = 45000;
  const totalBagian = Math.max(1, Math.ceil(json.length / UKURAN));
  for (let i = 0, b = 0; i < json.length; i += UKURAN, b++) {
    Logger.log('--- JSON LENGKAP bagian ' + (b + 1) + '/' + totalBagian + ' ---');
    Logger.log(json.slice(i, i + UKURAN));
  }

  // ─── v2: kelengkapan kolom + kecocokan nama produk ───
  Logger.log('');
  Logger.log('=== ANALISIS KELENGKAPAN (v2) ===');
  let k2 = null;
  try {
    k2 = analisisKelengkapanPenjualan();
  } catch (e) {
    Logger.log('analisisKelengkapanPenjualan GAGAL: ' + e);
    return 'Selesai (v2 gagal: ' + e + ')';
  }
  Logger.log('RINGKASAN v2 | barisData=' + k2.barisData +
    ' | lengkapPenuh=' + k2.rekapBaris.lengkapPenuh +
    ' parsial=' + k2.rekapBaris.parsial +
    ' | kosongVolume=' + k2.rekapBaris.kosongVolume +
    ' kosongHpp=' + k2.rekapBaris.kosongHpp +
    ' kosongModal=' + k2.rekapBaris.kosongModal +
    ' kosongLaba=' + k2.rekapBaris.kosongLaba);
  Logger.log('ISI PER KOLOM | ' + JSON.stringify(k2.isiPerKolom));
  Logger.log('PROFIL PENGISIAN | ' + JSON.stringify(k2.profil));
  const json2 = JSON.stringify(k2, null, 2);
  const totalBagian2 = Math.max(1, Math.ceil(json2.length / UKURAN));
  for (let i = 0, b = 0; i < json2.length; i += UKURAN, b++) {
    Logger.log('--- v2 LENGKAP bagian ' + (b + 1) + '/' + totalBagian2 + ' ---');
    Logger.log(json2.slice(i, i + UKURAN));
  }

  return 'Selesai: ' + json.length + ' karakter (' + totalBagian + ' bagian) + v2 ' +
    json2.length + ' karakter (' + totalBagian2 + ' bagian). Buka Execution log.';
}

/**
 * Hitung volume (ml) dari nama produk — dipakai untuk kolom Volume (ml) di
 * sheet Penjualan (layout BARU 13 kolom). Pola: angka 100-1999 mengikuti nama,
 * mis. "Semangci 350 ml" → 350, "Wonapel 250 ml" → 250. Nama tanpa volume → ''.
 * Catatan: produk seharusnya bervolume ≥ 100 ml, angka di bawah itu (mis.
 * "Semangci 6" dari qty yang tak sengaja masuk nama) diabaikan.
 */
function hitungVolumeMl(nama) {
  const s = String(nama || '');
  const m = s.match(/(\d{3,4})\s*ml/i) || s.match(/\b(\d{3,4})\b/);
  if (!m) return '';
  const v = Number(m[1]);
  return (v >= 100 && v <= 1999) ? v : '';
}

/**
 * Mapping array → object berdasar header nyata (anti salah posisi kalau
 * struktur sheet berubah lagi ke depan).
 */
function barisKeObjek(baris, header) {
  const o = {};
  for (let i = 0; i < header.length; i++) o[String(header[i]).trim()] = baris[i];
  return o;
}

// ════════════════════════════════════════════════════════════════
// SKEMA BERBASIS NAMA HEADER (anti salah-posisi kolom)
//
// Akar bug "Total Harga = HPP" & "QTY = Volume": reader memakai index
// tetap (11 kolom) sementara sheet sudah 13 kolom. Solusinya JANGAN
// pernah mengasumsikan posisi — baca header row sekali, lalu petakan
// nama field ke indeks yang sebenarnya. Kalau kolom ditambah/bergeser
// lagi nanti, kode ikut adjusts tanpa perlu disentuh.
// ════════════════════════════════════════════════════════════════

/** Definisi kanonik kolom sheet Penjualan + alias header yang diterima. */
const PETA_KOLOM_PENJUALAN = {
  id: ['ID Transaksi', 'ID', 'id'],
  tanggal: ['Tanggal', 'Tanggal / Waktu', 'tanggal'],
  namaProduk: ['Nama Produk', 'namaProduk', 'Produk'],
  volumeMl: ['Volume (ml)', 'Volume', 'volume_ml'],
  hppSatuan: ['HPP Satuan', 'HPP', 'hpp'],
  jumlah: ['Jumlah', 'Qty', 'QTY', 'qty', 'Jumlah (pcs)'],
  totalHarga: ['Total Harga', 'Total', 'totalHarga'],
  metode: ['Metode Pembayaran', 'Metode', 'metode'],
  uangDibayar: ['Uang Dibayar', 'uangDibayar'],
  uangKembali: ['Uang Kembali', 'uangKembali'],
  modal: ['Modal', 'modal'],
  biayaOperasional: ['Biaya Operasional', 'biayaOperasional', 'BO'],
  labaBersih: ['Laba bersih', 'Laba Bersih', 'labaBersih', 'Laba']
};

/** Definisi kanonik kolom sheet Produk + alias header yang diterima. */
const PETA_KOLOM_PRODUK = {
  id: ['ID Produk', 'id', 'ID'],
  nama: ['Nama Produk', 'nama', 'Produk'],
  stok: ['Stok', 'stok'],
  harga: ['Harga', 'harga', 'Harga Jual'],
  foto_url: ['foto_url', 'Foto URL', 'foto'],
  hpp: ['HPP', 'hpp', 'HPP Satuan'],
  volume_ml: ['volume_ml', 'Volume (ml)', 'Volume', 'volume']
};

/** Normalisasi nama header: lowercase + spasi:raporation tunggal. */
function _normHeader(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Bangun peta { field -> indeks kolom } dari baris header sheet.
 *
 * Alias dicoba berurutan (urutan definisi = prioritas). Bila tidak ada
 * yang cocok persis, ada usaha longgar: header yang DIMULAI dengan
 * salah satu alias (mis. "HPP Satuan (Rp)" akan cocok "HPP Satuan").
 * Header yang tak dikenali TIDAK dihitung — pemetaan jadi ignorant
 * terhadap kolom asing, bukan menggeser apa pun.
 *
 * @return {{header: string[], col: Object, ambigu: Array, takDikenali: string[]}}
 */
function buatPetaKolom(headerBaris, definisi) {
  const header = (headerBaris || []).map(h => String(h == null ? '' : h).trim());
  const norm = header.map(_normHeader);
  const col = {};
  const ambigu = [];
  const dipakai = {};

  for (const field of Object.keys(definisi)) {
    let ketemu = -1;
    for (const alias of definisi[field]) {
      const target = _normHeader(alias);
      if (!target) continue;
      const idx = norm.indexOf(target);
      if (idx !== -1) { ketemu = idx; break; }
    }
    if (ketemu === -1) {
      for (const alias of definisi[field]) {
        const target = _normHeader(alias);
        if (target.length < 4) continue;
        for (let i = 0; i < norm.length; i++) {
          if (norm[i] && norm[i].indexOf(target) === 0) { ketemu = i; break; }
        }
        if (ketemu !== -1) break;
      }
    }
    if (ketemu === -1) continue;
    if (dipakai[ketemu]) {
      ambigu.push({ kolom: header[ketemu], fieldA: dipakai[ketemu], fieldB: field });
    } else {
      dipakai[ketemu] = field;
      col[field] = ketemu;
    }
  }

  const dikenal = new Set(Object.keys(col).map(f => String(col[f])));
  const takDikenali = header.filter((h, i) => h !== '' && !dikenal.has(String(i)));

  return { header: header, col: col, ambigu: ambigu, takDikenali: takDikenali };
}

/** Ambil nilai satu field dari baris sheet lewat peta kolom. */
function ambilKolom(row, peta, field, fallback) {
  const i = peta.col[field];
  if (i === undefined || i === -1) return fallback;
  const v = row[i];
  return (v === undefined || v === null) ? fallback : v;
}
function ambilKolomAngka(row, peta, field, fallback) {
  const v = ambilKolom(row, peta, field, fallback);
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}
function ambilKolomTeks(row, peta, field, fallback) {
  const v = ambilKolom(row, peta, field, fallback);
  return String(v == null ? (fallback || '') : v);
}
/**
 * Angka ATAU KOSONG: sel kosong diteruskan apa adanya (""), bukan dipaksa 0.
 *
 * Dipakai untuk kolom yang P3 tulis kosong sebagai penanda "HPP tak
 * terbaca" (HPP Satuan, Modal, Biaya Operasional, Laba Bersih). Kalau sel
 * kosong dipaksa jadi 0, kasir/dashboard membaca "tidak dihitung" sebagai
 * "nol" — dua arti berbeda jadi satu. Kolom lain (Jumlah, Total Harga)
 * tetap pakai ambilKolomAngka supaya tidak ada perubahan di sana.
 * Sel terisi angka (termasuk 0 yang disengaja) tetap dikirim sebagai angka.
 */
function ambilKolomAngkaAtauKosong(row, peta, field) {
  const mentah = ambilKolom(row, peta, field, '');
  if (mentah === '' || mentah == null) return '';
  const n = parseAngkaToleran(mentah);
  return Number.isFinite(n) ? n : 0;
}

/** Ambil satu field sebagai angka dengan parsing toleran format id-ID (P1/P2). */
function ambilKolomAngkaToleran(row, peta, field, fallback) {
  const v = ambilKolom(row, peta, field, fallback);
  const n = parseAngkaToleran(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

/**
 * Parsing angka toleran format Indonesia (P1):
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
  if (typeof v === 'number' && Number.isFinite(v)) return v;
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

/**
 * Susun baris sheet dari objek field → nilai, memakai PETA KOLOM.
 *
 * Kolom yang tidak ada di header sheet di-LEWATI (dikosongkan), bukan
 * diproses ke kanan. Inilah yang mencegah pergeseran posisi: writer
 * selalu mengikuti header yang benar-benar ada, tidak pernah menebak.
 */
function susunBarisKolom(nilai, peta) {
  let lebar = peta.header.length;
  for (const k of Object.keys(peta.col)) lebar = Math.max(lebar, peta.col[k] + 1);
  const out = new Array(lebar).fill('');
  let tertulis = 0;
  for (const field of Object.keys(nilai)) {
    const i = peta.col[field];
    if (i === undefined) continue; // kolom tidak ada di sheet -> jangan geser
    out[i] = nilai[field];
    tertulis++;
  }
  out.__tertulis = tertulis;
  out.__tanpaKolom = Object.keys(nilai).filter(f => peta.col[f] === undefined);
  return out;
}

/**
 * Baca header sheet Penjualan sekali lalu kembalikan petanya.
 * Kalau sheet kosong, tetap kembalikan peta kosong (bukan null) supaya
 * pemanggil tidak perlu/null-check.
 */
/**
 * Baca header sheet Penjualan lalu kembalikan petanya.
 * Sama seperti petaKolomProdukSheet: tidak dibaca -> peta kosong, bukan lempar.
 */
function petaKolomPenjualanSheet(sh) {
  if (!sh) return buatPetaKolom([], PETA_KOLOM_PENJUALAN);
  try {
    const maxCols = Math.max(sh.getMaxColumns ? sh.getMaxColumns() : 0, 13);
    const header = sh.getRange(1, 1, 1, maxCols).getValues()[0] || [];
    return buatPetaKolom(header, PETA_KOLOM_PENJUALAN);
  } catch (e) {
    Logger.log('petaKolomPenjualanSheet: gagal baca header sheet Penjualan (' + e + ') — peta kosong dipakai.');
    return buatPetaKolom([], PETA_KOLOM_PENJUALAN);
  }
}

/**
 * Baca header sheet Produk lalu kembalikan petanya.
 *
 * Kalau sheet tidak ada ATAU tidak bisa dibaca sama sekali (getRange/getValues
 * melempar — mis. sheet diakses via API yang tidak punya izin), kembalikan
 * PETA KOSONG, bukan exception. Peta kosong membuat semua kolom "tidak
 * ditemukan", sehingga pemanggil memberi pesan error yang jelas alih-alih
 * melempar error mentah ke kasir.
 */
function petaKolomProdukSheet(sh) {
  if (!sh) return buatPetaKolom([], PETA_KOLOM_PRODUK);
  try {
    const maxCols = Math.max(sh.getMaxColumns ? sh.getMaxColumns() : 0, 8);
    const header = sh.getRange(1, 1, 1, maxCols).getValues()[0] || [];
    return buatPetaKolom(header, PETA_KOLOM_PRODUK);
  } catch (e) {
    Logger.log('petaKolomProdukSheet: gagal baca header sheet Produk (' + e + ') — peta kosong dipakai.');
    return buatPetaKolom([], PETA_KOLOM_PRODUK);
  }
}

// ─── Alias nama produk ───
// Baris penjualan lama memakai nama yang berbeda dari master produk.
// "Semangka Leci X ml" = "Semangci X ml" (produk SAMA, beda ejaan) untuk
// varian 250, 350, dan 500 ml. HPP tetap diambil dari katalog master
// Produk — tidak ada HPP yang dikarang.
const ALIAS_PRODUK = {
  'semangka leci 250 ml': 'semangci 250 ml',
  'semangka leci 350 ml': 'semangci 350 ml',
  'semangka leci 500 ml': 'semangci 500 ml'
};

/**
 * Kunci normalisasi nama produk: lowercase + spasi rapi. Dipakai untuk
 * pencocokan nama yang tahan beda spasi/huruf besar.
 */
function _kunciProduk(nama) {
  return String(nama == null ? '' : nama).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Resolusi nama produk penjualan → master produk.
 * @return {string|null} nama master bila ketemu, null bila tidak.
 */
function selaraskanNamaProduk(namaPenjualan, daftarNamaProduk) {
  const kunci = _kunciProduk(namaPenjualan);
  if (!kunci) return null;

  // 1. Cocok persis
  for (const n of daftarNamaProduk) {
    if (_kunciProduk(n) === kunci) return n;
  }
  // 2. Pakai alias eksplisit
  if (ALIAS_PRODUK[kunci]) {
    const target = _kunciProduk(ALIAS_PRODUK[kunci]);
    for (const n of daftarNamaProduk) {
      if (_kunciProduk(n) === target) return n;
    }
  }
  return null;
}

/** Header payload penjualan — satu sumber kebenaran untuk semua reader. */
const HEADER_PENJUALAN_PAYLOAD = [
  'id', 'tanggal', 'namaProduk', 'volumeMl', 'hppSatuan', 'jumlah', 'totalHarga',
  'metode', 'uangDibayar', 'uangKembali', 'modal', 'biayaOperasional', 'labaBersih'
];
function headerPenjualanPayload() {
  return HEADER_PENJUALAN_PAYLOAD.slice();
}

/** Header payload produk — id, nama, stok, harga, foto_url, hpp, volume_ml. */
const HEADER_PRODUK_PAYLOAD = ['id', 'nama', 'stok', 'harga', 'foto_url', 'hpp', 'volume_ml'];
function headerProdukPayload() {
  return HEADER_PRODUK_PAYLOAD.slice();
}

// ════════════════════════════════════════════════════════════════
// PENGISIAN volume_ml (Fix 4)
//
// Kolom G "volume_ml" di sheet Produk adalah sumber volume yang
// SESUNGGUHNYA. Sebelumnya volume diturunkan dari nama produk, yang
// rapuh: produk bernama tanpa angka volume -> volume kosong/0.
//
// Fungsi ini MENGISI kolom G dari angka pada nama produk. Aman:
//  - hanya menulis sel yang masih KOSONG (idempoten, tidak menimpa isian manual)
//  - hanya produk yang volumenya bisa dibaca dari nama
//  -Report selalu dicetak ke Execution Log supaya bisa diperiksa
//
// Jalankan: isiVolumeMlProduk()   (aman dipanggil berkali-kali)
// Kalau ingin HANYA melihat rencana tanpa menulis: isiVolumeMlProduk(true)
// ════════════════════════════════════════════════════════════════
function isiVolumeMlProduk(hanyaSimulasi) {
  const ss = getSpreadsheet();
  const sh = ss.getSheetByName('Produk');

  if (!sh) {
    Logger.log('isiVolumeMlProduk: sheet Produk tidak ditemukan.');
    return { status: 'error', message: 'Sheet Produk tidak ditemukan.' };
  }

  const peta = petaKolomProdukSheet(sh);
  if (peta.col.volume_ml === undefined) {
    const pesan = 'Kolom volume_ml belum ada di sheet Produk. Header sekarang: ' + JSON.stringify(peta.header);
    Logger.log('isiVolumeMlProduk: ' + pesan);
    return { status: 'error', message: pesan };
  }
  if (peta.col.nama === undefined) {
    const pesan = 'Kolom "Nama Produk" tidak ditemukan di sheet Produk.';
    Logger.log('isiVolumeMlProduk: ' + pesan);
    return { status: 'error', message: pesan };
  }

  const iVol = peta.col.volume_ml;
  const iNama = peta.col.nama;
  const iId = peta.col.id;
  const data = sh.getDataRange().getValues();

  const rencana = [];
  for (let i = 1; i < data.length; i++) {
    const nama = String(ambilKolom(data[i], peta, 'nama', '') || '').trim();
    if (!nama) continue;

    const volume = hitungVolumeMl(nama);
    if (!volume) {
      rencana.push({ baris: i + 1, nama: nama, aksi: 'DILEWATI', alasan: 'volume tidak terbaca dari nama' });
      continue;
    }

    const sekarang = ambilKolom(data[i], peta, 'volume_ml', '');
    if (selKosong(sekarang)) {
      rencana.push({
        baris: i + 1,
        id: iId === undefined ? '' : String(ambilKolom(data[i], peta, 'id', '') || ''),
        nama: nama,
        dari: '(kosong)',
        ke: volume,
        aksi: hanyaSimulasi ? 'AKAN DIISI' : 'DIISI'
      });
    } else {
      rencana.push({
        baris: i + 1,
        id: iId === undefined ? '' : String(ambilKolom(data[i], peta, 'id', '') || ''),
        nama: nama,
        dari: sekarang,
        ke: volume,
        aksi: 'DILEWATI',
        alasan: 'sudah terisi (tidak ditimpa)'
      });
    }
  }

  const perluIsi = rencana.filter(p => p.aksi === 'DIISI' || p.aksi === 'AKAN DIISI');

  if (!hanyaSimulasi && perluIsi.length) {
    // Tulis per sel (jumlah kecil, & hanya kolom G) supaya aman bila
    // volume_ml tidak berurutan.
    perluIsi.forEach(p => {
      try {
        sh.getRange(p.baris, iVol + 1).setValue(p.ke);
      } catch (e) {
        p.aksi = 'GAGAL: ' + e;
      }
    });
  }

  Logger.log('=== LAPORAN isiVolumeMlProduk (' + (hanyaSimulasi ? 'SIMULASI, tidak menulis' : 'MENULIS') + ') ===');
  Logger.log('sheet: ' + (ss.getId ? ss.getId() : '(id tidak tersedia)') +
    ' | kolom volume_ml di index ' + iVol + ' (huruf ' + String.fromCharCode(65 + iVol) + ')');
  Logger.log('total baris produk diperiksa: ' + rencana.length + ' | akan diisi: ' + perluIsi.length);
  Logger.log('');
  rencana.forEach(p => {
    Logger.log('  baris ' + p.baris + ' | ' + (p.id || '(tanpa id)') + ' | ' + p.nama +
      ' | ' + p.aksi + ' | ' + p.dari + ' -> ' + p.ke + (p.alasan ? ' (' + p.alasan + ')' : ''));
  });
  Logger.log('');
  Logger.log('Selesai. Baris yang DILEWATI tidak diubah sama sekali.');

  return {
    status: 'success',
    simulasi: !!hanyaSimulasi,
    diperiksa: rencana.length,
    terisi: perluIsi.length,
    rencana: rencana
  };
}

/** True bila sel kosong (null, undefined, "", atau string spasi). */
function selKosong(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/** Format tanggal seragam untuk semua reader (Date → "dd/MM/yyyy HH:mm"). */
function formatTanggalRow(v, timezone) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, timezone, 'dd/MM/yyyy HH:mm');
  }
  if (v == null || v === '') return '';
  return String(v);
}

/**
 * Volume (ml) sebagai ANGKA, atau '' bila kosong.
 * Penting: sheet menyimpan angka 250, tapi reader lama memakai
 * `Number(x || 0)` sehingga volume kosong jadi 0 dan tidak bisa
 * dibedakan dari "volumenya memang 0". Di sini kosong -> ''.
 */
function formatVolumeMl(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

/** Log peringatan kalau pemetaan header tidak sempurna (nullable Logger). */
function catatPetaPeringatan(konteks, peta) {
  const fieldTakAda = [];
  for (const f of Object.keys(PETA_KOLOM_PENJUALAN)) {
    if (peta.col[f] === undefined) fieldTakAda.push(f);
  }
  if (fieldTakAda.length) {
    Logger.log(konteks + ': kolom tidak ditemukan di header sheet Penjualan -> ' +
      fieldTakAda.join(', ') + ' (nilai akan 0/kosong)');
  }
  if (peta.ambigu && peta.ambigu.length) {
    Logger.log(konteks + ': AMBIGU header ' + JSON.stringify(peta.ambigu));
  }
}

// ════════════════════════════════════════════════════════════════
// UJI STAGING — jalankan jalur TULIS yang sama dengan checkout,
// tapi ke sheet yang Anda tentukan secara EXPLICIT (default: dev).
//
// TUJUAN: membuktikan bahwa susunBarisKolom() + peta header menaruh
// setiap field di kolom yang benar di Google Sheets SUNGGUHNYA —
// bukan hanya di mock lokal.
//
// KEAMANAN:
//  - Membuka sheet by ID, TIDAK lewat getSpreadsheet()/ENV. Jadi aunque
//    ENV=production, fungsi ini tetap tidak menyentuh data production.
//  - MENOLAK menulis ke sheet production kecuali argumen kedua true.
//  - Menulis ke baris yang dipastikan KOSONG, jauh di bawah data.
//  - Selalu membersihkan baris uji (try/finally), walau error.
//  - Melaporkan hasil sebelum DAN sesudah pembersihan.
//
// CARA PAKAI (di Apps Script editor):
//   ujiStagingPenjualan()                                  -> sheet dev
//   ujiStagingPenjualan('1CVrF7B3TfTF8LYM5neg14gHfhgRS5O7hELlEMwCAWzk')
//   ujiStagingPenjualan('1CVrF7B3TfTF8LYM5neg14gHfhgRS5O7hELlEMwCAWzk', true)  -> juga bersihkan paksa
// ════════════════════════════════════════════════════════════════

const SS_ID_PROD_KONSTAN = '17nWhZx32MhOWI6OnADqisHwjsmAYrBug4-rRT_CjUJQ';
const SS_ID_DEV_DEFAULT = '1CVrF7B3TfTF8LYM5neg14gHfhgRS5O7hELlEMwCAWzk';

function ujiStagingPenjualan(ssIdTarget, izinkanProduksi) {
  const ssId = String(ssIdTarget || SS_ID_DEV_DEFAULT).trim();
  const log = [];
  const p = function () {
    const s = Array.prototype.join.call(arguments, ' ');
    log.push(s);
    Logger.log(s);
  };

  p('================ UJI STAGING PENJUALAN ================');

  // ── 0. GUARD: jangan pernah menulis ke production tanpa izin eksplisit
  if (ssId === SS_ID_PROD_KONSTAN && izinkanProduksi !== true) {
    p('DITOLAK: target adalah sheet PRODUCTION (' + ssId + ').');
    p('Fungsi ini tidak boleh menyentuh data transaksi production.');
    p('Kalau memang disengaja, panggil dengan argumen kedua true.');
    return { status: 'error', message: 'Menolak menulis ke sheet production.' };
  }
  p('Target sheet id : ' + ssId + (ssId === SS_ID_PROD_KONSTAN ? '  (PRODUCTION - izin eksplisit)' : '  (dev/staging)'));

  // ── 1. BUKA SHEET BY ID (bukan lewat ENV)
  let ss;
  try {
    ss = SpreadsheetApp.openById(ssId);
  } catch (e) {
    p('GAGAL membuka sheet: ' + e);
    return { status: 'error', message: 'Gagal membuka sheet: ' + e };
  }
  p('Sheet terbuka   : ' + ss.getName());
  try {
    p('ScriptProperty ENV saat ini: ' + String(PropertiesService.getScriptProperties().getProperty('ENV') || '(kosong)'));
    p('  ( fungsi ini TIDAK memakainya — sheet dibuka langsung by ID )');
  } catch (e) { }

  // ── 2. CETAK HEADER SHEET PENJUALAN (cek 13 kolom?)
  const sh = ss.getSheetByName('Penjualan');
  if (!sh) {
    p('GAGAL: sheet "Penjualan" tidak ada di spreadsheet ini.');
    p('Daftar sheet: ' + JSON.stringify(ss.getSheets().map(s => s.getName())));
    return { status: 'error', message: 'Sheet Penjualan tidak ada.' };
  }

  const lastRow = sh.getLastRow();
  const maxRows = sh.getMaxRows();
  const maxCols = sh.getMaxColumns();
  p('');
  p('--- (a) STRUKTUR SHEET PENJUALAN ---');
  p('lastRow     : ' + lastRow + '   (baris data: ' + Math.max(0, lastRow - 1) + ')');
  p('maxRows     : ' + maxRows);
  p('maxColumns  : ' + maxCols);
  p('jumlah kolom dipakai (header non-kosong): ' +
    sh.getRange(1, 1, 1, maxCols).getValues()[0].filter(x => String(x || '').trim() !== '').length);

  const headerSheet = sh.getRange(1, 1, 1, maxCols).getValues()[0] || [];
  p('header       : ' + JSON.stringify(headerSheet.map(h => String(h == null ? '' : h))));

  const peta = petaKolomPenjualanSheet(sh);
  p('');
  p('PETA KOLOM HASIL (dari header di atas, bukan asumsi posisi):');
  Object.keys(PETA_KOLOM_PENJUALAN).forEach(field => {
    const i = peta.col[field];
    p('   ' + (field + ':').padEnd(20) + (i === undefined ? 'TIDAK ADA' : ('idx ' + String(i).padStart(2) + '  kolom ' + String.fromCharCode(65 + i) + '   ' + headerSheet[i])));
  });
  if (peta.ambigu && peta.ambigu.length) p('   AMBIGU: ' + JSON.stringify(peta.ambigu));
  if (peta.takDikenali && peta.takDikenali.length) p('   kolom tak dikenali (diabaikan, tidak menggeser): ' + JSON.stringify(peta.takDikenali));

  const kolomPenting = ['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'labaBersih'];
  const hilangPenting = kolomPenting.filter(f => peta.col[f] === undefined);
  p('');
  if (hilangPenting.length) {
    p('*** PERINGATAN: kolom wajib [' + hilangPenting.join(', ') + '] TIDAK ADA di header sheet ini.');
    p('*** Writer AKAN MENOLAK transaksi (fail-safe). Uji tulis dilewati.');
    p('');
    p('=== RINGKASAN: sheet ini TIDAK sesuai untuk menguji writer. ===');
    return {
      status: 'error',
      message: 'Kolom wajib tidak ada: ' + hilangPenting.join(', '),
      header: peta.header,
      peta: peta.col,
      kolomHilang: hilangPenting
    };
  }
  p('Semua kolom wajib ADA. Uji tulis akan dilanjutkan.');
  p('');

  // ── 3. PERSIAPAN: pilih baris yang dipastikan kosong, jauh dari data
  const nBarisUji = 2;
  const MARGIN = 50;   // jarak minimum dari data asli

  // Baris uji HARUS di luar area data. Urutan pilihan:
  //   1) baris 9000 (jauh, tidak terlihat kasir)
  //   2) lastRow + MARGIN, kalau sheet tidak punya cukup baris
  //   3) BATAL — jangan pernah menulis di area data demi "maksa jalan"
  let barisUji = 9000;
  if (barisUji + nBarisUji - 1 > maxRows) {
    barisUji = lastRow + MARGIN;
  }
  p('--- (b) PERSIAPAN BARIS UJI ---');
  p('data terakhir di baris : ' + lastRow);
  p('maxRows sheet          : ' + maxRows);

  if (barisUji <= lastRow || barisUji + nBarisUji - 1 > maxRows) {
    p('*** TIDAK ADA RUANG AMAN untuk uji tulis (butuh minimal baris ' + (lastRow + MARGIN) + ').');
    p('*** Tidak ada yang ditulis. Tambahkan baris kosong di sheet Penjualan, lalu jalankan lagi.');
    return {
      status: 'error',
      ssId: ssId,
      message: 'Sheet tidak punya ruang kosong yang aman untuk uji tulis (maxRows=' + maxRows +
        ', lastRow=' + lastRow + '). Tambahkan baris kosong lalu ulangi.',
      lastRow: lastRow,
      maxRows: maxRows,
      kolomHilang: hilangPenting,
      log: log
    };
  }
  p('baris uji yang dipakai  : ' + barisUji + ' s.d. ' + (barisUji + nBarisUji - 1) +
    '   (jarak dari data: ' + (barisUji - lastRow) + ' baris)');

  // Pastikan baris itu benar-benar kosong sebelum menulis.
  const sebelumUji = sh.getRange(barisUji, 1, nBarisUji, maxCols).getValues();
  const adaIsi = sebelumUji.some(r => r.some(c => String(c == null ? '' : c).trim() !== ''));
  if (adaIsi) {
    p('*** BARIS UJI TIDAK KOSONG — dibatalkan demi keamanan. Tidak ada yang ditulis.');
    return { status: 'error', message: 'Baris uji tidak kosong, dibatalkan.', barisUji: barisUji };
  }
  p('Verifikasi: baris ' + barisUji + ' kosong. Aman untuk ditulis.');

  // ── 4. TULIS lewat jalur yang SAMA dengan checkout sungguhan
  //         (petaKolomPenjualanSheet + susunBarisKolom)
  const contoh = [
    { qty: 2, harga: 14000, hpp: 9000, metode: 'CASH', bayar: 50000 },
    { qty: 1, harga: 20000, hpp: 11000, metode: 'QRIS', bayar: 0 }
  ];
  const nilaiDummy = contoh.map(function (c, i) {
    const totalModal = c.hpp * c.qty;
    return susunBarisKolom({
      id: 'UJI-STAGING-' + (i + 1),
      tanggal: '28/09/2026 10:00',
      namaProduk: i === 0 ? 'Semangci 350 ml' : 'Semangci 500 ml',
      volumeMl: i === 0 ? 350 : 500,
      hppSatuan: c.hpp,
      jumlah: c.qty,
      totalHarga: c.harga * c.qty,
      metode: c.metode,
      uangDibayar: c.bayar,
      uangKembali: c.metode === 'CASH' ? c.bayar - (c.harga * c.qty) : 0,
      modal: totalModal,
      biayaOperasional: 0,
      labaBersih: (c.harga * c.qty) - totalModal
    }, peta);
  });

  const hasilBaca = { rows: [], bersih: false, ditulis: false };
  try {
    p('');
    p('--- (c) TULIS 2 BARIS UJI ---');
    nilaiDummy.forEach(function (row, i) {
      p('baris uji ' + (barisUji + i) + ' yang akan ditulis:');
      headerSheet.forEach(function (h, k) {
        if (k >= row.length) return;
        p('   ' + (String.fromCharCode(65 + k) + '  ' + String(h || '(tanpa nama)')).padEnd(32) + '= ' + (row[k] === '' ? '(kosong)' : row[k]));
      });
      const tanpaKolom = row.__tanpaKolom || [];
      if (tanpaKolom.length) p('   [field dilewati, tidak ada di header: ' + tanpaKolom.join(', ') + ']');
    });

    sh.getRange(barisUji, 1, nBarisUji, nilaiDummy[0].length).setValues(nilaiDummy);
    hasilBaca.ditulis = true;
    p('setValues OK.');

    // ── 5. BACA BALIK per kolom, lalu bersihkan
    p('');
    p('--- (d) HASIL BACA BALIK (dari sheet, bukan dari memori) ---');
    const bacaBalik = sh.getRange(barisUji, 1, nBarisUji, maxCols).getValues();
    for (let i = 0; i < bacaBalik.length; i++) {
      p('--- baris sheet ' + (barisUji + i) + ' ---');
      headerSheet.forEach(function (h, k) {
        if (k >= bacaBalik[i].length) return;
        const v = bacaBalik[i][k];
        p('   ' + (String.fromCharCode(65 + k) + '  ' + String(h || '(tanpa nama)')).padEnd(32) + '= ' + (v === '' || v == null ? '(kosong)' : v));
      });
      hasilBaca.rows.push(bacaBalik[i]);
    }

    // Verifikasi aritmetika: qty x HPP harus sama dengan Modal
    p('');
    p('--- (e) VERIFIKASI ---');
    const r0 = hasilBaca.rows[0] || [];
    // Hanya periksa kolom yang BENAR-BENAR ada di header sheet ini. Kalau
    // sheet dev masih 11 kolom, Volume/HPP memang tidak boleh ada —mengecek
    //nya akan melaporkan GAGAL padahal justru itu perilaku yang benar.
    const cekWajib = [
      ['Jumlah = 2 (BUKAN volume)', ambilKolomAngka(r0, peta, 'jumlah', 0) === 2],
      ['Total Harga = 28000 (BUKAN HPP)', ambilKolomAngka(r0, peta, 'totalHarga', 0) === 28000],
      ['Metode = CASH (BUKAN qty)', ambilKolomTeks(r0, peta, 'metode', '') === 'CASH'],
      ['Modal = 18000 = qty x HPP', ambilKolomAngka(r0, peta, 'modal', 0) === 18000],
      ['Laba bersih = 10000 TERTULIS', ambilKolomAngka(r0, peta, 'labaBersih', 0) === 10000]
    ];
    const cekOpsional = [
      { field: 'volumeMl', label: 'Volume (ml) = 350', ok: ambilKolomAngka(r0, peta, 'volumeMl', 0) === 350 },
      { field: 'hppSatuan', label: 'HPP Satuan = 9000', ok: ambilKolomAngka(r0, peta, 'hppSatuan', 0) === 9000 }
    ];
    let semuaLulus = true;
    cekWajib.forEach(function (c) {
      if (!c[1]) semuaLulus = false;
      p('   ' + (c[1] ? 'LULUS ' : 'GAGAL ') + '  [wajib] ' + c[0]);
    });
    cekOpsional.forEach(function (c) {
      const ada = peta.col[c.field] !== undefined;
      if (!ada) {
        p('   N/A    [opsional] ' + c.label + '  — kolom ini tidak ada di header sheet, jadi dilewati (benar)');
        return;
      }
      if (!c.ok) semuaLulus = false;
      p('   ' + (c.ok ? 'LULUS ' : 'GAGAL ') + '  [opsional] ' + c.label);
    });
    p('');
    p(semuaLulus ? '>>> VERIFIKASI TULIS: SEMUA LULUS' : '>>> VERIFIKASI TULIS: ADA YANG GAGAL (lihat baris GAGAL di atas)');
    hasilBaca.semuaLulus = semuaLulus;
    hasilBaca.cek = cekWajib.concat(cekOpsional.map(function (o) { return [o.label, o.ok]; }));
  } catch (err) {
    p('ERROR saat uji tulis: ' + err);
    hasilBaca.error = String(err);
    hasilBaca.semuaLulus = false;   // error apa pun = verdict GAGAL, jangan sukses palsu
  } finally {
    // ── 6. PEMBERSIHAN (selalu jalan, walau error)
    if (hasilBaca.ditulis) {
      p('');
      p('--- (f) PEMBERSIHAN baris uji ---');
      try {
        const rentang = sh.getRange(barisUji, 1, nBarisUji, maxCols);
        if (typeof rentang.clearContent === 'function') rentang.clearContent();
        else rentang.setValues(nilaiDummy.map(function () { return new Array(maxCols).fill(''); }));

        const setelah = sh.getRange(barisUji, 1, nBarisUji, maxCols).getValues();
        const masihAda = setelah.some(function (r) {
          return r.some(function (c) { return String(c == null ? '' : c).trim() !== ''; });
        });
        hasilBaca.bersih = !masihAda;
        p('baris ' + barisUji + '-' + (barisUji + nBarisUji - 1) + ' dikosongkan.');
        p(masihAda ? 'PERINGATAN: masih ada isi tersisa! Periksa manual.' : 'Verified: baris uji benar-benar KOSONG.');
        p('getLastRow() sekarang : ' + sh.getLastRow() + '  (sebelum uji: ' + lastRow + ')');
        p('Catatan: baris kosong mungkin masih "ada" di sheet sampai kamu hapus manual');
        p('  baris ' + barisUji + '-' + (barisUji + nBarisUji - 1) + ' bila tidak ingin terlihat di layar.');
      } catch (e2) {
        p('GAGAL membersihkan (PERIKSA MANUAL baris ' + barisUji + '-' + (barisUji + nBarisUji - 1) + '): ' + e2);
        hasilBaca.bersih = false;
      }
    } else {
      p('');
      p('--- (f) PEMBERSIHAN: tidak ada yang ditulis, tidak perlu dibersihkan. ---');
      hasilBaca.bersih = true;
    }
  }

  // ── 7. RINGKASAN
  p('');
  p('================ RINGKASAN UJI STAGING ================');
  p('sheet yang diuji      : ' + ss.getName() + ' (' + ssId + ')');
  p('header Penjualan      : ' + JSON.stringify(peta.header.map(function (h) { return String(h || ''); })));
  p('jumlah kolom di header: ' + peta.header.filter(function (h) { return String(h || '').trim() !== ''; }).length +
    (peta.header.filter(function (h) { return String(h || '').trim() !== ''; }).length === 13 ? '  (13 = sesuai layout target)' : '  (BUKAN 13 — perlu ditinjau)'));
  p('kolom wajib lengkap   : ' + (hilangPenting.length ? 'TIDAK (' + hilangPenting.join(', ') + ')' : 'YA'));
  p('baris uji yang dipakai: ' + barisUji + '-' + (barisUji + nBarisUji - 1));
  p('data sukses ditulis   : ' + (hasilBaca.ditulis ? 'YA' : 'TIDAK'));
  p('verifikasi tulis      : ' + (hasilBaca.semuaLulus === true ? 'SEMUA LULUS' : (hasilBaca.semuaLulus === false ? 'ADA YANG GAGAL' : 'tidak dijalankan')));
  p('baris uji dibersihkan : ' + (hasilBaca.bersih ? 'YA' : 'TIDAK — periksa manual'));
  p('======================================================');

  return {
    status: (hasilBaca.semuaLulus && hasilBaca.bersih && !hilangPenting.length) ? 'success' : 'error',
    ssId: ssId,
    header: peta.header,
    peta: peta.col,
    kolomHilang: hilangPenting,
    barisUji: barisUji,
    ditulis: hasilBaca.ditulis,
    semuaLulus: !!hasilBaca.semuaLulus,
    cek: hasilBaca.cek || [],
    bersih: hasilBaca.bersih,
    rows: hasilBaca.rows,
    log: log
  };
}

function loadPOSPage() {
  return HtmlService.createHtmlOutputFromFile('index').getContent();
}

function loadPOSData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Penjualan');

  if (!sheet) {
    return { error: 'Sheet tidak ditemukan! Pastikan nama sheet benar.' };
  }

  return sheet.getDataRange().getValues();
}

function getPageContent(page) {
  if (page === 'pos') return HtmlService.createHtmlOutputFromFile('index').getContent();
  return HtmlService.createHtmlOutputFromFile('Dashboard').getContent();
}

function getSpreadsheet() {
  try {
    var props = PropertiesService.getScriptProperties();
    var env = String(props.getProperty('ENV') || 'development').toLowerCase().trim();

    var ssId;

    if (env === 'production') {
      ssId = props.getProperty('SS_ID_PROD') || '17nWhZx32MhOWI6OnADqisHwjsmAYrBug4-rRT_CjUJQ';
    } else {
      // Ini adalah fallback untuk semua kondisi selain 'production'
      ssId = props.getProperty('SS_ID_DEV') || '1CVrF7B3TfTF8LYM5neg14gHfhgRS5O7hELlEMwCAWzk';
    }

    // Sengaja TANPA Logger.log di jalur ini. Fungsi ini dipanggil hampir di
    // setiap aksi server (baca produk, riwayat, checkout, stok, laporan),
    // sedangkan ENV dan ssId praktis tidak pernah berubah -- jadi lognya
    // selalu isi yang sama persis dan hanya menenggelamkan log yang berguna
    // (HPP kosong, kolom header tidak ketemu, idempotensi).
    return SpreadsheetApp.openById(ssId);
  } catch (e) {
    // Detail ENV + ssId dipindah ke sini: justru di sinilah nilainya
    // dibutuhkan, jadi informasinya tidak hilang, hanya muncul saat relevan.
    Logger.log('Error openById (env=' + env + ', ssId=' + ssId + '), fallback ke getActiveSpreadsheet: ' + e);
    return SpreadsheetApp.getActiveSpreadsheet();
  }
}