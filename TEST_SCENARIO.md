# Dokumen Skenario Pengujian (Test Scenario Document)
**Sistem:** Flourich POS (PWA & Web App)  
**Versi Acuan PRD:** 1.0 (Commit f42cfb2)  
**Tanggal:** 19 Oktober 2026  
**Status:** Siap Siap Diotomatisasi (Automation-Ready)  

---

## 1. Pendahuluan
Dokumen ini merepresentasikan skenario pengujian fungsional dan non-fungsional untuk Flourich POS. Skenario dalam dokumen ini dirancang agar siap diterjemahkan ke dalam *script automation* menggunakan *testing framework* modern seperti **Playwright** atau **Cypress**.

---

## 2. Matriks Skenario Pengujian

### Modul 1: Autentikasi & Manajemen Sesi (FR-01)
| ID Skenario | Judul Skenario | Langkah Pengujian (Steps) | Hasil yang Diharapkan (Expected Results) | Prioritas |
| :--- | :--- | :--- | :--- | :--- |
| **TC-AUTH-01** | Login Kasir Berhasil | 1. Buka halaman login.<br>2. Masukkan *username* dan *password* valid.<br>3. Klik tombol "MASUK". | - Redirect ke halaman utama POS.<br>- Data sesi tersimpan di `sessionStorage`.<br>- Sesi diset berlaku selama 30 menit. | **High** |
| **TC-AUTH-02** | Login Gagal (Kredensial Salah) | 1. Buka halaman login.<br>2. Masukkan *username* atau *password* salah.<br>3. Klik "MASUK". | - Pesan error/peringatan muncul.<br>- Pengguna tetap berada di halaman login.<br>- `sessionStorage` tidak berisi token sesi. | **High** |
| **TC-AUTH-03** | Logout Sistem | 1. Berada dalam kondisi *logged in*.<br>2. Klik tombol Logout. | - `sessionStorage` dibersihkan.<br>- Redirect otomatis ke halaman login. | **Medium** |

---

### Modul 2: Katalog Produk & Keranjang Belanja (FR-03, FR-04)
| ID Skenario | Judul Skenario | Langkah Pengujian (Steps) | Hasil yang Diharapkan (Expected Results) | Prioritas |
| :--- | :--- | :--- | :--- | :--- |
| **TC-CART-01** | Penambahan Produk ke Keranjang | 1. Pilih produk dari daftar/dropdown.<br>2. Klik "Tambah ke Keranjang". | - Produk masuk ke keranjang.<br>- Total tagihan ter-update otomatis.<br>- Sisa stok di UI berkurang sesuai jumlah yang diambil. | **High** |
| **TC-CART-02** | Perubahan Kuantitas Item | 1. Tambah 1 produk ke keranjang.<br>2. Ubah *quantity* dari 1 menjadi 3. | - Subtotal item berubah (Harga x 3).<br>- Total transaksi dihitung ulang secara akurat. | **High** |
| **TC-CART-03** | Batas Maksimum Kuantitas Stok | 1. Pilih produk dengan sisa stok $N$.<br>2. Coba tambahkan kuantitas $> N$. | - UI memblokir penambahan lebih dari $N$.<br>- Pesan peringatan stok tidak mencukupi muncul. | **Medium** |

---

### Modul 3: Checkout & Pembayaran (FR-05, FR-06, FR-07)
| ID Skenario | Judul Skenario | Langkah Pengujian (Steps) | Hasil yang Diharapkan (Expected Results) | Prioritas |
| :--- | :--- | :--- | :--- | :--- |
| **TC-PAY-01** | Checkout CASH Nominal Pas/Lebih | 1. Buat keranjang belanja.<br>2. Pilih metode CASH.<br>3. Masukkan nominal bayar $\ge$ Total.<br>4. Klik Proses Checkout. | - Kembalian terhitung benar ($\text{Uang} - \text{Total}$).<br>- Tombol checkout terkunci sementara.<br>- Struk sukses ditampilkan dengan ID bermerek `FR-`. | **Critical** |
| **TC-PAY-02** | Checkout CASH Nominal Kurang | 1. Buat keranjang belanja.<br>2. Pilih metode CASH.<br>3. Masukkan nominal bayar $<$ Total.<br>4. Klik Proses Checkout. | - Sistem menolak proses checkout.<br>- Pesan kesalahan nominal pembayaran ditampilkan. | **High** |
| **TC-PAY-03** | Checkout QRIS dengan Konfirmasi Kasir | 1. Buat keranjang belanja.<br>2. Pilih metode QRIS.<br>3. Tekan Bayar.<br>4. Verifikasi modal QR statis.<br>5. Klik "Sudah Dibayar". | - Modal menampilkan QR statis & total tagihan.<br>- Setelah mengonfirmasi, transaksi berhasil dicatat dengan nilai bayar = total. | **High** |

---

