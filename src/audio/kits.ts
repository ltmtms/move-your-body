import * as Tone from 'tone'
import type { Judgment, Side } from '../game/types.ts'

/**
 * Hit sounds: synthesized drum kits built with Tone.js (MIT-licensed,
 * https://tonejs.github.io). There are no samples to download.
 *
 * Each kit is a small drum set. The drum you hit depends on where the beat
 * falls in the bar (kick / low drum on the downbeat, other drums on 2–4,
 * hi-hat on off-beats), and the left and right hands play different drums. A
 * cymbal crashes only now and then: on the downbeat that opens a 4-bar phrase
 * and on double saucers. A SLAP adds a splash. A song uses one kit per
 * section (≤ 4 sections), so the kit changes at most 3 times.
 */

type Drum = (time: number, vel: number) => void

interface Kit {
  name: string
  /** per hand: [downbeat, beat 3, beats 2 & 4] */
  L: [Drum, Drum, Drum]
  R: [Drum, Drum, Drum]
  /** off-beats, per hand */
  hat: Record<Side, Drum>
  cymbal: Drum
}

const WEIGHT: Record<Exclude<Judgment, 'miss'>, number> = { perfect: 1, great: 0.8, good: 0.6 }

/**
 * Tone's synths are monophonic and throw when re-triggered before their last
 * note ends, so each drum is a small round-robin pool.
 */
function pool<T>(make: () => T, n = 3): () => T {
  const xs = Array.from({ length: n }, make)
  let i = 0
  return () => xs[i++ % n]
}

/** drum building blocks, all routed into one output node */
function builders(out: Tone.ToneAudioNode) {
  const level = (g: number) => new Tone.Gain(g).connect(out)

  /** kicks, toms, congas, bongos: a pitched membrane with a falling pitch */
  const membrane = (note: Tone.Unit.Frequency, o: { pitchDecay: number; octaves: number; decay: number; level?: number }): Drum => {
    const dest = level(o.level ?? 1)
    const get = pool(() =>
      new Tone.MembraneSynth({
        pitchDecay: o.pitchDecay,
        octaves: o.octaves,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: o.decay, sustain: 0, release: 0.05 },
      }).connect(dest),
    )
    return (t, v) => get().triggerAttackRelease(note, o.decay, t, v)
  }

  /** filtered noise burst; `pulses` > 1 makes a hand clap */
  const noise = (o: { type: 'white' | 'pink'; filter: Tone.FilterOptions['type']; freq: number; q?: number; decay: number; level: number; pulses?: number }): Drum => {
    const dest = new Tone.Filter({ type: o.filter, frequency: o.freq, Q: o.q ?? 1 }).connect(level(o.level))
    const pulses = o.pulses ?? 1
    const get = pool(() => new Tone.NoiseSynth({ noise: { type: o.type }, envelope: { attack: 0.001, decay: o.decay, sustain: 0 } }).connect(dest), 3 * pulses)
    return (t, v) => {
      for (let k = 0; k < pulses; k++) {
        const last = k === pulses - 1
        get().triggerAttackRelease(last ? o.decay : 0.008, t + k * 0.011, last ? v : v * 0.7)
      }
    }
  }

  /** hats, cymbals, cowbell: inharmonic FM partials */
  const metal = (freq: number, o: { harmonicity: number; modulationIndex: number; resonance: number; octaves: number; decay: number; level: number }, n = 3): Drum => {
    const dest = level(o.level)
    const get = pool(
      () =>
        new Tone.MetalSynth({
          harmonicity: o.harmonicity,
          modulationIndex: o.modulationIndex,
          resonance: o.resonance,
          octaves: o.octaves,
          envelope: { attack: 0.001, decay: o.decay, release: 0.05 },
        }).connect(dest),
      n,
    )
    return (t, v) => get().triggerAttackRelease(freq, o.decay, t, v)
  }

  /** woody FM hits: rim shots, claves, electro toms */
  const fm = (note: Tone.Unit.Frequency, o: { harmonicity: number; modulationIndex: number; decay: number; level: number }): Drum => {
    // FM voices come out ~6x quieter than membranes at the same gain
    const dest = level(o.level * 6)
    const get = pool(() =>
      new Tone.FMSynth({
        harmonicity: o.harmonicity,
        modulationIndex: o.modulationIndex,
        envelope: { attack: 0.001, decay: o.decay, sustain: 0, release: 0.03 },
        modulationEnvelope: { attack: 0.001, decay: o.decay * 0.4, sustain: 0, release: 0.02 },
      }).connect(dest),
    )
    return (t, v) => get().triggerAttackRelease(note, o.decay, t, v)
  }

  const both = (...ds: Drum[]): Drum => (t, v) => ds.forEach((d) => d(t, v))

  // shared cymbal recipes
  const crash = (bright: number): Drum =>
    both(
      metal(300 * bright, { harmonicity: 5.1, modulationIndex: 64, resonance: 4200 * bright, octaves: 1.5, decay: 1.4, level: 0.32 }, 2),
      noise({ type: 'white', filter: 'highpass', freq: 6500, decay: 1.1, level: 0.25 }),
    )
  const hat = (freq: number, decay: number, level = 0.8) =>
    metal(freq, { harmonicity: 5.1, modulationIndex: 32, resonance: 7500, octaves: 1.5, decay, level })

  return { membrane, noise, metal, fm, both, crash, hat }
}

