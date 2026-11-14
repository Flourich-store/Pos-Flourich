'use strict';

/**
 * ============================================================
 * Pengujian lokal — Stok UI & sinkronisasi
 * Checkout mengurangi stok: backend menulis stok batch, frontend
 * menerapkan optimistic update SEKETIKA pasca-checkout sukses.
 * Suite ini memastikan:
 *   - checkout sukses: stok langsung berkurang di UI/cache
 *   - checkout gagal: stok TIDAK berubah
 *   - tambah stok manual tetap memperbarui UI seketika
 *   - sinkronisasi berkala memakai data server terbaru
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

// Balasan server SETELAH checkout: riwayat bertambah & stok hasil penulisan
// server (50-2=48, 30-3=27 sesuai skenario uji).
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

r.suite('Checkout mengurangi stok (optimistic + sinkron server)', () => {

  r.test('checkout sukses: stok berkurang SEKETIKA di UI & cache (optimistic)', () => {
    const { dom, app } = loadStokSkenario(RESPON_VALID, RESPON_STOK_BARU);
    isiKeranjangDanCheckout(app, dom);

    r.assertEq(stokProduk(app, '1'), 48, 'stok produk 1 langsung 50-2=48 di UI');
    r.assertEq(stokDiCache(dom, '1'), 48, 'cache ikut diperbarui');
    r.assertEq(app.get('cart').length, 0, 'keranjang dikosongkan (checkout sukses)');
  });

  r.test('checkout multi-produk: semua stok produk ikut berkurang', () => {
    const { dom, app } = loadStokSkenario(RESPON_VALID, RESPON_STOK_BARU);
    app.set('cart', [
      { id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 },
      { id: '2', nama: 'Wonapel 250 ml', jumlah: 3, total: 42000 }
    ]);
    dom.window.__elements.selMetode.value = 'QRIS';
    app.call('checkout');              // v93: modal QRIS dulu utk QRIS
    app.call('konfirmasiQrisDibayar'); // lalu alur asli berjalan

    r.assertEq(stokProduk(app, '1'), 48, 'stok produk 1 berkurang 2');
    r.assertEq(stokProduk(app, '2'), 27, 'stok produk 2 berkurang 3');
  });

  r.test('refreshData mengganti data dengan hasil server terbaru (bukan cache lama)', () => {
    const { dom, app } = loadStokSkenario(RESPON_VALID, RESPON_STOK_BARU);
    isiKeranjangDanCheckout(app, dom);

    // Server mengembalikan data terbaru (stok hasil penulisan server); UI ikut server.
    r.assertEq(stokProduk(app, '1'), 48, 'stok dari server terbaru');
    // Riwayat penjualan juga terisi dari server: 1 baris transaksi + header
    const rawJual = app.get('rawPenjualanData');
    r.assertArray(rawJual, 'rawPenjualanData harus array');
    r.assertEq(rawJual.length, 2, 'header + 1 transaksi baru tampil tanpa refresh');
  });

  r.test('checkout gagal (server menolak) TIDAK mengubah stok lokal', () => {
    const dom = createDomStub();
    // Respon checkout gagal dikirim lewat mock prosesCheckout khusus
    const app = loadFrontend(dom, RESPON_VALID);
    dom.triggerEvent('document', 'DOMContentLoaded');
    dom.window.google.script.run.prosesCheckout = function () {
      return { status: 'error', message: 'Stok Semangci 250 ml tidak mencukupi.' };
    };

    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 999, total: 999 * 15000 }]);
    dom.window.__elements.selMetode.value = 'QRIS';
    app.call('checkout');              // v93: modal QRIS dulu utk QRIS
    app.call('konfirmasiQrisDibayar'); // lalu alur asli berjalan

    r.assertEq(stokProduk(app, '1'), 50, 'stok tidak berubah saat checkout gagal');
    r.assertEq(dom.alerts.length, 1, 'alert kegagalan muncul');
    r.assertIncludes(dom.alerts[0], 'tidak mencukupi');
  });
});

r.suite('Stok langsung bertambah setelah input stok manual', () => {

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
    // (RESPON_STOK_DITAMBAH = admin menambah stok manual di server: 50 -> 60)
    dom.window.google.script.run.getInitialData = function () { return RESPON_STOK_DITAMBAH; };
    intervalCb();

    r.assertEq(stokProduk(app, '1'), 60, 'sinkronisasi mengambil data terbaru dari server');
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

r.suite('Stok per cabang di UI', () => {

  const PAYLOAD_CABANG = {
    produk: RESPON_VALID.produk,
    penjualan: RESPON_VALID.penjualan,
    stokCabang: { cabang: 'CABANG-2', adaSheet: true, adaKolom: true, stok: { '1': 7 } },
    cabang: 'CABANG-2',
    timestamp: 1
  };

  function muat(payload, cabang) {
    const dom = createDomStub();
    const app = loadFrontend(dom, payload);
    if (cabang !== undefined) dom.sessionStorage.setItem('pos_cabang', cabang);
    app.call('renderDataPaksa', payload);
    return { dom, app };
  }

  r.test('stok cabang dipakai bila sudah diisi, lengkap dengan keterangan sumber', () => {
    const { app } = muat(PAYLOAD_CABANG, 'CABANG-2');

    const info = app.call('stokUntukTampilan', '1', 50);

    r.assertEq(info.nilai, 7, 'tampil stok cabang 7, bukan total 50');
    r.assertIncludes(info.judul, 'CABANG-2', 'judul menyebut cabang');
    r.assertIncludes(info.judul, '50', 'judul tetap menyebut total');
  });

  r.test('produk tanpa stok cabang -> pakai stok total & keterangannya jujur', () => {
    const { app } = muat(PAYLOAD_CABANG, 'CABANG-2');

    const info = app.call('stokUntukTampilan', '2', 30);

    r.assertEq(info.nilai, 30, 'jatuh ke stok total');
    r.assertIncludes(info.judul, 'belum diisi', 'menyatakan stok cabang belum diisi');
  });

  r.test('sesi tanpa cabang -> stok total tanpa embel-embel cabang', () => {
    const { app } = muat(PAYLOAD_CABANG, '');

    const info = app.call('stokUntukTampilan', '1', 50);

    r.assertEq(info.nilai, 50, 'pakai total');
    r.assertIncludes(info.judul, 'Stok total', 'keterangan total');
  });

  r.test('badge header menampilkan cabang sesi', () => {
    const { dom } = muat(PAYLOAD_CABANG, 'CABANG-2');

    const el = dom.window.document.getElementById('lblCabang');
    r.assertOk(el, 'elemen badge ada');
    r.assertIncludes(el.textContent, 'CABANG-2', 'badge menyebut cabang');
  });

  r.test('badge memberi tahu bila sesi belum punya cabang', () => {
    const { dom } = muat(PAYLOAD_CABANG, '');

    const el = dom.window.document.getElementById('lblCabang');
    r.assertIncludes(el.textContent, 'belum diatur', 'bukan kosong diam-diam');
  });

  r.test('stokCabang ikut tersimpan di cache lokal', () => {
    const { dom } = muat(PAYLOAD_CABANG, 'CABANG-2');

    const raw = dom.localStorage.getItem('pos_initial_data');
    const parsed = JSON.parse(raw);
    r.assertOk(parsed.stokCabang, 'cache menyimpan stokCabang');
    r.assertEq(parsed.stokCabang.stok['1'], 7, 'nilai stok cabang tersimpan');
  });

});

// ════════════════════════════════════════════════════════════════
// KARTU "STOK PER CABANG" (dropdown pemantau)
// ════════════════════════════════════════════════════════════════

r.suite('Stok per cabang — dropdown pemantauan', () => {

  const PAYLOAD_SEMUA = {
    produk: RESPON_VALID.produk,
    penjualan: RESPON_VALID.penjualan,
    stokCabang: { cabang: '', adaSheet: true, adaKolom: false, stok: {} },
    stokCabangSemua: {
      adaSheet: true,
      daftarCabang: ['PUSAT', 'CABANG-2'],
      stok: { 'PUSAT': { '1': 40, '2': 30 }, 'CABANG-2': { '1': 7 } },
      total: { '1': 47, '2': 30 }
    },
    cabang: '',
    timestamp: 1
  };

  function muat(role, payload) {
    const dom = createDomStub();
    const app = loadFrontend(dom, payload || PAYLOAD_SEMUA);
    if (role) dom.sessionStorage.setItem('pos_role', role);
    app.call('renderDataPaksa', payload || PAYLOAD_SEMUA);
    return { dom, app };
  }

  r.test('pemantau melihat kartu dengan stok tiap cabang + total', () => {
    const { dom } = muat('PENGAWAS');
    const doc = dom.window.document;

    r.assertEq(doc.getElementById('cardStokCabang').classList.contains('hidden'), false, 'kartu tampil');
    const head = doc.getElementById('theadStokCabang').innerHTML;
    r.assertIncludes(head, 'PUSAT', 'header memuat PUSAT');
    r.assertIncludes(head, 'CABANG-2', 'header memuat CABANG-2');
    r.assertIncludes(head, 'TOTAL', 'header memuat TOTAL');
    const body = doc.getElementById('tbodyStokCabang').innerHTML;
    r.assertIncludes(body, 'Semangci 250 ml', 'nama produk ikut');
    r.assertIncludes(body, '47', 'total produk 1');
    r.assertIncludes(body, '—', 'sel kosong ditandai, bukan 0');
  });

  r.test('dropdown memilih satu cabang -> hanya kolom cabang itu', () => {
    const { dom, app } = muat('PENGAWAS');
    const doc = dom.window.document;

    doc.getElementById('selCabangStok').value = 'CABANG-2';
    app.call('renderStokCabang');

    const head = doc.getElementById('theadStokCabang').innerHTML;
    r.assertIncludes(head, 'CABANG-2', 'kolom terpilih');
    r.assertEq(head.indexOf('PUSAT'), -1, 'PUSAT tidak ikut');
    const body = doc.getElementById('tbodyStokCabang').innerHTML;
    r.assertIncludes(body, '7', 'stok CABANG-2 produk 1');
  });

  r.test('super admin TIDAK melihat kartu (khusus pemantau)', () => {
    const { dom } = muat('SUPER_ADMIN');
    r.assertEq(
      dom.window.document.getElementById('cardStokCabang').classList.contains('hidden'),
      true,
      'kartu disembunyikan untuk super admin'
    );
  });

  r.test('kasir tidak melihat kartu stok semua cabang', () => {
    const { dom } = muat('KASIR');
    r.assertEq(
      dom.window.document.getElementById('cardStokCabang').classList.contains('hidden'),
      true,
      'kartu disembunyikan'
    );
  });

  r.test('payload lama/belum termigrasi -> kartu disembunyikan, tidak error', () => {
    const { dom } = muat('PENGAWAS', {
      produk: RESPON_VALID.produk,
      penjualan: RESPON_VALID.penjualan,
      stokCabang: { cabang: '', adaSheet: false, adaKolom: false, stok: {} },
      cabang: '',
      timestamp: 1
    });

    r.assertEq(
      dom.window.document.getElementById('cardStokCabang').classList.contains('hidden'),
      true,
      'kartu disembunyikan'
    );
  });

});

// ════════════════════════════════════════════════════════════════
// KOLOM CABANG DI RIWAYAT
// ════════════════════════════════════════════════════════════════

r.suite('Riwayat — kolom cabang', () => {

  // baris penjualan 14 kolom (indeks 13 = cabang)
  const BARIS_CABANG = ['FR-1', '14/11/2026 15:10', 'Semangci 500 ml', 500, 11000, 1, 20000, 'QRIS', 20000, 0, 11000, 0, 9000, 'CABANG-2'];
  const BARIS_LAMA = ['FR-2', '01/09/2026 08:00', 'Semangci 250 ml', 250, 7500, 1, 10000, 'CASH', 10000, 0, 7500, 0, 2500, ''];

  function muatRiwayat(penjualan) {
    const dom = createDomStub();
    const tbody = { innerHTML: '' };
    dom.window.document.querySelector = (sel) => (sel === '#penjualanTable tbody'
      ? tbody
      : { innerHTML: '', classList: { contains: () => false, add() { }, remove() { } } });
    const payload = {
      produk: RESPON_VALID.produk,
      penjualan: penjualan,
      cabang: '',
      timestamp: 1
    };
    const app = loadFrontend(dom, payload);
    app.call('renderDataPaksa', payload);
    return { dom, app, tbody };
  }

  r.test('setiap baris riwayat punya 14 sel, termasuk cabang transaksi', () => {
    const { tbody } = muatRiwayat([RESPON_VALID.penjualan[0], BARIS_CABANG]);

    r.assertEq((tbody.innerHTML.match(/<td/g) || []).length, 14, '14 kolom per baris');
    r.assertIncludes(tbody.innerHTML, 'CABANG-2', 'nilai cabang tampil');
  });

  r.test('baris lama tanpa cabang ditandai "—", bukan dikarang PUSAT', () => {
    const { tbody } = muatRiwayat([RESPON_VALID.penjualan[0], BARIS_LAMA]);

    r.assertIncludes(tbody.innerHTML, '—', 'penanda kosong');
    r.assertEq(tbody.innerHTML.indexOf('PUSAT'), -1, 'tidak menebak PUSAT');
  });

  r.test('tanpa riwayat -> colspan 14 (bukan 13) supaya tabel tetap rapi', () => {
    const { tbody } = muatRiwayat([RESPON_VALID.penjualan[0]]);

    r.assertIncludes(tbody.innerHTML, 'colspan="14"', 'colspan menyesuaikan jumlah kolom');
  });

});

// ════════════════════════════════════════════════════════════════
// FILTER CABANG DI RIWAYAT (khusus pemantau)
// ════════════════════════════════════════════════════════════════

r.suite('Riwayat — dropdown filter cabang untuk pemantau', () => {

  const HDR = ['id', 'tanggal', 'namaProduk', 'volumeMl', 'hppSatuan', 'jumlah', 'totalHarga',
    'metode', 'uangDibayar', 'uangKembali', 'modal', 'biayaOperasional', 'labaBersih', 'cabang'];
  const ROW_PUSAT = ['FR-PUSAT', '14/11/2026 10:00', 'Semangci 250 ml', 250, 7500, 1, 10000, 'CASH', 10000, 0, 7500, 0, 2500, 'PUSAT'];
  const ROW_CAB2 = ['FR-CAB2', '14/11/2026 15:10', 'Semangci 500 ml', 500, 11000, 1, 20000, 'QRIS', 20000, 0, 11000, 0, 9000, 'CABANG-2'];

  const PAYLOAD = {
    produk: RESPON_VALID.produk,
    penjualan: [HDR, ROW_PUSAT, ROW_CAB2],
    stokCabang: { cabang: '', adaSheet: true, adaKolom: false, stok: {} },
    stokCabangSemua: {
      adaSheet: true,
      daftarCabang: ['PUSAT', 'CABANG-2'],
      stok: { 'PUSAT': {}, 'CABANG-2': {} },
      total: {}
    },
    cabang: '',
    timestamp: 1
  };

  function muat(role) {
    const dom = createDomStub();
    const tbody = { innerHTML: '' };
    dom.window.document.querySelector = (sel) => (sel === '#penjualanTable tbody' ? tbody : { innerHTML: '' });
    if (role) dom.sessionStorage.setItem('pos_role', role);
    const app = loadFrontend(dom, PAYLOAD);
    app.call('renderDataPaksa', PAYLOAD);
    return { dom, app, tbody };
  }

  r.test('pemantau melihat dropdown cabang berisi cabang yang ada', () => {
    const { dom } = muat('PENGAWAS');
    const doc = dom.window.document;

    r.assertEq(doc.getElementById('filterCabangGroup').classList.contains('hidden'), false, 'grup filter tampil');
    const opsi = doc.getElementById('filterCabang').innerHTML;
    r.assertIncludes(opsi, 'PUSAT', 'opsi PUSAT');
    r.assertIncludes(opsi, 'CABANG-2', 'opsi CABANG-2');
  });

  r.test('memilih satu cabang menyaring riwayat ke cabang itu saja', () => {
    const { dom, app, tbody } = muat('PENGAWAS');
    const doc = dom.window.document;

    r.assertIncludes(tbody.innerHTML, 'FR-PUSAT', 'sebelum filter: dua cabang');
    r.assertIncludes(tbody.innerHTML, 'FR-CAB2', 'sebelum filter: dua cabang');

    doc.getElementById('filterCabang').value = 'CABANG-2';
    app.call('applyFilter', true);

    r.assertIncludes(tbody.innerHTML, 'FR-CAB2', 'transaksi CABANG-2 tetap');
    r.assertEq(tbody.innerHTML.indexOf('FR-PUSAT'), -1, 'transaksi PUSAT tersaring');
  });

  r.test('Reset mengembalikan filter ke semua cabang', () => {
    const { dom, app, tbody } = muat('PENGAWAS');
    const doc = dom.window.document;

    doc.getElementById('filterCabang').value = 'CABANG-2';
    app.call('applyFilter', true);
    app.call('resetFilter');

    r.assertEq(doc.getElementById('filterCabang').value, '', 'dropdown kembali ke semua cabang');
    r.assertIncludes(tbody.innerHTML, 'FR-PUSAT', 'riwayat kedua cabang kembali');
  });

  r.test('kasir tidak melihat dropdown cabang', () => {
    const { dom } = muat('KASIR');

    r.assertEq(
      dom.window.document.getElementById('filterCabangGroup').classList.contains('hidden'),
      true,
      'grup filter disembunyikan'
    );
  });

});

r.run('Stok UI & sinkronisasi (stok manual)').then(ok => { process.exit(ok ? 0 : 1); });
