/**
 * All audio is synthesised with WebAudio oscillators — no asset files, nothing
 * to license, nothing to load.
 *
 * Muted by default: a page that makes noise before you ask it to is a page you
 * close. The choice persists in localStorage.
 */

const STORAGE_KEY = 'deadman:sound';

class Sound {
  private ctx: AudioContext | null = null;
  private enabled = false;
  private lastBeat = 0;

  constructor() {
    try {
      this.enabled = localStorage.getItem(STORAGE_KEY) === 'on';
    } catch {
      this.enabled = false;
    }
  }

  get isOn(): boolean {
    return this.enabled;
  }

  /** Browsers only allow an AudioContext to start from a user gesture. */
  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off');
    } catch {
      /* private browsing — the setting just won't persist */
    }
    if (this.enabled) {
      this.ensure();
      this.blip(880, 0.07, 0.05);
    }
    return this.enabled;
  }

  private tone(
    freq: number,
    duration: number,
    gain: number,
    type: OscillatorType = 'sine',
    startAt = 0,
  ): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + startAt;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    // Quick attack, exponential decay — a click envelope, not a drone.
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  blip(freq: number, duration: number, gain: number): void {
    this.tone(freq, duration, gain, 'sine');
  }

  /**
   * Lub-dub. Called from the render loop; it rate-limits itself against the
   * interval the caller asks for, which shortens as the clock runs down.
   */
  heartbeat(intervalMs: number, intensity: number): void {
    if (!this.enabled) return;
    const now = performance.now();
    if (now - this.lastBeat < intervalMs) return;
    this.lastBeat = now;
    const g = 0.05 + intensity * 0.16;
    this.tone(62, 0.16, g, 'sine', 0);
    this.tone(48, 0.2, g * 0.7, 'sine', 0.15);
  }

  /** Two-tone alarm for a press under ten seconds. */
  klaxon(): void {
    if (!this.enabled) return;
    this.tone(440, 0.19, 0.16, 'square', 0);
    this.tone(330, 0.26, 0.16, 'square', 0.2);
  }

  /** Descending tone: the era just died. */
  flatline(): void {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, t0);
    osc.frequency.exponentialRampToValueAtTime(45, t0 + 1.4);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(0.14, t0 + 0.05);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 1.55);
  }

  /** Rising chime when your own press lands. */
  confirm(): void {
    if (!this.enabled) return;
    this.tone(523, 0.11, 0.12, 'sine', 0);
    this.tone(659, 0.11, 0.12, 'sine', 0.09);
    this.tone(784, 0.22, 0.13, 'sine', 0.18);
  }

  /** Kick the context awake on the first gesture, even while muted. */
  primeFromGesture(): void {
    if (this.enabled) this.ensure();
  }
}

export const sound = new Sound();
