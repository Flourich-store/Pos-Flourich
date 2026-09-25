'use strict';

/**
 * ============================================================
 * Pengujian lokal — Antrian transaksi offline
 * Skenario: jaringan putus saat kasir menekan PROSES TRANSAKSI.
 * Jaminan yang diuji:
 *  1. Transaksi TIDAK hilang — masuk antrian lokal (localStorage),
 *     struk lokal tetap muncul, keranjang dikosongkan.
 *  2. koneksiId unik dibuat per tekanan tombol (idempotensi).
 *  3. Saat koneksi pulih, antrian dikirim ulang OTOMATIS dengan
 *     koneksiId yang SAMA (bukan baru).
 *  4. Idempotensi backend: koneksiId sama -> transaksi TIDAK
 *     dobel-append ke sheet Penjualan & stok tidak dobel-kurang.
 *  5. Error bisnis saat kirim ulang (stok habis) -> item dikeluarkan
 *     dari antrian (tidak berulang selamanya), TIDAK dobel-catat.
 *  6. Badge indikator menampilkan jumlah transaksi tertunda.
 *
 * CATATAN HARNESS: stub setTimeout di helpers.js mengeksekusi
 * sinkron delay <= 5000ms. Akibatnya jadwalkanKirimAntrianOffline()
 * langsung menjalankan kirim. Skenario test dirancang di sekitar
 * perilaku ini (jaringan mati-total hingga kirim antrian sukses).
 * ============================================================
 */

const { createGasMock, loadBackend, createDomStub, loadFrontend, createRunner } = require('./helpers');

const r = createRunner();

const PRODUK_VALID = [
  ['id', 'nama', 'stok', 'harga', 'modal'],
  ['1', 'Semangci 250 ml', 50, 15000, 10000],
  ['2', 'Wonapel 250 ml', 30, 14000, 9000]
];

const CART_SEMANGCI_2 = [{ id: '1', nama: 'Semangci 250 ml', jumlah: 2, harga: 15000, total: 30000 }];

// ---------- util ----------

/**
 * Muat frontend dengan apiRequest aktif (bukan mode file:) + fetch stub.
 * fetchFailUntil: jumlah panggilan pertama yang SELALU gagal jaringan.
 */
function muatSkenario(fetchFailUntil) {
  const dom = createDomStub();
  const app = loadFrontend(dom);
  dom.window.location.protocol = 'https:';

  const panggilan = [];
  app.sandbox.fetch = function (url, opts) {
    panggilan.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
    if (panggilan.length <= fetchFailUntil) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(balasanSukses(panggilan.length, opts))) });
  };
  return { dom, app, panggilan };
}

/** Balasan server sukses sesuai aksi (checkout vs getInitialData). */
function balasanSukses(panggilanKe, opts) {
  let aksi = '';
  try { aksi = JSON.parse((opts && opts.body) || '{}').action; } catch (e) { }
  if (aksi === 'getInitialData') {
    return { status: 'success', data: { produk: PRODUK_VALID, penjualan: [], timestamp: new Date().getTime() } };
  }
  return { status: 'success', data: { status: 'success', transaksi: 'FR-SRV-' + panggilanKe, total: 30000, bayar: 30000, kembali: 0, metode: 'CASH' } };
}

/**
 * Ganti fetch stub di tengah skenario (simulasi koneksi pulih).
 * penolakanServer: {message} untuk simulasi server hidup tapi MENOLAK transaksi.
 */
function muatSkenarioUlangFetch(app, panggilan, fetchFailUntil, penolakanServer) {
  app.sandbox.fetch = function (url, opts) {
    panggilan.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
    if (panggilan.length <= fetchFailUntil) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    const isi = penolakanServer
      ? { status: 'error', message: penolakanServer.message }
      : balasanSukses(panggilan.length, opts);
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(isi)) });
  };
}

/** Jalankan async sampai semua microtask & setTimeout sinkron selesai. */
function flush() {
  return new Promise(resolve => setTimeout(resolve, 20));
}