type B = ReturnType<typeof builders>

const KITS: { name: string; make: (b: B) => Omit<Kit, 'name'> }[] = [
  {
    name: 'ROCK',
    make: ({ membrane, noise, fm, both, crash, hat }) => ({
      L: [
        membrane('C1', { pitchDecay: 0.05, octaves: 7, decay: 0.4 }), // kick
        membrane('A1', { pitchDecay: 0.08, octaves: 2.5, decay: 0.5, level: 0.9 }), // floor tom
        membrane('D2', { pitchDecay: 0.06, octaves: 2, decay: 0.4, level: 0.85 }), // low tom
      ],
      R: [
        both(
          noise({ type: 'white', filter: 'highpass', freq: 1800, decay: 0.18, level: 1.3 }),
          membrane('G2', { pitchDecay: 0.02, octaves: 2, decay: 0.1, level: 0.6 }),
        ), // snare
        membrane('G2', { pitchDecay: 0.05, octaves: 2, decay: 0.3, level: 0.8 }), // rack tom
        fm('C6', { harmonicity: 3.5, modulationIndex: 20, decay: 0.06, level: 0.5 }), // rim shot
      ],
      hat: { L: hat(380, 0.05), R: hat(420, 0.09) },
      cymbal: crash(1),
    }),
  },
  {
    name: '808',
    make: ({ membrane, noise, metal, crash, hat }) => ({
      L: [
        membrane('A0', { pitchDecay: 0.12, octaves: 6, decay: 0.9 }), // 808 boom
        membrane('G1', { pitchDecay: 0.1, octaves: 3, decay: 0.5, level: 0.85 }), // low tom
        membrane('C2', { pitchDecay: 0.1, octaves: 3, decay: 0.45, level: 0.8 }), // mid tom
      ],
      R: [
        noise({ type: 'white', filter: 'bandpass', freq: 1300, q: 1.4, decay: 0.16, level: 1.8, pulses: 3 }), // clap
        membrane('F2', { pitchDecay: 0.1, octaves: 3, decay: 0.35, level: 0.75 }), // hi tom
        metal(540, { harmonicity: 1.48, modulationIndex: 2, resonance: 2000, octaves: 0.4, decay: 0.25, level: 0.35 }), // cowbell
      ],
      hat: { L: hat(450, 0.04), R: hat(500, 0.18, 0.45) },
      cymbal: crash(0.8),
    }),
  },
  {
    name: 'LATIN',
    make: ({ membrane, noise, metal, fm, both }) => ({
      L: [
        membrane('D2', { pitchDecay: 0.03, octaves: 3, decay: 0.7 }), // surdo
        membrane('D3', { pitchDecay: 0.01, octaves: 1.6, decay: 0.3, level: 0.8 }), // tumba
        membrane('G3', { pitchDecay: 0.01, octaves: 1.6, decay: 0.25, level: 0.75 }), // conga
      ],
      R: [
        both(
          membrane('E4', { pitchDecay: 0.005, octaves: 1.2, decay: 0.25, level: 0.7 }),
          metal(900, { harmonicity: 2.1, modulationIndex: 6, resonance: 4000, octaves: 0.5, decay: 0.12, level: 0.12 }),
        ), // timbale
        membrane('A4', { pitchDecay: 0.005, octaves: 1.2, decay: 0.12, level: 1.4 }), // bongo
        fm('E6', { harmonicity: 2.4, modulationIndex: 8, decay: 0.05, level: 0.55 }), // clave
      ],
      hat: {
        L: noise({ type: 'white', filter: 'bandpass', freq: 6000, q: 0.8, decay: 0.07, level: 1.6 }), // shaker
        R: noise({ type: 'white', filter: 'bandpass', freq: 8000, q: 0.8, decay: 0.05, level: 1.5 }),
      },
      // ride bell instead of a crash
      cymbal: metal(620, { harmonicity: 3.5, modulationIndex: 12, resonance: 5200, octaves: 0.8, decay: 0.9, level: 0.3 }, 2),
    }),
  },
  {
    name: 'ELECTRO',
    make: ({ membrane, noise, fm, both, crash, hat }) => ({
      L: [
        membrane('C1', { pitchDecay: 0.03, octaves: 8, decay: 0.3 }), // 909 kick
        fm('C3', { harmonicity: 1.5, modulationIndex: 9, decay: 0.28, level: 0.8 }), // FM tom low
        fm('F3', { harmonicity: 1.5, modulationIndex: 9, decay: 0.24, level: 0.75 }), // FM tom mid
      ],
      R: [
        both(
          noise({ type: 'pink', filter: 'highpass', freq: 2500, decay: 0.14, level: 2.6 }),
          membrane('A2', { pitchDecay: 0.01, octaves: 1.5, decay: 0.08, level: 0.9 }),
        ), // 909 snare
        noise({ type: 'white', filter: 'bandpass', freq: 1600, q: 1.2, decay: 0.14, level: 1.6, pulses: 3 }), // 909 clap
        fm('G5', { harmonicity: 3, modulationIndex: 14, decay: 0.07, level: 0.4 }), // zap
      ],
      hat: { L: hat(400, 0.05), R: hat(440, 0.22, 0.45) }, // closed / open
      cymbal: crash(1.2),
    }),
  },
]

