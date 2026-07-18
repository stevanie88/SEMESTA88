# Lucky Spin — versi Cloudflare Pages

## Isi folder
- `index.html` — aplikasi Lucky Spin (frontend)
- `functions/api/state.js` — backend (Cloudflare Pages Function) yang membaca/menulis data ke Cloudflare KV

## Setup singkat
1. Push folder ini ke repo GitHub.
2. Di dashboard Cloudflare, buat KV Namespace, misalnya beri nama `LUCKY_SPIN_KV`.
3. Buat project Cloudflare Pages, hubungkan ke repo GitHub tadi.
   - Build command: kosongkan
   - Build output directory: `/`
4. Di Settings project Pages → Functions → KV namespace bindings, tambahkan binding:
   - Variable name: `LUCKY_KV`
   - KV namespace: pilih yang dibuat di langkah 2
5. Deploy. Buka URL yang diberikan Cloudflare, aplikasi siap dipakai.

PIN admin default: admin123 (ganti di menu Pengaturan setelah masuk).
