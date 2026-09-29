'use strict';

/**
 * ============================================================
 * Pengujian lokal — Performa: checkout cepat & refresh ringan
 * Latar: setiap refresh mem-fetch SELURUH riwayat (490+ baris,
 * 45KB, 6-40 detik) dan checkout menulis sheet per item.
 * Perbaikan yang diuji:
 *  1. getInitialData(limit) mengirim riwayat TERBATAS (baris terbaru).
 *  2. apiRequest menyimpan cache pendek 3 detik untuk getInitialData;
 *     trueSync melewatinya.
 *  3. refreshData + checkout + tambah stok + antrian offline memakai
 *     trueSync agar optimistic update tidak tertimpa cache.
 *  4. Sinkronisasi berkala longgar (45 detik, bukan 10 detik).
 *  5. prosesCheckout backend menulis penjualan & stok secara BATCH
 *     (1 setValues penjualan + maks 1 setValues per rentang stok).
 *  6. Kunci idempotensi tua dibersihkan otomatis.
 * ============================================================
 */

const { createGasMock, loadBackend, createDomStub, loadFrontend, createRunner } = require('./helpers');

const r = createRunner();

const PRODUK_VALID = [
  ['id', 'nama', 'stok', 'harga', 'foto_url'],
  ['1', 'Semangci 250 ml', 50, 15000, ''],
  ['2', 'Wonapel 250 ml', 30, 14000, '']
];

// ============================================================
// BACKEND: getInitialData(limit)
// ============================================================