async function tekanCheckoutGagalJaringan(app, dom, cart) {
  // Isi data produk seperti hasil fetch server — tanpa ini checkout berhenti
  // di type guard 'Data produk belum termuat' sebelum sempat memanggil API.
  app.set('dataProduk', PRODUK_VALID);
  app.set('masterData', PRODUK_VALID);
  app.set('cart', cart.map(it => Object.assign({}, it)));
  dom.confirms.length = 0;
  dom.alerts.length = 0;
  app.call('checkout');
  await flush();
}

function badgeCount(dom) {
  return String(dom.window.document.getElementById('offlineQueueCount').textContent);
}

function badgeTampil(dom) {
  return !dom.window.document.getElementById('offlineQueueBadge').classList.contains('hidden');
}

// ============================================================
// 1. Penyimpanan ke antrian saat jaringan putus
// ============================================================

r.suite('Antrian Offline — penyimpanan saat jaringan putus', () => {

  r.test('checkout gagal jaringan -> transaksi masuk antrian lokal (tidak hilang)', async () => {
    const { dom, app, panggilan } = muatSkenario(999); // jaringan mati-total
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);

    const antrian = JSON.parse(dom.localStorage.getItem('pos_offline_queue') || '[]');
    r.assertEq(antrian.length, 1);
    r.assertEq(antrian[0].status, 'pending');
    r.assertEq(antrian[0].cart[0].id, '1');
    r.assertEq(antrian[0].cart[0].jumlah, 2);
    r.assertOk(antrian[0].koneksiId, 'koneksiId wajib ada');
    r.assertOk(String(antrian[0].transaksi).startsWith('FR-OFF-'), 'ID lokal struk berformat FR-OFF-...');
    r.assertOk(panggilan.length >= 3, 'POST dicoba minimal 3x sebelum masuk antrian');
  });

  r.test('kasir tetap melihat konfirmasi transaksi aman (alert + struk lokal)', async () => {
    const { dom, app } = muatSkenario(999);
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);

    const gabung = dom.alerts.join(' | ');
    r.assertIncludes(gabung, 'FR-OFF-', 'alert menampilkan ID sementara');
    r.assertIncludes(gabung, 'otomatis', 'alert menjelaskan pengiriman otomatis saat koneksi pulih');
    // Struk lokal tetap tersedia (kasir bisa mencetak bukti)
    const receipt = app.sandbox.window.lastReceipt;
    r.assertOk(receipt && receipt.transaksi && String(receipt.transaksi).startsWith('FR-OFF-'),
      'struk lokal (lastReceipt) memakai ID FR-OFF-');
  });

  r.test('keranjang dikosongkan & badge antrian tampil setelah masuk antrian', async () => {
    const { dom, app } = muatSkenario(999);
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);

    r.assertEq(app.get('cart').length, 0, 'keranjang dikosongkan (sudah aman di antrian)');
    r.assertEq(badgeCount(dom), '1');
    r.assertOk(badgeTampil(dom), 'badge tampil');
  });

  r.test('tekan checkout 2x saat offline -> dua item antrian, koneksiId BEDA', async () => {
    const { dom, app } = muatSkenario(999);
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);

    const antrian = JSON.parse(dom.localStorage.getItem('pos_offline_queue') || '[]');
    r.assertEq(antrian.length, 2, 'dua transaksi tersimpan');
    r.assertOk(antrian[0].koneksiId !== antrian[1].koneksiId, 'koneksiId unik per transaksi');
    r.assertEq(app.get('cart').length, 0, 'cart tetap kosong (tidak dobel)');
  });

  r.test('error BISNIS (stok kurang) TIDAK masuk antrian — tampil langsung ke kasir', async () => {
    const dom = createDomStub();
    const app = loadFrontend(dom);
    dom.window.location.protocol = 'https:';
    app.sandbox.fetch = function () {
      // Error bisnis dari backend GAS: HTTP 200 + {status:'error', message}
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ status: 'error', message: 'Stok Semangci 250 ml tidak mencukupi.' }))
      });
    };
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);

    r.assertEq(dom.localStorage.getItem('pos_offline_queue'), null, 'tidak ada antrian tersimpan');
    r.assertIncludes(dom.alerts.join(' '), 'tidak mencukupi', 'pesan stok tampil apa adanya');
  });
});

// ============================================================
// 2. Kirim ulang otomatis saat koneksi pulih
// ============================================================

