# POS-Flourich

POS (Point of Sale) berbasis Google Apps Script + Spreadsheet.
Frontend: `index.html` — Backend: `Code.js` (deploy sebagai Web App Apps Script).

## Menjalankan Pengujian Lokal

Pengujian berjalan di Node.js **tanpa dependensi eksternal**. Code.js dan blok
`<script>` index.html dijalankan apa adanya di sandbox `vm` dengan mock
Google Apps Script (`SpreadsheetApp`, `PropertiesService`, dst.) dan stub DOM.

```bash
npm test
# atau manual:
node tests/backend.test.js
node tests/frontend.test.js
node tests/frontend_stok.test.js
node tests/frontend_login.test.js
node tests/frontend_jaringan.test.js
node tests/frontend_antrian.test.js
node tests/audit_input.test.js
```

### Cakupan pengujian

**Backend (`tests/backend.test.js`) — 12 kasus:**
- Alur normal `prosesCheckout`: CASH (kembalian & stok berkurang), QRIS, validasi cart,
  stok kurang, uang kurang, ID produk tidak dikenal.
- **Skenario data produk gagal dimuat**: `getValues()` melempar error, mengembalikan
  non-array, sheet kosong, dan sheet tidak ada — semuanya harus menghasilkan error
  terkendali, bukan `TypeError: dataProduk.findIndex is not a function`.
- Jalur HTTP `doPost`: checkout sukses dan action tidak dikenal.

**Frontend (`tests/frontend.test.js`) — 13 kasus:**
- Inisialisasi: `dataProduk`/`masterData` selalu array; respon `getInitialData` rusak
  di-fallback ke `[]`; cache `localStorage` korup dibuang otomatis.
- `checkout()` normal: CASH & QRIS sukses, modal sukses tampil, keranjang kosong.
- **Checkout saat data produk gagal dimuat**: diblokir dengan pesan ramah
  ("Data produk belum termuat..."), tanpa crash.
- Cart tercemar non-array dan `addToCart` saat data gagal dimuat.
- Mode lokal (`file:`): mock backend & alur lengkap add-to-cart → checkout.

**Stok UI & sinkronisasi (`tests/frontend_stok.test.js`) — 6 kasus:**
- **Stok dikelola manual**: checkout sukses TIDAK mengubah stok di UI/cache
  (backend murni pencatatan penjualan, tanpa tulis stok).
- Stok berubah hanya lewat Tambah Stok (langsung tampil di UI) / data server.
- Sinkronisasi berkala memakai data server terbaru (bukan render cache lama).

**Alur pasca-login (`tests/frontend_login.test.js`) — 9 kasus:**
- **Regresi utama**: fetch awal saat halaman dibuka gagal (server lambat/cold start),
  login sukses → stok tetap langsung tampil dari server, bukan cache kosong.
- Render pasca-login mengabaikan guard `isUserInteracting`.
- Fallback ke cache + retry otomatis maks 2x saat server tetap gagal, tanpa crash/alert.
- Pemulihan sesi (refresh halaman saat masih login) mengambil data terbaru dari server.
- Login gagal/kredensial kosong tidak memicu fetch data.

**Ketahanan jaringan (`tests/frontend_jaringan.test.js`) — 13 kasus:**
- Backend: `doGet` fallback GET untuk aksi baca (`getInitialData`, `checkLogin`);
  aksi tulis (`prosesCheckout`, `tambahStokProduk`) **ditolak** lewat GET (keamanan
  transaksi); halaman web app tetap bisa dibuka tanpa parameter.
- Frontend `apiRequest`: timeout 25 detik + retry otomatis 3x dengan backoff;
  fallback jalur GET hanya untuk aksi baca; respons HTML error Google & HTTP 5xx
  di-retry; error bisnis (stok kurang, dsb.) tampil apa adanya tanpa retry; pesan
  akhir menenangkan (transaksi belum tercatat, keranjang aman).

**Antrian transaksi offline (`tests/frontend_antrian.test.js`) — 21 kasus:**
- Jaringan putus saat checkout → transaksi masuk **antrian lokal** (localStorage,
  maks 50), struk lokal ber-ID `FR-OFF-...` tetap tercetak, keranjang aman, dan
  badge indikator di header menampilkan jumlah transaksi tertunda.
