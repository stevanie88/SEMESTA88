// Cloudflare Pages Function — jalan otomatis di /api/state
// Butuh KV Namespace bernama LUCKY_KV yang sudah di-bind ke project ini
// (Pages dashboard → Settings → Functions → KV namespace bindings)

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

// GET /api/state — ambil data terbaru
export async function onRequestGet(context) {
  const { env } = context;
  const raw = await env.LUCKY_KV.get(KV_KEY);
  const body = raw || JSON.stringify(DEFAULT_STATE);
  return new Response(body, {
    headers: { 'Content-Type': 'application/json' }
  });
}

// POST /api/state — simpan data terbaru (dipanggil tiap ada perubahan)
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const text = await request.text();
    JSON.parse(text); // validasi format sebelum disimpan
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