r.suite('Antrian Offline — kirim ulang otomatis', () => {

  r.test('kirimAntrianOffline() mengirim dengan koneksiId SAMA (idempoten)', async () => {
    const { dom, app, panggilan } = muatSkenario(999); // gagal saat checkout
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);
    const antrianSebelum = JSON.parse(dom.localStorage.getItem('pos_offline_queue'));
    const koneksiIdSebelum = antrianSebelum[0].koneksiId;

    // Koneksi pulih: semua fetch berikutnya sukses
    muatSkenarioUlangFetch(app, panggilan, 0);

    await app.call('kirimAntrianOffline');
    await flush();

    const antrian = JSON.parse(dom.localStorage.getItem('pos_offline_queue') || '[]');
    r.assertEq(antrian.length, 0, 'antrian kosong setelah terkirim');

    const postKirim = panggilan.filter(p => p.method === 'POST' && p.body && p.body.indexOf('koneksiId') !== -1);
    r.assertOk(postKirim.length >= 1, 'ada POST dengan koneksiId');
    const body = JSON.parse(postKirim[postKirim.length - 1].body);
    r.assertEq(body.koneksiId, koneksiIdSebelum, 'koneksiId TIDAK berubah saat kirim ulang');
    r.assertEq(body.action, 'prosesCheckout');
  });

  r.test('badge kembali 0/sembunyi setelah antrian terkirim', async () => {
    const { dom, app, panggilan } = muatSkenario(999);
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);
    r.assertEq(badgeCount(dom), '1');

    muatSkenarioUlangFetch(app, panggilan, 0);
    await app.call('kirimAntrianOffline');
    await flush();

    r.assertEq(badgeCount(dom), '0');
    r.assertOk(!badgeTampil(dom), 'badge disembunyikan');
  });

  r.test('jaringan masih putus saat kirim ulang -> item tetap pending, percobaan bertambah', async () => {
    const { dom, app } = muatSkenario(999); // semua fetch gagal selamanya
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);
    const percobaanSebelum = JSON.parse(dom.localStorage.getItem('pos_offline_queue'))[0].percobaan || 0;

    await app.call('kirimAntrianOffline');
    await flush();

    const antrian = JSON.parse(dom.localStorage.getItem('pos_offline_queue') || '[]');
    r.assertEq(antrian.length, 1, 'tetap tersimpan');
    r.assertEq(antrian[0].status, 'pending');
    r.assertEq(antrian[0].percobaan, percobaanSebelum + 1, 'counter percobaan bertambah');
  });

  r.test('event online bisa terpicu di stub window', () => {
    const { dom, app } = muatSkenario(999);
    let terpicu = 0;
    dom.window.addEventListener('online', function () { terpicu++; });
    dom.triggerEvent('window', 'online');
    r.assertEq(terpicu, 1, 'listener online terpicu');
    r.assertDoesNotThrow(() => app.call('perbaruiIndikatorAntrian'));
  });

  r.test('simpanDanRenderData memicu pengiriman antrian (server terbukti hidup)', async () => {
    const { dom, app } = muatSkenario(999);
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);

    let dipicu = 0;
    app.sandbox.jadwalkanKirimAntrianOffline = function () { dipicu++; };
    app.call('simpanDanRenderData', { produk: PRODUK_VALID, penjualan: [] });
    r.assertOk(dipicu >= 1, 'pengiriman dijadwalkan setelah data server sukses diambil');
  });

  r.test('error bisnis saat kirim ulang -> item dikeluarkan dari antrian (bukan loop abadi)', async () => {
    const { dom, app, panggilan } = muatSkenario(999);
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);
    r.assertEq(JSON.parse(dom.localStorage.getItem('pos_offline_queue')).length, 1);

    // Server hidup, tapi MENOLAK transaksi (mis. produk sudah dihapus / stok habis)
    muatSkenarioUlangFetch(app, panggilan, 0, {
      status: 'error', message: 'Produk ID 1 tidak ditemukan.'
    });
    await app.call('kirimAntrianOffline');
    await flush();

    const antrian = JSON.parse(dom.localStorage.getItem('pos_offline_queue') || '[]');
    r.assertEq(antrian.length, 0, 'item ditolak server dikeluarkan dari antrian (tidak diulang selamanya)');
  });
});

// ============================================================
// 3. Idempotensi backend (Code.js)
// ============================================================

