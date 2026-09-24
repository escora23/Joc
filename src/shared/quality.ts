// FRONT ULTRA — graphics quality presets. Every subsystem reads ctx.quality (a QualityProfile) in init()
// and again in setQuality() when the player changes the preset (bus 'qualityChanged').
// Owner: shared. Subsystems may ignore fields that do not apply to them, but must not invent their own presets.

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export interface QualityProfile {
  level: QualityLevel;
  // --- renderer / post (app, globe/post)
  /** Max device pixel ratio used by the renderer. */
  pixelRatioCap: number;
  antialias: 'none' | 'fxaa' | 'smaa' | 'msaa4';
  /** 0 off, 1 half-res cheap, 2 full UnrealBloom-quality. */
  bloom: 0 | 1 | 2;
  /** Vignette, film grain, chromatic aberration, lens dirt, heat haze. */
  cinematicPost: boolean;
  // --- globe
  /** Sphere/terrain mesh subdivision level (globe decides the mapping; larger = finer). */
  globeDetail: 0 | 1 | 2 | 3;
  /** Max texture size uploaded for earth textures (2048 downsamples the 4K NASA maps). */
  textureSize: 2048 | 4096;
  /** 0 static clouds, 1 animated clouds, 2 animated + cloud shadows. */
  clouds: 0 | 1 | 2;
  /** 0 rim glow, 1 single-scattering approx, 2 full multi-sample scattering. */
  atmosphere: 0 | 1 | 2;
  /** 0 flat specular, 1 animated normals + glint, 2 + foam/fresnel detail. */
  ocean: 0 | 1 | 2;
  // --- units / fx / battle
  /** Max particles alive across all FX systems. */
  particles: number;
  /** Max instanced infantry figures in the ground battle layer. */
  battleInfantry: number;
  /** Max vehicles (tanks, artillery, trucks) in the ground battle layer. */
  battleVehicles: number;
  /** Max ground decals (craters, scorch). */
  decals: number;
  // --- command mode
  /** Shadow map size, 0 = no shadows. */
  shadows: 0 | 1024 | 2048 | 4096;
  /** View distance in meters in command mode. */
  commandViewDistance: number;
  /** 0..1 vegetation / props density in command mode. */
  commandDetail: number;
  // --- audio
  maxVoices: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityProfile> = {
  low: {
    level: 'low', pixelRatioCap: 0.85, antialias: 'none', bloom: 0, cinematicPost: false,
    globeDetail: 0, textureSize: 2048, clouds: 0, atmosphere: 0, ocean: 0,
    particles: 2_000, battleInfantry: 1_500, battleVehicles: 80, decals: 32,
    shadows: 0, commandViewDistance: 1_500, commandDetail: 0.25, maxVoices: 16,
  },
  medium: {
    level: 'medium', pixelRatioCap: 1, antialias: 'fxaa', bloom: 1, cinematicPost: false,
    globeDetail: 1, textureSize: 4096, clouds: 1, atmosphere: 1, ocean: 1,
    particles: 6_000, battleInfantry: 5_000, battleVehicles: 200, decals: 96,
    shadows: 1024, commandViewDistance: 3_000, commandDetail: 0.5, maxVoices: 24,
  },
  high: {
    level: 'high', pixelRatioCap: 1.5, antialias: 'smaa', bloom: 2, cinematicPost: true,
    globeDetail: 2, textureSize: 4096, clouds: 2, atmosphere: 2, ocean: 2,
    particles: 15_000, battleInfantry: 12_000, battleVehicles: 400, decals: 192,
    shadows: 2048, commandViewDistance: 5_000, commandDetail: 0.8, maxVoices: 32,
  },
  ultra: {
    level: 'ultra', pixelRatioCap: 2, antialias: 'msaa4', bloom: 2, cinematicPost: true,
    globeDetail: 3, textureSize: 4096, clouds: 2, atmosphere: 2, ocean: 2,
    particles: 30_000, battleInfantry: 25_000, battleVehicles: 800, decals: 384,
    shadows: 4096, commandViewDistance: 8_000, commandDetail: 1, maxVoices: 48,
  },
};

export function qualityProfile(level: QualityLevel): QualityProfile {
  return { ...(QUALITY_PRESETS[level] ?? QUALITY_PRESETS.high) };
}
