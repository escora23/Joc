// FRONT ULTRA — ground battle: farmland layout shared by the ground shader and the CPU scatterers (owner: battle).
//
// The countryside is a patchwork of fields in long parallel rows (rotated per battlefield), each row with its own
// field width and offset, some fields split into strips, some left as woodlots. Hedgerows run along part of the
// row boundaries and field ends. The GPU paints crops, furrows, margins and hedge bases from this layout; the CPU
// plants trees on exactly the same hedgerows and woodlots, so the two always agree. Both sides use the same
// integer hash (PCG), bit-exact between GLSL and JS.

/** Row pitch (m) of the field grid. */
export const FIELD_ROW = 150;
/** Hedge segment length (m) along row boundaries (each segment has or lacks a hedge). */
export const HEDGE_SEG = 330;
export const HEDGE_ROW_P = 0.42;
export const HEDGE_COL_P = 0.38;
/** Share of fields that are woodlots. */
export const WOODLOT_P = 0.075;

export const GLSL_FIELDS = /* glsl */ `
uniform vec2 uFieldRot; // cos, sin of the field grid rotation
uint fPcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float fHash(int a, int b, int k) {
  uint h = fPcg(uint(a) * 1597334677u ^ fPcg(uint(b) + uint(k) * 3812015801u));
  return float(h) * (1.0 / 4294967295.0);
}
// Field cell at a local point. id = (column, row) of the (unsplit) field, uv = position inside the (split) field,
// size = field size (m), crop = crop hash, hedge = distance (m) to the nearest hedgerow (large if none).
struct Field { ivec2 id; vec2 uv; vec2 size; float crop; float hedge; float strip; float wood; vec2 fp; };
Field fieldAt(vec2 xz) {
  Field f;
  vec2 fp = vec2(uFieldRot.x * xz.x + uFieldRot.y * xz.y, -uFieldRot.y * xz.x + uFieldRot.x * xz.y);
  f.fp = fp;
  float rowF = floor(fp.y / ${FIELD_ROW.toFixed(1)});
  int row = int(rowF);
  float w = 120.0 + 240.0 * fHash(row, 0, 1);
  float fx = fp.x + fHash(row, 0, 2) * 997.0;
  float colF = floor(fx / w);
  int col = int(colF);
  vec2 uv = vec2(fx / w - colF, fp.y / ${FIELD_ROW.toFixed(1)} - rowF);
  f.id = ivec2(col, row);
  f.crop = fHash(col, row, 3);
  f.wood = f.crop < ${WOODLOT_P.toFixed(3)} ? 1.0 : 0.0;
  // Hedgerows: row boundaries by segments, field ends by field.
  int er = uv.y < 0.5 ? row : row + 1;
  float dy = min(uv.y, 1.0 - uv.y) * ${FIELD_ROW.toFixed(1)};
  float hy = fHash(er, int(floor(fp.x / ${HEDGE_SEG.toFixed(1)})), 4) < ${HEDGE_ROW_P.toFixed(3)} ? dy : 1e4;
  int ec = uv.x < 0.5 ? col : col + 1;
  float dx = min(uv.x, 1.0 - uv.x) * w;
  float hx = fHash(ec, row, 5) < ${HEDGE_COL_P.toFixed(3)} ? dx : 1e4;
  f.hedge = min(hx, hy);
  // Some fields are farmed in strips.
  float hs = fHash(col, row, 6);
  f.strip = 0.0;
  if (hs < 0.3 && f.wood < 0.5) {
    float n = hs < 0.12 ? 3.0 : 2.0;
    float sub = floor(uv.x * n);
    uv.x = uv.x * n - sub;
    w /= n;
    f.crop = fHash(col * 4 + int(sub), row, 7);
    if (f.crop < ${WOODLOT_P.toFixed(3)}) f.crop += 0.1;
    f.strip = 1.0;
  }
  f.uv = uv;
  f.size = vec2(w, ${FIELD_ROW.toFixed(1)});
  return f;
}
`;

function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** Bit-exact twin of the GLSL fHash. */
export function fieldHash(a: number, b: number, k: number): number {
  const inner = pcg((b + Math.imul(k, 3812015801)) >>> 0);
  return pcg((Math.imul(a >>> 0, 1597334677) ^ inner) >>> 0) / 4294967295;
}

/** Field-space coordinates (rotated frame) of a local point, and back. */
export class FieldFrame {
  c = 1;
  s = 0;
  setAngle(a: number): void {
    this.c = Math.cos(a);
    this.s = Math.sin(a);
  }
  /** local xz -> field space. */
  toField(x: number, z: number, out: { x: number; y: number }): void {
    out.x = this.c * x + this.s * z;
    out.y = -this.s * x + this.c * z;
  }
  /** field space -> local xz. */
  toLocal(fx: number, fy: number, out: { x: number; y: number }): void {
    out.x = this.c * fx - this.s * fy;
    out.y = this.s * fx + this.c * fy;
  }
}

export function rowWidth(row: number): number {
  return 120 + 240 * fieldHash(row, 0, 1);
}
export function rowShift(row: number): number {
  return fieldHash(row, 0, 2) * 997;
}
export function rowHedge(edgeRow: number, fpx: number): boolean {
  return fieldHash(edgeRow, Math.floor(fpx / HEDGE_SEG), 4) < HEDGE_ROW_P;
}
export function colHedge(edgeCol: number, row: number): boolean {
  return fieldHash(edgeCol, row, 5) < HEDGE_COL_P;
}
export function isWoodlot(col: number, row: number): boolean {
  return fieldHash(col, row, 3) < WOODLOT_P;
}
