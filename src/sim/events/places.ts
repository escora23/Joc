// FRONT ULTRA — real-world geography for world events (owner: sim-ai). Worker-safe data.
//
// Events happen where they happen on the real planet: earthquakes along the Ring of Fire and the Alpide belt,
// hurricanes in the tropical cyclone basins with realistic tracks, gold rushes in historic gold fields.

/** Seismic hotspots: [lat, lon, weight]. */
export const SEISMIC: [number, number, number][] = [
  [36.0, 139.5, 1.4], [38.3, 142.4, 1.0], [-33.4, -71.6, 1.3], [-20.0, -69.5, 0.8], [-12.0, -77.0, 0.9], [-1.5, -78.5, 0.8],
  [-7.0, 110.0, 1.1], [0.0, 99.5, 1.2], [-8.5, 118.0, 0.6], [39.5, 35.0, 1.1], [38.0, 44.0, 0.7], [34.0, 51.5, 1.0],
  [28.0, 84.5, 1.1], [31.0, 103.5, 1.0], [24.0, 121.0, 0.8], [36.5, -120.5, 1.2], [34.0, -118.2, 0.9], [19.4, -99.1, 1.0],
  [16.5, -95.0, 0.6], [14.6, -90.5, 0.8], [18.5, -72.5, 0.8], [42.0, 13.5, 0.9], [38.0, 22.5, 0.9], [13.0, 122.5, 1.0],
  [61.0, -150.0, 0.9], [-41.5, 174.5, 0.9], [-43.5, 172.6, 0.5], [33.5, 72.0, 0.8], [36.5, 70.5, 0.8], [36.2, 3.0, 0.6],
  [30.9, -8.4, 0.5], [22.0, 95.5, 0.7], [41.0, 72.5, 0.6], [53.0, 159.0, 0.5], [44.0, 147.0, 0.5], [-17.5, -72.5, 0.6],
  [40.8, 14.3, 0.4], [45.8, 26.6, 0.4], [29.5, 35.0, 0.3], [9.5, 126.5, 0.5], [-5.5, 146.5, 0.5], [64.0, -21.0, 0.3],
];

/** Hurricane basins: [lat, lon, heading (rad, tile space: 0 = north, pi/2 = east), weight]. */
export const CYCLONE_BASINS: [number, number, number, number][] = [
  [14, -42, -1.3, 1.3],   // Atlantic main development region -> Caribbean / Gulf
  [16, -58, -1.25, 0.9],   // Lesser Antilles
  [13, -100, -1.35, 0.9],   // Eastern Pacific -> Mexico
  [12, 148, -1.3, 1.2],   // Western Pacific typhoons -> Philippines / Japan / China
  [15, 132, -1.1, 0.9],
  [12, 89, -0.4, 0.7],     // Bay of Bengal -> Bangladesh / Myanmar
  [14, 66, -0.9, 0.5],     // Arabian Sea
  [-13, 72, -2.0, 0.6],    // South Indian Ocean -> Madagascar / Mozambique
  [-14, 122, -2.3, 0.6],   // Australian region
  [-15, 165, 2.6, 0.4],    // South Pacific -> Fiji / Vanuatu
];

/** Historic gold fields: [lat, lon, weight]. */
export const GOLD_FIELDS: [number, number, number][] = [
  [64.0, -139.4, 1.0], [38.6, -120.8, 1.1], [-26.2, 28.0, 1.2], [-30.7, 121.5, 1.0], [62.5, 150.0, 0.8],
  [-6.0, -49.8, 0.8], [6.2, -1.7, 0.9], [39.5, -117.0, 0.7], [39.0, -106.0, 0.6], [-14.2, -70.0, 0.7],
  [41.5, 64.6, 0.8], [43.5, 106.9, 0.6], [-4.0, 137.1, 0.7], [12.6, -8.0, 0.7], [-45.0, 169.5, 0.5],
  [-20.0, -44.0, 0.8], [64.5, -165.4, 0.5], [19.5, 33.5, 0.6], [55.0, 116.5, 0.5], [-17.5, 31.0, 0.5],
  [11.0, 39.0, 0.4], [5.0, -59.0, 0.5], [-33.0, 149.0, 0.6], [46.5, 23.5, 0.4], [60.8, 101.0, 0.4],
];
