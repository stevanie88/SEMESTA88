# Lucky Spin — versi Cloudflare Workers

## Isi folder
- `public/index.html` — aplikasi Lucky Spin (frontend)
- `src/index.js` — Worker script: melayani index.html dan endpoint /api/state
- `wrangler.toml` — konfigurasi Worker (nama, static assets, binding KV)

## Setup singkat
1. Push semua isi folder ini ke repo GitHub (root repo, jangan dibungkus folder tambahan).
2. Di dashboard Cloudflare → Workers & Pages → KV → Create namespace. Kasih nama misalnya `LUCKY_SPIN_KV`. Setelah dibuat, salin **ID** namespace itu.
3. Di GitHub, edit file `wrangler.toml`, ganti tulisan `GANTI_DENGAN_ID_KV` dengan ID yang kamu salin tadi. Commit changes.
4. Di dashboard Cloudflare → Workers & Pages → Create application → tab **Workers** → Connect to Git → pilih repo ini.
5. Biarkan pengaturan default (Deploy command: `npx wrangler deploy`, Path: `/`). Klik Deploy.
6. Setelah selesai, buka URL yang diberikan Cloudflare (bentuknya `nama-worker.<subdomain>.workers.dev`).

PIN admin default: `admin123` (ganti di menu Pengaturan setelah masuk).
