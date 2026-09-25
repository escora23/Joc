// FRONT ULTRA — world-data build worker (owner: data).
//
// Runs the whole data pipeline off the main thread: downloads the NASA maps (streamed, with byte progress),
// decodes them with createImageBitmap + OffscreenCanvas, loads the Natural Earth topology (bundled JSON),
// builds the grid, the country raster and the aux fields, and transfers every typed array back (zero copy).
//
// Protocol: main -> { type: 'build', urls: { water, topo, day, night } } (absolute URLs)
//           worker -> { type: 'progress', f, label } ... { type: 'done', result } | { type: 'error', message }

import { buildTransferables, buildWorld, type RgbaImage } from './build';
import type { CountriesTopology } from './rasterize';

export interface BuildRequest {
  type: 'build';
  urls: { water: string; topo: string; day: string; night: string };
}

type Post = (msg: unknown, transfer?: Transferable[]) => void;
const post: Post = (msg, transfer) => (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage(msg, transfer ?? []);

/** Weighted download progress over several files (weights ~ file sizes). */
class DownloadMeter {
  private readonly loaded = new Map<string, number>();
  private readonly total = new Map<string, number>();
  constructor(private readonly onChange: (f: number) => void) {}
  set(key: string, loaded: number, total: number): void {
    this.loaded.set(key, loaded);
    this.total.set(key, total);
    let l = 0, t = 0;
    for (const [k, v] of this.total) {
      t += v;
      l += Math.min(v, this.loaded.get(k) ?? 0);
    }
    this.onChange(t > 0 ? l / t : 0);
  }
}

/** Fetch with streamed byte progress. `expected` is a fallback size when there is no Content-Length. */
async function fetchBlob(url: string, key: string, expected: number, meter: DownloadMeter): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || expected;
  meter.set(key, 0, total);
  if (!res.body) {
    const b = await res.blob();
    meter.set(key, total, total);
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    meter.set(key, got, Math.max(total, got));
  }
  meter.set(key, got, got);
  return new Blob(chunks as BlobPart[], { type: res.headers.get('content-type') ?? '' });
}

async function decode(blob: Blob): Promise<RgbaImage> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('OffscreenCanvas 2D unavailable');
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width: img.width, height: img.height, data: img.data };
}

/** Full pipeline, usable both inside the worker and (fallback) on the main thread. */
export async function runBuild(
  urls: BuildRequest['urls'],
  progress: (f: number, label: string) => void | Promise<void>,
  thread: string,
) {
  // 0.00-0.40 download, 0.40-0.50 decode, 0.50-1.00 build.
  const meter = new DownloadMeter((f) => void progress(f * 0.4, 'data.download'));
  const topoJson = import('world-atlas/countries-50m.json').then((m) => m.default as unknown as CountriesTopology);
  const [waterB, topoB, dayB, nightB] = await Promise.all([
    fetchBlob(urls.water, 'water', 430_000, meter),
    fetchBlob(urls.topo, 'topo', 380_000, meter),
    fetchBlob(urls.day, 'day', 1_460_000, meter),
    fetchBlob(urls.night, 'night', 715_000, meter),
  ]);
  await progress(0.4, 'data.decode');
  const [water, topo, day, night, countries] = await Promise.all([decode(waterB), decode(topoB), decode(dayB), decode(nightB), topoJson]);
  await progress(0.5, 'data.water');
  return buildWorld({ water, topo, day, night, countries }, (f, l) => progress(0.5 + f * 0.5, l), thread);
}

// Worker entry (only when actually running as a dedicated worker).
const WGS = (globalThis as unknown as { WorkerGlobalScope?: new () => unknown }).WorkerGlobalScope;
const isWorker = typeof WGS === 'function' && self instanceof WGS;
if (isWorker) {
  self.addEventListener('message', (ev: MessageEvent<BuildRequest>) => {
    if (ev.data?.type !== 'build') return;
    let last = -1;
    runBuild(
      ev.data.urls,
      (f, label) => {
        // Throttle progress messages to ~1% steps.
        if (f - last >= 0.01 || f >= 1) {
          last = f;
          post({ type: 'progress', f, label });
        }
      },
      'worker',
    )
      .then((result) => post({ type: 'done', result }, buildTransferables(result)))
      .catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) }));
  });
}