### Modul 4: Handling Offline, Antrian, & Idempotensi (FR-08, FR-09, FR-10)
| ID Skenario | Judul Skenario | Langkah Pengujian (Steps) | Hasil yang Diharapkan (Expected Results) | Prioritas |
| :--- | :--- | :--- | :--- | :--- |
| **TC-OFF-01** | Checkout saat Jaringan Terputus (Offline Mode) | 1. Matikan jaringan browser (Simulasi Offline).<br>2. Selesaikan transaksi CASH.<br>3. Klik Proses. | - Transaksi tersimpan ke `localStorage`.<br>- Struk lokal tercetak dengan prefix `FR-OFF-`.<br>- Badge antrian offline bertambah +1. | **Critical** |
| **TC-OFF-02** | Sinkronisasi Otomatis Antrian Offline | 1. Buat 1 transaksi saat offline.<br>2. Nyalakan kembali jaringan.<br>3. Picu proses sinkronisasi. | - Antrian dikirimkan ke backend Apps Script.<br>- Transaksi berpindah dari `localStorage` ke Google Sheets.<br>- Badge antrian berkurang. | **High** |
| **TC-IDEM-01** | Pencegahan Transaksi Ganda (Deduplikasi) | 1. Kirim *request* checkout dengan `koneksiId` unik $X$.<br>2. Kirim ulang *request* kedua dengan `koneksiId` yang sama ($X$). | - Backend mengenali `koneksiId` $X$.<br>- Transaksi tidak dicatat dua kali di Google Sheets.<br>- Stok tidak terpotong dua kali. | **Critical** |

---

### Modul 5: Riwayat Penjualan & Filter (FR-12, FR-13)
| ID Skenario | Judul Skenario | Langkah Pengujian (Steps) | Hasil yang Diharapkan (Expected Results) | Prioritas |
| :--- | :--- | :--- | :--- | :--- |
| **TC-HIST-01** | Filter & Paginasi Riwayat | 1. Masuk ke tab Riwayat Penjualan.<br>2. Set filter tanggal & kata kunci pencarian.<br>3. Navigasi halaman (Next/Prev). | - Data difilter sesuai tanggal dan ID/Nama.<br>- Paginasi membatasi tampilan maksimal 10 baris per halaman. | **Medium** |

---

## 3. Panduan Langkah Selanjutnya (Next Steps Roadmap)

Setelah dokumen skenario di atas tersedia, berikut adalah alur kerja teknis yang harus Anda lakukan untuk mulai membangun *QA Automation Framework*:

```
[Skenario Siap] 
       │
       ▼
[1. Analisis Element Locators (DOM)]
       │
       ▼
[2. Setup Project Automation (Playwright/Cypress)]
       │
       ▼
[3. Implementasi Design Pattern (Page Object Model)]
       │
       ▼
[4. Penulisan Script Automation & Assertion]
       │
       ▼
[5. Integrasi ke Pipeline CI/CD (GitHub Actions)]
```

### Detail Langkah-Langkah Teknis:

#### Langkah 1: Elemen Mapping (DOM Locator Identification)
Buka aplikasi Flourich POS di browser, tekan `F12` (Inspect Element), lalu catat ID atau Class CSS unik untuk elemen penting:
*   Input Username: `#username` / `input[name="username"]`
*   Input Password: `#password` / `input[type="password"]`
*   Tombol Masuk: `button:has-text("MASUK")`
*   Dropdown Produk, Tombol Checkout, dst.

#### Langkah 2: Setup Testing Framework (Disarankan: Playwright + Node.js)
Jalankan perintah berikut di terminal komputer Anda untuk menginisialisasi *environment*:
```bash
npm init playwright@latest
```
Pilih TypeScript/JavaScript sebagai bahasa utama Anda.

#### Langkah 3: Terapkan Page Object Model (POM)
Buat struktur folder yang rapi agar kode *automation* mudah dirawat jika UI mengalami perubahan:
*   `pages/LoginPage.js` -> Menyimpan aksi & locator halaman Login.
*   `pages/POSPage.js` -> Menyimpan aksi memilih produk & checkout.
*   `tests/login.spec.js` -> File pengujian skenario login.
*   `tests/checkout.spec.js` -> File pengujian transaksi cash/qris.

#### Langkah 4: Tulis Kode Script Pertama
Terjemahkan skenario dari dokumen (misal **TC-AUTH-01**) ke dalam kode Playwright:
```javascript
// Contoh ringkas Playwright Test
test('TC-AUTH-01: Login Kasir Berhasil', async ({ page }) => {
  await page.goto('https://flourich-store.github.io/Pos-Flourich/');
  await page.fill('#username', 'kasir1');
  await page.fill('#password', 'password123');
  await page.click('button:has-text("MASUK")');
  
  // Assertion
  await expect(page).toHaveURL(/.*dashboard/);
});
```

#### Langkah 5: Jalankan & Evaluasi Pengujian
Jalankan pengujian secara lokal dengan mode visual (*Headed*) maupun tanpa antarmuka (*Headless*):
```bash
npx playwright test --headed
```