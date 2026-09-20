'use strict';

/**
 * ============================================================
 * Pengujian lokal — Stok langsung berubah di UI
 * Skenario: setelah checkout sukses stok LANGSUNG berkurang,
 * setelah tambah stok sukses stok LANGSUNG bertambah,
 * tanpa perlu refresh halaman (regresi bug lama: fetchData()
 * hanya me-render cache lama yang tidak pernah diperbarui).
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

const RESPON_STOK_BARU = {
  produk: [
    ['id', 'nama', 'stok', 'harga', 'foto_url'],
    ['1', 'Semangci 250 ml', 48, 15000, ''],
    ['2', 'Wonapel 250 ml', 27, 14000, '']
  ],
  penjualan: [
    ['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali'],
    ['FR-1', '20/09/2026 10:00', 'Semangci 250 ml', 2, 30000, 'CASH', 35000, 5000]
  ],
  timestamp: 2
};

const RESPON_STOK_DITAMBAH = {
  produk: [
    ['id', 'nama', 'stok', 'harga', 'foto_url'],
    ['1', 'Semangci 250 ml', 60, 15000, ''],
    ['2', 'Wonapel 250 ml', 30, 14000, '']
  ],
  penjualan: [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali']],
  timestamp: 3
};

function stokProduk(app, id) {
  const dp = app.get('dataProduk');
  if (!Array.isArray(dp)) return undefined;
  const row = dp.find(x => String(x[0]) === String(id));
  return row ? Number(row[2]) : undefined;
}

function stokDiCache(dom, id) {
  const raw = dom.localStorage.getItem('pos_initial_data');
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  const row = parsed.produk.find(x => String(x[0]) === String(id));
  return row ? Number(row[2]) : undefined;
}

r.suite('Stok langsung berkurang setelah checkout sukses', () => {

  r.test('stok lokal berkurang SEKETIKA sebelum refresh server (optimistic update)', () => {
    const { dom, app } = loadStokSkenario(RESPON_VALID, RESPON_STOK_BARU);
    isiKeranjangDanCheckout(app, dom);

    r.assertEq(stokProduk(app, '1'), 48, 'stok produk 1 langsung 50-2=48 di UI');
    r.assertEq(stokDiCache(dom, '1'), 48, 'cache ikut diperbarui');
  });

  r.test('semua item di keranjang multi-produk ikut mengurangi stok masing-masing', () => {
    const { dom, app } = loadStokSkenario(RESPON_VALID, RESPON_STOK_BARU);
    app.set('cart', [
      { id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 },
      { id: '2', nama: 'Wonapel 250 ml', jumlah: 3, total: 42000 }
    ]);
    dom.window.__elements.selMetode.value = 'QRIS';
    app.call('checkout');

    r.assertEq(stokProduk(app, '1'), 48, 'stok produk 1 berkurang 2');
    r.assertEq(stokProduk(app, '2'), 27, 'stok produk 2 berkurang 3');
  });

  r.test('refreshData mengganti data dengan hasil server terbaru (bukan cache lama)', () => {
    const { dom, app } = loadStokSkenario(RESPON_VALID, RESPON_STOK_BARU);
    isiKeranjangDanCheckout(app, dom);

    r.assertEq(stokProduk(app, '1'), 48, 'stok dari server terbaru');
    // Riwayat penjualan juga terisi dari server: 1 baris transaksi + header
    const rawJual = app.get('rawPenjualanData');
    r.assertArray(rawJual, 'rawPenjualanData harus array');
    r.assertEq(rawJual.length, 2, 'header + 1 transaksi baru tampil tanpa refresh');
  });

  r.test('checkout gagal (stok kurang) TIDAK mengubah stok lokal', () => {
    const dom = createDomStub();
    // Respon checkout gagal dikirim lewat mock prosesCheckout khusus
    const app = loadFrontend(dom, RESPON_VALID);
    dom.triggerEvent('document', 'DOMContentLoaded');
    dom.window.google.script.run.prosesCheckout = function () {
      return { status: 'error', message: 'Stok Semangci 250 ml tidak mencukupi.' };
    };

    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 999, total: 999 * 15000 }]);
    dom.window.__elements.selMetode.value = 'QRIS';
    app.call('checkout');

    r.assertEq(stokProduk(app, '1'), 50, 'stok tidak berubah saat checkout gagal');
    r.assertEq(dom.alerts.length, 1, 'alert kegagalan muncul');
    r.assertIncludes(dom.alerts[0], 'tidak mencukupi');
  });
});

r.suite('Stok langsung bertambah setelah input stok sukses', () => {

  r.test('tambah stok +10: stok langsung 50 -> 60 di UI tanpa refresh halaman', () => {
    const { dom, app } = loadStokSkenario(RESPON_VALID, RESPON_STOK_DITAMBAH);
    dom.window.sessionStorage.setItem('pos_role', 'KASIR');
    dom.window.__promptValue = '10'; // isi prompt tambah stok

    app.call('aksiTambahStok', '1', 'Semangci 250 ml');

    r.assertEq(stokProduk(app, '1'), 60, 'stok langsung bertambah di UI');
    r.assertEq(stokDiCache(dom, '1'), 60, 'cache ikut diperbarui');
  });
});

r.suite('Sinkronisasi berkala memakai data server terbaru', () => {

  r.test('startRealtimeSync memakai refreshData (bukan render cache lama)', () => {
    const dom = createDomStub();
    const app = loadFrontend(dom, RESPON_VALID);
    dom.triggerEvent('document', 'DOMContentLoaded');

    // Daftarkan interval sinkronisasi (dipanggil aplikasi saat sesi aktif)
    app.call('startRealtimeSync');
    const intervalCb = dom.window.__lastIntervalCallback;
    r.assertOk(intervalCb, 'interval sinkronisasi terdaftar');

    // Eksekusi callback interval: stok harus ikut data server baru
    dom.window.google.script.run.getInitialData = function () { return RESPON_STOK_BARU; };
    intervalCb();

    r.assertEq(stokProduk(app, '1'), 48, 'sinkronisasi mengambil data terbaru dari server');
  });
});

// ===== Helper skenario =====

function loadStokSkenario(responAwal, responServerBerikutnya) {
  const dom = createDomStub();
  const app = loadFrontend(dom, responAwal);
  dom.triggerEvent('document', 'DOMContentLoaded');

  // Setelah load awal, server mengembalikan data terbaru untuk refreshData()
  dom.window.google.script.run.getInitialData = function () { return responServerBerikutnya; };
  return { dom, app };
}

function isiKeranjangDanCheckout(app, dom) {
  app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 }]);
  dom.window.__elements.selMetode.value = 'CASH';
  dom.window.__elements.inpBayar.value = '35000';
  app.call('checkout');
}

r.run('Stok UI langsung berubah').then(ok => { process.exit(ok ? 0 : 1); });
