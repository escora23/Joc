// FRONT ULTRA — command mode: chunk mesh arrays (owner: W5-command-v2). Shared by the terrain worker and the
// main-thread fallback: no DOM, no three.js.

/** Render arrays of a chunk: (inner + 2)² vertices (the inner grid and its skirt ring), local to the chunk centre. */
export interface ChunkMesh {
  position: Float32Array;
  normal: Float32Array;
  splatA: Uint8Array;
  splatB: Uint8Array;
  tint: Uint8Array;
}

/**
 * Mesh arrays for an inner res² grid of `size` meters taken from padded data (pad samples of border): positions local
 * to the chunk centre, normals from the padded heights (continuous across chunks), splat and tint, and a skirt ring
 * (the outer vertices repeat the edge ones `skirt` m lower). Water is clamped at −60 m.
 */
export function buildChunkMesh(d: { heights: Float32Array; splatA: Uint8Array; splatB: Uint8Array; tint: Uint8Array }, P: number, pad: number, size: number, skirt: number): ChunkMesh {
  const res = P - 2 * pad;
  const R = res + 2;
  const n = R * R;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const sa = new Uint8Array(n * 4), sb = new Uint8Array(n * 4), tn = new Uint8Array(n * 3);
  const cell = size / (res - 1);
  const H = d.heights;
  const inv2 = 1 / (2 * cell);
  for (let gi = 0; gi < R; gi++) {
    const i = Math.min(res - 1, Math.max(0, gi - 1));
    const skirtRow = gi === 0 || gi === R - 1;
    for (let gj = 0; gj < R; gj++) {
      const j = Math.min(res - 1, Math.max(0, gj - 1));
      const skirtV = skirtRow || gj === 0 || gj === R - 1;
      const pi = i + pad, pj = j + pad;
      const k = pi * P + pj;
      let h = H[k];
      if (h < -60) h = -60;
      const v = gi * R + gj;
      pos[v * 3] = -size / 2 + j * cell;
      pos[v * 3 + 1] = skirtV ? h - skirt : h;
      pos[v * 3 + 2] = -size / 2 + i * cell;
      const kl = pj > 0 ? k - 1 : k, kr = pj < P - 1 ? k + 1 : k, ku = pi > 0 ? k - P : k, kd = pi < P - 1 ? k + P : k;
      const hl = Math.max(-60, H[kl]), hr = Math.max(-60, H[kr]), hu = Math.max(-60, H[ku]), hd = Math.max(-60, H[kd]);
      const nx = -(hr - hl) * inv2 * (kr - kl === 2 ? 1 : 2), nz = -(hd - hu) * inv2 * (kd - ku === 2 * P ? 1 : 2);
      const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nrm[v * 3] = nx * il;
      nrm[v * 3 + 1] = il;
      nrm[v * 3 + 2] = nz * il;
      sa[v * 4] = d.splatA[k * 4]; sa[v * 4 + 1] = d.splatA[k * 4 + 1]; sa[v * 4 + 2] = d.splatA[k * 4 + 2]; sa[v * 4 + 3] = d.splatA[k * 4 + 3];
      sb[v * 4] = d.splatB[k * 4]; sb[v * 4 + 1] = d.splatB[k * 4 + 1]; sb[v * 4 + 2] = d.splatB[k * 4 + 2]; sb[v * 4 + 3] = d.splatB[k * 4 + 3];
      tn[v * 3] = d.tint[k * 3];
      tn[v * 3 + 1] = d.tint[k * 3 + 1];
      tn[v * 3 + 2] = d.tint[k * 3 + 2];
    }
  }
  return { position: pos, normal: nrm, splatA: sa, splatB: sb, tint: tn };
}

