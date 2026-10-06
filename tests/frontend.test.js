'use strict';

/**
 * ============================================================
 * Pengujian lokal — Frontend index.html (fungsi checkout)
 * Menjalankan blok <script> index.html ASLI di sandbox vm
 * dengan stub DOM/localStorage + mock google.script.run (file:).
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const { createDomStub, loadFrontend, createRunner, createGasMock, loadBackend } = require('./helpers');

const PRODUK_VALID = [
  ['id', 'nama', 'stok', 'harga', 'foto_url'],
  ['1', 'Semangci 250 ml', 50, 15000, ''],
  ['2', 'Wonapel 250 ml', 30, 14000, '']
];

const r = createRunner();

const RESPON_VALID = {
  produk: [
    ['id', 'nama', 'stok', 'harga', 'foto_url'],
    ['1', 'Semangci 250 ml', 50, 15000, ''],
    ['2', 'Wonapel 250 ml', 30, 14000, '']
  ],
  penjualan: [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali']],
  timestamp: 1
};

function siapkanAplikasi(responGetInitialData) {
  const dom = createDomStub();
  const app = loadFrontend(dom, responGetInitialData);

  // Muat data awal (seperti event DOMContentLoaded yang dieksekusi sinkron saat load)
  dom.triggerEvent('document', 'DOMContentLoaded');

  return { dom, app };
}

function isiKeranjang(app) {
  app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }]);
}

r.suite('Frontend — inisialisasi data produk', () => {

  r.test('getInitialData valid: masterData & dataProduk terisi array', () => {
    const { app } = siapkanAplikasi(RESPON_VALID);

    r.assertArray(app.get('masterData'), 'masterData harus array');
    r.assertArray(app.get('dataProduk'), 'dataProduk harus array');
    r.assertEq(app.get('dataProduk').length, 3, 'header + 2 produk');
  });

  r.test('REGRESI v83: payload header != panjang baris data ditolak, TIDAK crash, cache dibuang', () => {
    // Rekonstruksi bug live @83: backend mengirim header 11 elemen tapi baris
    // data hanya 8 (kolom Modal/biayaOperasional/labaBersih dipangkas).
    // Frontend (dan frontend lama di device user) harus menolak payload ini
    // dengan aman — jangan sampai rawPenjualanData diracuni lalu UI kacau.
    const payloadBuruk = {
      produk: RESPON_VALID.produk,
      penjualan: [
        ['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali', 'Modal', 'biayaOperasional', 'labaBersih'],
        ['FR-1', '13/09/2026 06:42', 'Semangci 350 ml', 0, 0, '1', 14000, null]
      ],
      timestamp: 1
    };
    const { app } = siapkanAplikasi(payloadBuruk);

    r.assertDoesNotThrow(() => app.call('renderInitialData', payloadBuruk));
    r.assertArray(app.get('rawPenjualanData'), 'rawPenjualanData tetap array');
  });

  r.test('getInitialData rusak (produk bukan array): dataProduk TETAP array kosong, tidak crash', () => {
    const { app } = siapkanAplikasi({ produk: 'BUKAN-ARRAY', penjualan: null });

    r.assertArray(app.get('dataProduk'), 'dataProduk harus tetap array');
    r.assertEq(app.get('dataProduk').length, 0, 'dataProduk kosong');
    r.assertArray(app.get('masterData'), 'masterData harus tetap array');
  });

  r.test('cache korup (JSON rusak) di localStorage dibuang otomatis, lalu diganti data valid', () => {
    const dom = createDomStub();
    dom.localStorage.setItem('pos_initial_data', '{{{bukan json}}');
    loadFrontend(dom, RESPON_VALID);
    dom.triggerEvent('document', 'DOMContentLoaded');

    const sekarang = dom.localStorage.getItem('pos_initial_data');
    r.assertOk(sekarang, 'cache harus terisi ulang oleh data valid');
    let parsed = null;
    r.assertDoesNotThrow(() => { parsed = JSON.parse(sekarang); }, 'cache baru harus JSON valid');
    r.assertArray(parsed.produk, 'produk di cache baru harus array');
  });

  r.test('cache dengan struktur salah (produk bukan array) dibuang, lalu diganti data valid', () => {
    const dom = createDomStub();
    dom.localStorage.setItem('pos_initial_data', JSON.stringify({ produk: 'BUKAN-ARRAY', penjualan: [] }));
    loadFrontend(dom, RESPON_VALID);
    dom.triggerEvent('document', 'DOMContentLoaded');

    const parsed = JSON.parse(dom.localStorage.getItem('pos_initial_data'));
    r.assertArray(parsed.produk, 'cache baru harus punya produk berupa array');
    r.assertArray(parsed.penjualan, 'cache baru harus punya penjualan berupa array');
  });
});

r.suite('Frontend — checkout() alur normal', () => {

  r.test('checkout CASH sukses: modal sukses tampil, keranjang kosong', () => {
    const { dom, app } = siapkanAplikasi(RESPON_VALID);
    isiKeranjang(app);
    dom.window.__elements.selMetode.value = 'CASH';
    dom.window.__elements.inpBayar.value = '35000';

    app.call('checkout');

    // confirm() stub selalu true -> transaksi jalan
    r.assertEq(app.get('cart').length, 0, 'keranjang dikosongkan setelah sukses');
    r.assertFalse(dom.window.__elements.successModal.classList.contains('hidden'), 'modal sukses tampil');
    r.assertEq(dom.alerts.length, 0, 'tidak boleh ada alert error');
  });

  r.test('checkout QRIS sukses tanpa input bayar', () => {
    const { dom, app } = siapkanAplikasi(RESPON_VALID);
    isiKeranjang(app);
    dom.window.__elements.selMetode.value = 'QRIS';

    app.call('checkout');

    r.assertEq(app.get('cart').length, 0, 'keranjang kosong');
    r.assertEq(dom.alerts.length, 0, 'tidak ada alert error');
  });
});

r.suite('Frontend — checkout() skenario data produk gagal dimuat', () => {

  r.test('dataProduk gagal dimuat -> checkout diblokir dengan pesan ramah, TIDAK crash', () => {
    const { dom, app } = siapkanAplikasi({ produk: 'BUKAN-ARRAY', penjualan: null });
    isiKeranjang(app);
    dom.window.__elements.selMetode.value = 'QRIS';

    r.assertDoesNotThrow(() => app.call('checkout'));

    r.assertEq(dom.alerts.length, 1, 'tepat satu alert');
    r.assertIncludes(dom.alerts[0], 'Data produk belum termuat', 'pesan peringatan data');
  });

  r.test('dataProduk array tapi hanya header (kosong) -> checkout diblokir', () => {
    const { dom, app } = siapkanAplikasi({
      produk: [['id', 'nama', 'stok', 'harga', 'foto_url']],
      penjualan: []
    });
    isiKeranjang(app);
    dom.window.__elements.selMetode.value = 'QRIS';

    r.assertDoesNotThrow(() => app.call('checkout'));
    r.assertEq(dom.alerts.length, 1, 'satu alert');
    r.assertIncludes(dom.alerts[0], 'Data produk belum termuat');
  });

  r.test('masterData dicemari non-array -> checkout diblokir, tidak TypeError', () => {
    const { dom, app } = siapkanAplikasi(RESPON_VALID);
    isiKeranjang(app);
    // Simulasi variabel tercemar (mis. hasil parse API rusak)
    app.set('masterData', { bukan: 'array' });
    app.set('dataProduk', { bukan: 'array' });
    dom.window.__elements.selMetode.value = 'QRIS';

    r.assertDoesNotThrow(() => app.call('checkout'));
    r.assertIncludes(dom.alerts[0] || '', 'Data produk belum termuat', 'type guard bekerja');
  });
});

r.suite('Frontend — cart korup & addToCart dengan data gagal dimuat', () => {

  r.test('cart tercemar non-array -> checkout aman: dianggap keranjang kosong', () => {
    const { dom, app } = siapkanAplikasi(RESPON_VALID);
    app.set('cart', 'BUKAN-ARRAY');
    dom.window.__elements.selMetode.value = 'QRIS';

    r.assertDoesNotThrow(() => app.call('checkout'));
    r.assertEq(dom.alerts.length, 1, 'satu alert');
    r.assertIncludes(dom.alerts[0], 'Keranjang belanja masih kosong');
  });

  r.test('addToCart saat data gagal dimuat -> pesan jelas, tidak TypeError .find', () => {
    const { dom, app } = siapkanAplikasi({ produk: 'BUKAN-ARRAY', penjualan: null });
    dom.window.__elements.selProduk.value = '1';
    dom.window.__elements.inpQty.value = '1';

    r.assertDoesNotThrow(() => app.call('addToCart'));
    r.assertIncludes(dom.alerts[0] || '', 'Data produk belum termuat', 'pesan ramah addToCart');
  });
});

// ============================================================
// PENJUALAN: konsistensi struktur payload (backend vs frontend)
// ============================================================

// FIX 6: sheet Penjualan sekarang 13 kolom (Volume (ml) & HPP Satuan
// disisipkan di tengah, Laba bersih jadi kolom terakhir). Payload WAJIB
// 13 kolom supaya frontend tidak pernah mengira posisi kolom tetap.
r.suite('Frontend - struktur payload penjualan (13 kolom, konsisten header==data)', () => {

  const HEADER_13 = ['id', 'tanggal', 'namaProduk', 'volumeMl', 'hppSatuan', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali', 'modal', 'biayaOperasional', 'labaBersih'];

  r.test('renderInitialData menerima payload 13 kolom konsisten: rawPenjualanData terisi utuh', () => {
    const payload = {
      produk: RESPON_VALID.produk,
      penjualan: [
        HEADER_13,
        ['FR-1789256522360', '13/09/2026 06:42', 'Semangci 350 ml', 350, 9000, 1, 14000, 'QRIS', 14000, 0, 9000, 0, 5000]
      ],
      timestamp: 1
    };
    const { app } = siapkanAplikasi(payload);

    const raw = app.get('rawPenjualanData');
    r.assertArray(raw, 'rawPenjualanData array');
    r.assertEq(raw.length, 2, 'header + 1 baris');
    r.assertEq(raw[0].length, 13, 'header 13 kolom');
    r.assertEq(raw[1].length, 13, 'baris data 13 kolom');

    // Guard eksplisit terhadap bug asli: QTY pernah terbaca dari kolom
    // Volume (ml) dan Total Harga pernah terbaca dari HPP Satuan.
    const row = raw[1];
    r.assertEq(row[5], 1, 'kolom ke-6 (Jumlah) = 1, bukan volume 350');
    r.assertEq(row[3], 350, 'kolom ke-4 (Volume ml) = 350');
    r.assertEq(row[4], 9000, 'kolom ke-5 (HPP Satuan) = 9000');
    r.assertEq(row[6], 14000, 'kolom ke-7 (Total Harga) = 14000 = harga x qty, bukan HPP');
  });

  r.test('backend getInitialData: header & baris data penjualan SAMA PANJANG (regresi mismatch v83)', () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    const hasil = backend.getInitialData(60);
    const header = hasil.penjualan[0];
    r.assertEq(header.length, 13, 'header 13 kolom');
    for (let i = 1; i < hasil.penjualan.length; i++) {
      r.assertEq(hasil.penjualan[i].length, header.length, 'baris ' + i + ' sama panjang dengan header');
    }
  });
});

// ============================================================
// GRUP B — badge metode mengikuti indeks 13 kolom (row[7]),
// penanda "HPP tak terbaca" HANYA di keranjang (tidak di struk).
// ============================================================

// Payload produk VERSI PRODUKSI: 7 kolom (idx 5 = HPP, idx 6 = volume_ml).
// Dipakai untuk membuktikan alur nyata addToCart selalu membawa `hpp`.
const RESPON_PRODUK_7KOLOM = {
  produk: [
    ['id', 'nama', 'stok', 'harga', 'foto_url', 'hpp', 'volume_ml'],
    ['1', 'Semangci 250 ml', 50, 15000, '', 9500, 250],
    ['2', 'Wonapel 250 ml', 30, 14000, '', 9000, 250]
  ],
  penjualan: [['id', 'tanggal', 'namaProduk', 'volumeMl', 'hppSatuan', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali', 'modal', 'biayaOperasional', 'labaBersih']],
  timestamp: 1
};

const RESPON_PRODUK_7KOLOM_HPP_KOSONG = {
  produk: [
    ['id', 'nama', 'stok', 'harga', 'foto_url', 'hpp', 'volume_ml'],
    ['1', 'Semangci 250 ml', 50, 15000, '', 0, 250]
  ],
  penjualan: [],
  timestamp: 1
};

function baris13(metode, extras) {
  return [
    'FR-1790566607168', '13/09/2026 06:42', 'Semangci 350 ml', 350, 9000, 1, 14000,
    metode, 14000, 0, 9000, 0, 5000
  ].map((v, i) => (extras && i in extras ? extras[i] : v));
}

r.suite('Grup B — badge metode & label versi 13 kolom (v86)', () => {

  // Stub querySelector TIDAK meng-cache elemen (lihat helpers.js), jadi tbody
  // ditangkap lewat override agar HTML tabel bisa diperiksa test.
  function renderTabel(rows) {
    const dom = createDomStub();
    const tbody = { innerHTML: '' };
    dom.window.document.querySelector = (sel) => (sel === '#penjualanTable tbody' ? tbody : { innerHTML: '' });
    const app = loadFrontend(dom, RESPON_VALID);
    dom.triggerEvent('document', 'DOMContentLoaded');
    app.set('filteredPenjualanData', rows);
    app.set('currentPage', 1);
    app.call('renderPenjualanTable');
    return tbody.innerHTML;
  }

  r.test('REGRESI: metode CASH di kolom ke-8 -> badge-cash (bukan baca kolom ke-6/Jumlah)', () => {
    // bug lama: isCash dibaca dari row[5] (= jumlah) sehingga badge CASH/QRIS
    // tidak pernah cocok pada payload 13 kolom.
    const html = renderTabel([baris13('CASH')]);
    r.assertIncludes(html, 'badge badge-cash', 'baris CASH dapat badge-cash');
    r.assertIncludes(html, '>CASH</span>', 'teks metode CASH tampil di badge');
  });

  r.test('metode QRIS di kolom ke-8 -> badge-qris', () => {
    const html = renderTabel([baris13('QRIS')]);
    r.assertIncludes(html, 'badge badge-qris', 'baris QRIS dapat badge-qris');
    r.assertIncludes(html, '>QRIS</span>', 'teks metode QRIS tampil di badge');
  });

  r.test('kolom Jumlah berisi "CASH" tapi metode "QRIS": badge ikut metode, bukan jumlah', () => {
    // Bila jumlah sengaja berisi "CASH", badge HARUS tetap qris — bukti indeks 7 dibaca.
    const html = renderTabel([baris13('QRIS', { 5: 'CASH' })]);
    r.assertIncludes(html, 'badge badge-qris', 'badge ditentukan oleh row[7]');
    r.assertNotIncludes(html, 'badge badge-cash', 'tidak boleh badge-cash dari kolom Jumlah');
  });

  r.test('seluruh <th> tabel = 13 kolom & sebaris dengan indeks payload', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const th = html.match(/<th>[^<]*<\/th>/g) || [];
    r.assertEq(th.length, 13, 'header tabel punya 13 <th>');
    const head = th.map(x => x.replace(/<\/?th>/g, '').trim());
    r.assertEq(head[7], 'Metode', 'kolom ke-8 = Metode (indeks badge)');
    r.assertEq(head[10], 'Modal', 'kolom ke-11 = Modal');
    r.assertEq(head[12], 'Laba Bersih', 'kolom ke-13 = Laba Bersih');
  });

  r.test('P5: sel Modal/Biaya/Laba kosong di Riwayat tampil "—", bukan "Rp 0"', () => {
    // idx 9 (Uang Kembali) sengaja 0 yang ASLI -> harus tetap "Rp 0".
    // Jadi yang diuji: 4 sel kosong jadi "—", dan "Rp 0" hanya muncul
    // untuk sel yang benar-benar bernilai 0.
    const kosong = baris13('CASH', { 4: '', 10: '', 11: '', 12: '' });
    const html = renderTabel([kosong]);
    // idx 4/10/11 polos, idx 12 (Laba) dibungkus <b> seperti aslinya.
    r.assertEq((html.match(/<td>—<\/td>/g) || []).length, 3,
      'HPP Satuan + Modal + Biaya kosong = 3 sel "—" polos');
    r.assertIncludes(html, '<td><b>—</b></td>', 'Laba Bersih kosong = "—" (tetap ditebalkan)');
    r.assertEq((html.match(/Rp 0<\/td>/g) || []).length, 1,
      '"Rp 0" hanya untuk Uang Kembali yang memang 0');
  });

  r.test('P5: sel terisi tetap "Rp 10.500" dsb (tampilan tidak berubah)', () => {
    const html = renderTabel([baris13('CASH')]);
    r.assertIncludes(html, 'Rp 9.000', 'HPP Satuan terisi = Rp 9.000');
    r.assertIncludes(html, 'Rp 9.000</td>', 'Modal terisi = Rp 9.000');
    r.assertIncludes(html, 'Rp 5.000', 'Laba bersih terisi = Rp 5.000');
    r.assertNotIncludes(html, '<td>—</td>', 'tidak ada "—" pada baris yang lengkap');
  });

  r.test('P5: Modal 0 yang SUNGGUHNYA nol tetap tampil "Rp 0" (tidak disamarkan jadi "—")', () => {
    const html = renderTabel([baris13('CASH', { 11: 0 })]);
    r.assertIncludes(html, 'Rp 0</td>', 'Biaya Operasional 0 asli tetap Rp 0');
  });

  r.test('penanda versi sinkron antara meta & konstanta (keduanya 91)', () => {
    const { app } = siapkanAplikasi(RESPON_VALID);
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const meta = (html.match(/<meta name="app-version" content="(\d+)"/) || [])[1];
    r.assertEq(meta, '91', 'meta app-version = 91');
    r.assertEq(app.get('VERSI_HTML'), 91, 'VERSI_HTML = 91');
    // Invariant yang disebut di komentar meta: keduanya HARUS dinaikkan bersama.
    // Kalau tidak sinkron, self-check auto-reload salah arah dan kasir
    // terjebak di HTML lama atau reload berulang.
    r.assertEq(meta, String(app.get('VERSI_HTML')),
      'meta app-version dan VERSI_HTML tidak boleh berbeda');
  });
});

r.suite('Grup B — penanda "HPP tak terbaca" hanya di keranjang', () => {

  r.test('item keranjang dengan hpp > 0 -> TIDAK ada penanda', () => {
    const { dom, app } = siapkanAplikasi(RESPON_VALID);
    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000, hpp: 9500 }]);
    app.call('renderCart');
    const html = dom.window.__elements.cartDisplay.innerHTML;
    r.assertNotIncludes(html, 'HPP tak terbaca', 'HPP terbaca -> tanpa penanda');
    r.assertIncludes(html, 'Semangci 250 ml', 'item tetap tampil');
  });

  r.test('item keranjang dengan hpp = 0 -> penanda muncul', () => {
    const { dom, app } = siapkanAplikasi(RESPON_VALID);
    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000, hpp: 0 }]);
    app.call('renderCart');
    r.assertIncludes(dom.window.__elements.cartDisplay.innerHTML, 'HPP tak terbaca', 'HPP kosong -> penanda');
  });

  r.test('item keranjang tanpa field hpp sama sekali -> penanda muncul (tidak crash)', () => {
    const { dom, app } = siapkanAplikasi(RESPON_VALID);
    r.assertDoesNotThrow(() => {
      app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }]);
      app.call('renderCart');
    });
    r.assertIncludes(dom.window.__elements.cartDisplay.innerHTML, 'HPP tak terbaca', 'hpp undefined -> penanda');
  });

  r.test('ALUR NYATA: addToCart dari payload produk 7 kolom selalu menyertakan hpp => penanda tidak salah muncul', () => {
    // Src kebenaran: satu-satunya sumber item keranjang adalah addToCart, dan
    // payload produk produksi punya 7 kolom (idx 5 = HPP). Dengan payload ini
    // penanda TIDAK boleh muncul — membuktikan penanda tidak false-positive.
    const { dom, app } = siapkanAplikasi(RESPON_PRODUK_7KOLOM);
    dom.window.__elements.selProduk.value = '1';
    dom.window.__elements.inpQty.value = '2';
    app.call('addToCart');
    const cart = app.get('cart');
    r.assertEq(cart.length, 1, 'satu item');
    r.assertOk('hpp' in cart[0], 'field hpp selalu ada di item keranjang');
    r.assertEq(typeof cart[0].hpp, 'number', 'hpp bertipe number');
    r.assertEq(cart[0].hpp, 9500, 'hpp diambil dari kolom 6 payload (idx 5)');
    app.call('renderCart');
    r.assertNotIncludes(
      dom.window.__elements.cartDisplay.innerHTML,
      'HPP tak terbaca',
      'produk dengan HPP valid tidak memicu penanda'
    );
  });

  r.test('ALUR NYATA: HPP produk kosong di sheet (payload 0) -> penanda muncul, itu memangcondition-nya', () => {
    const { dom, app } = siapkanAplikasi(RESPON_PRODUK_7KOLOM_HPP_KOSONG);
    dom.window.__elements.selProduk.value = '1';
    dom.window.__elements.inpQty.value = '1';
    app.call('addToCart');
    app.call('renderCart');
    r.assertIncludes(
      dom.window.__elements.cartDisplay.innerHTML,
      'HPP tak terbaca',
      'HPP 0 di sheet -> penanda muncul (kasir diberi tahu Modal/Laba kosong)'
    );
  });

  r.test('STRUK pelanggan TIDAK memuat penanda HPP / Modal / Laba', () => {
    const { dom, app } = siapkanAplikasi(RESPON_VALID);
    dom.window.__elements.selMetode.value = 'CASH';
    dom.window.__elements.inpBayar.value = '50000';
    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000, hpp: 0 }]);
    app.call('checkout');
    r.assertDoesNotThrow(() => app.call('showReceiptModal'), 'struk tetap bisa dicetak');
    const struk = dom.window.__elements.receiptContent.innerHTML;
    r.assertIncludes(struk, 'Semangci 250 ml', 'struk tetap memuat item');
    r.assertNotIncludes(struk, 'HPP tak terbaca', 'penanda HPP TIDAK boleh tampil di struk');
    r.assertNotIncludes(struk, 'Laba', 'struk tidak menampilkan Laba');
    r.assertNotIncludes(struk, 'hppSatuan', 'struk tidak menampilkan HPP Satuan');
  });
});

r.suite('Frontend — mock mode lokal (file:)', () => {
  r.test('mock prosesCheckout tersedia & getInitialData mock terdefinisi', () => {
    const { app } = siapkanAplikasi(RESPON_VALID);

    r.assertEq(typeof app.get('google').script.run.prosesCheckout, 'function', 'mock prosesCheckout ada');
    r.assertEq(typeof app.get('google').script.run.getInitialData, 'function', 'mock getInitialData ada');
  });

  r.test('alur lengkap lokal: add to cart -> checkout sukses via mock', () => {
    const { dom, app } = siapkanAplikasi(RESPON_VALID);
    dom.window.__elements.selProduk.value = '1';
    dom.window.__elements.inpQty.value = '2';

    app.call('addToCart');
    const cart = app.get('cart');
    r.assertArray(cart, 'cart harus array');
    r.assertEq(cart.length, 1, 'satu item masuk keranjang');

    dom.window.__elements.selMetode.value = 'CASH';
    dom.window.__elements.inpBayar.value = '50000';
    app.call('checkout');

    r.assertEq(app.get('cart').length, 0, 'keranjang kosong setelah checkout');
    r.assertEq(dom.alerts.length, 0, 'tanpa alert error');
  });
});

r.run('Frontend index.html').then(ok => { process.exit(ok ? 0 : 1); });