r.suite('Antrian Offline — idempotensi backend (Code.js)', () => {

  function backendBaru() {
    const gas = createGasMock();
    const sheet = gas.createSpreadsheetMock(PRODUK_VALID); // mock spreadsheet: __produk/__penjualan di sini
    gas.scriptRuntime.activeSpreadsheet = sheet;
    const backend = loadBackend(gas);
    return { gas, sheet, backend };
  }

  function bodyPost(action, args, koneksiId) {
    return { postData: { contents: JSON.stringify({ action: action, args: args, koneksiId: koneksiId }) } };
  }

  r.test('POST sama dengan koneksiId sama -> transaksi hanya TERCATAT SEKALI', () => {
    const { sheet, backend } = backendBaru();
    const kid = 'kx-123-abc';

    const res1 = JSON.parse(backend.doPost(bodyPost('prosesCheckout', [CART_SEMANGCI_2, 'CASH', 50000], kid)).getContent());
    r.assertEq(res1.status, 'success');

    // Simulasi kirim ulang: request SAMA dikirim ulang (koneksi putus sebelumnya)
    const res2 = JSON.parse(backend.doPost(bodyPost('prosesCheckout', [CART_SEMANGCI_2, 'CASH', 50000], kid)).getContent());
    r.assertEq(res2.status, 'success');
    r.assertEq(res2.transaksi, res1.transaksi, 'respons kirim ulang = respons asli (bukan transaksi baru)');

    r.assertEq(sheet.__penjualan.__rows().length, 2, 'Penjualan: header + 1 baris (tidak dobel)');
    // Stok hanya berkurang sekali meski request dikirim ulang: 50 - 2 = 48.
    r.assertEq(Number(sheet.__produk.__rows()[1][2]), 48, 'stok tidak dobel-kurang (idempoten)');
  });

  r.test('koneksiId BEDA -> dua transaksi normal (bukan dedup berlebihan)', () => {
    const { sheet, backend } = backendBaru();
    const res1 = JSON.parse(backend.doPost(bodyPost('prosesCheckout', [CART_SEMANGCI_2, 'CASH', 50000], 'kx-A')).getContent());
    const res2 = JSON.parse(backend.doPost(bodyPost('prosesCheckout', [CART_SEMANGCI_2, 'CASH', 50000], 'kx-B')).getContent());
    r.assertEq(res1.status, 'success');
    r.assertEq(res2.status, 'success');
    // (ID transaksi bisa sama bila dua panggilan jatuh di milidetik yang sama;
    //  bukti dedup yang benar adalah jumlah baris penjualan.)
    r.assertEq(sheet.__penjualan.__rows().length, 3, 'header + 2 baris penjualan');
  });

  r.test('koneksiId bersih dari karakter liar & dibatasi panjang', () => {
    const { backend } = backendBaru();
    const kidRaw = 'kx~~~123!!!' + 'x'.repeat(300);
    const res = JSON.parse(backend.doPost(bodyPost('prosesCheckout', [CART_SEMANGCI_2, 'CASH', 50000], kidRaw)).getContent());
    r.assertEq(res.status, 'success');
    // Kirim ulang dengan versi tersanitasi setara harus dianggap koneksiId yang sama
    const res2 = JSON.parse(backend.doPost(bodyPost('prosesCheckout', [CART_SEMANGCI_2, 'CASH', 50000], 'kx123' + 'x'.repeat(96))).getContent());
    r.assertEq(res2.transaksi, res.transaksi, 'sanitasi menghasilkan kunci idempotensi yang konsisten');
  });

  r.test('tanpa koneksiId (klien lama) -> checkout tetap normal', () => {
    const { sheet, backend } = backendBaru();
    const res = JSON.parse(backend.doPost(bodyPost('prosesCheckout', [CART_SEMANGCI_2, 'CASH', 50000])).getContent());
    r.assertEq(res.status, 'success');
    r.assertEq(sheet.__penjualan.__rows().length, 2);
  });

  r.test('doGet tetap MENOLAK prosesCheckout meski membawa koneksiId', () => {
    const { sheet, backend } = backendBaru();
    const e = { parameter: { action: 'prosesCheckout', args: JSON.stringify([CART_SEMANGCI_2, 'CASH', 50000]), koneksiId: 'kx-hack' } };
    const out = JSON.parse(backend.doGet(e).getContent());
    r.assertEq(out.status, 'error');
    r.assertIncludes(out.message, 'POST', 'ditolak dengan alasan keamanan');
    r.assertEq(sheet.__penjualan.__rows().length, 1, 'tidak ada transaksi tercatat via GET');
  });

  r.test('doGet aksi BACA membawa koneksiId tidak mengganggu hasil', () => {
    const { backend } = backendBaru();
    const e = { parameter: { action: 'getInitialData', koneksiId: 'kx-abc' } };
    const out = JSON.parse(backend.doGet(e).getContent());
    // doGet/doPost membalas hasil fungsi backend langsung (tanpa pembungkus data)
    r.assertOk(out && Array.isArray(out.produk), 'getInitialData tetap normal');
  });
});

