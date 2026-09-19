/*************************************************
 * FLOU RICH POS
 * Code.gs
 * Version : 1.0 Final
 *************************************************/

/**
 * Menampilkan halaman utama (POS-only entrypoint)
 * Penting: hindari routing page=dashboard di file POS agar login POS tidak bentrok.
 */
function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('FLOU RICH - POS')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    const requestData = JSON.parse(e.postData.contents);
    const action = requestData.action;
    const args = requestData.args || [];
    
    let result;
    if (action === 'checkLogin') {
      result = checkLogin(args[0], args[1]);
    } else {
      result = { status: false, message: "Action tidak dikenal: " + action };
    }
    
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: false, message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Login POS
 */
function checkLogin(username, password) {

  const sheet = getSpreadsheet().getSheetByName("User");

  if (!sheet) return {status: false, message: "Sheet User tidak ditemukan"};

  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {

    const user = String(data[i][0]).trim();
    const pass = String(data[i][1]).trim();

    if (
      user === String(username).trim() &&
      pass === String(password).trim()
    ) {
      return {
        status: true,
        username: user,
        role: data[i][2] || "KASIR"
      };
    }

  }

  return {status: false, message: "Username atau password salah"};
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
function tambahStokProduk(idProduk, qtyTambah, role) {

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

  for (let i = 1; i < data.length; i++) {

    if (String(data[i][0]) === String(idProduk)) {

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
 * Checkout
 */
function prosesCheckout(cart, metode, uangDibayar) {
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

    const dataProduk = shProduk.getDataRange().getValues();
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

      const produkIndex = dataProduk.findIndex(row => String(row[0] || '').trim() === itemId);
      if (produkIndex <= 0) {
        return { status: "error", message: "Produk ID " + itemId + " tidak ditemukan." };
      }

      const produk = dataProduk[produkIndex];
      const hargaSatuan = Number(produk[3] || 0);
      const stokTersedia = Number(produk[2] || 0);
      if (jumlah > stokTersedia) {
        return { status: "error", message: "Stok " + (itemNama || produk[1] || itemId) + " tidak mencukupi." };
      }

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

    for (const item of validatedItems) {
      const totalModal = item.modalSatuan * item.jumlah;
      const biayaOperasional = 0;
      const labaBersih = item.totalHarga - totalModal - biayaOperasional;

      shPenjualan.appendRow([
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
      ]);

      const produkIndex = dataProduk.findIndex(row => String(row[0] || '').trim() === item.id);
      if (produkIndex > 0) {
        const stokBaru = Number(dataProduk[produkIndex][2] || 0) - item.jumlah;
        dataProduk[produkIndex][2] = stokBaru;
        shProduk.getRange(produkIndex + 1, 3).setValue(stokBaru);
      }
    }

    return {
      status: "success",
      transaksi: transaksi,
      total: grandTotal,
      bayar: finalBayar,
      kembali: uangKembali,
      metode: metode
    };

  } catch (err) {
    return {
      status: "error",
      message: "Error sistem: " + err.toString()
    };
  }
}

/**
 * Reset stok harian
 */
function resetStokHarian(){

  const ss = getSpreadsheet();

  const sheet = ss.getSheetByName("Produk");

  if(!sheet) return;

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
function createDailyTrigger(){

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
  topProducts.sort((a,b) => (b.qty - a.qty));

  return {
    txCount: txCount,
    grossTotal: grossTotal,
    netTotal: grossTotal,
    topProducts: topProducts.slice(0, 10)
  };
}

function loadPOSPage() {
  return HtmlService.createHtmlOutputFromFile('Index').getContent();
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
  if (page === 'pos') return HtmlService.createHtmlOutputFromFile('Index').getContent();
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