- Setiap percobaan checkout diberi `koneksiId` unik → kirim ulang memakai
  koneksiId yang **sama** → **idempotensi**: backend tidak pernah dobel-catat
  (Penjualan tetap 1 baris, stok tetap berkurang sekali).
- Kirim ulang otomatis saat koneksi pulih (event `online`, sukses refresh data,
  login) + error bisnis saat kirim ulang dikeluarkan dari antrian (bukan loop
  abadi); retry jaringan dibatasi 8x per item; antrian korup di-reset aman.
- Backend: `prosesCheckout` menerima `koneksiId` via POST **maupun** GET; klien
  lama tanpa koneksiId tetap normal; GET tetap menolak aksi tulis.

**Audit jalur input — stok & penjualan (`tests/audit_input.test.js`) — 16 kasus:**
- **Backend `tambahStokProduk`**: sukses (stok sheet bertambah), ID dengan spasi
  tetap cocok (trim), penolakan qty 0/negatif/non-angka, ID tidak ditemukan,
  role tanpa akses, sheet Produk kosong/rusak — semua balas teks, tanpa crash.
- **UI `aksiTambahStok` via jalur HTTPS** (fetch stub → `doPost` backend sungguhan):
  stok di layar langsung bertambah saat server konfirmasi; **regresi bug stok-palsu** —
  server menolak (ID salah) → alert penolakan tampil tapi stok di layar **tidak**
  bertambah; guard qty tidak valid di frontend; prompt dibatalkan → tanpa request;
  role tanpa akses diblokir sebelum prompt qty.
- **Rantai penjualan ujung-ke-ujung** (UI → `doPost` → mock spreadsheet): addToCart
  & updateCartQty menolak qty melebihi stok; checkout ditolak server → keranjang aman
  & tidak masuk antrian offline; checkout sukses → Penjualan tercatat 1 baris,
  stok sheet tidak disentuh (stok manual); uang kurang ditolak konsisten oleh
  frontend & backend.

### Perbaikan v87 — "tabel kosong" setelah login (P1, P2, P4) + P5, diagnosis P6

Akar masalah "login sukses tapi tabel produk/riwayat kosong" terbukti DUA, keduanya
di frontend, keduanya terverifikasi di halaman live.

- **P1 — guard interaksi menelan update server tanpa jejak** (penyebab utama).
  `renderFromCache()` `return` begitu `isUserInteracting` menyala, dan flag itu hanya
  dilepas `focusout`. Di perangkat kasir `focusout` kadang tak pernah datang (tekan
  tombol tanpa lepas fokus, pindah aplikasi, layar terkunci) sehingga flag nyangkut dan
  SETIAP update berikutnya hilang diam-diam — termasuk sinkronisasi 45 detik. Terbukti
  di live: 7/10 → server kirim 2 produk, guard menyala tetap 7/10; guard dilepas
  langsung 2/1. Kini flag `renderTertunda` mencatat update yang ditahan dan
  mengeksekusinya begitu interaksi selesai, lewat tiga pemicu tanpa timer/tebakan:
  `focusout`, `window blur`, `visibilitychange`. Tidak ada yang tertahan → tidak ada
  render sia-sia.
- **P2 — sisa filter tidak pernah dikosongkan saat login.** `filterSearch` dan
  rentang tanggal bertahan dari kunjungan sebelumnya, jadi `applyFilter()` langsung
  menyaring seluruh baris dan riwayat tampil kosong. Terbukti di live: sisa
  `zzz-tidak-ada` → 1 baris (empty state), dikosongkan → 10 baris. Login sukses kini
  memanggil `resetFilter()` yang sudah ada.
- **P4 — tick sinkronisasi 45 detik yang pasti sia-sia dilewati.** Setelah P1, hasil
  refresh yang masuk saat guard menyala nol byte-nya sampai ke layar, tapi tetap
  dibayar penuh ke Spreadsheet. Pentanya di dalam callback `setInterval`, BUKAN di
  dalam `refreshData` — yang terakhir akan ikut mematikan refresh setelah
  checkout/tambah stok. Terukur: tab terlihat & tidak berinteraksi → 1 request;
  berinteraksi → 0; interaksi selesai → 1; tab tersembunyi → 0; refresh setelah
  checkout tetap 1 walau tab tersembunyi.
