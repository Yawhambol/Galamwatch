# Galamsey Reporter (AAMUSTED)

A privacy-first, offline-ready mobile web app for reporting illegal mining (galamsey) with GPS, blur radius, stealth capture mode, upload-when-safe, and SMS/USSD fallback.

## Features
- Anonymous by default
- GPS capture with accuracy
- Geo-privacy blur radius (public vs private views)
- Stealth mode (no previews; queue until safe)
- Upload-when-safe (move N meters or wait M minutes)
- Auto-remove EXIF by re-encoding images
- Checklist mode (low-literacy)
- My Reports: export JSON, SMS draft, status timeline
- Map: user location, blurred pins, distance, fit-to-bounds
- Settings: authority SMS and USSD

## Run locally
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
npm run preview -- --host
```

## Deploy on Vercel
1. Upload project files to GitHub (root must contain `package.json`, `vite.config.ts`, `index.html`, `src/`).
2. Import repo into Vercel → Framework: Vite → Build: `npm run build` → Output: `dist`.
3. Deploy.
