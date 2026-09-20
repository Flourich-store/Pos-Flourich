'use strict';

/**
 * Probe verifikasi deployment (TIDAK menulis data):
 * memanggil prosesCheckout dengan ID produk fiktif "999".
 * - Respons JSON {status:"error", message:"Produk ID 999 tidak ditemukan."}
 *   => kode BARU live (validasi berjalan, tidak ada TypeError).
 * - Respons berisi "findindex"/"findIndex is not a function"
 *   => masih kode LAMA (typo).
 */

const API_URL = process.argv[2];

if (!API_URL) {
  console.error('Pemakaian: node tests/verify_deploy.js <URL_web_app>');
  process.exit(1);
}

fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8', Accept: 'application/json' },
  body: JSON.stringify({
    action: 'prosesCheckout',
    args: [[{ id: '999', nama: 'Probe', jumlah: 1, total: 1000 }], 'QRIS', 0]
  })
})
  .then(async (r) => {
    const text = await r.text();
    console.log('HTTP status:', r.status);
    console.log('Respons:', text.substring(0, 300));

    const lower = text.toLowerCase();
    if (lower.includes('findindex')) {
      console.log('\nGAGAL: masih kode LAMA (typo findindex masih ada). Deployment belum aktif.');
      process.exit(2);
    }
    if (text.includes('"status":"error"') || text.includes('"status": "error"')) {
      console.log('\nOK: kode BARU live — validasi berjalan tanpa TypeError findIndex.');
      process.exit(0);
    }
    console.log('\nPERHATIAN: respons tidak dikenali — periksa manual.');
    process.exit(3);
  })
  .catch((e) => {
    console.error('Gagal fetch:', e.message);
    process.exit(1);
  });