r.suite('Backend — getInitialData terbatas (payload kecil, refresh cepat)', () => {

  function buatPenjualanBanyak(jumlahTx) {
    const rows = [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali', 'Modal', 'biayaOperasional', 'labaBersih']];
    for (let i = 1; i <= jumlahTx; i++) {
      rows.push(['FR-' + i, '20/09/2026 10:00', 'Semangci 250 ml', 1, 15000, 'CASH', 20000, 5000, 10000, 0, 5000]);
    }
    return rows;
  }

  function setupDenganPenjualan(rows) {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    // Timpa sheet Penjualan dengan data banyak transaksi
    const penjualanMock = gas.createSpreadsheetMock(PRODUK_VALID);
    gas.scriptRuntime.activeSpreadsheet.getSheetByName = function (name) {
      if (name === 'Produk') return gas.scriptRuntime.activeSpreadsheet.__produk;
      if (name === 'Penjualan') return penjualanMock.__penjualan;
      if (name === 'User') return gas.scriptRuntime.activeSpreadsheet.__user;
      return null;
    };
    penjualanMock.__penjualan.__state.rows = rows;
    return loadBackend(gas);
  }

  r.test('default: riwayat dibatasi 60 baris terbaru (bukan seluruh sheet)', () => {
    const backend = setupDenganPenjualan(buatPenjualanBanyak(200));
    const hasil = backend.getInitialData();
    r.assertEq(hasil.penjualan.length, 61, 'header + 60 baris terbaru');
    r.assertEq(hasil.penjualan[1][0], 'FR-141', 'baris terlama yang masih masuk jendela');
    r.assertEq(hasil.penjualan[60][0], 'FR-200', 'baris TERBARU ada di jendela');
  });

  r.test('limit khusus dihormati (mis. 10) & baris terbaru yang dipakai', () => {
    const backend = setupDenganPenjualan(buatPenjualanBanyak(200));
    const hasil = backend.getInitialData(10);
    r.assertEq(hasil.penjualan.length, 11, 'header + 10 baris terbaru');
    r.assertEq(hasil.penjualan[1][0], 'FR-191', 'baris terlama jendela');
    r.assertEq(hasil.penjualan[10][0], 'FR-200', 'baris terbaru jendela');
  });

  r.test('sheet lebih kecil dari limit: semua baris tetap terkirim', () => {
    const backend = setupDenganPenjualan(buatPenjualanBanyak(5));
    const hasil = backend.getInitialData(60);
    r.assertEq(hasil.penjualan.length, 6, 'header + 5 baris');
  });

  r.test('produk tetap lengkap walau riwayat dibatasi', () => {
    const backend = setupDenganPenjualan(buatPenjualanBanyak(200));
    const hasil = backend.getInitialData(5);
    r.assertEq(hasil.produk.length, 3, 'header + 2 produk tetap utuh');
  });
});

// ============================================================
// BACKEND: prosesCheckout batch tulis + pembersih idempotensi
// ============================================================

r.suite('Backend — prosesCheckout tulis batch (checkout cepat)', () => {

  function setup() {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);
    return { gas, backend, spreadsheet: gas.scriptRuntime.activeSpreadsheet };
  }

  r.test('checkout 2 produk (3 item): hasil identik dengan versi per-item', () => {
    const { backend, spreadsheet } = setup();

    const res = backend.prosesCheckout([
      { id: '1', nama: 'Semangci 250 ml', jumlah: 2, total: 30000 },
      { id: '2', nama: 'Wonapel 250 ml', jumlah: 1, total: 14000 },
      { id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }
    ], 'CASH', 60000);

    r.assertEq(res.status, 'success', 'status sukses');
    r.assertEq(res.total, 59000, 'grand total 30000+14000+15000');
    r.assertEq(spreadsheet.__penjualan.__rows().length, 4, '3 baris penjualan + header');
    // Produk 1 terjual 3x (2+1, agregasi per produk): 50 -> 47
    r.assertEq(spreadsheet.__produk.__rows()[1][2], 47, 'stok produk 1 berkurang 3 (agregasi)');
    r.assertEq(spreadsheet.__produk.__rows()[2][2], 29, 'stok produk 2 berkurang 1');
  });

  r.test('checkout QRIS tetap sukses dengan jalur batch', () => {
    const { backend, spreadsheet } = setup();
    const res = backend.prosesCheckout(
      [{ id: '2', nama: 'Wonapel 250 ml', jumlah: 2, total: 28000 }],
      'QRIS', 0
    );
    r.assertEq(res.status, 'success');
    r.assertEq(spreadsheet.__produk.__rows()[2][2], 28, 'stok 30 -> 28');
  });

  r.test('idempotensi tetap bekerja dengan batch: dobel koneksiId = 1 catatan', () => {
    const { backend, spreadsheet } = setup();
    const cart = [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }];
    const req = { koneksiId: 'kx-perf-1' };

    const a = backend.prosesCheckout(cart, 'CASH', 20000, req);
    const b = backend.prosesCheckout(cart, 'CASH', 20000, req);

    r.assertEq(a.status, 'success');
    r.assertEq(b.transaksi, a.transaksi, 'kirim ulang memakai hasil asli');
    r.assertEq(spreadsheet.__penjualan.__rows().length, 2, 'tetap 1 baris penjualan');
  });
});

r.suite('Backend — checkLogin sekaligus bawa data awal (login 1 roundtrip)', () => {

  r.test('login sukses: respons membawa dataAwal (produk + penjualan)', () => {
    const gas = createGasMock();
    // User sheet + Produk sheet: createSpreadsheetMock memakai PRODUK_VALID
    // sebagai produk; user admin/password tersedia di mock.
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    const res = backend.checkLogin('admin', 'password');
    r.assertEq(res.status, true, 'login sukses');
    r.assertOk(res.dataAwal, 'respons login membawa dataAwal');
    r.assertArray(res.dataAwal.produk, 'dataAwal.produk array');
    r.assertArray(res.dataAwal.penjualan, 'dataAwal.penjualan array');
    r.assertEq(res.dataAwal.produk.length, 3, 'produk lengkap (header + 2)');
  });

  r.test('login gagal: tanpa dataAwal', () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    const res = backend.checkLogin('admin', 'SALAH');
    r.assertEq(res.status, false, 'login ditolak');
    r.assertOk(!res.dataAwal, 'tidak ada dataAwal pada login gagal');
  });

});

