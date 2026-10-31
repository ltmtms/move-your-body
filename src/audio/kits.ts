import * as Tone from 'tone'
import type { Judgment, Side } from '../game/types.ts'

/**
 * Hit sounds: synthesized percussion built with Tone.js (MIT-licensed,
 * https://tonejs.github.io). There are no samples to download. Each kit has
 * a left-hand and a right-hand voice. A song uses one kit per section (≤ 4
 * sections), and within a kit the sound still varies: the downbeat is
 * accented, pitch walks with the beat in the bar, slaps add a crack, and
 * timing quality sets the velocity.
 */

type Play = (time: number, vel: number, step: number) => void

interface Kit {
  name: string
  L: Play
  R: Play
}

const WEIGHT: Record<Exclude<Judgment, 'miss'>, number> = { perfect: 1, great: 0.8, good: 0.6 }

/**
 * Tone's synths are monophonic and throw when re-triggered before their last
 * note ends, so each voice is a small round-robin pool.
 */
function pool<T>(make: () => T, n = 3): () => T {
  const xs = Array.from({ length: n }, make)
  let i = 0
  return () => xs[i++ % n]
}

export class HitKits {
  private kits: Kit[]
  private crack: () => Tone.NoiseSynth
  private current = -1
  readonly names: string[]

  private constructor(ctx: AudioContext) {
    Tone.setContext(ctx)
    // play immediately on a hit, no scheduling look-ahead
    Tone.getContext().lookAhead = 0

    const bus = new Tone.Compressor({ threshold: -18, ratio: 4, attack: 0.002, release: 0.12 }).toDestination()
    const verb = new Tone.Freeverb({ roomSize: 0.6, dampening: 3000, wet: 0.18 }).connect(bus)
    const out = new Tone.Gain(0.9).connect(verb)
    const gain = (g: number) => new Tone.Gain(g).connect(out)
    const noise = (type: 'white' | 'pink', decay: number, filter: Tone.Filter, level: number) => {
      const dest = filter.connect(gain(level))
      return pool(() => new Tone.NoiseSynth({ noise: { type }, envelope: { attack: 0.001, decay, sustain: 0 } }).connect(dest))
    }

    // 1 · 808: deep tom + clap
    const tom808 = pool(() =>
      new Tone.MembraneSynth({
        pitchDecay: 0.06,
        octaves: 5,
        envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.1 },
      }).connect(out),
    )
    const clap = noise('white', 0.16, new Tone.Filter({ type: 'bandpass', frequency: 1400, Q: 1.2 }), 1.6)
    const clapBodyOut = gain(0.5)
    const clapBody = pool(() =>
      new Tone.MembraneSynth({
        pitchDecay: 0.02,
        octaves: 2,
        envelope: { attack: 0.001, decay: 0.08, sustain: 0 },
      }).connect(clapBodyOut),
    )

    // 2 · METAL: cowbell + ride ping (MetalSynth = inharmonic FM partials)
    const bellOut = gain(0.55)
    const bell = pool(() =>
      new Tone.MetalSynth({
        harmonicity: 3.1,
        modulationIndex: 16,
        resonance: 1800,
        octaves: 0.8,
        envelope: { attack: 0.001, decay: 0.35, release: 0.1 },
      }).connect(bellOut),
    )
    const pingOut = gain(0.45)
    const ping = pool(() =>
      new Tone.MetalSynth({
        harmonicity: 5.1,
        modulationIndex: 32,
        resonance: 5200,
        octaves: 1.2,
        envelope: { attack: 0.001, decay: 0.18, release: 0.05 },
      }).connect(pingOut),
    )

