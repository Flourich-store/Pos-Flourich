'use strict';

/**
 * ============================================================
 * Pengujian lokal — Frontend index.html: Modal QRIS (v93)
 * Modal QR QRIS statis tampil saat kasir memilih QRIS lalu
 * menekan PROSES TRANSAKSI, SEBELUM alur checkout asli berjalan.
 *
 * Yang diuji:
 *  1. Modal muncul HANYA untuk QRIS — Tunai tidak tersentuh.
 *  2. Nominal di modal = total keranjang.
 *  3. "Batal" TIDAK memanggil checkout & keranjang tetap utuh.
 *  4. "Sudah Dibayar" memanggil checkout TEPAT SATU KALI
 *     (tahan klik ganda) lalu jalur asli tetap berjalan.
 *  5. Modal bisa ditutup dari tombol Batal dan X (close).
 *
 * Harness: skenario file: (protocol 'file:' di helpers -> mock
 * google.script.run). Stub setTimeout sinkron (delay<=5000ms).
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

const CART = [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }];

function siapkanQris(opts) {
  opts = opts || {};
  const dom = createDomStub();
  const app = loadFrontend(dom, RESPON_VALID);
  dom.triggerEvent('document', 'DOMContentLoaded');

  const panggilanCheckout = [];
  // Dalam mode file:, google.script.run.prosesCheckout adalah mock bawaan
  // helpers. Ganti dengan pencatat panggilan agar bisa dihitung jumlahnya.
  dom.window.google.script.run.prosesCheckout = function (cart, metode) {
    panggilanCheckout.push({ jumlahItem: (cart || []).length, metode: metode });
    return { status: 'success', transaksi: 'FR-QRIS-TES', total: 30000, bayar: 30000, kembali: 0, metode: metode };
  };

  app.set('cart', CART.map(it => Object.assign({}, it)));
  dom.window.__elements.selMetode.value = 'QRIS';
  dom.alerts.length = 0;
  dom.confirms.length = 0;
  if (opts.confirm === false) {
    // sandbox menangkap w.confirm SAAT loadFrontend — timpa di sandbox
    // (bukan di dom.window) agar checkout() asli melihat stub ini.
    app.sandbox.confirm = function () { return false; };
  }

  return { dom, app, panggilanCheckout };
}

// ============================================================
// 1. Modal muncul hanya untuk QRIS, bukan Tunai
// ============================================================

r.suite('Modal QRIS — intersepsi hanya untuk QRIS', () => {

  r.test('QRIS + PROSES TRANSAKSI -> modal QRIS tampil, checkout BELUM dipanggil', () => {
    const { dom, app, panggilanCheckout } = siapkanQris();

    app.call('checkout');

    r.assertFalse(
      dom.window.document.getElementById('qrisModal').classList.contains('hidden'),
      'modal QRIS tampil (hidden dihapus)');
    r.assertEq(panggilanCheckout.length, 0, 'checkout backend belum dipanggil saat modal tampil');
  });

  r.test('CASH + PROSES TRANSAKSI -> modal QRIS TIDAK tampil, checkout langsung jalan', () => {
    const dom = createDomStub();
    const app = loadFrontend(dom, RESPON_VALID);
    dom.triggerEvent('document', 'DOMContentLoaded');
    const panggilanCheckout = [];
    dom.window.google.script.run.prosesCheckout = function (cart, metode) {
      panggilanCheckout.push({ metode: metode });
      return { status: 'success', transaksi: 'FR-CASH-TES', total: 30000, bayar: 35000, kembali: 5000, metode: metode };
    };

    app.set('cart', CART.map(it => Object.assign({}, it)));
    dom.window.__elements.selMetode.value = 'CASH';
    dom.window.__elements.inpBayar.value = '35000';

    app.call('checkout');

    r.assertOk(
      dom.window.document.getElementById('qrisModal').classList.contains('hidden'),
      'modal QRIS tetap tersembunyi untuk Tunai');
    r.assertEq(panggilanCheckout.length, 1, 'checkout Tunai langsung dipanggil, tanpa modal');
    r.assertEq(panggilanCheckout[0].metode, 'CASH', 'metode yang dikirim CASH');
  });
});

// ============================================================
// 2. Nominal di modal = total keranjang
// ============================================================

r.suite('Modal QRIS — nominal total', () => {

  r.test('teks nominal modal = total keranjang terformat Rp 30.000', () => {
    const { dom, app } = siapkanQris();

    app.call('checkout');

    r.assertEq(
      dom.window.document.getElementById('qrisTotalAmount').textContent,
      'Rp 30.000',
      'nominal modal = total keranjang');
  });

  r.test('subtotal multi-item dijumlahkan: 30.000 + 14.000 = Rp 44.000', () => {
    const { dom, app } = siapkanQris();
    app.set('cart', [
      { id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 },
      { id: '2', nama: 'Wonapel 250 ml', jumlah: 1, total: 14000 }
    ]);

    app.call('checkout');

    r.assertEq(
      dom.window.document.getElementById('qrisTotalAmount').textContent,
      'Rp 44.000',
      'nominal modal = jumlah semua item keranjang');
  });

  r.test('buka ulang modal dengan keranjang baru -> nominal di-refresh (tidak menempel nilai lama)', () => {
    const { dom, app } = siapkanQris();
    app.call('checkout'); // tampil Rp 30.000
    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }]);
    app.call('tutupModalQris');
    app.call('checkout');

    r.assertEq(
      dom.window.document.getElementById('qrisTotalAmount').textContent,
      'Rp 15.000',
      'nominal mengikuti keranjang terbaru');
  });
});

// ============================================================
// 3. Batal: tidak memanggil checkout, keranjang utuh
// ============================================================

r.suite('Modal QRIS — tombol Batal', () => {

  r.test('Batal: modal tertutup, checkout backend TIDAK dipanggil, keranjang tetap utuh', () => {
    const { dom, app, panggilanCheckout } = siapkanQris();
    app.call('checkout'); // modal tampil

    app.call('tutupModalQris');

    r.assertOk(
      dom.window.document.getElementById('qrisModal').classList.contains('hidden'),
      'modal tertutup');
    r.assertEq(panggilanCheckout.length, 0, 'checkout TIDAK dipanggil setelah Batal');
    r.assertEq(app.get('cart').length, 1, 'keranjang tetap utuh (tidak dikosongkan)');
  });

  r.test('setelah Batal, kasir bisa PROSES TRANSAKSI lagi -> modal tampil ulang', () => {
    const { dom, app } = siapkanQris();
    app.call('checkout');
    app.call('tutupModalQris');
    app.call('checkout');

    r.assertFalse(
      dom.window.document.getElementById('qrisModal').classList.contains('hidden'),
      'modal tampil lagi setelah PROSES TRANSAKSI kedua');
  });
});

// ============================================================
// 4. Sudah Dibayar: checkout tepat satu kali (+ tahan klik ganda)
// ============================================================

r.suite('Modal QRIS — tombol Sudah Dibayar', () => {

  r.test('konfirmasiQrisDibayar(): modal tertutup & checkout backend dipanggil TEPAT 1x', () => {
    const { dom, app, panggilanCheckout } = siapkanQris();
    app.call('checkout');

    app.call('konfirmasiQrisDibayar');

    r.assertOk(
      dom.window.document.getElementById('qrisModal').classList.contains('hidden'),
      'modal tertutup saat pembayaran dikonfirmasi');
    r.assertEq(panggilanCheckout.length, 1, 'checkout backend dipanggil tepat satu kali');
    r.assertEq(panggilanCheckout[0].metode, 'QRIS', 'metode QRIS diteruskan ke alur asli');
  });

  r.test('TELAH KLIK GANDA: konfirmasiQrisDibayar() 2x berurutan -> checkout tetap TEPAT 1x', () => {
    const { app, panggilanCheckout } = siapkanQris();
    app.call('checkout');

    app.call('konfirmasiQrisDibayar'); // klik pertama
    app.call('konfirmasiQrisDibayar'); // klik ganda (cek)

    r.assertEq(panggilanCheckout.length, 1, 'klik ganda tidak memicu checkout kedua');
  });

  r.test('checkout asli tetap berjalan: modal sukses tampil & keranjang kosong setelah konfirmasi', () => {
    const { dom, app, panggilanCheckout } = siapkanQris();
    app.call('checkout');
    app.call('konfirmasiQrisDibayar');

    r.assertEq(app.get('cart').length, 0, 'keranjang dikosongkan oleh alur asli');
    r.assertFalse(
      dom.window.__elements.successModal.classList.contains('hidden'),
      'modal sukses tampil dari alur asli');
    r.assertEq(panggilanCheckout[0].jumlahItem, 1, 'cart dikirim ke backend utuh');
  });

  r.test('setelah konfirmasi, PROSES TRANSAKSI lagi (keranjang baru) -> modal tampil ULANG, tidak langsung checkout', () => {
    const { dom, app, panggilanCheckout } = siapkanQris();
    app.call('checkout');
    app.call('konfirmasiQrisDibayar'); // transaksi pertama jalan
    app.set('cart', CART.map(it => Object.assign({}, it)));
    app.call('checkout'); // keranjang baru

    r.assertFalse(
      dom.window.document.getElementById('qrisModal').classList.contains('hidden'),
      'modal tampil ulang untuk transaksi QRIS baru');
    r.assertEq(panggilanCheckout.length, 1, 'checkout pertama tetap hanya satu kali');
  });
});

// ============================================================
// 5. Modal bisa ditutup via tombol X (tutupModalQris)
// ============================================================

r.suite('Modal QRIS — penutupan modal', () => {

  r.test('tutupModalQris() dipasang di handler tombol X & tombol Batal di HTML modal', () => {
    const { dom } = siapkanQris();
    const html = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'index.html'), 'utf8');
    // Quirk harness: __elements cache elemen ad-hoc, tapi handler onclick
    // asli ada di HTML. Uji wiring-nya via markup:
    const htmlModal = html.slice(html.indexOf('id="qrisModal"'));
    r.assertOk(htmlModal.includes('onclick="tutupModalQris()"'),
      'tombol X & Batal memanggil tutupModalQris()');
    r.assertOk(htmlModal.includes('onclick="konfirmasiQrisDibayar()"'),
      'tombol Sudah Dibayar memanggil konfirmasiQrisDibayar()');
  });

  r.test('modal QRIS terdaftar sebagai elemen awal (tidak bergantung cache ad-hoc)', () => {
    const html = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'index.html'), 'utf8');
    r.assertOk(html.includes('id="qrisModal"'), 'elemen qrisModal ada di HTML');
    r.assertOk(html.includes('id="qrisTotalAmount"'), 'elemen nominal ada di HTML');
  });
});

// ============================================================
// 6. Confirm asli tetap berlaku di alur Sudah Dibayar
// ============================================================

r.suite('Modal QRIS — alur asli tidak berubah', () => {

  r.test('konfirmasi via Sudah Dibayar -> confirm() asli checkout tetap muncul SEKALI (double-check)', () => {
    const { dom, app } = siapkanQris();
    app.call('checkout');

    app.call('konfirmasiQrisDibayar');

    r.assertEq(dom.confirms.length, 1, 'confirm alur asli muncul tepat 1x (tidak dihilangkan, tidak dobel)');
    // note: confirms tetap 0 bila stub sandbox dipakai; skenario ini stub default (selalu true)
  });

  r.test('jika confirm dibatalkan oleh kasir: checkout TIDAK dipanggil, keranjang tetap utuh', () => {
    const { app, panggilanCheckout } = siapkanQris({ confirm: false });

    app.call('checkout');                    // modal tampil
    app.call('konfirmasiQrisDibayar');       // Sudah Dibayar, tapi confirm dibatalkan

    r.assertEq(panggilanCheckout.length, 0, 'checkout tidak jalan saat confirm dibatalkan');
    r.assertEq(app.get('cart').length, 1, 'keranjang tetap utuh');
  });
});

r.run('Modal QRIS v93 (statis QR 440% crop 300px)').then(ok => { process.exit(ok ? 0 : 1); });
