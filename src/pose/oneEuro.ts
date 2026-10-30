/** One Euro filter (Casiez et al.): low jitter when still, low lag when moving fast. */
export class OneEuro {
  private x: number | null = null
  private dx = 0
  private minCutoff: number
  private beta: number
  private dCutoff: number

  constructor(minCutoff = 1.2, beta = 0.03, dCutoff = 1.0) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(value: number, dt: number): number {
    if (this.x === null || dt <= 0) {
      this.x = value
      this.dx = 0
      return value
    }
    const rawDx = (value - this.x) / dt
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx)
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x)
    return this.x
  }

  reset(): void {
    this.x = null
  }
}
