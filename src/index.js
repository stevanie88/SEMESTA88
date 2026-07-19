// Cloudflare Worker — Lucky Spin
// Sistem login: Email (whitelist 2 alamat) + Password -> PIN 6 digit.
// Lupa password -> link reset via email. Ganti PIN butuh konfirmasi password.
// Recovery code (5x, sekali pakai) sebagai jalan darurat kalau password & PIN
// dua-duanya lupa.

const KV_KEY = 'luckyspin_state';
const MAX_ATTEMPTS = 10;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 menit
const PENDING_PIN_TTL_MS = 5 * 60 * 1000; // 5 menit untuk selesaikan step PIN
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 menit link reset password
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 jam — logout otomatis
const CHECK_CODE_RATE_LIMIT = 10; // maksimal percobaan per menit per IP
const MAX_CODES_PER_BATCH = 10; // maksimal kode dibuat sekaligus

const ALLOWED_EMAILS = ['hatihatilho12@gmail.com', 'mosiongto77@gmail.com'];

// ---------- crypto helpers ----------
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomSalt() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}
async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(digest);
}
async function hashSecret(plain) {
  const salt = randomSalt();
  const hash = await sha256Hex(salt + ':' + plain);
  return { salt, hash };
}
async function verifySecret(plain, record) {
  if (!record || !record.salt || !record.hash) return false;
  const hash = await sha256Hex(record.salt + ':' + plain);
  return hash === record.hash;
}
function randomToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(24)).buffer);
}
function randomRecoveryCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) {
    if (i === 5) s += '-';
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

const DEFAULT_STATE = {
  prizes: [
    { id: 'p1', name: 'Voucher 20rb', weight: 40, stock: null, color: '#3f9483' },
    { id: 'p2', name: 'Voucher 50rb', weight: 20, stock: null, color: '#e3b23c' },
    { id: 'p3', name: 'Coba Lagi', weight: 30, stock: null, color: '#b23a52' },
    { id: 'p4', name: 'Grand Prize', weight: 10, stock: 5, color: '#f3d685' }
  ],
  codes: [],
  history: [],
  settings: {
    allowedEmails: ALLOWED_EMAILS,
    passwordAuth: null,      // { salt, hash } — default password: admin123 (dibuat otomatis)
    pinAuth: null,           // { salt, hash } — default PIN: 123456 (dibuat otomatis)
    webhookUrl: '',
    prizeColumns: 2,
    session: null,           // { token, expiresAt, email }
    pendingLogin: null,      // { email, expiresAt } — sudah lolos password, tunggu PIN
    loginAttempts: null,     // { count, lockedUntil }
    pinAttempts: null,       // { count, lockedUntil }
    recoveryAttempts: null,  // { count, lockedUntil }
    resetToken: null,        // { tokenHash, email, expiresAt }
    recoveryCodes: [],       // [{ hash }]
    forgotPasswordLastSent: 0
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '-';
  const [user, domain] = email.split('@');
  const visible = user.slice(0, 2);
  return visible + '***@' + domain;
}
function normEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

async function getState(env) {
  const raw = await env.LUCKY_KV.get(KV_KEY);
  const state = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEFAULT_STATE));
  state.settings = state.settings || {};
  const s = state.settings;
  if (!Array.isArray(s.allowedEmails) || s.allowedEmails.length === 0) s.allowedEmails = ALLOWED_EMAILS;
  if (s.prizeColumns === undefined) s.prizeColumns = 2;
  if (s.webhookUrl === undefined) s.webhookUrl = '';
  if (s.session === undefined) s.session = null;
  if (s.pendingLogin === undefined) s.pendingLogin = null;
  if (!s.loginAttempts) s.loginAttempts = { count: 0, lockedUntil: 0 };
  if (!s.pinAttempts) s.pinAttempts = { count: 0, lockedUntil: 0 };
  if (!s.recoveryAttempts) s.recoveryAttempts = { count: 0, lockedUntil: 0 };
  if (s.resetToken === undefined) s.resetToken = null;
  if (!Array.isArray(s.recoveryCodes)) s.recoveryCodes = [];
  if (s.forgotPasswordLastSent === undefined) s.forgotPasswordLastSent = 0;

  let changed = false;
  if (!s.passwordAuth) { s.passwordAuth = await hashSecret('admin123'); changed = true; }
  if (!s.pinAuth) { s.pinAuth = await hashSecret('123456'); changed = true; }
  if (changed) await saveStateObj(env, state);
  return state;
}
async function saveStateObj(env, state) {
  await env.LUCKY_KV.put(KV_KEY, JSON.stringify(state));
}
function isAuthed(state, request) {
  const token = request.headers.get('X-Session-Token');
  const session = state.settings.session;
  return !!(session && token && token === session.token && Date.now() < session.expiresAt);
}
function checkLock(bucket) {
  if (bucket.lockedUntil && Date.now() < bucket.lockedUntil) {
    const minutesLeft = Math.ceil((bucket.lockedUntil - Date.now()) / 60000);
    return `Terlalu banyak percobaan salah. Coba lagi dalam ${minutesLeft} menit.`;
  }
  return null;
}
function registerFailure(bucket) {
  bucket.count = (bucket.count || 0) + 1;
  if (bucket.count >= MAX_ATTEMPTS) {
    bucket.lockedUntil = Date.now() + LOCK_DURATION_MS;
    bucket.count = 0;
    return true;
  }
  return false;
}
async function sendViaAppsScript(webhookUrl, payload) {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error('apps-script-rejected');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/admin' || path === '/admin/') {
      const adminUrl = new URL(url);
      adminUrl.pathname = '/admin.html';
      return env.ASSETS.fetch(new Request(adminUrl, request));
    }

    // ================= LOGIN STEP 1: Email + Password =================
    if (path === '/api/login' && request.method === 'POST') {
      const state = await getState(env);
      const la = state.settings.loginAttempts;
      const lockMsg = checkLock(la);
      if (lockMsg) return json({ status: 'locked', message: lockMsg }, 429);

      let body; try { body = await request.json(); } catch (e) { body = null; }
      const email = normEmail(body && body.email);
      const password = body && body.password;
      if (!email || !password) return json({ status: 'error', message: 'Email dan password wajib diisi.' }, 400);

      const allowed = state.settings.allowedEmails.map(normEmail);
      const emailOk = allowed.includes(email);
      const passOk = emailOk && await verifySecret(password, state.settings.passwordAuth);

      if (!emailOk || !passOk) {
        const locked = registerFailure(la);
        state.settings.loginAttempts = la;
        await saveStateObj(env, state);
        if (locked) return json({ status: 'locked', message: 'Terlalu banyak percobaan salah. Coba lagi dalam 15 menit.' }, 429);
        return json({ status: 'error', message: `Email atau password salah. Percobaan tersisa: ${MAX_ATTEMPTS - la.count}.` }, 400);
      }

      state.settings.loginAttempts = { count: 0, lockedUntil: 0 };
      state.settings.pendingLogin = { email, expiresAt: Date.now() + PENDING_PIN_TTL_MS };
      state.settings.pinAttempts = { count: 0, lockedUntil: 0 };
      await saveStateObj(env, state);
      return json({ status: 'ok' });
    }

    // ================= LOGIN STEP 2: PIN =================
    if (path === '/api/verify-pin' && request.method === 'POST') {
      const state = await getState(env);
      const pending = state.settings.pendingLogin;
      if (!pending || Date.now() > pending.expiresAt) {
        return json({ status: 'error', message: 'Sesi login kedaluwarsa, masukkan email & password lagi.' }, 400);
      }
      const pa = state.settings.pinAttempts;
      const lockMsg = checkLock(pa);
      if (lockMsg) return json({ status: 'locked', message: lockMsg }, 429);

      let body; try { body = await request.json(); } catch (e) { body = null; }
      const pin = body && body.pin;
      if (!pin) return json({ status: 'error', message: 'PIN wajib diisi.' }, 400);

      const pinOk = await verifySecret(String(pin).trim(), state.settings.pinAuth);
      if (!pinOk) {
        const locked = registerFailure(pa);
        state.settings.pinAttempts = pa;
        await saveStateObj(env, state);
        if (locked) return json({ status: 'locked', message: 'Terlalu banyak percobaan PIN salah. Coba lagi dalam 15 menit.' }, 429);
        return json({ status: 'error', message: `PIN salah. Percobaan tersisa: ${MAX_ATTEMPTS - pa.count}.` }, 400);
      }

      const token = crypto.randomUUID();
      state.settings.session = { token, expiresAt: Date.now() + SESSION_TTL_MS, email: pending.email };
      state.settings.pendingLogin = null;
      state.settings.pinAttempts = { count: 0, lockedUntil: 0 };
      await saveStateObj(env, state);
      return json({ status: 'ok', token });
    }

    // ================= LUPA PASSWORD: kirim link reset ke email =================
    if (path === '/api/forgot-password' && request.method === 'POST') {
      const state = await getState(env);
      let body; try { body = await request.json(); } catch (e) { body = null; }
      const email = normEmail(body && body.email);
      const allowed = state.settings.allowedEmails.map(normEmail);
      if (!allowed.includes(email)) return json({ status: 'error', message: 'Email tidak terdaftar.' }, 400);

      if (Date.now() - (state.settings.forgotPasswordLastSent || 0) < 60 * 1000) {
        return json({ status: 'error', message: 'Tunggu sebentar sebelum kirim ulang.' }, 429);
      }
      if (!state.settings.webhookUrl) return json({ status: 'error', message: 'URL Google Sheets/Apps Script belum disambungkan.' }, 400);

      const rawToken = randomToken();
      state.settings.resetToken = {
        tokenHash: await sha256Hex(rawToken),
        email,
        expiresAt: Date.now() + RESET_TOKEN_TTL_MS
      };
      state.settings.forgotPasswordLastSent = Date.now();
      await saveStateObj(env, state);

      const resetLink = `${url.origin}/admin.html?resetToken=${rawToken}`;
      try {
        await sendViaAppsScript(state.settings.webhookUrl, { action: 'sendPasswordReset', email, resetLink });
      } catch (e) {
        return json({ status: 'error', message: 'Gagal mengirim email reset.' }, 502);
      }
      return json({ status: 'ok', maskEmail: maskEmail(email) });
    }

    // ================= RESET PASSWORD via token dari email =================
    if (path === '/api/reset-password' && request.method === 'POST') {
      const state = await getState(env);
      let body; try { body = await request.json(); } catch (e) { body = null; }
      const rt = state.settings.resetToken;
      if (!rt || !body || !body.token || !body.newPassword) return json({ status: 'error', message: 'Data tidak lengkap.' }, 400);
      if (Date.now() > rt.expiresAt) return json({ status: 'error', message: 'Link reset sudah kedaluwarsa, minta link baru.' }, 400);
      if (String(body.newPassword).length < 6) return json({ status: 'error', message: 'Password minimal 6 karakter.' }, 400);

      const tokenHash = await sha256Hex(String(body.token));
      if (tokenHash !== rt.tokenHash) return json({ status: 'error', message: 'Link reset tidak valid.' }, 400);

      state.settings.passwordAuth = await hashSecret(String(body.newPassword));
      state.settings.resetToken = null;
      state.settings.session = null; // paksa login ulang
      state.settings.loginAttempts = { count: 0, lockedUntil: 0 };
      await saveStateObj(env, state);
      return json({ status: 'ok' });
    }

    // ================= LOGIN DARURAT: Recovery Code =================
    if (path === '/api/login-recovery' && request.method === 'POST') {
      const state = await getState(env);
      const ra = state.settings.recoveryAttempts;
      const lockMsg = checkLock(ra);
      if (lockMsg) return json({ status: 'locked', message: lockMsg }, 429);

      let body; try { body = await request.json(); } catch (e) { body = null; }
      const email = normEmail(body && body.email);
      const code = (body && body.code || '').toString().trim().toUpperCase();
      const allowed = state.settings.allowedEmails.map(normEmail);
      if (!allowed.includes(email) || !code) return json({ status: 'error', message: 'Data tidak lengkap.' }, 400);

      let matchIndex = -1;
      for (let i = 0; i < state.settings.recoveryCodes.length; i++) {
        const hash = await sha256Hex(code);
        if (hash === state.settings.recoveryCodes[i].hash) { matchIndex = i; break; }
      }

      if (matchIndex === -1) {
        const locked = registerFailure(ra);
        state.settings.recoveryAttempts = ra;
        await saveStateObj(env, state);
        if (locked) return json({ status: 'locked', message: 'Terlalu banyak percobaan salah. Coba lagi dalam 15 menit.' }, 429);
        return json({ status: 'error', message: 'Recovery code tidak valid atau sudah dipakai.' }, 400);
      }

      state.settings.recoveryCodes.splice(matchIndex, 1); // sekali pakai
      state.settings.recoveryAttempts = { count: 0, lockedUntil: 0 };
      const token = crypto.randomUUID();
      state.settings.session = { token, expiresAt: Date.now() + SESSION_TTL_MS, email };
      await saveStateObj(env, state);
      return json({
        status: 'ok',
        token,
        warning: 'Kamu masuk pakai recovery code. Segera ganti password & PIN di menu Pengaturan.',
        codesRemaining: state.settings.recoveryCodes.length
      });
    }

    // ================= Cek sesi (dipanggil saat refresh halaman) =================
    if (path === '/api/check-session' && request.method === 'POST') {
      let body; try { body = await request.json(); } catch (e) { body = null; }
      const state = await getState(env);
      const session = state.settings.session;
      const valid = !!(session && body && body.token === session.token && Date.now() < session.expiresAt);
      return json({ valid });
    }

    // ================= Logout =================
    if (path === '/api/logout' && request.method === 'POST') {
      const state = await getState(env);
      state.settings.session = null;
      await saveStateObj(env, state);
      return json({ status: 'ok' });
    }

    // ================= Ganti password (butuh sesi + password lama) =================
    if (path === '/api/change-password' && request.method === 'POST') {
      const state = await getState(env);
      if (!isAuthed(state, request)) return json({ status: 'error', message: 'Unauthorized' }, 401);
      let body; try { body = await request.json(); } catch (e) { body = null; }
      if (!body || !body.currentPassword || !body.newPassword) return json({ status: 'error', message: 'Data tidak lengkap.' }, 400);
      const ok = await verifySecret(body.currentPassword, state.settings.passwordAuth);
      if (!ok) return json({ status: 'error', message: 'Password saat ini salah.' }, 400);
      if (String(body.newPassword).length < 6) return json({ status: 'error', message: 'Password baru minimal 6 karakter.' }, 400);
      state.settings.passwordAuth = await hashSecret(String(body.newPassword));
      await saveStateObj(env, state);
      return json({ status: 'ok' });
    }

    // ================= Ganti PIN (butuh sesi + password untuk konfirmasi) =================
    if (path === '/api/change-pin' && request.method === 'POST') {
      const state = await getState(env);
      if (!isAuthed(state, request)) return json({ status: 'error', message: 'Unauthorized' }, 401);
      let body; try { body = await request.json(); } catch (e) { body = null; }
      if (!body || !body.currentPassword || !body.newPin) return json({ status: 'error', message: 'Data tidak lengkap.' }, 400);
      const ok = await verifySecret(body.currentPassword, state.settings.passwordAuth);
      if (!ok) return json({ status: 'error', message: 'Password salah, PIN tidak diganti.' }, 400);
      const newPin = String(body.newPin).trim();
      if (!/^\d{6}$/.test(newPin)) return json({ status: 'error', message: 'PIN harus 6 digit angka.' }, 400);
      state.settings.pinAuth = await hashSecret(newPin);
      await saveStateObj(env, state);
      return json({ status: 'ok' });
    }

    // ================= Generate recovery codes baru (butuh sesi + password) =================
    if (path === '/api/generate-recovery-codes' && request.method === 'POST') {
      const state = await getState(env);
      if (!isAuthed(state, request)) return json({ status: 'error', message: 'Unauthorized' }, 401);
      let body; try { body = await request.json(); } catch (e) { body = null; }
      if (!body || !body.currentPassword) return json({ status: 'error', message: 'Konfirmasi password wajib diisi.' }, 400);
      const ok = await verifySecret(body.currentPassword, state.settings.passwordAuth);
      if (!ok) return json({ status: 'error', message: 'Password salah.' }, 400);

      const plainCodes = [];
      const hashedCodes = [];
      for (let i = 0; i < 5; i++) {
        const code = randomRecoveryCode();
        plainCodes.push(code);
        hashedCodes.push({ hash: await sha256Hex(code) });
      }
      state.settings.recoveryCodes = hashedCodes;
      await saveStateObj(env, state);
      // Kode plaintext HANYA dikembalikan sekali di response ini, tidak pernah disimpan.
      return json({ status: 'ok', codes: plainCodes });
    }

    // ================= FULL STATE: wajib sesi login valid =================
    if (path === '/api/state') {
      const state = await getState(env);
      if (!isAuthed(state, request)) return json({ status: 'error', message: 'Unauthorized' }, 401);

      if (request.method === 'GET') {
        // jangan pernah kirim hash/secret ke browser
        const safe = JSON.parse(JSON.stringify(state));
        delete safe.settings.passwordAuth;
        delete safe.settings.pinAuth;
        delete safe.settings.resetToken;
        delete safe.settings.recoveryCodes;
        safe.settings.recoveryCodesCount = state.settings.recoveryCodes.length;
        return json(safe);
      }
      if (request.method === 'POST') {
        try {
          const text = await request.text();
          const parsed = JSON.parse(text);
          // lindungi field rahasia supaya tidak bisa ditimpa lewat /api/state
          parsed.settings = parsed.settings || {};
          parsed.settings.passwordAuth = state.settings.passwordAuth;
          parsed.settings.pinAuth = state.settings.pinAuth;
          parsed.settings.resetToken = state.settings.resetToken;
          parsed.settings.recoveryCodes = state.settings.recoveryCodes;
          parsed.settings.session = state.settings.session;
          parsed.settings.allowedEmails = state.settings.allowedEmails;
          await env.LUCKY_KV.put(KV_KEY, JSON.stringify(parsed));
          return json({ status: 'ok' });
        } catch (e) {
          return json({ status: 'error', message: 'Data tidak valid' }, 400);
        }
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // ================= DATA PUBLIK: aman untuk player =================
    if (path === '/api/prizes' && request.method === 'GET') {
      const state = await getState(env);
      return json({ prizes: state.prizes });
    }

    // ================= CEK KODE =================
    if (path === '/api/check-code' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rlKey = `ratelimit:checkcode:${ip}`;
      const rlRaw = await env.LUCKY_KV.get(rlKey);
      const rlCount = rlRaw ? parseInt(rlRaw) : 0;
      if (rlCount >= CHECK_CODE_RATE_LIMIT) {
        return json({ valid: false, message: 'Terlalu banyak percobaan. Coba lagi sebentar lagi.' }, 429);
      }
      await env.LUCKY_KV.put(rlKey, String(rlCount + 1), { expirationTtl: 60 });

      let body; try { body = await request.json(); } catch (e) { body = {}; }
      const code = (body.code || '').toString().trim().toUpperCase();
      if (!code) return json({ valid: false, message: 'Kode wajib diisi.' }, 400);

      const state = await getState(env);
      const entry = state.codes.find(c => c.code === code);
      if (!entry) return json({ valid: false, message: 'Kode tidak ditemukan.' });
      if (entry.used) return json({ valid: false, message: 'Kode ini sudah pernah dipakai.' });

      const activePrizes = state.prizes.filter(p => p.stock === null || p.stock > 0);
      if (activePrizes.length === 0) return json({ valid: false, message: 'Stok hadiah sedang habis. Hubungi penyelenggara.' });

      return json({ valid: true, fixedPrizeId: entry.fixedPrizeId || null, prizes: activePrizes });
    }

    // ================= FINALISASI SPIN =================
    if (path === '/api/finish-spin' && request.method === 'POST') {
      let body; try { body = await request.json(); } catch (e) { body = null; }
      if (!body || !body.code || !body.prizeId) return json({ status: 'error', message: 'Data tidak lengkap.' }, 400);
      const code = String(body.code).trim().toUpperCase();
      const name = (body.name || '').toString().slice(0, 60);

      const state = await getState(env);
      const entry = state.codes.find(c => c.code === code);
      if (!entry) return json({ status: 'error', message: 'Kode tidak ditemukan.' }, 400);
      if (entry.used) return json({ status: 'error', message: 'Kode sudah pernah dipakai.' }, 400);

      const prizeRef = state.prizes.find(p => p.id === body.prizeId);
      if (!prizeRef) return json({ status: 'error', message: 'Hadiah tidak valid.' }, 400);
      if (entry.fixedPrizeId && entry.fixedPrizeId !== body.prizeId) return json({ status: 'error', message: 'Hadiah tidak sesuai kode.' }, 400);
      if (prizeRef.stock !== null) {
        if (prizeRef.stock <= 0) return json({ status: 'error', message: 'Stok hadiah ini sudah habis.' }, 400);
        prizeRef.stock -= 1;
      }

      entry.used = true; entry.prize = prizeRef.name; entry.usedAt = Date.now(); entry.name = name;
      const record = { code: entry.code, prize: prizeRef.name, name, timestamp: new Date().toISOString() };
      state.history.unshift(record);
      await saveStateObj(env, state);

      if (state.settings.webhookUrl) {
        try { await sendViaAppsScript(state.settings.webhookUrl, record); } catch (e) { /* silent */ }
      }
      return json({ status: 'ok', prizeName: prizeRef.name });
    }

    return env.ASSETS.fetch(request);
  }
};
