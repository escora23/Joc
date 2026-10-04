// FRONT ULTRA — command mode: one placement board for the screen labels of the vehicle HUD (hud.ts) and the strategic
// layer (overlay.ts) (command gauntlet fix: labels no longer pile up on the reticle).
//
// Every frame the vehicle HUD resets the board, keeps a clear disc of CLEAR_PX around the reticle and reserves what
// belongs to the reticle (the target bracket's label, the range readout, the reload tag). Then labels are placed
// greedily by priority, each with rectangle collision against what is already placed:
//   1. the target under the reticle (reserved by the HUD), 2. the hottest point / objective marker, 3. vehicle
//   labels near the reticle, 4. the force under the cursor, 5. world labels (borders, forces, towns, bases).
// A label whose natural place falls inside the clear disc is pushed out radially and drawn with a thin leader line to
// what it names; a label that still collides is dropped (lower priority loses).

export const CLEAR_PX = 70;

export interface LabelRect {
  /** Top-left corner and size (CSS px). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placed extends LabelRect {
  /** Pushed away from its anchor: draw a leader line from the anchor to the rectangle. */
  leader: boolean;
}

export class LabelBoard {
  private rects: LabelRect[] = [];
  private cx = 0;
  private cy = 0;
  private clear = CLEAR_PX;
  private W = 1;
  private H = 1;
  /** Tools: labels placed, pushed out of the reticle disc, dropped this frame. */
  readonly stats = { placed: 0, pushed: 0, dropped: 0 };

  reset(W: number, H: number, cx = W / 2, cy = H / 2, clear = CLEAR_PX): void {
    this.rects.length = 0;
    this.W = W;
    this.H = H;
    this.cx = cx;
    this.cy = cy;
    this.clear = clear;
    this.stats.placed = this.stats.pushed = this.stats.dropped = 0;
  }

  /** Keep this rectangle for something already drawn (it is never tested against the clear disc). */
  reserve(r: LabelRect): void {
    this.rects.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }

  /** Whether the rectangle overlaps anything placed (with a small margin). */
  hits(r: LabelRect, pad = 3): boolean {
    for (const o of this.rects) {
      if (r.x < o.x + o.w + pad && r.x + r.w + pad > o.x && r.y < o.y + o.h + pad && r.y + r.h + pad > o.y) return true;
    }
    return false;
  }

  /** Whether the rectangle reaches into the clear disc around the reticle. */
  inClear(r: LabelRect): boolean {
    const qx = Math.max(r.x, Math.min(this.cx, r.x + r.w)), qy = Math.max(r.y, Math.min(this.cy, r.y + r.h));
    return Math.hypot(qx - this.cx, qy - this.cy) < this.clear;
  }

  private onScreen(r: LabelRect): boolean {
    return r.x >= 4 && r.y >= 4 && r.x + r.w <= this.W - 4 && r.y + r.h <= this.H - 4;
  }

  /**
   * Place a label of size w × h for an anchor point: centred above it (gap px) by default, else below; out of the
   * reticle's disc along the ray from the reticle through the anchor (with a leader line); null when nothing fits.
   * The rectangle is reserved when placed.
   */
  place(ax: number, ay: number, w: number, h: number, gap = 10): Placed | null {
    const tries: Placed[] = [
      { x: ax - w / 2, y: ay - gap - h, w, h, leader: false },
      { x: ax - w / 2, y: ay + gap, w, h, leader: false },
    ];
    for (const r of tries) {
      if (!this.inClear(r) && !this.hits(r) && this.onScreen(r)) return this.take(r);
    }
    // Out of the reticle's disc, along the ray through the anchor (then a little to either side).
    let dx = ax - this.cx, dy = ay - this.cy;
    const d = Math.hypot(dx, dy);
    if (d < 1) {
      dx = 0.6;
      dy = -0.8;
    } else {
      dx /= d;
      dy /= d;
    }
    const base = Math.atan2(dy, dx);
    for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
      const a = base + off;
      const ux = Math.cos(a), uy = Math.sin(a);
      const ext = Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
      const k = Math.max(this.clear + ext + 6, d + gap + ext);
      const r: Placed = { x: this.cx + ux * k - w / 2, y: this.cy + uy * k - h / 2, w, h, leader: true };
      if (!this.inClear(r) && !this.hits(r) && this.onScreen(r)) {
        this.stats.pushed++;
        return this.take(r);
      }
    }
    this.stats.dropped++;
    return null;
  }

  /** Place a label exactly where given if it is free and clear of the reticle's disc (no moving it); else drop it. */
  placeAt(r: LabelRect, allowClear = false): boolean {
    if ((!allowClear && this.inClear(r)) || this.hits(r)) {
      this.stats.dropped++;
      return false;
    }
    this.take({ ...r, leader: false });
    return true;
  }

  private take(r: Placed): Placed {
    this.rects.push(r);
    this.stats.placed++;
    return r;
  }
}

/** The one board shared by the vehicle HUD and the strategic layer of command mode. */
export const labelBoard = new LabelBoard();

/** A thin leader line from an anchor to the nearest point of a label's rectangle. */
export function leaderLine(g: CanvasRenderingContext2D, ax: number, ay: number, r: LabelRect, color: string): void {
  const qx = Math.max(r.x, Math.min(ax, r.x + r.w)), qy = Math.max(r.y, Math.min(ay, r.y + r.h));
  g.save();
  g.strokeStyle = color;
  g.globalAlpha *= 0.7;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(qx, qy);
  g.stroke();
  g.beginPath();
  g.arc(ax, ay, 2, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.restore();
}
