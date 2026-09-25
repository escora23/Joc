// FRONT ULTRA — command mode input (owner: command). Acquired in enter(), released in exit(): pointer lock on the
// canvas (requested on the first click, since the dive animation consumes the original gesture), keyboard state
// with edge detection, accumulated mouse deltas (works with or without pointer lock), buttons and wheel.

export class CommandInput {
  readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  lmb = false;
  rmb = false;
  private lmbPressed = false;
  private rmbPressed = false;
  locked = false;
  private active = false;
  private lastX = -1;
  private lastY = -1;
  /** Called on Escape (edge). */
  onEscape: () => void = () => undefined;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    if (this.active) return;
    this.active = true;
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('mousemove', this.onMove, true);
    window.addEventListener('mousedown', this.onDown, true);
    window.addEventListener('mouseup', this.onUp, true);
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    window.addEventListener('contextmenu', this.onContext, true);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  detach(): void {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('mousemove', this.onMove, true);
    window.removeEventListener('mousedown', this.onDown, true);
    window.removeEventListener('mouseup', this.onUp, true);
    window.removeEventListener('wheel', this.onWheel, true);
    window.removeEventListener('contextmenu', this.onContext, true);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.releaseLock();
    this.reset();
  }

  reset(): void {
    this.keys.clear();
    this.pressed.clear();
    this.mouseDX = this.mouseDY = this.wheel = 0;
    this.lmb = this.rmb = this.lmbPressed = this.rmbPressed = false;
  }

  requestLock(): void {
    try {
      if (document.pointerLockElement !== this.canvas) {
        const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        if (r && typeof r.catch === 'function') r.catch(() => undefined);
      }
    } catch {
      /* not allowed (headless, iframe): mouse deltas still work unlocked */
    }
  }

  releaseLock(): void {
    try {
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    } catch {
      /* ignore */
    }
    this.locked = false;
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** True once per key press. */
  hit(code: string): boolean {
    if (this.pressed.has(code)) {
      this.pressed.delete(code);
      return true;
    }
    return false;
  }

  lmbHit(): boolean {
    const v = this.lmbPressed;
    this.lmbPressed = false;
    return v;
  }

  rmbHit(): boolean {
    const v = this.rmbPressed;
    this.rmbPressed = false;
    return v;
  }

  /** Consume the accumulated mouse delta. */
  takeMouse(out: { x: number; y: number }): void {
    out.x = this.mouseDX;
    out.y = this.mouseDY;
    this.mouseDX = this.mouseDY = 0;
  }

  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Per-frame cleanup of unconsumed edges. */
  endFrame(): void {
    this.pressed.clear();
    this.lmbPressed = this.rmbPressed = false;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.onEscape();
      return;
    }
    if (!e.repeat) this.pressed.add(e.code);
    this.keys.add(e.code);
    if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
    // Command mode owns the keyboard: keep strategic hotkeys from firing underneath.
    e.stopPropagation();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    e.stopPropagation();
  };

  private onMove = (e: MouseEvent): void => {
    if (this.locked) {
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    } else {
      // Unlocked fallback: use position deltas (movementX is unreliable when the cursor is free on some platforms).
      if (this.lastX >= 0) {
        this.mouseDX += e.clientX - this.lastX;
        this.mouseDY += e.clientY - this.lastY;
      }
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  };

  private onDown = (e: MouseEvent): void => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest && tgt.closest('.fu-cmd-interactive')) return;
    if (!this.locked) this.requestLock();
    if (e.button === 0) {
      this.lmb = true;
      this.lmbPressed = true;
    } else if (e.button === 2) {
      this.rmb = true;
      this.rmbPressed = true;
    }
    e.preventDefault();
  };

  private onUp = (e: MouseEvent): void => {
    if (e.button === 0) this.lmb = false;
    else if (e.button === 2) this.rmb = false;
  };

  private onWheel = (e: WheelEvent): void => {
    this.wheel += Math.sign(e.deltaY);
    e.preventDefault();
    e.stopPropagation();
  };

  private onContext = (e: Event): void => {
    e.preventDefault();
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.lmb = this.rmb = false;
  };

  private onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    this.lastX = this.lastY = -1;
  };
}
