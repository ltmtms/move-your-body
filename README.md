# Move Your Body

Techno neon **body-rhythm game** for Stephen’s classes: upload an MP3, turn on your camera, and hit glowing saucer disks with your **left and right palms** in time with the beat.

**Play online:** [https://ltmtms.github.io/move-your-body/](https://ltmtms.github.io/move-your-body/)

## How to play

1. Open the game (use **HTTPS** — GitHub Pages, or `npm run dev` on localhost).
2. Tap **Choose MP3** and pick a track from your device.
3. Tap **Start game** and allow **camera** access when prompted.
4. Wait for beat analysis and the MoveNet pose model to load (first load may take a few seconds).
5. After the countdown, move so your upper body is visible. When a **cyan disk** reaches the hit line, cover it with your **left palm**; **magenta disks** use your **right palm**.
6. Score **Perfect / Good** hits and build your **combo**. Missed disks break the combo.

## Privacy

The camera feed is processed **entirely in your browser**. No video or audio is uploaded to any server.

## Tech

- [Vite](https://vite.dev/) + TypeScript
- Web Audio API beat/onset grid (good-enough chart, not a research-grade tracker)
- [@tensorflow-models/pose-detection](https://github.com/tensorflow/tfjs-models) **MoveNet Lightning** (fast, mobile-friendly)
- Canvas rendering with neon HUD

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (default port **9876**). Camera access requires a secure context (localhost counts).

## Build for GitHub Pages

The Vite `base` is set to `/move-your-body/`. Production build:

```bash
npm run build
npm run preview
```

Pushes to `main` run `.github/workflows/deploy-pages.yml`, which publishes `dist` to GitHub Pages (same pattern as [meteroo](https://github.com/ltmtms/meteroo) / [color-cars](https://github.com/ltmtms/color-cars)).

If Pages is not live yet, enable **Settings → Pages → GitHub Actions** once on the repo.

## Repository

[https://github.com/ltmtms/move-your-body](https://github.com/ltmtms/move-your-body)

Made for **ltmtms / SJACS** — move your body to the techno beat.
