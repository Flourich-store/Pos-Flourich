'use strict';
/**
 * Verifikasi deploy: halaman web app + API GET + proteksi aksi tulis.
 * Pemakaian: node tests/verify_antrian.js "<URL_web_app>"
 */
const url = process.argv[2] || 'https://script.google.com/macros/s/AKfycbzNNhSQCDyaxcZ5m1_2oiPrbyUOctjthaBW7HKOYk2L6ngDIi95FEQSgED2XmBAaOihOg/exec';

async function ambil(urlOpts) {
  const res = await fetch(urlOpts, { redirect: 'follow' });
  return { status: res.status, text: await res.text() };
}

function unescapeGas(s) {
  return s.replace(/\\x3d/g, '=').replace(/\\x5b/g, '[').replace(/\\x5d/g, ']').replace(/\\x27/g, "'");
}

(async () => {
  let gagal = 0;
  const cek = (nama, ok, detail) => {
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + nama + (detail ? ' | ' + detail : ''));
    if (!ok) gagal++;
  };

  // 1. Halaman web app: HTML dengan penanda kode antrian offline
  try {
    const hal = await ambil(url);
    const html = unescapeGas(hal.text || '');
    cek('Halaman web app HTTP 200', hal.status === 200);
    cek('HTML (bukan JSON)', String(html).trim().charAt(0) === '<', 'awal: ' + String(html).trim().slice(0, 30));
    for (const penanda of ['pos_offline_queue', 'bacaAntrianOffline', 'kirimAntrianOffline', 'offlineQueueBadge', 'koneksiId']) {
      cek('Penanda "' + penanda + '" ada di halaman', html.indexOf(penanda) !== -1);
    }
  } catch (e) {
    cek('Halaman web app', false, String(e));
  }

  // 2. API GET: getInitialData
  try {
    const api = await ambil(url + '?action=getInitialData');
    let json = null;
    try { json = JSON.parse(api.text); } catch (e) { }
    // doGet membalas hasil fungsi backend langsung (tanpa pembungkus 'data')
    const produk = json && (json.produk || (json.data && json.data.produk));
    cek('API GET getInitialData JSON', Array.isArray(produk),
      Array.isArray(produk) ? (produk.length + ' baris (termasuk header)') : String(api.text).slice(0, 80));
  } catch (e) {
    cek('API GET getInitialData', false, String(e));
  }

  // 3. Proteksi: aksi tulis via GET ditolak
  try {
    const tolak = await ambil(url + '?action=prosesCheckout&args=' + encodeURIComponent('[[],"CASH",0]') + '&koneksiId=probe-verify');
    let json = null;
    try { json = JSON.parse(tolak.text); } catch (e) { }
    cek('GET prosesCheckout DITOLAK', json && json.status === 'error',
      json ? String(json.message).slice(0, 60) : String(tolak.text).slice(0, 60));
  } catch (e) {
    cek('GET prosesCheckout ditolak', false, String(e));
  }

  console.log(gagal === 0 ? '=== SEMUA VERIFIKASI LULUS ===' : '=== ' + gagal + ' VERIFIKASI GAGAL ===');
  process.exit(gagal === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
