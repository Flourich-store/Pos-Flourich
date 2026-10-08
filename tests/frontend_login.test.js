'use strict';

/**
 * ============================================================
 * Pengujian lokal — Data stok langsung tampil setelah login
 * Regresi bug lama: login sukses hanya me-render cache lokal
 * (fetchData -> renderFromCache), sehingga jika fetch awal saat
 * halaman dibuka gagal/lambat (cold start Apps Script di mobile),
 * tabel stok kosong sampai sinkronisasi 10 detik berikutnya.
 * ============================================================
 */

const { createDomStub, loadFrontend, createRunner } = require('./helpers');

const r = createRunner();

const RESPON_VALID = {
  produk: [
    ['id', 'nama', 'stok', 'harga', 'foto_url'],
    ['1', 'Semangci 250 ml', 50, 15000, ''],
    ['2', 'Wonapel 250 ml', 32, 14000, '']
  ],
  penjualan: [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali']],
  timestamp: 1
};

const CACHE_SEED = {
  produk: [
    ['id', 'nama', 'stok', 'harga', 'foto_url'],
    ['1', 'Semangci 250 ml', 99, 15000, '']
  ],
  penjualan: [['id', 'tanggal', 'namaProduk', 'jumlah', 'totalHarga', 'metode', 'uangDibayar', 'uangKembali']],
  timestamp: 0
};

function stokProduk(app, id) {
  const dp = app.get('dataProduk');
  if (!Array.isArray(dp)) return undefined;
  const row = dp.find(x => String(x[0]) === String(id));
  return row ? Number(row[2]) : undefined;
}

function dropdownMemuatProduk(app) {
  const sel = app.get('dataProduk');
  return Array.isArray(sel) && sel.length > 1;
}

/**
 * Muat frontend dalam mode file: (blok mock aktif).
 * opsi:
 *  - initialPayload : respon getInitialData untuk fetch awal (DOMContentLoaded)
 *  - gagalkanAwal   : getInitialData MELEMPAR error saat fetch awal (server lambat)
 *  - seedCache      : isi localStorage 'pos_initial_data' sebelum apa pun
 * Kembalikan { dom, app, hitungPanggilan, setResponServer, setServerGagal }.
 */
function loadLoginSkenario(opts) {
  const o = opts || {};
  const dom = createDomStub();
  const initialPayload = o.gagalkanAwal ? undefined : (o.initialPayload !== undefined ? o.initialPayload : RESPON_VALID);
  const app = loadFrontend(dom, initialPayload);
  const w = dom.window;

  let hitungPanggilan = 0;
  let responSekarang = initialPayload;
  let gagalSekarang = !!o.gagalkanAwal;

  // Bungkus/override mock getInitialData agar bisa dihitung & dialihkan perilakunya
  w.google.script.run.getInitialData = function () {
    hitungPanggilan++;
    if (gagalSekarang) throw new Error('Simulasi server lambat/gagal');
    return responSekarang;
  };

  if (o.seedCache) {
    dom.localStorage.setItem('pos_initial_data', JSON.stringify(o.seedCache));
  }

  return {
    dom: dom,
    app: app,
    get hitungPanggilan() { return hitungPanggilan; },
    setResponServer: (payload) => { responSekarang = payload; gagalSekarang = false; },
    setServerGagal: () => { gagalSekarang = true; }
  };
}

function isiKredensialAdmin(dom) {
  dom.window.__elements['userInp'].value = 'admin';
  dom.window.__elements['passInp'].value = 'password';
}

r.suite('Setelah login sukses, stok langsung tampil dari server', () => {

  r.test('REGRESI UTAMA: fetch awal gagal saat halaman dibuka, login sukses -> stok tetap langsung tampil', () => {
    // Simulasi nyata: halaman dibuka, fetch data awal GAGAL (cold start/jaringan lambat)
    const sk = loadLoginSkenario({ gagalkanAwal: true });
    sk.dom.triggerEvent('document', 'DOMContentLoaded'); // fetch awal gagal senyap
    r.assertEq(sk.hitungPanggilan, 1, 'fetch awal pernah dipanggil');

    // Server "pulih": panggilan berikutnya berhasil
    sk.setResponServer(RESPON_VALID);

    // User login -> HARUS mengambil data dari server, bukan cuma render cache kosong
    isiKredensialAdmin(sk.dom);
    sk.app.call('login');

    r.assertEq(stokProduk(sk.app, '1'), 50, 'stok produk 1 langsung terisi (50) setelah login');
    r.assertEq(stokProduk(sk.app, '2'), 32, 'stok produk 2 langsung terisi (32) setelah login');
    r.assertOk(dropdownMemuatProduk(sk.app), 'dataProduk terisi sehingga dropdown/tabel bisa dirender');
    r.assertOk(sk.hitungPanggilan >= 2, 'getInitialData dipanggil lagi setelah login');
  });

  r.test('render pasca-login mengabaikan guard isUserInteracting (stok tidak tertahan)', () => {
    const sk = loadLoginSkenario({ gagalkanAwal: true });
    sk.setResponServer(RESPON_VALID);

    // Simulasi fokus input nyasar yang menaikkan flag interaksi sebelum login
    sk.app.set('isUserInteracting', true);

    isiKredensialAdmin(sk.dom);
    sk.app.call('login');

    r.assertEq(stokProduk(sk.app, '1'), 50, 'stok tetap dirender walau flag interaksi aktif sebelum login');
  });

  r.test('login sukses menyimpan respon server ke cache untuk kunjungan berikutnya', () => {
    const sk = loadLoginSkenario({ gagalkanAwal: true });
    sk.setResponServer(RESPON_VALID);

    isiKredensialAdmin(sk.dom);
    sk.app.call('login');

    const raw = sk.dom.localStorage.getItem('pos_initial_data');
    r.assertOk(raw, 'cache terisi setelah login');
    const parsed = JSON.parse(raw);
    r.assertArray(parsed.produk, 'cache berisi produk berbentuk array');
    r.assertEq(Number(parsed.produk[1][2]), 50, 'cache berisi stok terbaru');
  });

});

r.suite('Server tetap gagal setelah login: fallback & retry', () => {

  r.test('fallback menampilkan cache yang ada agar stok tidak kosong menunggu server', () => {
    const sk = loadLoginSkenario({ gagalkanAwal: true, seedCache: CACHE_SEED });

    isiKredensialAdmin(sk.dom);
    sk.app.call('login');

    r.assertEq(stokProduk(sk.app, '1'), 99, 'stok dari cache (99) tampil sebagai fallback');
    r.assertOk(sk.hitungPanggilan >= 3, 'di-retry otomatis sampai batas (maks 2x retry)');
  });

  r.test('tanpa cache pun tidak crash (tidak ada exception, tidak ada alert merah)', () => {
    const sk = loadLoginSkenario({ gagalkanAwal: true });

    let tidakCrash = true;
    try {
      isiKredensialAdmin(sk.dom);
      sk.app.call('login');
    } catch (e) {
      tidakCrash = false;
    }
    r.assertOk(tidakCrash, 'alur login + gagal server + tanpa cache tidak melempar exception');
    r.assertEq(sk.dom.alerts.length, 0, 'tidak ada alert error ke user (hanya retry senyap)');
  });

  r.test('retry berhenti setelah batas (tidak loop tanpa henti)', () => {
    const sk = loadLoginSkenario({ gagalkanAwal: true });

    isiKredensialAdmin(sk.dom);
    sk.app.call('login');

    // 1 panggilan awal + 2 retry = 3, lalu berhenti
    r.assertEq(sk.hitungPanggilan, 3, 'total 3 percobaan lalu berhenti');
  });

});

r.suite('Sesi dipulihkan (halaman di-refresh saat masih login)', () => {

  r.test('onload dengan sesi valid mengambil data terbaru dari server, bukan cuma cache', () => {
    const sk = loadLoginSkenario({ gagalkanAwal: true, seedCache: CACHE_SEED });
    sk.setResponServer(RESPON_VALID);

    // Simulasi sesi tersimpan yang masih berlaku
    sk.dom.sessionStorage.setItem('pos_session_expiry', String(new Date().getTime() + 600000));
    sk.dom.sessionStorage.setItem('pos_username', 'admin');
    sk.dom.sessionStorage.setItem('pos_role', 'SUPER_ADMIN');

    sk.dom.window.onload();

    r.assertEq(stokProduk(sk.app, '1'), 50, 'stok fresh dari server (50), bukan cache lama (99)');
    r.assertOk(sk.hitungPanggilan >= 1, 'server dipanggil saat pemulihan sesi');
  });

});

r.suite('Login gagal: tidak ada fetch data', () => {

  r.test('kredensial salah -> tidak memanggil getInitialData & alert peringatan', () => {
    const sk = loadLoginSkenario({});

    sk.dom.window.__elements['userInp'].value = 'admin';
    sk.dom.window.__elements['passInp'].value = 'SALAH';
    sk.app.call('login');

    r.assertEq(sk.hitungPanggilan, 0, 'getInitialData tidak dipanggil saat login gagal');
    r.assertOk(sk.dom.alerts.length >= 1, 'ada alert peringatan login gagal');
  });

  r.test('username/password kosong -> ditolak tanpa panggilan server', () => {
    const sk = loadLoginSkenario({});

    sk.dom.window.__elements['userInp'].value = '';
    sk.dom.window.__elements['passInp'].value = '';
    sk.app.call('login');

    r.assertEq(sk.hitungPanggilan, 0, 'tidak ada panggilan data');
    r.assertIncludes(sk.dom.alerts.join(' | '), 'username', 'alert meminta mengisi username/password');
  });

});

r.suite('Login sukses: filter tabel dibersihkan', () => {

  // Gejala nyata: "login berhasil tapi tabel riwayat kosong".
  // Penyebab: sisa filter dari kunjungan sebelumnya (filterSearch / rentang
  // tanggal) tidak pernah dikosongkan saat login, jadi applyFilter() langsung
  // menyaring seluruh baris dan tabel menampilkan keadaan kosong.

  r.test('sisa pencarian & filter tanggal dikosongkan setelah login sukses', () => {
    const sk = loadLoginSkenario({});
    sk.dom.window.__elements['filterSearch'].value = 'zzz-tidak-ada';
    sk.dom.window.__elements['filterStartDate'].value = '2000-01-01';
    sk.dom.window.__elements['filterEndDate'].value = '2000-01-02';

    isiKredensialAdmin(sk.dom);
    sk.app.call('login');

    r.assertEq(sk.dom.window.__elements['filterSearch'].value, '',
      'filter pencarian dikosongkan, bukan menyaring tabel jadi kosong');
    r.assertEq(sk.dom.window.__elements['filterStartDate'].value, '',
      'filter tanggal awal dikosongkan');
    r.assertEq(sk.dom.window.__elements['filterEndDate'].value, '',
      'filter tanggal akhir dikosongkan');
  });

});

// ============================================================
// v89.1: login paralel dua endpoint (hanya mode produksi)
// ============================================================

r.suite('Login paralel: mode lokal tetap lewat mock (tanpa fetch nyata)', () => {

  r.test('di file:/ login tetap memakai mock checkLogin (tidak crash, tidak fetch)', () => {
    let fetchTerpanggil = false;
    const sk = loadLoginSkenario({});
    sk.app.sandbox.fetch = function () {
      fetchTerpanggil = true;
      return Promise.reject(new Error('fetch nyata TIDAK boleh dipanggil di mode lokal'));
    };
    // Pastikan mock checkLogin tercatat saat dipanggil
    let checkLoginTerpanggil = false;
    const cekAsli = sk.dom.window.google.script.run.checkLogin;
    sk.dom.window.google.script.run.checkLogin = function (u, p) {
      checkLoginTerpanggil = true;
      return cekAsli(u, p);
    };

    isiKredensialAdmin(sk.dom);
    sk.app.call('login');

    r.assertOk(checkLoginTerpanggil, 'mock checkLogin dipakai di mode lokal');
    r.assertOk(!fetchTerpanggil, 'fetch nyata tidak dipanggil di mode lokal');
    r.assertEq(stokProduk(sk.app, '1'), 50, 'alur login sukses berjalan normal via mock');
  });});

// ============================================================
// v92: endpoint start pintar pada loginParalel (hanya mode produksi)
// ============================================================

/**
 * Muat frontend dengan protocol https: SEJAK AWAL sehingga isLocalMode=false
 * dan loginParalel memakai jalur paralel nyata (fetch dari sandbox).
 * fetchStub(url, opts) dipasang sebagai `fetch` dan merekam panggilan.
 */
function loadParalelSkenario(fetchStub) {
  const dom = createDomStub();
  dom.window.location.protocol = 'https:'; // sebelum load: isLocalMode=false
  const app = loadFrontend(dom); // tanpa payload -> blok mock https: tidak dipakai

  const panggilan = [];
  app.sandbox.fetch = function (url, opts) {
    panggilan.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return fetchStub(url, opts, panggilan.length);
  };
  return { dom, app, panggilan };
}

const ID_UTAMA = 'AKfycbyQlMr';      // awal ID endpoint utama di API_URL
const ID_CADANGAN = 'AKfycbzrk5';    // awal ID endpoint cadangan di API_URL_CADANGAN

const JAWABAN_LOGIN = JSON.stringify({
  status: true,
  username: 'admin',
  role: 'SUPER_ADMIN',
  dataAwal: { produk: [['id', 'nama', 'stok', 'harga', 'foto_url'], ['1', 'Semangci 250 ml', 50, 15000, '']], penjualan: [], timestamp: 1 }
});

function balasanOk() {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JAWABAN_LOGIN) });
}