r.suite('Backend — pembersih kunci idempotensi tua', () => {

  r.test('kunci idem_ >24 jam dihapus, kunci baru dipertahankan', () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);

    const msLama = Date.now() - 25 * 60 * 60 * 1000; // 25 jam lalu
    const props = gas.PropertiesService.getScriptProperties();
    props.setProperty('idem_kx-lama', JSON.stringify({ status: 'success', transaksi: 'FR-' + msLama }));
    props.setProperty('bukan_idem', 'jangan dihapus');

    backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }],
      'CASH', 20000, { koneksiId: 'kx-baru' }
    );

    r.assertEq(props.getProperty('idem_kx-lama'), null, 'kunci tua (25 jam) terhapus');
    r.assertOk(props.getProperty('bukan_idem'), 'properti non-idem tidak disentuh');
    r.assertOk(props.getProperty('idem_kx-baru'), 'kunci baru tersimpan');
  });

  r.test('kunci idem_ korup dibuang tanpa mengganggu checkout', () => {
    const gas = createGasMock();
    gas.scriptRuntime.activeSpreadsheet = gas.createSpreadsheetMock(PRODUK_VALID);
    const backend = loadBackend(gas);
    const props = gas.PropertiesService.getScriptProperties();
    props.setProperty('idem_kx-rusak', '{ini bukan json');

    const res = backend.prosesCheckout(
      [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }],
      'CASH', 20000, { koneksiId: 'kx-normal' }
    );

    r.assertEq(res.status, 'success', 'checkout tetap sukses');
    r.assertEq(props.getProperty('idem_kx-rusak'), null, 'kunci korup dibuang');
  });
});

// ============================================================
// FRONTEND: cache pendek + trueSync + interval longgar
// ============================================================

function loadJaringanSkenario(fetchStub) {
  const dom = createDomStub();
  const app = loadFrontend(dom);
  dom.window.location.protocol = 'https:';
  const panggilan = [];
  app.sandbox.fetch = function (url, opts) {
    panggilan.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return fetchStub(url, opts, panggilan.length);
  };
  return { dom, app, panggilan };
}

function buatResponApi(data) {
  return {
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify({ data: data }))
  };
}

