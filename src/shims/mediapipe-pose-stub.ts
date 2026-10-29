/** Stub so Vite can bundle MoveNet-only pose-detection without MediaPipe runtime. */
export class Pose {
  constructor(_opts?: unknown) {}
  close(): void {}
  initialize(): Promise<void> {
    return Promise.resolve()
  }
  reset(): void {}
  send(_input: unknown): void {}
  onResults(_cb: unknown): void {}
}
