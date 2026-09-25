// FRONT ULTRA — bundled web fonts (owner: ui). All SIL OFL 1.1, served from the static build (no CDN).
//   Rajdhani         — condensed military/tech display face (titles, labels, buttons)
//   Barlow           — clean UI sans (body copy)
//   Barlow Condensed — compact captions and small caps
//   JetBrains Mono   — tabular numerals (troops, gold, timers)
import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';

/** Resolve once the UI faces are ready (or after a short timeout), so the loading screen never flashes fallback fonts. */
export async function fontsReady(timeoutMs = 1500): Promise<void> {
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const loads = [
      '700 20px Rajdhani', '600 20px Rajdhani', '500 20px Rajdhani', '400 16px Barlow', '600 16px "Barlow Condensed"',
      '500 16px "JetBrains Mono"',
    ].map((f) => fonts.load(f).catch(() => undefined));
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, timeoutMs))]);
  } catch {
    /* fonts API unavailable: fallback faces are fine */
  }
}
