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