// ============================================================
// 4. Batas & ketahanan antrian
// ============================================================

r.suite('Antrian Offline — batas & ketahanan', () => {

  r.test('antrian korup (bukan JSON) -> di-reset aman, tidak crash', async () => {
    const { dom, app } = muatSkenario(999);
    dom.localStorage.setItem('pos_offline_queue', '{korup!!!');
    r.assertDoesNotThrow(() => app.call('bacaAntrianOffline'));
    r.assertEq(app.call('jumlahAntrianTertunda'), 0);

    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);
    const antrian = JSON.parse(dom.localStorage.getItem('pos_offline_queue') || '[]');
    r.assertEq(antrian.length, 1, 'transaksi baru tetap tersimpan setelah reset');
  });

  r.test('antrian berisi nilai bukan-array -> dianggap kosong', () => {
    const { dom, app } = muatSkenario(0);
    dom.localStorage.setItem('pos_offline_queue', '{"bukan":"array"}');
    r.assertEq(app.call('jumlahAntrianTertunda'), 0);
  });

  r.test('RETRY_MAKS_PER_ITEM = 8 tercapai -> item dikeluarkan dari antrian (gagal permanen)', async () => {
    const { dom, app } = muatSkenario(999); // jaringan selalu gagal
    await tekanCheckoutGagalJaringan(app, dom, CART_SEMANGCI_2);

    // Simulasi 7 percobaan gagal sebelumnya, lalu 1 lagi -> habis kuota
    const antrian = JSON.parse(dom.localStorage.getItem('pos_offline_queue'));
    antrian[0].percobaan = 7;
    dom.localStorage.setItem('pos_offline_queue', JSON.stringify(antrian));

    await app.call('kirimAntrianOffline');
    await flush();

    const sisa = JSON.parse(dom.localStorage.getItem('pos_offline_queue') || '[]');
    r.assertEq(sisa.length, 0, 'item gagal permanen dikeluarkan dari antrian');
  });

  r.test('QUEUE_MAKS = 50: penuh -> checkout menolak & transaksi tetap di keranjang', async () => {
    const { dom, app } = muatSkenario(999);
    const penuh = [];
    for (let i = 0; i < 50; i++) {
      penuh.push({ koneksiId: 'kx-' + i, transaksi: 'FR-OFF-' + i, cart: CART_SEMANGCI_2, metode: 'CASH', uangDibayar: 50000, waktu: new Date().toISOString(), percobaan: 0, status: 'pending' });
    }
    dom.localStorage.setItem('pos_offline_queue', JSON.stringify(penuh));

    app.set('dataProduk', PRODUK_VALID);
    app.set('masterData', PRODUK_VALID);
    app.set('cart', CART_SEMANGCI_2.map(it => Object.assign({}, it)));
    dom.alerts.length = 0;
    app.call('checkout');
    await flush();

    r.assertIncludes(dom.alerts.join(' '), 'penuh', 'alert menyatakan antrian penuh');
    r.assertEq(app.get('cart').length, 1, 'keranjang TIDAK dikosongkan — kasir bisa coba lagi');
    const tetap = JSON.parse(dom.localStorage.getItem('pos_offline_queue') || '[]');
    r.assertEq(tetap.length, 50, 'tidak ada item ke-51');
  });
});

r.run('Antrian Transaksi Offline').then(ok => { process.exit(ok ? 0 : 1); });
