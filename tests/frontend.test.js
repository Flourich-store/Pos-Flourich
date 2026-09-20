'use strict';

/**
 * ============================================================
 * Pengujian lokal — Frontend index.html (fungsi checkout)
 * Menjalankan blok <script> index.html ASLI di sandbox vm
 * dengan stub DOM/localStorage + mock google.script.run (file:).
 * ============================================================
 */

const { createDomStub, loadFrontend, createRunner } = require('./helpers');

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
