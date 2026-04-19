# Loyalty App (React + Vite + Tailwind + Capacitor)

## Jalankan lokal

```bash
npm install
npm run dev
```

## Build web

```bash
npm run build
```

Folder hasil build: `dist`

## Jadikan APK Android

```bash
npm install
npx cap add android
npm run build
npx cap copy
npx cap open android
```

## Catatan
- File `src/App.jsx` diambil dari script upload pengguna dan ditutup ulang di bagian akhir agar struktur JSX lengkap.
- Login admin pada kode masih hardcoded (`admin` / `admin123`), jadi cocok untuk demo/MVP, belum untuk produksi.
