# MOVE YOUR BODY

Techno 體感節奏遊戲。上載 MP3，遊戲會分析節拍並生成譜面；螢光飛碟沿著路軌飛向你，用鏡頭追蹤你的手掌，把手掌泊在飛碟上（或快速拍穿它）得分。

**Play:** https://ltmtms.github.io/move-your-body/

Works on phone, iPad and desktop (Chrome / Safari / Edge, HTTPS required for the camera). Landscape with your upper body in view works best.

## How to play

1. Upload an MP3 (or tap **DEMO TECHNO** to try a built-in 128 BPM track) and pick EASY / NORMAL / HARD.
2. Allow camera access. Step back so your head, shoulders and both hands are visible.
3. Raise both hands above your shoulders for 1 second to start.
4. Saucers fly in from the horizon. When one reaches its dashed target ring (the solid approach ring closes onto it on the beat):
   - **HOVER**: have your palm on the target when the beat lands, or
   - **SLAP**: swipe through it fast for a **+250 SLAP bonus**.
5. Gold beams link double saucers. Use both hands.

Rank = score ÷ best possible score: **S+++** (≥100%, no misses; SLAP bonuses get you there) · **S++** ≥95% · **S+** ≥90% · **S** ≥85% · **A** ≥75% · **B** ≥60% · **C**.
Combo raises the multiplier up to ×2.

## How it works

| Part | Method |
| --- | --- |
| Body tracking | **MediaPipe PoseLandmarker (lite)**, GPU delegate with CPU fallback, one inference per new camera frame (`requestVideoFrameCallback`). Upper-body chain: shoulders → elbows → wrists → index/pinky knuckles. Palm centre = wrist + knuckles blend, smoothed with a **One Euro filter**. Pose (rather than a hand model) keeps tracking a motion-blurred hand mid-slap and gives the shoulders as a body anchor. |
| Target placement | Slots are in body space (shoulder-width units around the shoulder midpoint), so targets stay reachable at any distance or screen size. |
| Fast slaps vs. frame rate | Collision uses the **swept path** between consecutive palm samples, not single points, so a hand that jumps 30 cm between two 15 fps frames still connects. Contact time is interpolated along the path. A slap is timed at its closest pass, and a hover from when the palm arrives until it leaves. Swing speed above 3.2 shoulder widths/s counts as a SLAP. If the wrist blurs out, the palm is dead-reckoned along its last velocity for up to 140 ms. Timing windows widen by half the measured camera frame interval. |
| Timing | Camera frames are stamped with `captureTime` and mapped to song time through `AudioContext.getOutputTimestamp()`, which covers audio output latency. |
| Beat analysis | Runs in a Web Worker: 22 kHz mono → STFT log spectral flux (plus a low band for kicks) → tempo by autocorrelation → **dynamic-programming beat tracker** (Ellis 2007). Then a chart per difficulty: weak beats and quiet passages are dropped, HARD adds strong off-beats, loud downbeats become doubles. |
| Rendering | Canvas 2D: synthwave floor whose lines are the song's beats, pre-rendered glowing saucer sprites, palm trails (white when you are slapping), particles. The DOM HUD uses safe-area insets. |

Everything runs in your browser. Neither the camera feed nor the music leaves your device. The MediaPipe WASM and model are served from this site, not a CDN.

## Develop

```bash
npm install
npm run dev      # https needed on phones: use the deployed site or a tunnel
npm run build
```

`npm run dev/build` copies the MediaPipe WASM runtime from `node_modules` into `public/mediapipe/`. It also downloads the pose model to `public/models/` the first time.

Pushes to `main` deploy to GitHub Pages via `.github/workflows/deploy-pages.yml`.
