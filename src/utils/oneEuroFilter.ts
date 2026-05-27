/**
 * 1€ Filter：静止时强平滑、快速移动时低延迟，兼顾「跟眼」与「不抖」。
 * @see https://gery.casiez.net/1euro/
 */
export class OneEuroFilter {
  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = 0;
  private initialized = false;

  constructor(
    private minCutoff = 1.0,
    private beta = 0.007,
    private dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, t: number): number {
    if (!this.initialized) {
      this.initialized = true;
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.max(1e-4, t - this.tPrev);
    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;
    return xHat;
  }

  reset(x: number, t: number): void {
    this.initialized = true;
    this.xPrev = x;
    this.dxPrev = 0;
    this.tPrev = t;
  }
}
