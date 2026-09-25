// FRONT ULTRA — HUD occlusion rectangles (owner: ui, added by W2 for DESIGN_V2 §10.10).
// World overlays drawn under the DOM (nation labels) must not hide beneath HUD panels. Every visible panel of the
// HUD uses the `fu-glass` look (top bar, clock, leaderboard, minimap, build bar, selection card, toasts, tutorial,
// spawn briefing); elements can also opt in with `data-occludes`. Panels that follow the cursor (tooltip, hover
// chip) are left out so labels do not flicker as the mouse moves. Layout is read at most 4 times a second.

const SELECTOR = '.fu-glass:not(.fu-tt):not(.fu-chip):not(.fu-bb-tip), [data-occludes]';
const REFRESH_MS = 250;

export interface OcclusionTracker {
  rects(): readonly DOMRect[];
  invalidate(): void;
}

export function createOcclusionTracker(root: HTMLElement): OcclusionTracker {
  let cache: DOMRect[] = [];
  let at = -1e9;
  function measure(): DOMRect[] {
    const out: DOMRect[] = [];
    const els = root.querySelectorAll<HTMLElement>(SELECTOR);
    for (const el of els) {
      if (el.closest('.fu-hidden')) continue;
      if (root.style.visibility === 'hidden') break;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
      out.push(r);
    }
    return out;
  }
  return {
    rects() {
      const now = performance.now();
      if (now - at >= REFRESH_MS) {
        at = now;
        cache = measure();
      }
      return cache;
    },
    invalidate() {
      at = -1e9;
    },
  };
}
