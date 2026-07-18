// Cloudflare Worker — melayani halaman Lucky Spin (dari folder /public)
// dan endpoint API yang baca/tulis data ke Cloudflare KV.
//
// Ada 2 halaman terpisah:
//   /            -> public/index.html  (player, link untuk dibagikan ke member)
//   /admin       -> public/admin.html  (panel admin, jangan dibagikan)
//
// Ada 4 endpoint API:
//   GET  /api/state        -> data LENGKAP (termasuk PIN & semua kode). Hanya dipakai admin.html.
//   POST /api/state        -> simpan data lengkap. Hanya dipakai admin.html.
//   GET  /api/prizes       -> hanya daftar hadiah (aman dibagikan ke player).
//   POST /api/check-code   -> cek 1 kode, tidak membocorkan kode lain / PIN.
//   POST /api/finish-spin  -> tandai kode terpakai, catat pemenang, kirim webhook.

const KV_KEY = 'luckyspin_state';

const DEFAULT_STATE = {
  prizes: [
    { id: 'p1', name: 'Voucher 20rb', weight: 40, stock: null, color: '#3f9483' },
    { id: 'p2', name: 'Voucher 50rb', weight: 20, stock: null, color: '#e3b23c' },
    { id: 'p3', name: 'Coba Lagi', weight: 30, stock: null, color: '#b23a52' },
    { id: 'p4', name: 'Grand Prize', weight: 10, stock: 5, color: '#f3d685' }
  ],
  codes: [],
  history: [],
  settings: { pin: 'admin123', webhookUrl: '', prizeColumns: 2 }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getState(env) {
  const raw = await env.LUCKY_KV.get(KV_KEY);
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
  const parsed = JSON.parse(raw);
  // jaga-jaga kalau field baru belum ada di data lama
  if (!parsed.settings) parsed.settings = {};
  if (parsed.settings.prizeColumns === undefined) parsed.settings.prizeColumns = 2;
  return parsed;
}

async function saveStateObj(env, state) {
  await env.LUCKY_KV.put(KV_KEY, JSON.stringify(state));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // URL cantik: /admin -> admin.html
    if (path === '/admin' || path === '/admin/') {
      const adminUrl = new URL(url);
      adminUrl.pathname = '/admin.html';
      return env.ASSETS.fetch(new Request(adminUrl, request));
    }

    // ---------- FULL STATE: hanya untuk admin.html ----------
    if (path === '/api/state') {
      if (request.method === 'GET') {
        const state = await getState(env);
        return json(state);
      }
      if (request.method === 'POST') {
        try {
          const text = await request.text();
          const parsed = JSON.parse(text);
          await env.LUCKY_KV.put(KV_KEY, JSON.stringify(parsed));
          return json({ status: 'ok' });
        } catch (e) {
          return json({ status: 'error', message: 'Data tidak valid' }, 400);
        }
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // ---------- DATA PUBLIK: aman untuk player ----------
    if (path === '/api/prizes' && request.method === 'GET') {
      const state = await getState(env);
      return json({ prizes: state.prizes });
    }

    // ---------- CEK KODE: tanpa membocorkan kode lain / PIN ----------
    if (path === '/api/check-code' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { body = {}; }
      const code = (body.code || '').toString().trim().toUpperCase();
      if (!code) return json({ valid: false, message: 'Kode wajib diisi.' }, 400);

      const state = await getState(env);
      const entry = state.codes.find(c => c.code === code);
      if (!entry) return json({ valid: false, message: 'Kode tidak ditemukan.' });
      if (entry.used) return json({ valid: false, message: 'Kode ini sudah pernah dipakai.' });

      const activePrizes = state.prizes.filter(p => p.stock === null || p.stock > 0);
      if (activePrizes.length === 0) {
        return json({ valid: false, message: 'Stok hadiah sedang habis. Hubungi penyelenggara.' });
      }

      return json({ valid: true, fixedPrizeId: entry.fixedPrizeId || null, prizes: activePrizes });
    }

    // ---------- FINALISASI SPIN: satu-satunya yang boleh menandai kode "used" ----------
    if (path === '/api/finish-spin' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { body = null; }
      if (!body || !body.code || !body.prizeId) {
        return json({ status: 'error', message: 'Data tidak lengkap.' }, 400);
      }
      const code = String(body.code).trim().toUpperCase();
      const name = (body.name || '').toString().slice(0, 60);

      const state = await getState(env);
      const entry = state.codes.find(c => c.code === code);
      if (!entry) return json({ status: 'error', message: 'Kode tidak ditemukan.' }, 400);
      if (entry.used) return json({ status: 'error', message: 'Kode sudah pernah dipakai.' }, 400);

      const prizeRef = state.prizes.find(p => p.id === body.prizeId);
      if (!prizeRef) return json({ status: 'error', message: 'Hadiah tidak valid.' }, 400);
      if (entry.fixedPrizeId && entry.fixedPrizeId !== body.prizeId) {
        return json({ status: 'error', message: 'Hadiah tidak sesuai kode.' }, 400);
      }
      if (prizeRef.stock !== null) {
        if (prizeRef.stock <= 0) return json({ status: 'error', message: 'Stok hadiah ini sudah habis.' }, 400);
        prizeRef.stock -= 1;
      }

      entry.used = true;
      entry.prize = prizeRef.name;
      entry.usedAt = Date.now();
      entry.name = name;

      const record = { code: entry.code, prize: prizeRef.name, name, timestamp: new Date().toISOString() };
      state.history.unshift(record);

      await saveStateObj(env, state);

      // Kirim ke Google Sheets (server-side, jadi webhook URL tidak perlu dibocorkan ke player)
      if (state.settings.webhookUrl) {
        try {
          await fetch(state.settings.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(record)
          });
        } catch (e) { /* silent — jangan sampai kegagalan webhook menggagalkan hasil spin */ }
      }

      return json({ status: 'ok', prizeName: prizeRef.name });
    }

    // Selain rute di atas, layani file statis dari folder public (index.html, admin.html, dst)
    return env.ASSETS.fetch(request);
  }
};
