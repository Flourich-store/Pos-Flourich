# Lintas Cek Harian: Mutasi QRIS Merchant ↔ Sheet Penjualan

Tujuan: membuktikan setiap rupiah QRIS yang di-settle di merchant masuk sheet
Penjualan, dan memastikan selisih ditemukan dari FAKTA jam+nominal, bukan
asumsi. Skrip verifikasi: [tools/cek_mutasi_qris.js](tools/cek_mutasi_qris.js).

## Kategori temuan

| Kode | Arti | Penanganan |
|---|---|---|
| **A** | QRIS tercatat di sheet TAPI tidak ada mutasi merchant | Minta bukti settle ke merchant — dana tidak masuk |
| **B** | Mutasi merchant TANPA baris QRIS di sheet | Transaksi tidak tercatat — cek antrian offline (lihat bawah) |
| **C** | Mutasi QRIS tanpa pasangan, TAPI ada baris CASH nominal sama & jam dekat | Dugaan metode terpilih CASH padahal bayar QRIS — koreksi data |

## Langkah kasir (harian)

**Pagi (2 menit)**
1. Buka aplikasi merchant → catat jam + nominal tiap settle QRIS pagi ini
   ke kertas atau teks.
2. Bandingkan jumlah struk QRIS fisik vs jumlah mutasi.

**Sore/malam (5 menit)**
3. POS → Riwayat Penjualan → filter hari ini.
4. Buat file CSV mutasi (format di bawah) dan jalankan perintah pencocok.
5. Jika ada temuan **B**: buka DevTools perangkat kasir (chrome://inspect),
   jalankan `localStorage.getItem('pos_offline_queue')` — jika kosong tapi
   ada temuan B, kerangka auditor memperkirakan penyebab; simpan screenshot
   output skrip + log console untuk admin.
6. Jika ada temuan **C**: konfirmasi ke kasir; koreksi kolom metode di sheet.
7. Jika ada temuan **A**: lapor ke merchant AppleWebKit yangkosong bukti settle.

## Format CSV mutasi

Satu baris per mutasi, delimiter `;` atau `,` (deteksi otomatis), baris
`#...` = komentar, header jam/nominal opsional:

```
jam;nominal
06:29;Rp 20.000
06:49;Rp 10.000
```

Nominal bebas format (`15000`, `Rp 15.000`, `15,000` — titik/koma ribuan
dipahami, jangan pakai desimal). Jam boleh `HH:mm` saja atau lengkap
`dd/mm/yyyy HH:mm` bila CSV lintas hari.

## Perintah skrip

```bash
node tools/cek_mutasi_qris.js --date 25/10/2026 --mutasi mutasi-25-10.csv
node tools/cek_mutasi_qris.js --date 25/10/2026 --mutasi m.csv --tol 10
node tools/cek_mutasi_qris.js --date 25/10/2026 --mutasi m.csv --simpan snap.json
node tools/cek_mutasi_qris.js --date 25/10/2026 --mutasi m.csv --data snap.json
node tools/cek_mutasi_qris.js --date 25/10/2026 --mutasi m.csv --strict
```

- `--date dd/mm/yyyy` — filter baris sheet tanggal itu (default: hari ini,
  Asia/Jakarta). Wajib bila CSV memakai jam tanpa tanggal.
- `--tol N` — toleransi memasangkan jam (menit, default 5; settle bisa telat
  1–2 menit).
- `--limit N` — jumlah baris sheet yang ditarik (default 3000, cukup untuk
  beberapa hari ke belakang).
- `--simpan/--data file.json` — simpan/pakai snapshot hasil GET untuk
  re-run offline tanpa menyentuh endpoint lagi.
- `--api url` — endpoint GAS lain; `--strict` — exit 1 bila ada temuan.
- Skrip murni READ-ONLY (hanya GET `getInitialData`), tidak menulis sheet.
