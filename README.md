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

**Stok UI langsung berubah (`tests/frontend_stok.test.js`) — 6 kasus:**
- Optimistic update: stok berkurang seketika setelah checkout sukses (lokal + cache),
  multi-produk ikut terkurang, checkout gagal tidak mengubah stok.
- Stok langsung bertambah setelah tambah stok sukses.
- Sinkronisasi berkala memakai data server terbaru (bukan render cache lama).

**Alur pasca-login (`tests/frontend_login.test.js`) — 9 kasus:**
- **Regresi utama**: fetch awal saat halaman dibuka gagal (server lambat/cold start),
  login sukses → stok tetap langsung tampil dari server, bukan cache kosong.
- Render pasca-login mengabaikan guard `isUserInteracting`.
- Fallback ke cache + retry otomatis maks 2x saat server tetap gagal, tanpa crash/alert.
- Pemulihan sesi (refresh halaman saat masih login) mengambil data terbaru dari server.
- Login gagal/kredensial kosong tidak memicu fetch data.

### Struktur berkas pengujian

```
tests/
├── helpers.js               # Mock GAS + stub DOM + runner mini
├── backend.test.js          # Suite backend (Code.js)
├── frontend.test.js         # Suite frontend (index.html)
├── frontend_stok.test.js    # Regresi stok langsung berubah di UI
└── frontend_login.test.js   # Regresi stok tampil setelah login
```