    // 3 · FM: wooden FM tom + bright rim
    const fmOut = gain(0.8)
    const fmTom = pool(() =>
      new Tone.FMSynth({
        harmonicity: 1.5,
        modulationIndex: 9,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.28, sustain: 0, release: 0.05 },
        modulation: { type: 'square' },
        modulationEnvelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
      }).connect(fmOut),
    )
    const rimOut = gain(0.55)
    const rim = pool(() =>
      new Tone.FMSynth({
        harmonicity: 3.5,
        modulationIndex: 20,
        envelope: { attack: 0.001, decay: 0.09, sustain: 0, release: 0.03 },
        modulationEnvelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.02 },
      }).connect(rimOut),
    )

    // 4 · ELECTRO: punchy kick-tom + noise snare with a square zap
    const kick = pool(() =>
      new Tone.MembraneSynth({
        pitchDecay: 0.03,
        octaves: 8,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.05 },
      }).connect(out),
    )
    const snare = noise('pink', 0.12, new Tone.Filter({ type: 'highpass', frequency: 2500 }), 1.4)
    const zapOut = gain(0.18)
    const zap = pool(() =>
      new Tone.Synth({
        oscillator: { type: 'square' },
        envelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.02 },
      }).connect(zapOut),
    )

    // slap layer: a short bright crack on top of any kit
    this.crack = noise('white', 0.05, new Tone.Filter({ type: 'highpass', frequency: 5000 }), 1.2)

    // pitch walks with the beat in the bar: varied, but the kit keeps its character
    const TOM = ['G1', 'A#1', 'C2', 'D#2']
    const BELL = [540, 600, 680, 800]
    const FM = ['C3', 'D#3', 'F3', 'G3']
    const ZAP = ['C6', 'G5', 'A#5', 'D6']

    this.kits = [
      {
        name: '808',
        L: (t, v, s) => tom808().triggerAttackRelease(TOM[s], 0.3, t, v),
        R: (t, v, s) => {
          clap().triggerAttackRelease(0.12, t, v)
          clapBody().triggerAttackRelease(s === 0 ? 'E3' : 'G3', 0.05, t, v * 0.6)
        },
      },
      {
        name: 'METAL',
        L: (t, v, s) => bell().triggerAttackRelease(BELL[s], 0.25, t, v),
        R: (t, v, s) => ping().triggerAttackRelease(BELL[s] * 2.5, 0.12, t, v),
      },
      {
        name: 'FM',
        L: (t, v, s) => fmTom().triggerAttackRelease(FM[s], 0.2, t, v),
        R: (t, v, s) => rim().triggerAttackRelease(Tone.Frequency(FM[s]).transpose(12).toFrequency(), 0.06, t, v),
      },
      {
        name: 'ELECTRO',
        L: (t, v, s) => kick().triggerAttackRelease(s === 0 ? 'C1' : 'D#1', 0.25, t, v),
        R: (t, v, s) => {
          snare().triggerAttackRelease(0.1, t, v)
          zap().triggerAttackRelease(ZAP[s], 0.05, t, v * 0.8)
        },
      },
    ]
    this.names = this.kits.map((k) => k.name)
  }

  static create(ctx: AudioContext): HitKits {
    return new HitKits(ctx)
  }

  /** returns true when the kit just changed (for the HUD banner) */
  setKit(kit: number): boolean {
    const k = ((kit % this.kits.length) + this.kits.length) % this.kits.length
    if (k === this.current) return false
    this.current = k
    return true
  }

  hit(side: Side, judgment: Exclude<Judgment, 'miss'>, slap: boolean, beat: number): void {
    const kit = this.kits[Math.max(0, this.current)]
    const t = Tone.now()
    // downbeat accent, off-beats softer
    const accent = beat === 0 ? 1 : beat < 0 ? 0.7 : 0.85
    const vel = Math.min(1, WEIGHT[judgment] * accent * (slap ? 1.15 : 1))
    try {
      kit[side](t, vel, beat < 0 ? 3 : beat)
      if (slap) this.crack().triggerAttackRelease(0.04, t, 0.8)
    } catch (err) {
      // a dropped hit sound must never break the game loop
      console.warn(err)
    }
  }
}