- **P5 — dua `Logger.log()` per-panggilan di `getSpreadsheet()` dibuang.** Fungsi ini
  dipanggil hampir di setiap aksi server; ENV & ssId praktis tidak pernah berubah.
  Terukur 2 baris log per panggilan, 40 baris untuk 20 panggilan, dan log yang
  berguna (HPP kosong, header tidak ketemu, idempotensi) tenggelam. Detail env+ssId
  dipindah ke jalur `catch` — muncul justru saat `openById` gagal. Log error sendiri
  TIDAK dibungkam. **Aktif di kasir sejak v90** (29/09), tanpa perubahan URL.
- **P3 — sudah DIUKUR, lalu ditolak.** Dugaan awal "hemat 3-5 detik/login" ternyata
  salah: tidak ada antrean request (`apiRequest` = `fetch` biasa), sehingga fetch
  pre-login berjalan paralel dan dampaknya hanya kontensi ±0,3-0,7 detik. Deduksi
  "tarik seluruh riwayat 524 baris" juga salah — `getInitialData` sudah punya default
  60 baris, jadi `getInitialData[]` identik dengan `[60]` (61 baris, 13 kolom,
  keduanya). Yang benar-benar terbuang cuma ~3 detik KUOTA Apps Script per page load,
  bukan kecepatan yang dilihat kasir. Menghapusnya berarti membuang jaring pengaman
  cache hangat — kategori bug yang justru baru diperbaiki. **Keputusan pemilik: jangan
  kerjakan.** Angka di sini supaya tidak dianalisis ulang.
- **P6 — diagnosis (bukan perbaikan) untuk menutup sisa kasus guard nyangkut.**
  Yang sudah terbukti adalah akibatnya, belum pemicunya, sehingga diagnosis
  sebelumnya masih menggantung. Tick sinkronisasi kini mencatat, setiap 90
  detik (2 tick), bahwa guard sudah menyala terlalu lama, menyebut elemen yang
  memegangnya dan apakah ada update yang tertahan. Sengaja **tidak pernah
  melepas guard sendiri** — melepas tanpa bukti berarti menebak kapan
  "cukup", dan render di tengah pengetikan bisa menimpa input kasir.
  Ditambah `laporanInteraksiPos()`: satu perintah console untuk mengambil
  laporan state tanpa menggulir log panjang. Verifikasi end-to-end di DOM
  asli: `getInitialData` masuk saat guard menyala → `stokTable` 0 baris &
  `penjualanTable` 1 baris (persis gejala yang dilaporkan kasir), lalu
  `focusout` melepas guard → 7 dan 10 baris. Guard dalam uji itu menyala 104
  detik, melewati ambang 90 detik, jadi diagnosisnya tepat sasaran.

Suite: 281 → 301 tes, semua hijau. 15 tes regresi baru (P1 ×5, P2 ×1, P4 ×5,
  P5 ×3, P6 ×6), semuanya ditulis lebih dulu dan sudah diamati gagal
  sebelum kodenya diubah.
"interval 45000 ms" yang rapuh (jendela 400 karakter) diganti membaca nilai dari
argumen `setInterval` — tetap setektif, hanya tahan terhadap komentar tambahan.
P6 tidak menaikkan versi: ia tidak mengubah apa yang dilihat kasir, hanya
menambah satu peringatan console. Helper `triggerEvent` kini menerima argumen
event opsional agar `focusin` bisa diuji di batas event yang sebenarnya.

**Route halaman Apps Script tertinggal, lalu disusulkan di v90.** Halaman POS
yang dipakai kasir berasal dari GitHub Pages (v87). Route halaman di
deployment `@89` memang benar-benar tertinggal — P1/P2/P4 belum ada di sana.
Tapi dua "bukti" yang sempat dipakai untuk menyimpulkan tertinggal jauh
ternyata artefak, dan dicoret agar tidak dipakai lagi: wrapper web app Apps
Script meng-escape `<` menjadi `\x3c` (jadi `<th` tak terlihat sama sekali)
dan menyisipkan daftar nama fungsi server (jadi `getPenjualanReport` muncul
sebagai `\x22getPenjualanReport\x22`). Setelah di-decape keduanya cocok dengan
lokal, jadi yang benar-benar tertinggal hanya isi kodenya. Sejak v90 route ini
sudah menyusul: P1/P4/P6 ada dan 20 elemen `<th>`, sama seperti lokal.

