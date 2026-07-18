// Cloudflare Worker — melayani halaman Lucky Spin (dari folder /public)
// dan endpoint /api/state yang baca/tulis data ke Cloudflare KV.

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
  settings: { pin: 'admin123', webhookUrl: '' }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/state') {
      if (request.method === 'GET') {
        const raw = await env.LUCKY_KV.get(KV_KEY);
        return new Response(raw || JSON.stringify(DEFAULT_STATE), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (request.method === 'POST') {
        try {
          const text = await request.text();
          JSON.parse(text); // validasi
          await env.LUCKY_KV.put(KV_KEY, text);
          return new Response(JSON.stringify({ status: 'ok' }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ status: 'error', message: 'Data tidak valid' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // Selain /api/state, layani file statis dari folder public (index.html, dst)
    return env.ASSETS.fetch(request);
  }
};
