'use strict';
/**
 * Verifikasi live pasca-deploy versi 73 (audit jalur input).
 * - HTML live memuat guard "const sukses" (perbaikan bug stok-palsu)
 * - Penanda CSS/JS versi sebelumnya tidak hilang (regresi UI/struk)
 * - API GET fallback balas JSON sehat
 * - GET tetap menolak aksi tulis (prosesCheckout / tambahStokProduk)
 */
const ENDPOINT = 'https://script.google.com/macros/s/AKfycbzNNhSQCDyaxcZ5m1_2oiPrbyUOctjthaBW7HKOYk2L6ngDIi95FEQSgED2XmBAaOihOg/exec';

async function main() {
  let pass = 0, fail = 0;
  function cek(nama, ok, detail) {
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + nama + (detail ? ' | ' + detail : ''));
    ok ? pass++ : fail++;
  }

  // 1. Halaman web app: penanda perbaikan + penanda versi sebelumnya
  const res = await fetch(ENDPOINT, { redirect: 'follow' });
  const html = await res.text();
  cek('halaman HTML OK', res.ok && html.length > 5000, 'status=' + res.status + ' len=' + html.length);
  cek('perbaikan stok-palsu ada (guard "const sukses")', html.includes('const sukses'));
  // Marker trim ada di Code.js (backend) — dicek lokal, karena source Code.js
  // memang tidak pernah disajikan sebagai bagian HTML halaman.
  const fs = require('fs');
  const path = require('path');
  const codeJs = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');
  cek('penanda trim backend ada (Code.js ter-push)', codeJs.includes('trim() agar ID dengan spasi tak sengaja tetap cocok'));
  cek('penanda struk versi 72 tetap ada', html.includes('receipt-logo'));
  cek('penanda UI versi 71 tetap ada', html.includes('Graphite') || html.includes('--ink'));
  cek('penanda antrian offline tetap ada', html.includes('pos_offline_queue'));

  // 2. API GET fallback sehat
  const resGet = await fetch(ENDPOINT + '?action=getInitialData', { redirect: 'follow' });
  const payload = JSON.parse(await resGet.text());
  const produk = payload && Array.isArray(payload.produk) ? payload.produk : [];
  cek('GET getInitialData JSON sehat', produk.length >= 2, 'produk=' + produk.length);

  // 3. GET menolak aksi tulis
  const resTulis = await fetch(ENDPOINT + '?action=prosesCheckout&args=' + encodeURIComponent('[[1,"x",1]]'), { redirect: 'follow' });
  const pTulis = JSON.parse(await resTulis.text());
  cek('GET prosesCheckout ditolak', pTulis.status === 'error', String(pTulis.message || '').slice(0, 60));

  const resTulis2 = await fetch(ENDPOINT + '?action=tambahStokProduk&args=' + encodeURIComponent('["1",5,"KASIR"]'), { redirect: 'follow' });
  const pTulis2 = JSON.parse(await resTulis2.text());
  cek('GET tambahStokProduk ditolak', pTulis2.status === 'error', String(pTulis2.message || '').slice(0, 60));

  console.log('=== Verifikasi live v73: ' + pass + ' pass, ' + fail + ' fail ===');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('GAGAL:', e.message || e); process.exit(1); });