export class HitKits {
  private build: B
  private built = new Map<number, Kit>()
  private splash: Drum
  private current = -1
  readonly names = KITS.map((k) => k.name)

  private constructor(ctx: AudioContext) {
    Tone.setContext(ctx)
    // play immediately on a hit, no scheduling look-ahead
    Tone.getContext().lookAhead = 0
    const bus = new Tone.Compressor({ threshold: -18, ratio: 4, attack: 0.002, release: 0.12 }).toDestination()
    const verb = new Tone.Freeverb({ roomSize: 0.6, dampening: 3000, wet: 0.16 }).connect(bus)
    this.build = builders(new Tone.Gain(0.9).connect(verb))
    // SLAP: a short splash cymbal on top of any kit
    this.splash = this.build.metal(420, { harmonicity: 5.1, modulationIndex: 40, resonance: 6500, octaves: 1.4, decay: 0.35, level: 0.3 })
  }

  static create(ctx: AudioContext): HitKits {
    return new HitKits(ctx)
  }

  private kit(k: number): Kit {
    let kit = this.built.get(k)
    if (!kit) {
      kit = { name: KITS[k].name, ...KITS[k].make(this.build) }
      this.built.set(k, kit)
    }
    return kit
  }

  private index(kit: number): number {
    return ((kit % KITS.length) + KITS.length) % KITS.length
  }

  /** build the kits a song will use up front (during loading, not mid-song) */
  prepare(kits: number[]): void {
    for (const k of kits) this.kit(this.index(k))
  }

  /** returns true when the kit just changed (for the HUD banner) */
  setKit(kit: number): boolean {
    const k = this.index(kit)
    if (k === this.current) return false
    this.current = k
    return true
  }

  hit(side: Side, judgment: Exclude<Judgment, 'miss'>, slap: boolean, beat: number, cymbal: boolean): void {
    const kit = this.kit(Math.max(0, this.current))
    const t = Tone.now()
    const accent = beat === 0 ? 1 : beat < 0 ? 0.75 : 0.85
    const vel = Math.min(1, WEIGHT[judgment] * accent * (slap ? 1.15 : 1))
    try {
      if (beat < 0) kit.hat[side](t, vel)
      else kit[side][beat === 0 ? 0 : beat === 2 ? 1 : 2](t, vel)
      if (cymbal) kit.cymbal(t, vel * 0.8)
      if (slap) this.splash(t, 0.7)
    } catch (err) {
      // a dropped hit sound must never break the game loop
      console.warn(err)
    }
  }
}