const RESPON_DATA = {
  produk: PRODUK_VALID,
  penjualan: [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali']],
  timestamp: 1
};

r.suite('Frontend — cache pendek getInitialData (3 detik)', () => {

  r.test('dua panggilan beruntun = 1 request HTTP (kedua-nya dari cache)', async () => {
    const { app, panggilan } = loadJaringanSkenario(() => buatResponApi(RESPON_DATA));

    await app.sandbox.apiRequest('getInitialData', [60]);
    await app.sandbox.apiRequest('getInitialData', [60]);

    r.assertEq(panggilan.length, 1, 'request kedua dilayani cache');
  });

  r.test('cache menampung payload hasil server', async () => {
    const { app } = loadJaringanSkenario(() => buatResponApi(RESPON_DATA));
    const hasil = await app.sandbox.apiRequest('getInitialData', [60]);
    r.assertArray(hasil.produk, 'hasil dari cache sama bentuknya dengan respons server');
  });

  r.test('aksi tulis (prosesCheckout) tidak pernah memakai cache', async () => {
    const { app, panggilan } = loadJaringanSkenario(() => buatResponApi(RESPON_DATA));

    await app.sandbox.apiRequest('prosesCheckout', [[], 'CASH', 0]);
    await app.sandbox.apiRequest('prosesCheckout', [[], 'CASH', 0]);

    r.assertEq(panggilan.length, 2, 'setiap checkout benar-benar ke server');
  });

  r.test('trueSync melewati cache meski cache masih panas', async () => {
    const { app, panggilan } = loadJaringanSkenario(() => buatResponApi(RESPON_DATA));

    await app.sandbox.apiRequest('getInitialData', [60]);
    await app.sandbox.apiRequest('getInitialData', [60], null, true);

    r.assertEq(panggilan.length, 2, 'trueSync = ambil segar dari server');
  });
});

r.suite('Frontend — refreshData & aksi tulis memakai trueSync', () => {

  r.test('refreshData meneruskan trueSync ke apiRequest', async () => {
    const { app, panggilan } = loadJaringanSkenario(() => buatResponApi(RESPON_DATA));

    app.call('refreshData', true, true);
    await new Promise(res => setTimeout(res, 10));

    r.assertEq(panggilan.length, 1, 'refreshData menembak server');
    // Panaskan cache, lalu pastikan refreshData(true, true) TIDAK terkena cache
    await app.sandbox.apiRequest('getInitialData', [60]);
    const sebelum = panggilan.length;
    app.call('refreshData', true, true);
    await new Promise(res => setTimeout(res, 10));
    r.assertEq(panggilan.length, sebelum + 1, 'refreshData trueSync tidak terkena cache');
  });

  r.test('kode checkout sukses memanggil refreshData(true, true)', () => {
    const dom = createDomStub();
    const app = loadFrontend(dom, RESPON_DATA);
    dom.triggerEvent('document', 'DOMContentLoaded'); // pasang listener DOMContentLoaded
    let terekam = null;
    app.set('refreshData', function (silent, trueSync) { terekam = [silent, trueSync]; });
    app.set('cart', [{ id: '1', nama: 'Semangci 250 ml', jumlah: 1, total: 15000 }]);
    dom.window.__elements.selMetode.value = 'CASH';
    dom.window.__elements.inpBayar.value = '20000';

    app.call('checkout');
    // safeGoogleRun mock file: mengeksekusi handler sukses via setTimeout sinkron

    r.assertEq(JSON.stringify(terekam), '[true,true]', 'checkout sukses = trueSync');
  });

  r.test('kode aksiTambahStok sukses memanggil refreshData(true, true)', () => {
    const dom = createDomStub();
    const app = loadFrontend(dom, RESPON_DATA);
    dom.window.sessionStorage.setItem('pos_role', 'KASIR');
    dom.window.__promptValue = '5';
    let terekam = null;
    app.set('refreshData', function (silent, trueSync) { terekam = [silent, trueSync]; });

    app.call('aksiTambahStok', '1', 'Semangci 250 ml');

    r.assertEq(JSON.stringify(terekam), '[true,true]', 'tambah stok sukses = trueSync');
  });

  r.test('interval sinkronisasi memakai trueSync & longgar (45 detik)', () => {
    const dom = createDomStub();
    const app = loadFrontend(dom, RESPON_DATA);
    app.call('startRealtimeSync');
    const cb = dom.window.__lastIntervalCallback;
    r.assertOk(cb, 'interval terdaftar');

    let terekam = null;
    app.set('refreshData', function (silent, trueSync) { terekam = [silent, trueSync]; });
    cb();
    r.assertEq(JSON.stringify(terekam), '[true,true]', 'sinkronisasi berkala = trueSync');

    // Ambil nilai interval dari argumen setInterval-nya, bukan sekadar
    // menebak dari jarak karakter: assertion versi lama memakai jendela
    // 400 karakter sehingga langsung rapuh begitu ada satu komentar
    // penjelasan tambahan di dalam blok setInterval.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
    const m = src.match(/setInterval\([\s\S]*?,\s*(\d+)\)/);
    r.assertOk(m, 'pola setInterval(..., <ms>) ditemukan di index.html');
    r.assertEq(m[1], '45000', 'interval sinkronisasi 45000 ms di index.html');
  });
});

r.suite('Guard isUserInteracting tidak boleh menelan update server', () => {

  // Gejala nyata: "login berhasil tapi tabel produk/riwayat kosong".
  // Penyebab: renderFromCache() return diam-diam saat isUserInteracting = true.
  // Flag itu di-true oleh focusin di input mana pun dan hanya dilepas focusout.
  // Kalau focusout tidak pernah datang (mis. kasir menekan tombol tanpa
  // melepaskan fokus input, atau fokus pindah ke luar halaman), update server
  // berikutnya — termasuk sinkronisasi 45 detik — hilang tanpa jejjak.

  const RESPON_AWAL = {
    produk: [
      ['id', 'nama', 'stok', 'harga', 'foto_url'],
      ['1', 'Semangci 250 ml', 50, 15000, ''],
      ['2', 'Wonapel 250 ml', 30, 14000, ''],
      ['3', 'Semangci 350 ml', 20, 16000, '']
    ],
    penjualan: [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali']],
    timestamp: 1
  };

  const RESPON_TERBARU = {
    produk: [
      ['id', 'nama', 'stok', 'harga', 'foto_url'],
      ['1', 'Semangci 250 ml', 48, 15000, '']
    ],
    penjualan: [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali']],
    timestamp: 2
  };

  function jumlahProdukTerRender(app) {
    const dp = app.get('dataProduk');
    return Array.isArray(dp) ? dp.length : 0;
  }

  function mumpetkanSkenario() {
    const dom = createDomStub();
    const app = loadFrontend(dom, RESPON_AWAL);
    dom.triggerEvent('document', 'DOMContentLoaded');
    return { dom, app };
  }

  r.test('update yang tertahan guard dirender begitu interaksi berakhir', () => {
    const { dom, app } = mumpetkanSkenario();
    r.assertEq(jumlahProdukTerRender(app), 4, 'baseline: 3 produk dari data awal');

    // Kasir sedang mengetik di kolom pencarian -> guard menyala
    app.set('isUserInteracting', true);

    // Server mengirim data terbaru (3 produk -> 1 produk)
    dom.localStorage.setItem('pos_initial_data', JSON.stringify(RESPON_TERBARU));
    app.call('renderFromCache');
    r.assertEq(jumlahProdukTerRender(app), 4, 'guard menahan render (input kasir tidak ditimpa)');

    // Kasir selesai mengetik -> focusout
    dom.triggerEvent('document', 'focusout');
    r.assertEq(jumlahProdukTerRender(app), 2,
      'update yang tertahan WAJIB dirender setelah interaksi berakhir');
  });

  r.test('render yang sudah berhasil tidak menggantung render ulang data basi', () => {
    const { dom, app } = mumpetkanSkenario();

    app.set('isUserInteracting', true);
    dom.localStorage.setItem('pos_initial_data', JSON.stringify(RESPON_TERBARU));
    app.call('renderFromCache');            // tertahan

    // Guard lepas dan render benar-benar jalan
    app.set('isUserInteracting', false);
    app.call('renderFromCache');
    r.assertEq(jumlahProdukTerRender(app), 2, 'data terbaru terender');

    // Cache berubah lagi setelahnya; focusout tidak boleh menarik data lama
    dom.localStorage.setItem('pos_initial_data', JSON.stringify(RESPON_AWAL));
    dom.triggerEvent('document', 'focusout');
    r.assertEq(jumlahProdukTerRender(app), 2,
      'focusout tidak boleh merender data usang yang sudah tertinggal di cache');
  });

  r.test('focusout tanpa update tertunda tidak mengubah apa pun (tidak rendering sia-sia)', () => {
    const { dom, app } = mumpetkanSkenario();
    dom.triggerEvent('document', 'focusout');
    r.assertEq(jumlahProdukTerRender(app), 4, 'data tetap sama, tidak ada efek samping');
  });

  r.test('update tertahan tetap dirender saat kasir berpindah aplikasi (window blur)', () => {
    // Di HP, kasir sering mengunci layar atau pindah ke WhatsApp tanpa
    // memicu focusout -> flag nyangkut dan update hilang sampai reload.
    const { dom, app } = mumpetkanSkenario();
    app.set('isUserInteracting', true);
    dom.localStorage.setItem('pos_initial_data', JSON.stringify(RESPON_TERBARU));
    app.call('renderFromCache');
    r.assertEq(jumlahProdukTerRender(app), 4, 'masih tertahan');

    dom.triggerEvent('window', 'blur');
    r.assertEq(jumlahProdukTerRender(app), 2, 'update tertahan dirender saat aplikasi ditinggalkan');
  });

  r.test('update tertahan tetap dirender saat halaman dikembalikan ke depan', () => {
    const { dom, app } = mumpetkanSkenario();
    app.set('isUserInteracting', true);
    dom.localStorage.setItem('pos_initial_data', JSON.stringify(RESPON_TERBARU));
    app.call('renderFromCache');
    r.assertEq(jumlahProdukTerRender(app), 4, 'masih tertahan');

    dom.triggerEvent('document', 'visibilitychange');
    r.assertEq(jumlahProdukTerRender(app), 2, 'update tertunda dirender saat halaman terlihat lagi');
  });
});

// ============================================================
// Tick sinkronisasi 45 detik
// ============================================================
// Setelah P1, hasil refresh yang masuk saat guard interaksi menyala
// ditahan (renderTertunda), bukan langsung tampil. Artinya request
// berkala itu dibayar penuh (12-28 detik ke Spreadsheet) tanpa satu
// pun byte yang sampai ke layar. Lewati saja; jangan menambah permintaan
// lain sebagai gantinya.
r.suite('Tick sinkronisasi 45 detik tidak membuang request sia-sia', () => {

  function siapkanTick() {
    const dom = createDomStub();
    const app = loadFrontend(dom, RESPON_DATA);
    app.call('startRealtimeSync');
    const cb = dom.window.__lastIntervalCallback;
    let dipanggil = 0;
    let argumen = null;
    app.set('refreshData', function (silent, trueSync) { dipanggil++; argumen = [silent, trueSync]; });
    return { dom, app, cb, hitung: () => dipanggil, argumen: () => argumen };
  }

  r.test('tab disembunyikan: tick tidak menembak server', () => {
    const s = siapkanTick();
    s.dom.window.document.hidden = true;
    s.cb();
    r.assertEq(s.hitung(), 0, 'tidak ada request ke server saat tidak ada yang melihat layar');
  });

  r.test('kasir sedang berinteraksi: tick tidak menembak server', () => {
    const s = siapkanTick();
    s.app.set('isUserInteracting', true);
    s.cb();
    r.assertEq(s.hitung(), 0, 'tidak ada request sia-sia saat guard interaksi menyala');
  });

  r.test('kondisi normal: tick tetap menembak server dengan trueSync', () => {
    const s = siapkanTick();
    s.cb();
    r.assertEq(s.hitung(), 1, 'satu request ke server');
    r.assertEq(JSON.stringify(s.argumen()), '[true,true]', 'masih trueSync, bukan cache');
  });

  r.test('setelah interaksi selesai, tick berikutnya kembali menembak server', () => {
    const s = siapkanTick();
    s.app.set('isUserInteracting', true);
    s.cb();
    r.assertEq(s.hitung(), 0, 'ditahan selama interaksi');
    s.app.set('isUserInteracting', false);
    s.cb();
    r.assertEq(s.hitung(), 1, 'kembali normal begitu interaksi selesai');
  });

  r.test('refreshData sendiri tidak pernah dilewati, hanya tick-nya', () => {
    // Jaga-jaga: kalau penentzanya diletakkan di dalam refreshData, refresh
    // setelah checkout / tambah stok ikut hilang dan kasir tidak pernah
    // melihat hasil transaksinya sendiri.
    const dom = createDomStub();
    const app = loadFrontend(dom, RESPON_DATA);
    dom.window.document.hidden = true;
    app.set('isUserInteracting', true);
    let dipanggil = 0;
    app.set('safeGoogleRun', function () { dipanggil++; });
    app.call('refreshData', true, true);
    r.assertEq(dipanggil, 1,
      'refresh setelah checkout/stok tetap menembak server walau tab tersembunyi dan guard menyala');
  });
});

r.run('Performa Checkout & Refresh').then(ok => { process.exit(ok ? 0 : 1); });
