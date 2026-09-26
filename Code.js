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
  if (action === 'getInitialData') {
    result = getInitialData.apply(null, args);
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
        dataAwal = getInitialData(60);
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
    return [['id', 'nama', 'stok', 'harga', 'foto_url']];
  }

  // Ambil daftar foto dari Google Drive secara otomatis
  const photoList = getDrivePhotoList();

  // Pastikan header memiliki kolom foto_url di kolom E jika belum ada
  if (data[0].length < 5) {
    try {
      sheet.getRange(1, 5).setValue("foto_url");
    } catch (e) { }
  }

  // Pastikan setiap row memiliki 5 kolom (id, nama, stok, harga, foto_url)
  const result = [];
  result.push(['id', 'nama', 'stok', 'harga', 'foto_url']);

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const id = String(row[0] || '').trim();
    const nama = String(row[1] || '').trim();
    const stok = Number(row[2] || 0);
    const harga = Number(row[3] || 0);
    let fotoUrl = String(row[4] || '').trim();

    // Cocokkan foto dari Google Drive berdasarkan Nama Produk
    const matchedDriveUrl = matchPhotoForProduct(id, nama, photoList);
    if (matchedDriveUrl) {
      fotoUrl = matchedDriveUrl;
      // Auto simpan ke spreadsheet jika di spreadsheet masih kosong
      if (!row[4]) {
        try {
          sheet.getRange(i + 1, 5).setValue(fotoUrl);
        } catch (e) { }
      }
    }

    result.push([
      id,
      nama,
      stok,
      harga,
      fotoUrl
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

  for (let i = 1; i < data.length; i++) {

    // trim() agar ID dengan spasi tak sengaja tetap cocok
    if (String(data[i][0]).trim() === String(idProduk).trim()) {

      let stok = Number(data[i][2]);
      stok += qtyTambah;

      sheet.getRange(i + 1, 3).setValue(stok);

      return "Berhasil menambah stok " +
        data[i][1] +
        " sebanyak " +
        qtyTambah;

    }

  }

  return "ID Produk tidak ditemukan.";

}

/**
 * Ambil Riwayat Penjualan
 */
function getPenjualanData() {

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName("Penjualan");

  if (!sheet) {
    return [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali', 'Modal', 'biayaOperasional', 'labaBersih']];
  }

  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali', 'Modal', 'biayaOperasional', 'labaBersih']];
  }

  const data = sheet.getRange(1, 1, lastRow, 11).getValues();

  const hasil = [];


  const timezone = ss.getSpreadsheetTimeZone();

  hasil.push(data[0]);

  for (let i = 1; i < data.length; i++) {

    let row = data[i];

    if (row[0] == "" || row[1] == "") continue;

    let tanggal = "";

    if (row[1] instanceof Date) {

      tanggal = Utilities.formatDate(
        row[1],
        timezone,
        "dd/MM/yyyy HH:mm"
      );

    } else {

      tanggal = String(row[1]);

    }

    hasil.push([
      String(row[0]),          // ID
      tanggal,                 // Tanggal
      String(row[2] || ""),    // Nama Produk
      Number(row[3] || 0),     // Jumlah
      Number(row[4] || 0),     // Total Harga
      String(row[5] || ""),    // Metode
      Number(row[6] || 0),     // Uang Dibayar
      Number(row[7] || 0),     // Uang Kembali
      Number(row[8] || 0),     // Modal (Kolom I)
      Number(row[9] || 0),     // Biaya Operasional (Kolom J)
      Number(row[10] || 0)     // Laba Bersih (Kolom K)
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
  let produkResult = [['id', 'nama', 'stok', 'harga', 'foto_url']];

  if (shProduk) {
    const dataProduk = shProduk.getDataRange().getValues();

    if (dataProduk.length > 0) {
      // Fast path: jika SEMUA produk sudah punya foto_url tersimpan, JANGAN panggil
      // DriveApp (bisa 3-10 detik per pemanggilan). Pencocokan Drive hanya perlu
      // dilakukan saat ada produk dengan foto kosong (produk baru). Satu pengecualian:
      // jika ada foto_url kosong tapi tidak ada teks sel, tetap jalankan fast path
      // tanpa menulis (kondisi "belum terisi" ditandai string kosong di kolom E).
      let perluCocokkanDrive = false;
      for (let i = 1; i < dataProduk.length; i++) {
        if (!String(dataProduk[i][4] || '').trim()) { perluCocokkanDrive = true; break; }
      }

      const photoList = perluCocokkanDrive ? getDrivePhotoList() : [];
      let photoColUpdate = [["foto_url"]];
      let needsUpdate = false;

      // Pastikan header ada
      if (dataProduk[0].length < 5) {
        needsUpdate = true;
      }

      for (let i = 1; i < dataProduk.length; i++) {
        const row = dataProduk[i];
        const id = String(row[0] || '').trim();
        const nama = String(row[1] || '').trim();
        const stok = Number(row[2] || 0);
        const harga = Number(row[3] || 0);
        let fotoUrl = String(row[4] || '').trim();

        // Cocokkan foto dari Google Drive hanya bila ada foto yang belum terisi
        if (perluCocokkanDrive) {
          const matchedDriveUrl = matchPhotoForProduct(id, nama, photoList);
          if (matchedDriveUrl) {
            fotoUrl = matchedDriveUrl;
            if (!row[4]) {
              needsUpdate = true; // Tandai jika ada sel yang butuh diupdate
            }
          }
        }

        photoColUpdate.push([fotoUrl]);
        produkResult.push([id, nama, stok, harga, fotoUrl]);
      }

      // Batch setValues untuk foto_url jika ada yang perlu diperbarui
      if (needsUpdate) {
        try {
          shProduk.getRange(1, 5, photoColUpdate.length, 1).setValues(photoColUpdate);
        } catch (e) { }
      }
    }
  }

  // ─── 2. PENJUALAN DATA (batch getValues) ───
  const shPenjualan = ss.getSheetByName("Penjualan");
  // v83: header payload hanya 8 kolom (senada baris data — kolom 8-10 tidak
  // dikirim ke klien; frontend membaca baris data mulai index 1).
  const penjualanHeader = ['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali'];
  let penjualanResult = [penjualanHeader];

  if (shPenjualan) {
    const lastRow = shPenjualan.getLastRow();

    if (lastRow > 1) {
      // Baca HANYA jendela baris terbaru (terakhir `limitPenjualan` baris + header),
      // bukan seluruh sheet — baris 490+ per refresh memperlambat payload & respons.
      const jumlahBaris = Math.min(lastRow, limitPenjualan + 1);
      const barisAwal = lastRow - jumlahBaris + 1;
      const dataJual = shPenjualan.getRange(barisAwal, 1, jumlahBaris, 11).getValues();

      penjualanResult = [];
      // Jendela yang dibaca belum tentu memuat baris header (barisAwal > 1),
      // jadi pakai definisi header statis.
      penjualanResult.push(penjualanHeader);

      for (let i = 1; i < dataJual.length; i++) {
        const row = dataJual[i];
        if (row[0] == "" || row[1] == "") continue;

        let tanggal = "";
        if (row[1] instanceof Date) {
          tanggal = Utilities.formatDate(row[1], timezone, "dd/MM/yyyy HH:mm");
        } else {
          tanggal = String(row[1]);
        }

        penjualanResult.push([
          String(row[0]),
          tanggal,
          String(row[2] || ""),
          Number(row[3] || 0),
          Number(row[4] || 0),
          String(row[5] || ""),
          Number(row[6] || 0),
          Number(row[7] || 0)
          // Fase 1 (v83): kolom 8-10 (Modal, biayaOperasional, labaBersih) TIDAK
          // dikirim ke klien — hasil dependency check: POS frontend hanya membaca
          // kolom 0-7; dashboard getPenjualanReport membaca langsung dari sheet;
          // tidak ada export CSV. Sheet tetap menulis 11 kolom (prosesCheckout
          // tidak berubah) — yang dirampingkan hanya payload jaringan.
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

    // Validasi data Produk: minimal harus ada baris header (kolom 0..3 = id, nama, stok, harga).
    if (dataProduk.length < 2 ||
      !Array.isArray(dataProduk[0]) ||
      dataProduk[0].length < 4) {
      return {
        status: "error",
        message: "Data produk belum termuat dengan benar (sheet Produk kosong/bermasalah). Muat ulang halaman lalu coba lagi."
      };
    }

    // Harga satuan & modal diambil dari data produk via Map (O(1) per item).
    // TANPA validasi stok (stok dikelola manual): penjualan tidak diblokir
    // meski angka stok di sheet basi. Stok tetap DIKURANGI di akhir proses.
    const indeksPerId = new Map(); // id produk -> indeks baris di dataProduk
    for (let i = 1; i < dataProduk.length; i++) {
      const kunci = String(dataProduk[i][0] || '').trim();
      if (kunci) indeksPerId.set(kunci, i);
    }

    let grandTotal = 0;
    const validatedItems = [];

    for (const item of cart) {
      const itemId = String(item && item.id != null ? item.id : '').trim();
      const itemNama = String(item && item.nama ? item.nama : '').trim();
      const jumlah = Number(item && item.jumlah != null ? item.jumlah : 0);

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

      const hargaSatuan = Number(produk[3] || 0);
      const totalHargaItem = hargaSatuan * jumlah;
      grandTotal += totalHargaItem;

      const modalRaw = Number(produk[4] ?? produk[5] ?? 0);
      const modalSatuan = Number.isFinite(modalRaw) ? modalRaw : 0;

      validatedItems.push({
        id: itemId,
        nama: itemNama || String(produk[1] || ''),
        jumlah: jumlah,
        hargaSatuan: hargaSatuan,
        totalHarga: totalHargaItem,
        modalSatuan: modalSatuan
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
      finalBayar = Number(uangDibayar);
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
      const barisPenjualan = validatedItems.map(item => {
        const totalModal = item.modalSatuan * item.jumlah;
        const biayaOperasional = 0;
        const labaBersih = item.totalHarga - totalModal - biayaOperasional;
        return [
          transaksi,
          tanggal,
          item.nama,
          item.jumlah,
          item.totalHarga,
          metode,
          finalBayar,
          uangKembali,
          totalModal,
          biayaOperasional,
          labaBersih
        ];
      });

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
        const indeksStok = entriStok.map(e => e[0]);
        const nilaiStok = entriStok.map(e => {
          const stokBaru = Number(dataProduk[e[0] - 1][2] || 0) - e[1];
          dataProduk[e[0] - 1][2] = stokBaru;
          return [stokBaru];
        });
        let k = 0;
        while (k < indeksStok.length) {
          let m = k;
          while (m + 1 < indeksStok.length && indeksStok[m + 1] === indeksStok[m] + 1) m++;
          const jumlahBaris = m - k + 1;
          shProduk
            .getRange(indeksStok[k], 3, jumlahBaris, 1)
            .setValues(nilaiStok.slice(k, m + 1));
          k = m + 1;
        }
      }
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

  // Kolom di sheet Penjualan (sesuai getPenjualanData):
  // 0:id, 1:tanggal, 2:namaProduk, 3:jumlah, 4:totalHarga, 5:metode, 6:uangDibayar, 7:uangKembali
  const timezone = ss.getSpreadsheetTimeZone();

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
    const idTx = row[0];
    const tanggalCell = row[1];
    const namaProduk = String(row[2] || '').trim();
    const jumlah = Number(row[3] || 0);
    const totalHarga = Number(row[4] || 0);
    const metode = String(row[5] || '').trim();

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

    // Log untuk debugging
    Logger.log('ENV yang terdeteksi: ' + env);

    var ssId;

    if (env === 'production') {
      ssId = props.getProperty('SS_ID_PROD') || '17nWhZx32MhOWI6OnADqisHwjsmAYrBug4-rRT_CjUJQ';
    } else {
      // Ini adalah fallback untuk semua kondisi selain 'production'
      ssId = props.getProperty('SS_ID_DEV') || '1CVrF7B3TfTF8LYM5neg14gHfhgRS5O7hELlEMwCAWzk';
    }

    Logger.log('ssId yang dipakai: ' + ssId);
    return SpreadsheetApp.openById(ssId);
  } catch (e) {
    Logger.log('Error openById, fallback ke getActiveSpreadsheet: ' + e);
    return SpreadsheetApp.getActiveSpreadsheet();
  }
}