r.suite('v92 endpoint start pintar: catatan tercepat menjadi jalur mulai login', () => {

  r.test('login sukses via endpoint utama -> localStorage mencatat "utama"', async () => {
    const { dom, app } = loadParalelSkenario((url) => {
      if (url.indexOf(ID_UTAMA) !== -1) return balasanOk(); // utama sukses
      return Promise.reject(new TypeError('Failed to fetch')); // cadangan gagal
    });

    let sukses = null;
    app.call('loginParalel', 'admin', 'password', (h) => { sukses = h; }, () => { });
    await new Promise(s => setTimeout(s, 10)); // beri waktu mikrotask

    r.assertEq(sukses && sukses.status, true, 'login sukses via utama');
    r.assertEq(dom.localStorage.getItem('pos_endpoint_login_cepat'), 'utama', 'pemenang tercatat = utama');
  });

  r.test('login sukses via endpoint cadangan -> localStorage mencatat "cadangan"', async () => {
    const { dom, app } = loadParalelSkenario((url) => {
      if (url.indexOf(ID_CADANGAN) !== -1) return balasanOk(); // cadangan sukses
      return Promise.reject(new TypeError('Failed to fetch')); // utama gagal
    });

    let sukses = null;
    app.call('loginParalel', 'admin', 'password', (h) => { sukses = h; }, () => { });
    await new Promise(s => setTimeout(s, 10));

    r.assertEq(sukses && sukses.status, true, 'login sukses via cadangan');
    r.assertEq(dom.localStorage.getItem('pos_endpoint_login_cepat'), 'cadangan', 'pemenang tercatat = cadangan');
  });

  r.test('tanpa catatan: jalur mulai = endpoint UTAMA, cadangan menyusul', () => {
    const { dom, app, panggilan } = loadParalelSkenario(() => new Promise(() => { })); // tidak pernah menjawab

    app.call('loginParalel', 'admin', 'password', () => { }, () => { });

    // Stub setTimeout eksekusi sinkron utk jeda <=5 dtk, jadi kedua kirim
    // sudah tercatat berurutan saat loginParalel kembali.
    r.assertEq(panggilan.length, 2, '2 endpoint dikirim');
    r.assertOk(panggilan[0].url.indexOf(ID_UTAMA) !== -1, 'yang pertama = endpoint utama');
    r.assertOk(panggilan[1].url.indexOf(ID_CADANGAN) !== -1, 'yang kedua = endpoint cadangan');
    r.assertEq(dom.localStorage.getItem('pos_endpoint_login_cepat'), null, 'belum ada catatan');
  });

  r.test('dengan catatan "cadangan": jalur mulai = endpoint CADANGAN, utama menyusul', () => {
    const { dom, app, panggilan } = loadParalelSkenario(() => new Promise(() => { })); // tidak pernah menjawab
    dom.localStorage.setItem('pos_endpoint_login_cepat', 'cadangan'); // catatan dari login sukses sebelumnya

    app.call('loginParalel', 'admin', 'password', () => { }, () => { });

    r.assertEq(panggilan.length, 2, '2 endpoint dikirim');
    r.assertOk(panggilan[0].url.indexOf(ID_CADANGAN) !== -1, 'yang pertama = endpoint cadangan (tercepat tercatat)');
    r.assertOk(panggilan[1].url.indexOf(ID_UTAMA) !== -1, 'yang kedua = endpoint utama (penutup)');
  });

  r.test('endpoint mulai gagal -> endpoint kedua tetap menutup (failover utuh)', async () => {
    const { dom, app } = loadParalelSkenario((url) => {
      if (url.indexOf(ID_CADANGAN) !== -1) return Promise.reject(new TypeError('Failed to fetch')); // mulai: gagal
      return balasanOk(); // penutup: sukses
    });
    dom.localStorage.setItem('pos_endpoint_login_cepat', 'cadangan');

    let sukses = null;
    app.call('loginParalel', 'admin', 'password', (h) => { sukses = h; }, () => { });
    await new Promise(s => setTimeout(s, 10));

    r.assertEq(sukses && sukses.status, true, 'login tetap sukses lewat endpoint penutup');
    r.assertEq(dom.localStorage.getItem('pos_endpoint_login_cepat'), 'utama', 'catatan diperbarui ke pemenang baru (utama)');
  });

});

r.run('frontend_login.test.js').then(ok => {
  process.exit(ok ? 0 : 1);
});
