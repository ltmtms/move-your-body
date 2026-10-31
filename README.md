# MOVE YOUR BODY

Techno 體感節奏遊戲。上載 MP3，遊戲會分析節拍並生成譜面；螢光飛碟沿著路軌飛向你，用鏡頭追蹤你的手掌，把手掌泊在飛碟上（或快速拍穿它）得分。

**Play:** https://ltmtms.github.io/move-your-body/

Works on phone, iPad and desktop (Chrome / Safari / Edge, HTTPS required for the camera). Landscape with your upper body in view works best.

## How to play

1. Upload an MP3 (or tap **DEMO TECHNO** to try a built-in 128 BPM track) and pick EASY / NORMAL / HARD.
2. Allow camera access. Step back so your head, shoulders and both hands are visible.
3. Raise both hands above your shoulders for 1 second to start.
4. Saucers fly in from the horizon. When one reaches its dashed target ring (the solid approach ring closes onto it on the beat):
   - **SWIPE**: sweep your palm through it on the beat. **A palm that just rests on the saucer does not count**; you have to move.
   - **SLAP**: swipe through it fast for a **+250 SLAP bonus**.

   How much movement is needed depends on the mode:

   | Mode | Minimum palm speed | Feels like |
   | --- | --- | --- |
   | EASY | 0.8 shoulder widths/s (~0.3 m/s) | a gentle wave |
   | NORMAL | 1.6 shoulder widths/s (~0.65 m/s) | a clear swipe |
   | HARD | 2.4 shoulder widths/s (~1 m/s) | a quick slap |

   Too slow shows **TOO STILL** and counts as a miss. The SLAP bonus starts at 3.2 shoulder widths/s in every mode.
5. Gold beams link double saucers. Use both hands.

| Mode | Saucers | Targets |
| --- | --- | --- |
| EASY | 1 per bar, on the downbeat (重拍) | 2 fixed targets, one per hand |
| NORMAL | 2 per bar (beats 1 & 3) | the same 2 fixed targets |
| HARD | every beat + a syncopated off-beat in loud bars | 8 targets that move around your body |

Saucers launch on a beat and arrive on the beat. Quiet intros and breaks get fewer saucers.

Every hit plays a synthesized percussion sound, with different voices for the left and right hand. The song is split into up to 4 sections (intro, verse, drop…), and each section gets its own kit (808, METAL, FM, ELECTRO). The sound therefore changes at most 3 times per song. Within a kit, downbeats are accented, the pitch moves with the beat in the bar, and slaps add a crack.

Rank = score ÷ best possible score: **S+++** (≥100%, no misses; SLAP bonuses get you there) · **S++** ≥95% · **S+** ≥90% · **S** ≥85% · **A** ≥75% · **B** ≥60% · **C**.
Combo raises the multiplier up to ×2.

## How it works

| Part | Method |
| --- | --- |
| Body tracking | **MediaPipe PoseLandmarker (lite)**, GPU delegate with CPU fallback, one inference per new camera frame (`requestVideoFrameCallback`). Upper-body chain: shoulders → elbows → wrists → index/pinky knuckles. Palm centre = wrist + knuckles blend, smoothed with a **One Euro filter**. Pose (rather than a hand model) keeps tracking a motion-blurred hand mid-slap and gives the shoulders as a body anchor. |
| Target placement | Slots are in body space (shoulder-width units around the shoulder midpoint), so targets stay reachable at any distance or screen size. |
| Fast slaps vs. frame rate | Collision uses the **swept path** between consecutive palm samples, not single points, so a hand that jumps 30 cm between two 15 fps frames still connects. Contact time is interpolated along the path. A hit is timed at the palm's closest pass to the saucer. It only counts if the palm is moving: speed is the larger of the latest segment (catches a sharp slap) and the displacement over the last 140 ms (averages tracker jitter away), compared with a per-mode minimum. Segments shorter than 8% of a shoulder width are ignored as noise, and on cameras under ~16 fps the minimum is relaxed by 25%. Speed above 3.2 shoulder widths/s counts as a SLAP. If the wrist blurs out, the palm is dead-reckoned along its last velocity for up to 140 ms. Timing windows widen by half the measured camera frame interval. |
| Timing | Camera frames are stamped with `captureTime` and mapped to song time through `AudioContext.getOutputTimestamp()`, which covers audio output latency. |
| Beat analysis | Runs in a Web Worker: 22 kHz mono → STFT log spectral flux. Tempo comes from autocorrelation of a kick/bass-weighted pulse, so off-beat hi-hats can't pull it half a beat off. Then a **dynamic-programming beat tracker** (Ellis 2007). |
| Downbeats (重拍) | Each beat is scored on kick strength, a chord change (harmony chroma), a bassline change (bass chroma), a timbre change, and the backbeat (snare/clap on 2 and 4). The 4-beat phase with the best score in a sliding ±4-bar window marks the bar starts. Tested at 92–98% on synthetic tracks from 100 to 170 BPM and 93% on the demo track. |
| Sections & kits | Phrase boundaries (every 4 bars) where loudness or timbre changes the most split the song into ≤ 4 sections. Hit sounds are synthesized with [Tone.js](https://tonejs.github.io) (MIT): MembraneSynth, MetalSynth, FMSynth and NoiseSynth through a compressor and light reverb. |
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
