'use strict';
// Verifikasi live pasca-deploy versi 76 (performa checkout & refresh)
const ENDPOINT = 'https://script.google.com/macros/s/AKfycbzNNhSQCDyaxcZ5m1_2oiPrbyUOctjthaBW7HKOYk2L6ngDIi95FEQSgED2XmBAaOihOg/exec';

async function main() {
  let pass = 0, fail = 0;
  function cek(nama, ok, detail) {
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + nama + (detail ? ' | ' + detail : ''));
    ok ? pass++ : fail++;
  }

  // 1. HTML web app memuat penanda kode baru
  try {
    const r = await fetch(ENDPOINT);
    const html = await r.text();
    const unesc = html.replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    cek('HTML web app dapat diambil', r.ok && html.length > 1000, r.status + ', ' + html.length + ' bytes');
    cek('Penanda [60] argumen getInitialData (payload kecil)', unesc.includes("'getInitialData', [60]"));
    cek('Penanda cache pendek pos_api_cache_', unesc.includes('pos_api_cache_'));
    cek('Penanda trueSync refreshData', unesc.includes('function refreshData(silent, trueSync)'));
    cek('Penanda interval 45000', unesc.includes('45000'));
    cek('Penanda animasi struk receiptIn', unesc.includes('receiptIn'));
    cek('Penanda CSS lama interval 10000 hilang', !unesc.includes('}, 10000);'));
  } catch (e) {
    cek('HTML web app dapat diambil', false, e.message);
  }

  // 2. API GET: payload riwayat harus terbatas 60 baris terbaru
  try {
    const t0 = Date.now();
    const r = await fetch(ENDPOINT + '?action=getInitialData&args=' + encodeURIComponent(JSON.stringify([60])));
    const txt = await r.text();
    const ms = Date.now() - t0;
    const j = JSON.parse(txt);
    const data = j.data !== undefined ? j.data : j;
    cek('API GET getInitialData balas JSON', Array.isArray(data.produk), (data.produk || []).length + ' produk');
    cek('Riwayat terbatas (<= 60 baris + header)', Array.isArray(data.penjualan) && data.penjualan.length <= 61, data.penjualan.length + ' baris');
    cek('Latensi API GET wajar', ms < 15000, ms + ' ms');
  } catch (e) {
    cek('API GET getInitialData', false, e.message);
  }

  // 3. Aksi tulis via GET tetap ditolak
  try {
    const r = await fetch(ENDPOINT + '?action=prosesCheckout&args=' + encodeURIComponent(JSON.stringify([[], 'CASH', 0])));
    const j = JSON.parse(await r.text());
    cek('GET prosesCheckout ditolak (keamanan)', j.status === 'error', j.message || '');
  } catch (e) {
    cek('GET prosesCheckout ditolak', false, e.message);
  }

  console.log('---');
  console.log('TOTAL: ' + pass + ' pass, ' + fail + ' fail');
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