Deployment `@HEAD` (`...RjJWNV`) dipastikan tidak bisa dipakai: halamannya
login Google (`accounts.google.com/v3/signin/`), jadi kasir selalu butuh
otorisasi.

**Memperbarui deployment: `clasp deploy -i` TIDAK bisa dipakai.** Pada
29/09 dicoba dan gagal 404 tanpa efek samping (versi 90 tidak terbentuk).
Yang berhasil: `versions.create` lalu `deployments.update` (PUT) dengan
`deploymentConfig` saja. `entryPoints` ditolak API saat update ("Unknown name
`entryPoints`") — untungnya itu field baca-saja, jadi `executeAs:
`USER_DEPLOYING`` dan `access: ANYONE_ANONYMOUS` otomatis utuh, dan URL tetap
sama sehingga `API_URL` tidak perlu disentuh. **HATI-HATI:** `clasp deployments`
 masih menampilkan `@89` setelah update — datanya basi. Yang benar dibaca
dari `deployments.get`, yang mengembalikan `versionNumber: 90`.

### Perbaikan v84 — Fase 2: ikon SVG inline (FontAwesome dihapus) + fix payload riwayat

- **FIX BUG LIVE "struktur data berubah"**: trim payload v83 membuat header 11
  elemen vs baris data 8 elemen — mismatch yang ditolak frontend (login nyangkut
  "MEMPROSES..." dengan alert struktur tidak valid di device lama). Payload
  `getInitialData` kembali konsisten 11 kolom (header == data) — kompatibel ke
  SEMUA frontend, termasuk halaman lama yang masih ter-cache di browser user.
- **Riwayat Penjualan sekarang tampil 11 kolom, sama persis dengan sheet**: ID,
  Tanggal, Produk, Qty, Total, Metode, Uang Dibayar, Uang Kembali + Modal,
  Biaya Operasional, Laba Bersih (permintaan: "kolom riwayat disamakan dengan
  sheet Penjualan karena tata letak berbeda-beda"). Baris historis lama yang
  kosong tampil Rp 0 — bukan error, menyesuaikan isi sheet.
- Tes baru: payload mismatch ditolak aman tanpa crash; backend dijamin selalu
  mengirim header == panjang baris (regresi v83 tidak akan terulang). Suite:
  114 → 117 tes, semua hijau.
- **Inventaris lengkap**: 28 glyph unik (27 statik + `eye-slash` dinamis) + animasi
  `fa-spin`. Mapping 1:1 ke SVG resmi Font Awesome Free 6.4.0 (CC BY 4.0) sebagai
  `<symbol>` inline sprite — dirender via `<use href="#icon-...">`.
- **Hemat ±252 KB + 1 request** per kunjungan: CSS all.min.css (102 KB) + webfont
  fa-solid-900.woff2 (150 KB) tidak lagi diunduh; sprite hanya ±5 KB dan ikut cache
  halaman.
- Toggle intip-password kini via `setPassIcon()` (ganti `href` `<use>`), bukan
  classList. Aturan CSS `.login-hint i`, `.user-badge i`, `.card h3 i` diganti
  selector `.ic`; animasi spin ada di `.icon-spin`.
- **Verifikasi nol dependensi**: 0 token `fa-*`, 0 tag `<i>`, 0 link font-awesome,
  0 request cdnjs. FA dihapus HANYA setelah semua 38 tag `<i>` terganti.
- Regresi browser (mock lokal, produksi aman): login, toggle password, ikon kart/
  navbar/modal/struk, checkout CASH (stok berkurang instan + validasi uang kurang
  tetap jalan), riwayat 11 kolom termasuk baris historis lama, 360px tanpa overflow
  dokumen (tabel lebar scroll dalam wadah).

### Perbaikan v83 — Fase 1 optimasi performa

- `getInitialData` tidak mengirim kolom 8-10 (Modal/biayaOperasional/labaBersih) —
  dependency check: frontend hanya baca kolom 0-7, dashboard baca langsung sheet,
  tanpa export CSV. Sheet tetap 11 kolom.
- `renderPenjualanTable` single-write (dulu `innerHTML +=` per baris, O(n²)).
- Gambar produk `loading=lazy decoding=async`.
- `preconnect` CDN ikon.

### Perbaikan v82 — kalibrasi ulang login & ketahanan fallback

- **Timeout login 6 dtk → 20 dtk**: diagnostik live menunjukkan redirect 302 Google
  saja butuh 4,7-5,3 dtk dan `checkLogin` (yang membawa `dataAwal`) bisa 5-15 dtk saat
  cold start — timeout 6 dtk v81 memotong request yang masih diproses server
  ("Failed to fetch" berulang → alert koneksi).
- **Watchdog login 60 dtk**: browser lama tanpa `AbortController` tidak punya timeout
  sendiri — kini tombol MASUK dijamin kembali aktif walau fetch menggantung.
- **HTTP 401/403/404 di POST → langsung fallback GET** (tanpa retry di jalur yang
  sama); 5xx & 429 tetap di-retry 3x. Cek `!response.ok` kini SEBELUM parsing JSON
  agar 404 ber-body HTML tidak menyembunyikan penyebab.
- Pesan gagal login menjelaskan cold start 10-20 dtk pertama.

### Perbaikan v81 — audit mobile (login & stok)

- **Self-check versi halaman**: GitHub Pages meng-cache HTML (`max-age=600`) sehingga
  HP bisa menjalankan halaman LAMA tanpa sadar — penyebab utama "login nyangkut" dan
  "stok tidak berkurang" yang ternyata bukan bug kode. Kini halaman membandingkan
  `<meta name="app-version">` (browser) dengan versi di server dan reload otomatis
  SEKALI bila lebih tua (guard sesi anti-loop). Naikkan `VERSI_HTML` + meta bersamaan
  tiap rilis.
- **Timeout login benar-benar berlaku**: `opsi.timeoutMs` sebelumnya dihitung tapi
  tidak pernah diteruskan ke `fetchDenganTimeout` (login mobile tetap menunggu 25
  dtk per percobaan). Kini diteruskan via `opts.batasMs` — login gagal cepat ±14 dtk
  dengan tombol kembali aktif + pesan jelas.
- **Stok langsung berkurang di UI**: update stok optimistic pasca-checkout kini
  merender via `renderDataPaksa()` (guard `isUserInteracting` tidak lagi bisa
  menahan tampilnya stok baru di HP).
- **LockService**: `prosesCheckout` & `tambahStokProduk` berjalan di bawah kunci
  tulis script-wide (maks tunggu 20 dtk; bila lock gagal, transaksi tetap diproses
  tanpa lock agar kasir tidak pernah terblokir). Mencegah race condition dobel-tulis
  stok antar perangkat yang checkout bersamaan.
- **Debug log alur** (tanpa kredensial): `LOGIN START → REQUEST SENT → SUCCESS/FAILURE`,
  `CHECKOUT START → SUCCESS/FAILURE`, `PRODUCT REFRESH START` — mudah dibaca dari
  remote debugging HP.

### Struktur berkas pengujian

```
tests/
├── helpers.js                  # Mock GAS + stub DOM + runner mini
├── backend.test.js             # Suite backend (Code.js)
├── frontend.test.js            # Suite frontend (index.html)
├── frontend_stok.test.js       # Regresi stok langsung berubah di UI
├── frontend_login.test.js      # Regresi stok tampil setelah login
├── frontend_jaringan.test.js   # Regresi ketahanan jaringan (retry + fallback GET)
├── frontend_antrian.test.js    # Regresi antrian transaksi offline + idempotensi
├── audit_input.test.js         # Audit jalur input stok & penjualan (uji perbaikan bug)
├── frontend_performa.test.js   # Regresi checkout instan + cache + trueSync
└── (kode & README)             # total 8 suite, 111 kasus (v81)
```
