// FRONT ULTRA — country catalog (owner: data). Worker-safe, hand-authored.
//
// One row per Natural Earth (world-atlas countries-50m) feature, keyed by the feature's `properties.name`
// (some features have no ISO id, and "Ashmore and Cartier Is." shares Australia's). Every row carries:
//   ISO3, ISO2, English + Spanish names, capital (English + Spanish name, lat/lon accurate to ~0.05 deg),
//   population (millions, ~2023), GDP (billion USD, ~2023), world region.
// MERGE maps disputed/partial features onto the internationally recognised country; DROP removes features
// that must not become countries (Antarctica is ice; Siachen is filled from its neighbours).

import type { WorldRegion } from './types';

export interface CountryRow {
  ne: string;
  iso3: string;
  iso2: string;
  en: string;
  es: string;
  capEn: string;
  capEs: string;
  lat: number;
  lon: number;
  pop: number;
  gdp: number;
  region: WorldRegion;
}

type Raw = [string, string, string, string, string, string, string, number, number, number, number, string];

const R: Record<string, WorldRegion> = {
  EU: 'europe', AS: 'asia', ME: 'middleEast', AF: 'africa', NA: 'northAmerica', CA: 'centralAmerica', SA: 'southAmerica', OC: 'oceania',
};

// [NE name, ISO3, ISO2, English, Spanish, capital EN, capital ES, lat, lon, pop M, GDP B$, region]
const RAW: Raw[] = [
  // --- Europe -------------------------------------------------------------------------------------------
  ['United Kingdom', 'GBR', 'GB', 'United Kingdom', 'Reino Unido', 'London', 'Londres', 51.507, -0.128, 68.3, 3340, 'EU'],
  ['France', 'FRA', 'FR', 'France', 'Francia', 'Paris', 'París', 48.857, 2.352, 68.2, 3030, 'EU'],
  ['Germany', 'DEU', 'DE', 'Germany', 'Alemania', 'Berlin', 'Berlín', 52.520, 13.405, 84.5, 4456, 'EU'],
  ['Spain', 'ESP', 'ES', 'Spain', 'España', 'Madrid', 'Madrid', 40.417, -3.704, 48.3, 1581, 'EU'],
  ['Portugal', 'PRT', 'PT', 'Portugal', 'Portugal', 'Lisbon', 'Lisboa', 38.722, -9.139, 10.5, 287, 'EU'],
  ['Italy', 'ITA', 'IT', 'Italy', 'Italia', 'Rome', 'Roma', 41.903, 12.496, 58.9, 2255, 'EU'],
  ['Netherlands', 'NLD', 'NL', 'Netherlands', 'Países Bajos', 'Amsterdam', 'Ámsterdam', 52.370, 4.895, 17.9, 1118, 'EU'],
  ['Belgium', 'BEL', 'BE', 'Belgium', 'Bélgica', 'Brussels', 'Bruselas', 50.850, 4.352, 11.8, 632, 'EU'],
  ['Luxembourg', 'LUX', 'LU', 'Luxembourg', 'Luxemburgo', 'Luxembourg', 'Luxemburgo', 49.612, 6.130, 0.66, 86, 'EU'],
  ['Switzerland', 'CHE', 'CH', 'Switzerland', 'Suiza', 'Bern', 'Berna', 46.948, 7.447, 8.8, 885, 'EU'],
  ['Austria', 'AUT', 'AT', 'Austria', 'Austria', 'Vienna', 'Viena', 48.208, 16.374, 9.1, 516, 'EU'],
  ['Liechtenstein', 'LIE', 'LI', 'Liechtenstein', 'Liechtenstein', 'Vaduz', 'Vaduz', 47.141, 9.521, 0.04, 7, 'EU'],
  ['Monaco', 'MCO', 'MC', 'Monaco', 'Mónaco', 'Monaco', 'Mónaco', 43.738, 7.425, 0.036, 9, 'EU'],
  ['Andorra', 'AND', 'AD', 'Andorra', 'Andorra', 'Andorra la Vella', 'Andorra la Vieja', 42.507, 1.521, 0.08, 3.7, 'EU'],
  ['San Marino', 'SMR', 'SM', 'San Marino', 'San Marino', 'San Marino', 'San Marino', 43.936, 12.447, 0.034, 2, 'EU'],
  ['Vatican', 'VAT', 'VA', 'Vatican City', 'Ciudad del Vaticano', 'Vatican City', 'Ciudad del Vaticano', 41.903, 12.453, 0.001, 0.3, 'EU'],
  ['Malta', 'MLT', 'MT', 'Malta', 'Malta', 'Valletta', 'La Valeta', 35.899, 14.514, 0.54, 20, 'EU'],
  ['Ireland', 'IRL', 'IE', 'Ireland', 'Irlanda', 'Dublin', 'Dublín', 53.350, -6.260, 5.3, 545, 'EU'],
  ['Iceland', 'ISL', 'IS', 'Iceland', 'Islandia', 'Reykjavik', 'Reikiavik', 64.147, -21.942, 0.39, 31, 'EU'],
  ['Norway', 'NOR', 'NO', 'Norway', 'Noruega', 'Oslo', 'Oslo', 59.914, 10.752, 5.5, 485, 'EU'],
  ['Sweden', 'SWE', 'SE', 'Sweden', 'Suecia', 'Stockholm', 'Estocolmo', 59.329, 18.069, 10.5, 593, 'EU'],
  ['Finland', 'FIN', 'FI', 'Finland', 'Finlandia', 'Helsinki', 'Helsinki', 60.170, 24.938, 5.6, 300, 'EU'],
  ['Åland', 'ALA', 'AX', 'Åland Islands', 'Islas Åland', 'Mariehamn', 'Mariehamn', 60.097, 19.935, 0.03, 1.8, 'EU'],
  ['Denmark', 'DNK', 'DK', 'Denmark', 'Dinamarca', 'Copenhagen', 'Copenhague', 55.676, 12.568, 5.9, 404, 'EU'],
  ['Faeroe Is.', 'FRO', 'FO', 'Faroe Islands', 'Islas Feroe', 'Tórshavn', 'Tórshavn', 62.009, -6.772, 0.054, 3.9, 'EU'],
  ['Estonia', 'EST', 'EE', 'Estonia', 'Estonia', 'Tallinn', 'Tallin', 59.437, 24.754, 1.37, 41, 'EU'],
  ['Latvia', 'LVA', 'LV', 'Latvia', 'Letonia', 'Riga', 'Riga', 56.950, 24.105, 1.9, 43, 'EU'],
  ['Lithuania', 'LTU', 'LT', 'Lithuania', 'Lituania', 'Vilnius', 'Vilna', 54.687, 25.280, 2.9, 79, 'EU'],
  ['Poland', 'POL', 'PL', 'Poland', 'Polonia', 'Warsaw', 'Varsovia', 52.230, 21.012, 37.6, 811, 'EU'],
  ['Czechia', 'CZE', 'CZ', 'Czechia', 'Chequia', 'Prague', 'Praga', 50.075, 14.438, 10.9, 330, 'EU'],
  ['Slovakia', 'SVK', 'SK', 'Slovakia', 'Eslovaquia', 'Bratislava', 'Bratislava', 48.149, 17.107, 5.4, 133, 'EU'],
  ['Hungary', 'HUN', 'HU', 'Hungary', 'Hungría', 'Budapest', 'Budapest', 47.498, 19.040, 9.6, 212, 'EU'],
  ['Slovenia', 'SVN', 'SI', 'Slovenia', 'Eslovenia', 'Ljubljana', 'Liubliana', 46.057, 14.506, 2.1, 68, 'EU'],
  ['Croatia', 'HRV', 'HR', 'Croatia', 'Croacia', 'Zagreb', 'Zagreb', 45.815, 15.982, 3.9, 82, 'EU'],
  ['Bosnia and Herz.', 'BIH', 'BA', 'Bosnia and Herzegovina', 'Bosnia y Herzegovina', 'Sarajevo', 'Sarajevo', 43.856, 18.413, 3.2, 27, 'EU'],
  ['Serbia', 'SRB', 'RS', 'Serbia', 'Serbia', 'Belgrade', 'Belgrado', 44.787, 20.457, 6.6, 75, 'EU'],
  ['Montenegro', 'MNE', 'ME', 'Montenegro', 'Montenegro', 'Podgorica', 'Podgorica', 42.441, 19.263, 0.62, 7.4, 'EU'],
  ['Kosovo', 'XKX', 'XK', 'Kosovo', 'Kosovo', 'Pristina', 'Pristina', 42.663, 21.166, 1.8, 10, 'EU'],
  ['Albania', 'ALB', 'AL', 'Albania', 'Albania', 'Tirana', 'Tirana', 41.328, 19.819, 2.8, 23, 'EU'],
  ['Macedonia', 'MKD', 'MK', 'North Macedonia', 'Macedonia del Norte', 'Skopje', 'Skopie', 41.998, 21.425, 1.8, 15, 'EU'],
  ['Greece', 'GRC', 'GR', 'Greece', 'Grecia', 'Athens', 'Atenas', 37.984, 23.728, 10.4, 239, 'EU'],
  ['Bulgaria', 'BGR', 'BG', 'Bulgaria', 'Bulgaria', 'Sofia', 'Sofía', 42.698, 23.322, 6.4, 102, 'EU'],
  ['Romania', 'ROU', 'RO', 'Romania', 'Rumanía', 'Bucharest', 'Bucarest', 44.427, 26.103, 19.0, 351, 'EU'],
  ['Moldova', 'MDA', 'MD', 'Moldova', 'Moldavia', 'Chișinău', 'Chisináu', 47.011, 28.863, 2.5, 16, 'EU'],
  ['Ukraine', 'UKR', 'UA', 'Ukraine', 'Ucrania', 'Kyiv', 'Kiev', 50.450, 30.523, 37.0, 179, 'EU'],
  ['Belarus', 'BLR', 'BY', 'Belarus', 'Bielorrusia', 'Minsk', 'Minsk', 53.904, 27.562, 9.2, 72, 'EU'],
  ['Russia', 'RUS', 'RU', 'Russia', 'Rusia', 'Moscow', 'Moscú', 55.756, 37.617, 144.0, 2020, 'EU'],
  ['Cyprus', 'CYP', 'CY', 'Cyprus', 'Chipre', 'Nicosia', 'Nicosia', 35.186, 33.382, 1.26, 32, 'EU'],
  ['Jersey', 'JEY', 'JE', 'Jersey', 'Jersey', 'Saint Helier', 'Saint Helier', 49.186, -2.107, 0.1, 6.5, 'EU'],
  ['Guernsey', 'GGY', 'GG', 'Guernsey', 'Guernsey', 'Saint Peter Port', 'Saint Peter Port', 49.456, -2.536, 0.064, 3.5, 'EU'],
  ['Isle of Man', 'IMN', 'IM', 'Isle of Man', 'Isla de Man', 'Douglas', 'Douglas', 54.150, -4.482, 0.084, 7.5, 'EU'],
  // --- Middle East & Caucasus ----------------------------------------------------------------------------
  ['Turkey', 'TUR', 'TR', 'Turkey', 'Turquía', 'Ankara', 'Ankara', 39.934, 32.860, 85.3, 1108, 'ME'],
  ['Georgia', 'GEO', 'GE', 'Georgia', 'Georgia', 'Tbilisi', 'Tiflis', 41.716, 44.783, 3.7, 30, 'ME'],
  ['Armenia', 'ARM', 'AM', 'Armenia', 'Armenia', 'Yerevan', 'Ereván', 40.179, 44.499, 2.8, 24, 'ME'],
  ['Azerbaijan', 'AZE', 'AZ', 'Azerbaijan', 'Azerbaiyán', 'Baku', 'Bakú', 40.409, 49.867, 10.1, 72, 'ME'],
  ['Syria', 'SYR', 'SY', 'Syria', 'Siria', 'Damascus', 'Damasco', 33.513, 36.292, 23.0, 20, 'ME'],
  ['Lebanon', 'LBN', 'LB', 'Lebanon', 'Líbano', 'Beirut', 'Beirut', 33.894, 35.502, 5.4, 18, 'ME'],
  ['Israel', 'ISR', 'IL', 'Israel', 'Israel', 'Jerusalem', 'Jerusalén', 31.769, 35.216, 9.8, 510, 'ME'],
  ['Palestine', 'PSE', 'PS', 'Palestine', 'Palestina', 'Ramallah', 'Ramala', 31.903, 35.204, 5.4, 17, 'ME'],
  ['Jordan', 'JOR', 'JO', 'Jordan', 'Jordania', 'Amman', 'Amán', 31.954, 35.911, 11.3, 51, 'ME'],
  ['Iraq', 'IRQ', 'IQ', 'Iraq', 'Irak', 'Baghdad', 'Bagdad', 33.315, 44.366, 45.5, 250, 'ME'],
  ['Iran', 'IRN', 'IR', 'Iran', 'Irán', 'Tehran', 'Teherán', 35.689, 51.389, 89.2, 404, 'ME'],
  ['Saudi Arabia', 'SAU', 'SA', 'Saudi Arabia', 'Arabia Saudí', 'Riyadh', 'Riad', 24.713, 46.675, 36.9, 1068, 'ME'],
  ['Kuwait', 'KWT', 'KW', 'Kuwait', 'Kuwait', 'Kuwait City', 'Kuwait', 29.376, 47.977, 4.3, 162, 'ME'],
  ['Bahrain', 'BHR', 'BH', 'Bahrain', 'Baréin', 'Manama', 'Manama', 26.228, 50.586, 1.5, 44, 'ME'],
  ['Qatar', 'QAT', 'QA', 'Qatar', 'Catar', 'Doha', 'Doha', 25.285, 51.531, 2.7, 213, 'ME'],
  ['United Arab Emirates', 'ARE', 'AE', 'United Arab Emirates', 'Emiratos Árabes Unidos', 'Abu Dhabi', 'Abu Dabi', 24.453, 54.377, 9.5, 504, 'ME'],
  ['Oman', 'OMN', 'OM', 'Oman', 'Omán', 'Muscat', 'Mascate', 23.588, 58.383, 4.6, 109, 'ME'],
  ['Yemen', 'YEM', 'YE', 'Yemen', 'Yemen', "Sana'a", 'Saná', 15.369, 44.191, 34.4, 21, 'ME'],
  // --- Africa ----------------------------------------------------------------------------------------------
  ['Egypt', 'EGY', 'EG', 'Egypt', 'Egipto', 'Cairo', 'El Cairo', 30.044, 31.236, 112.7, 396, 'AF'],
  ['Libya', 'LBY', 'LY', 'Libya', 'Libia', 'Tripoli', 'Trípoli', 32.887, 13.191, 6.9, 50, 'AF'],
  ['Tunisia', 'TUN', 'TN', 'Tunisia', 'Túnez', 'Tunis', 'Túnez', 36.806, 10.182, 12.4, 48, 'AF'],
  ['Algeria', 'DZA', 'DZ', 'Algeria', 'Argelia', 'Algiers', 'Argel', 36.754, 3.059, 45.6, 240, 'AF'],
  ['Morocco', 'MAR', 'MA', 'Morocco', 'Marruecos', 'Rabat', 'Rabat', 34.021, -6.841, 37.8, 141, 'AF'],
  ['W. Sahara', 'ESH', 'EH', 'Western Sahara', 'Sáhara Occidental', 'Tifariti', 'Tifariti', 26.158, -10.567, 0.1, 0.2, 'AF'],
  ['Mauritania', 'MRT', 'MR', 'Mauritania', 'Mauritania', 'Nouakchott', 'Nuakchot', 18.079, -15.965, 4.9, 10, 'AF'],
  ['Mali', 'MLI', 'ML', 'Mali', 'Malí', 'Bamako', 'Bamako', 12.639, -8.003, 23.3, 21, 'AF'],
  ['Niger', 'NER', 'NE', 'Niger', 'Níger', 'Niamey', 'Niamey', 13.512, 2.113, 27.2, 17, 'AF'],
  ['Chad', 'TCD', 'TD', 'Chad', 'Chad', "N'Djamena", 'Yamena', 12.134, 15.056, 18.3, 13, 'AF'],
  ['Sudan', 'SDN', 'SD', 'Sudan', 'Sudán', 'Khartoum', 'Jartum', 15.501, 32.560, 48.1, 30, 'AF'],
  ['S. Sudan', 'SSD', 'SS', 'South Sudan', 'Sudán del Sur', 'Juba', 'Yuba', 4.859, 31.571, 11.1, 6, 'AF'],
  ['Eritrea', 'ERI', 'ER', 'Eritrea', 'Eritrea', 'Asmara', 'Asmara', 15.322, 38.925, 3.7, 2.3, 'AF'],
  ['Ethiopia', 'ETH', 'ET', 'Ethiopia', 'Etiopía', 'Addis Ababa', 'Adís Abeba', 9.030, 38.740, 126.5, 164, 'AF'],
  ['Djibouti', 'DJI', 'DJ', 'Djibouti', 'Yibuti', 'Djibouti', 'Yibuti', 11.589, 43.145, 1.1, 4, 'AF'],
  ['Somalia', 'SOM', 'SO', 'Somalia', 'Somalia', 'Mogadishu', 'Mogadiscio', 2.047, 45.318, 18.1, 11, 'AF'],
  ['Kenya', 'KEN', 'KE', 'Kenya', 'Kenia', 'Nairobi', 'Nairobi', -1.292, 36.822, 55.1, 108, 'AF'],
  ['Uganda', 'UGA', 'UG', 'Uganda', 'Uganda', 'Kampala', 'Kampala', 0.348, 32.582, 48.6, 49, 'AF'],
  ['Rwanda', 'RWA', 'RW', 'Rwanda', 'Ruanda', 'Kigali', 'Kigali', -1.944, 30.062, 14.1, 14, 'AF'],
  ['Burundi', 'BDI', 'BI', 'Burundi', 'Burundi', 'Gitega', 'Gitega', -3.428, 29.925, 13.2, 3.3, 'AF'],
  ['Tanzania', 'TZA', 'TZ', 'Tanzania', 'Tanzania', 'Dodoma', 'Dodoma', -6.163, 35.752, 67.4, 79, 'AF'],
  ['Senegal', 'SEN', 'SN', 'Senegal', 'Senegal', 'Dakar', 'Dakar', 14.716, -17.467, 17.8, 31, 'AF'],
  ['Gambia', 'GMB', 'GM', 'Gambia', 'Gambia', 'Banjul', 'Banjul', 13.454, -16.579, 2.8, 2.3, 'AF'],
  ['Guinea-Bissau', 'GNB', 'GW', 'Guinea-Bissau', 'Guinea-Bisáu', 'Bissau', 'Bisáu', 11.864, -15.598, 2.1, 2, 'AF'],
  ['Guinea', 'GIN', 'GN', 'Guinea', 'Guinea', 'Conakry', 'Conakri', 9.642, -13.578, 14.2, 23, 'AF'],
  ['Sierra Leone', 'SLE', 'SL', 'Sierra Leone', 'Sierra Leona', 'Freetown', 'Freetown', 8.484, -13.234, 8.6, 3.8, 'AF'],
  ['Liberia', 'LBR', 'LR', 'Liberia', 'Liberia', 'Monrovia', 'Monrovia', 6.301, -10.797, 5.4, 4.3, 'AF'],
  ["Côte d'Ivoire", 'CIV', 'CI', "Côte d'Ivoire", 'Costa de Marfil', 'Yamoussoukro', 'Yamusukro', 6.827, -5.289, 28.9, 79, 'AF'],
  ['Burkina Faso', 'BFA', 'BF', 'Burkina Faso', 'Burkina Faso', 'Ouagadougou', 'Uagadugú', 12.371, -1.520, 23.3, 20, 'AF'],
  ['Ghana', 'GHA', 'GH', 'Ghana', 'Ghana', 'Accra', 'Acra', 5.604, -0.187, 34.1, 76, 'AF'],
  ['Togo', 'TGO', 'TG', 'Togo', 'Togo', 'Lomé', 'Lomé', 6.131, 1.223, 9.1, 9, 'AF'],
  ['Benin', 'BEN', 'BJ', 'Benin', 'Benín', 'Porto-Novo', 'Porto Novo', 6.497, 2.605, 13.7, 19, 'AF'],
  ['Nigeria', 'NGA', 'NG', 'Nigeria', 'Nigeria', 'Abuja', 'Abuya', 9.077, 7.399, 223.8, 363, 'AF'],
  ['Cameroon', 'CMR', 'CM', 'Cameroon', 'Camerún', 'Yaoundé', 'Yaundé', 3.848, 11.502, 28.6, 48, 'AF'],
  ['Central African Rep.', 'CAF', 'CF', 'Central African Republic', 'República Centroafricana', 'Bangui', 'Bangui', 4.394, 18.558, 5.7, 2.6, 'AF'],
  ['Eq. Guinea', 'GNQ', 'GQ', 'Equatorial Guinea', 'Guinea Ecuatorial', 'Malabo', 'Malabo', 3.750, 8.783, 1.7, 12, 'AF'],
  ['Gabon', 'GAB', 'GA', 'Gabon', 'Gabón', 'Libreville', 'Libreville', 0.416, 9.467, 2.4, 20, 'AF'],
  ['Congo', 'COG', 'CG', 'Congo', 'Congo', 'Brazzaville', 'Brazzaville', -4.263, 15.242, 6.1, 15, 'AF'],
  ['Dem. Rep. Congo', 'COD', 'CD', 'DR Congo', 'RD del Congo', 'Kinshasa', 'Kinsasa', -4.441, 15.266, 102.3, 67, 'AF'],
  ['Angola', 'AGO', 'AO', 'Angola', 'Angola', 'Luanda', 'Luanda', -8.839, 13.289, 36.7, 85, 'AF'],
  ['Zambia', 'ZMB', 'ZM', 'Zambia', 'Zambia', 'Lusaka', 'Lusaka', -15.387, 28.323, 20.6, 28, 'AF'],
  ['Malawi', 'MWI', 'MW', 'Malawi', 'Malaui', 'Lilongwe', 'Lilongüe', -13.963, 33.787, 20.9, 13, 'AF'],
  ['Mozambique', 'MOZ', 'MZ', 'Mozambique', 'Mozambique', 'Maputo', 'Maputo', -25.969, 32.573, 33.9, 21, 'AF'],
  ['Zimbabwe', 'ZWE', 'ZW', 'Zimbabwe', 'Zimbabue', 'Harare', 'Harare', -17.829, 31.053, 16.7, 28, 'AF'],
  ['Botswana', 'BWA', 'BW', 'Botswana', 'Botsuana', 'Gaborone', 'Gaborone', -24.653, 25.906, 2.7, 19, 'AF'],
  ['Namibia', 'NAM', 'NA', 'Namibia', 'Namibia', 'Windhoek', 'Windhoek', -22.560, 17.066, 2.6, 12, 'AF'],
  ['South Africa', 'ZAF', 'ZA', 'South Africa', 'Sudáfrica', 'Pretoria', 'Pretoria', -25.747, 28.188, 60.4, 377, 'AF'],
  ['Lesotho', 'LSO', 'LS', 'Lesotho', 'Lesoto', 'Maseru', 'Maseru', -29.310, 27.478, 2.3, 2.1, 'AF'],
  ['eSwatini', 'SWZ', 'SZ', 'Eswatini', 'Esuatini', 'Mbabane', 'Mbabane', -26.305, 31.137, 1.2, 4.6, 'AF'],
  ['Madagascar', 'MDG', 'MG', 'Madagascar', 'Madagascar', 'Antananarivo', 'Antananarivo', -18.879, 47.508, 30.3, 16, 'AF'],
  ['Comoros', 'COM', 'KM', 'Comoros', 'Comoras', 'Moroni', 'Moroni', -11.702, 43.256, 0.85, 1.3, 'AF'],
  ['Mauritius', 'MUS', 'MU', 'Mauritius', 'Mauricio', 'Port Louis', 'Port Louis', -20.161, 57.501, 1.26, 14, 'AF'],
  ['Seychelles', 'SYC', 'SC', 'Seychelles', 'Seychelles', 'Victoria', 'Victoria', -4.619, 55.452, 0.1, 2.1, 'AF'],
  ['Cabo Verde', 'CPV', 'CV', 'Cape Verde', 'Cabo Verde', 'Praia', 'Praia', 14.933, -23.513, 0.6, 2.6, 'AF'],
  ['São Tomé and Principe', 'STP', 'ST', 'São Tomé and Príncipe', 'Santo Tomé y Príncipe', 'São Tomé', 'Santo Tomé', 0.336, 6.727, 0.23, 0.6, 'AF'],
  ['Saint Helena', 'SHN', 'SH', 'Saint Helena', 'Santa Elena', 'Jamestown', 'Jamestown', -15.925, -5.717, 0.005, 0.03, 'AF'],
  // --- Asia ------------------------------------------------------------------------------------------------
  ['China', 'CHN', 'CN', 'China', 'China', 'Beijing', 'Pekín', 39.904, 116.407, 1410.0, 17790, 'AS'],
  ['Hong Kong', 'HKG', 'HK', 'Hong Kong', 'Hong Kong', 'Hong Kong', 'Hong Kong', 22.320, 114.170, 7.5, 382, 'AS'],
  ['Macao', 'MAC', 'MO', 'Macau', 'Macao', 'Macau', 'Macao', 22.199, 113.544, 0.7, 47, 'AS'],
  ['Taiwan', 'TWN', 'TW', 'Taiwan', 'Taiwán', 'Taipei', 'Taipéi', 25.033, 121.565, 23.9, 756, 'AS'],
  ['Japan', 'JPN', 'JP', 'Japan', 'Japón', 'Tokyo', 'Tokio', 35.690, 139.692, 124.5, 4213, 'AS'],
  ['South Korea', 'KOR', 'KR', 'South Korea', 'Corea del Sur', 'Seoul', 'Seúl', 37.567, 126.978, 51.7, 1710, 'AS'],
  ['North Korea', 'PRK', 'KP', 'North Korea', 'Corea del Norte', 'Pyongyang', 'Pionyang', 39.039, 125.763, 26.2, 28, 'AS'],
  ['Mongolia', 'MNG', 'MN', 'Mongolia', 'Mongolia', 'Ulaanbaatar', 'Ulán Bator', 47.886, 106.906, 3.4, 20, 'AS'],
  ['Kazakhstan', 'KAZ', 'KZ', 'Kazakhstan', 'Kazajistán', 'Astana', 'Astaná', 51.169, 71.449, 19.8, 262, 'AS'],
  ['Uzbekistan', 'UZB', 'UZ', 'Uzbekistan', 'Uzbekistán', 'Tashkent', 'Taskent', 41.300, 69.240, 35.6, 90, 'AS'],
  ['Turkmenistan', 'TKM', 'TM', 'Turkmenistan', 'Turkmenistán', 'Ashgabat', 'Asjabad', 37.960, 58.326, 6.5, 60, 'AS'],
  ['Kyrgyzstan', 'KGZ', 'KG', 'Kyrgyzstan', 'Kirguistán', 'Bishkek', 'Biskek', 42.875, 74.590, 7.0, 13, 'AS'],
  ['Tajikistan', 'TJK', 'TJ', 'Tajikistan', 'Tayikistán', 'Dushanbe', 'Dusambé', 38.560, 68.787, 10.1, 12, 'AS'],
  ['Afghanistan', 'AFG', 'AF', 'Afghanistan', 'Afganistán', 'Kabul', 'Kabul', 34.528, 69.172, 41.5, 14, 'AS'],
  ['Pakistan', 'PAK', 'PK', 'Pakistan', 'Pakistán', 'Islamabad', 'Islamabad', 33.684, 73.048, 240.5, 338, 'AS'],
  ['India', 'IND', 'IN', 'India', 'India', 'New Delhi', 'Nueva Delhi', 28.614, 77.209, 1428.6, 3550, 'AS'],
  ['Nepal', 'NPL', 'NP', 'Nepal', 'Nepal', 'Kathmandu', 'Katmandú', 27.717, 85.324, 30.9, 40, 'AS'],
  ['Bhutan', 'BTN', 'BT', 'Bhutan', 'Bután', 'Thimphu', 'Timbu', 27.473, 89.639, 0.78, 2.9, 'AS'],
  ['Bangladesh', 'BGD', 'BD', 'Bangladesh', 'Bangladés', 'Dhaka', 'Daca', 23.811, 90.413, 173.0, 437, 'AS'],
  ['Sri Lanka', 'LKA', 'LK', 'Sri Lanka', 'Sri Lanka', 'Colombo', 'Colombo', 6.927, 79.861, 22.0, 84, 'AS'],
  ['Maldives', 'MDV', 'MV', 'Maldives', 'Maldivas', 'Malé', 'Malé', 4.175, 73.509, 0.52, 6.6, 'AS'],
  ['Myanmar', 'MMR', 'MM', 'Myanmar', 'Birmania', 'Naypyidaw', 'Naipyidó', 19.763, 96.078, 54.6, 64, 'AS'],
  ['Thailand', 'THA', 'TH', 'Thailand', 'Tailandia', 'Bangkok', 'Bangkok', 13.756, 100.502, 71.8, 515, 'AS'],
  ['Laos', 'LAO', 'LA', 'Laos', 'Laos', 'Vientiane', 'Vientián', 17.975, 102.633, 7.6, 15, 'AS'],
  ['Cambodia', 'KHM', 'KH', 'Cambodia', 'Camboya', 'Phnom Penh', 'Nom Pen', 11.556, 104.928, 16.9, 31, 'AS'],
  ['Vietnam', 'VNM', 'VN', 'Vietnam', 'Vietnam', 'Hanoi', 'Hanói', 21.028, 105.854, 98.9, 430, 'AS'],
  ['Malaysia', 'MYS', 'MY', 'Malaysia', 'Malasia', 'Kuala Lumpur', 'Kuala Lumpur', 3.139, 101.687, 34.3, 400, 'AS'],
  ['Singapore', 'SGP', 'SG', 'Singapore', 'Singapur', 'Singapore', 'Singapur', 1.290, 103.852, 5.9, 501, 'AS'],
  ['Brunei', 'BRN', 'BN', 'Brunei', 'Brunéi', 'Bandar Seri Begawan', 'Bandar Seri Begawan', 4.903, 114.940, 0.45, 15, 'AS'],
  ['Indonesia', 'IDN', 'ID', 'Indonesia', 'Indonesia', 'Jakarta', 'Yakarta', -6.208, 106.846, 277.5, 1371, 'AS'],
  ['Timor-Leste', 'TLS', 'TL', 'East Timor', 'Timor Oriental', 'Dili', 'Dili', -8.556, 125.560, 1.36, 2.2, 'AS'],
  ['Philippines', 'PHL', 'PH', 'Philippines', 'Filipinas', 'Manila', 'Manila', 14.599, 120.984, 117.3, 437, 'AS'],
  ['Br. Indian Ocean Ter.', 'IOT', 'IO', 'British Indian Ocean Territory', 'Territorio Británico del Océano Índico', 'Diego Garcia', 'Diego García', -7.313, 72.411, 0.003, 0.1, 'AS'],
  // --- North America -----------------------------------------------------------------------------------------
  ['United States of America', 'USA', 'US', 'United States', 'Estados Unidos', 'Washington, D.C.', 'Washington D. C.', 38.907, -77.037, 334.9, 27360, 'NA'],
  ['Canada', 'CAN', 'CA', 'Canada', 'Canadá', 'Ottawa', 'Ottawa', 45.421, -75.697, 40.1, 2140, 'NA'],
  ['Mexico', 'MEX', 'MX', 'Mexico', 'México', 'Mexico City', 'Ciudad de México', 19.433, -99.133, 128.5, 1789, 'NA'],
  ['Greenland', 'GRL', 'GL', 'Greenland', 'Groenlandia', 'Nuuk', 'Nuuk', 64.181, -51.694, 0.056, 3.2, 'NA'],
  ['Bermuda', 'BMU', 'BM', 'Bermuda', 'Bermudas', 'Hamilton', 'Hamilton', 32.294, -64.781, 0.064, 7.5, 'NA'],
  ['St. Pierre and Miquelon', 'SPM', 'PM', 'Saint Pierre and Miquelon', 'San Pedro y Miquelón', 'Saint-Pierre', 'San Pedro', 46.779, -56.177, 0.006, 0.2, 'NA'],
  // --- Central America & Caribbean ---------------------------------------------------------------------------
  ['Guatemala', 'GTM', 'GT', 'Guatemala', 'Guatemala', 'Guatemala City', 'Ciudad de Guatemala', 14.634, -90.507, 18.1, 104, 'CA'],
  ['Belize', 'BLZ', 'BZ', 'Belize', 'Belice', 'Belmopan', 'Belmopán', 17.251, -88.759, 0.41, 3.2, 'CA'],
  ['El Salvador', 'SLV', 'SV', 'El Salvador', 'El Salvador', 'San Salvador', 'San Salvador', 13.693, -89.218, 6.3, 34, 'CA'],
  ['Honduras', 'HND', 'HN', 'Honduras', 'Honduras', 'Tegucigalpa', 'Tegucigalpa', 14.072, -87.192, 10.6, 34, 'CA'],
  ['Nicaragua', 'NIC', 'NI', 'Nicaragua', 'Nicaragua', 'Managua', 'Managua', 12.115, -86.236, 7.0, 17, 'CA'],
  ['Costa Rica', 'CRI', 'CR', 'Costa Rica', 'Costa Rica', 'San José', 'San José', 9.928, -84.091, 5.2, 86, 'CA'],
  ['Panama', 'PAN', 'PA', 'Panama', 'Panamá', 'Panama City', 'Ciudad de Panamá', 8.983, -79.520, 4.5, 83, 'CA'],
  ['Cuba', 'CUB', 'CU', 'Cuba', 'Cuba', 'Havana', 'La Habana', 23.113, -82.366, 11.1, 107, 'CA'],
  ['Jamaica', 'JAM', 'JM', 'Jamaica', 'Jamaica', 'Kingston', 'Kingston', 17.971, -76.793, 2.8, 19, 'CA'],
  ['Haiti', 'HTI', 'HT', 'Haiti', 'Haití', 'Port-au-Prince', 'Puerto Príncipe', 18.594, -72.307, 11.7, 20, 'CA'],
  ['Dominican Rep.', 'DOM', 'DO', 'Dominican Republic', 'República Dominicana', 'Santo Domingo', 'Santo Domingo', 18.486, -69.931, 11.3, 121, 'CA'],
  ['Puerto Rico', 'PRI', 'PR', 'Puerto Rico', 'Puerto Rico', 'San Juan', 'San Juan', 18.466, -66.106, 3.2, 113, 'CA'],
  ['Bahamas', 'BHS', 'BS', 'Bahamas', 'Bahamas', 'Nassau', 'Nasáu', 25.048, -77.355, 0.41, 14, 'CA'],
  ['Turks and Caicos Is.', 'TCA', 'TC', 'Turks and Caicos Islands', 'Islas Turcas y Caicos', 'Cockburn Town', 'Cockburn Town', 21.462, -71.140, 0.046, 1.4, 'CA'],
  ['Cayman Is.', 'CYM', 'KY', 'Cayman Islands', 'Islas Caimán', 'George Town', 'George Town', 19.293, -81.381, 0.07, 6, 'CA'],
  ['Trinidad and Tobago', 'TTO', 'TT', 'Trinidad and Tobago', 'Trinidad y Tobago', 'Port of Spain', 'Puerto España', 10.654, -61.502, 1.5, 28, 'CA'],
  ['Barbados', 'BRB', 'BB', 'Barbados', 'Barbados', 'Bridgetown', 'Bridgetown', 13.097, -59.618, 0.28, 6.4, 'CA'],
  ['Grenada', 'GRD', 'GD', 'Grenada', 'Granada', "St. George's", 'Saint George', 12.056, -61.749, 0.13, 1.3, 'CA'],
  ['St. Vin. and Gren.', 'VCT', 'VC', 'Saint Vincent and the Grenadines', 'San Vicente y las Granadinas', 'Kingstown', 'Kingstown', 13.160, -61.225, 0.1, 1.1, 'CA'],
  ['Saint Lucia', 'LCA', 'LC', 'Saint Lucia', 'Santa Lucía', 'Castries', 'Castries', 14.010, -60.987, 0.18, 2.4, 'CA'],
  ['Dominica', 'DMA', 'DM', 'Dominica', 'Dominica', 'Roseau', 'Roseau', 15.301, -61.388, 0.073, 0.65, 'CA'],
  ['Antigua and Barb.', 'ATG', 'AG', 'Antigua and Barbuda', 'Antigua y Barbuda', "St. John's", 'Saint John', 17.127, -61.846, 0.094, 2, 'CA'],
  ['St. Kitts and Nevis', 'KNA', 'KN', 'Saint Kitts and Nevis', 'San Cristóbal y Nieves', 'Basseterre', 'Basseterre', 17.302, -62.717, 0.047, 1.1, 'CA'],
  ['Montserrat', 'MSR', 'MS', 'Montserrat', 'Montserrat', 'Brades', 'Brades', 16.792, -62.210, 0.0045, 0.07, 'CA'],
  ['Anguilla', 'AIA', 'AI', 'Anguilla', 'Anguila', 'The Valley', 'The Valley', 18.217, -63.057, 0.016, 0.3, 'CA'],
  ['British Virgin Is.', 'VGB', 'VG', 'British Virgin Islands', 'Islas Vírgenes Británicas', 'Road Town', 'Road Town', 18.428, -64.618, 0.03, 1, 'CA'],
  ['U.S. Virgin Is.', 'VIR', 'VI', 'U.S. Virgin Islands', 'Islas Vírgenes de EE. UU.', 'Charlotte Amalie', 'Charlotte Amalie', 18.342, -64.931, 0.1, 4.4, 'CA'],
  ['St-Martin', 'MAF', 'MF', 'Saint Martin', 'San Martín', 'Marigot', 'Marigot', 18.068, -63.083, 0.032, 0.6, 'CA'],
  ['Sint Maarten', 'SXM', 'SX', 'Sint Maarten', 'Sint Maarten', 'Philipsburg', 'Philipsburg', 18.026, -63.046, 0.044, 1.6, 'CA'],
  ['St-Barthélemy', 'BLM', 'BL', 'Saint Barthélemy', 'San Bartolomé', 'Gustavia', 'Gustavia', 17.897, -62.850, 0.01, 0.4, 'CA'],
  ['Aruba', 'ABW', 'AW', 'Aruba', 'Aruba', 'Oranjestad', 'Oranjestad', 12.524, -70.027, 0.1, 3.5, 'CA'],
  ['Curaçao', 'CUW', 'CW', 'Curaçao', 'Curazao', 'Willemstad', 'Willemstad', 12.108, -68.935, 0.15, 3, 'CA'],
  // --- South America ------------------------------------------------------------------------------------------
  ['Brazil', 'BRA', 'BR', 'Brazil', 'Brasil', 'Brasília', 'Brasilia', -15.794, -47.882, 216.4, 2170, 'SA'],
  ['Argentina', 'ARG', 'AR', 'Argentina', 'Argentina', 'Buenos Aires', 'Buenos Aires', -34.604, -58.382, 46.6, 641, 'SA'],
  ['Chile', 'CHL', 'CL', 'Chile', 'Chile', 'Santiago', 'Santiago de Chile', -33.449, -70.669, 19.6, 335, 'SA'],
  ['Colombia', 'COL', 'CO', 'Colombia', 'Colombia', 'Bogotá', 'Bogotá', 4.711, -74.072, 52.1, 364, 'SA'],
  ['Venezuela', 'VEN', 'VE', 'Venezuela', 'Venezuela', 'Caracas', 'Caracas', 10.481, -66.904, 28.3, 92, 'SA'],
  ['Peru', 'PER', 'PE', 'Peru', 'Perú', 'Lima', 'Lima', -12.046, -77.043, 34.4, 268, 'SA'],
  ['Ecuador', 'ECU', 'EC', 'Ecuador', 'Ecuador', 'Quito', 'Quito', -0.180, -78.468, 18.2, 119, 'SA'],
  ['Bolivia', 'BOL', 'BO', 'Bolivia', 'Bolivia', 'La Paz', 'La Paz', -16.490, -68.119, 12.4, 46, 'SA'],
  ['Paraguay', 'PRY', 'PY', 'Paraguay', 'Paraguay', 'Asunción', 'Asunción', -25.264, -57.576, 6.9, 43, 'SA'],
  ['Uruguay', 'URY', 'UY', 'Uruguay', 'Uruguay', 'Montevideo', 'Montevideo', -34.901, -56.164, 3.4, 77, 'SA'],
  ['Guyana', 'GUY', 'GY', 'Guyana', 'Guyana', 'Georgetown', 'Georgetown', 6.801, -58.155, 0.81, 17, 'SA'],
  ['Suriname', 'SUR', 'SR', 'Suriname', 'Surinam', 'Paramaribo', 'Paramaribo', 5.852, -55.204, 0.62, 3.5, 'SA'],
  ['Falkland Is.', 'FLK', 'FK', 'Falkland Islands', 'Islas Malvinas', 'Stanley', 'Puerto Argentino', -51.697, -57.852, 0.0037, 0.2, 'SA'],
  ['S. Geo. and the Is.', 'SGS', 'GS', 'South Georgia', 'Georgia del Sur', 'King Edward Point', 'Grytviken', -54.283, -36.494, 0.00003, 0.01, 'SA'],
  // --- Oceania ------------------------------------------------------------------------------------------------
  ['Australia', 'AUS', 'AU', 'Australia', 'Australia', 'Canberra', 'Canberra', -35.281, 149.130, 26.6, 1724, 'OC'],
  ['New Zealand', 'NZL', 'NZ', 'New Zealand', 'Nueva Zelanda', 'Wellington', 'Wellington', -41.287, 174.776, 5.2, 253, 'OC'],
  ['Papua New Guinea', 'PNG', 'PG', 'Papua New Guinea', 'Papúa Nueva Guinea', 'Port Moresby', 'Port Moresby', -9.443, 147.180, 10.3, 31, 'OC'],
  ['Fiji', 'FJI', 'FJ', 'Fiji', 'Fiyi', 'Suva', 'Suva', -18.142, 178.442, 0.93, 5.4, 'OC'],
  ['Solomon Is.', 'SLB', 'SB', 'Solomon Islands', 'Islas Salomón', 'Honiara', 'Honiara', -9.433, 159.950, 0.72, 1.6, 'OC'],
  ['Vanuatu', 'VUT', 'VU', 'Vanuatu', 'Vanuatu', 'Port Vila', 'Port Vila', -17.734, 168.322, 0.33, 1.1, 'OC'],
  ['New Caledonia', 'NCL', 'NC', 'New Caledonia', 'Nueva Caledonia', 'Nouméa', 'Numea', -22.276, 166.458, 0.27, 10, 'OC'],
  ['Samoa', 'WSM', 'WS', 'Samoa', 'Samoa', 'Apia', 'Apia', -13.834, -171.760, 0.22, 0.9, 'OC'],
  ['American Samoa', 'ASM', 'AS', 'American Samoa', 'Samoa Americana', 'Pago Pago', 'Pago Pago', -14.276, -170.702, 0.045, 0.87, 'OC'],
  ['Tonga', 'TON', 'TO', 'Tonga', 'Tonga', "Nuku'alofa", 'Nukualofa', -21.139, -175.204, 0.1, 0.5, 'OC'],
  ['Kiribati', 'KIR', 'KI', 'Kiribati', 'Kiribati', 'South Tarawa', 'Tarawa Sur', 1.329, 172.979, 0.13, 0.28, 'OC'],
  ['Micronesia', 'FSM', 'FM', 'Micronesia', 'Micronesia', 'Palikir', 'Palikir', 6.917, 158.158, 0.11, 0.46, 'OC'],
  ['Marshall Is.', 'MHL', 'MH', 'Marshall Islands', 'Islas Marshall', 'Majuro', 'Majuro', 7.090, 171.380, 0.04, 0.28, 'OC'],
  ['Palau', 'PLW', 'PW', 'Palau', 'Palaos', 'Ngerulmud', 'Melekeok', 7.500, 134.624, 0.018, 0.27, 'OC'],
  ['Nauru', 'NRU', 'NR', 'Nauru', 'Nauru', 'Yaren', 'Yaren', -0.547, 166.921, 0.012, 0.15, 'OC'],
  ['Guam', 'GUM', 'GU', 'Guam', 'Guam', 'Hagåtña', 'Agaña', 13.476, 144.749, 0.17, 6.9, 'OC'],
  ['N. Mariana Is.', 'MNP', 'MP', 'Northern Mariana Islands', 'Islas Marianas del Norte', 'Saipan', 'Saipán', 15.212, 145.754, 0.05, 1.2, 'OC'],
  ['Fr. Polynesia', 'PYF', 'PF', 'French Polynesia', 'Polinesia Francesa', 'Papeete', 'Papeete', -17.535, -149.569, 0.28, 6, 'OC'],
  ['Wallis and Futuna Is.', 'WLF', 'WF', 'Wallis and Futuna', 'Wallis y Futuna', 'Mata-Utu', 'Mata-Utu', -13.282, -176.176, 0.011, 0.2, 'OC'],
  ['Cook Is.', 'COK', 'CK', 'Cook Islands', 'Islas Cook', 'Avarua', 'Avarua', -21.207, -159.775, 0.017, 0.3, 'OC'],
  ['Niue', 'NIU', 'NU', 'Niue', 'Niue', 'Alofi', 'Alofi', -19.055, -169.918, 0.0016, 0.01, 'OC'],
  ['Pitcairn Is.', 'PCN', 'PN', 'Pitcairn Islands', 'Islas Pitcairn', 'Adamstown', 'Adamstown', -25.066, -130.101, 0.00005, 0.001, 'OC'],
  ['Norfolk Island', 'NFK', 'NF', 'Norfolk Island', 'Isla Norfolk', 'Kingston', 'Kingston', -29.056, 167.959, 0.002, 0.01, 'OC'],
  ['Indian Ocean Ter.', 'CXR', 'CX', 'Christmas Island', 'Isla de Navidad', 'Flying Fish Cove', 'Flying Fish Cove', -10.421, 105.679, 0.002, 0.01, 'OC'],
  ['Ashmore and Cartier Is.', 'AUS', 'AU', 'Ashmore and Cartier Islands', 'Islas Ashmore y Cartier', 'West Island', 'Isla Oeste', -12.258, 123.041, 0, 0, 'OC'],
  ['Heard I. and McDonald Is.', 'HMD', 'HM', 'Heard and McDonald Islands', 'Islas Heard y McDonald', 'Atlas Cove', 'Atlas Cove', -53.019, 73.393, 0, 0, 'OC'],
  ['Fr. S. Antarctic Lands', 'ATF', 'TF', 'French Southern Lands', 'Tierras Australes Francesas', 'Port-aux-Français', 'Port-aux-Français', -49.350, 70.219, 0.0001, 0.01, 'AF'],
];

/** Features merged into another (internationally recognised) country. */
export const MERGE: Record<string, string> = {
  Somaliland: 'Somalia',
  'N. Cyprus': 'Cyprus',
};

/** Features that never become countries. */
export const DROP = new Set<string>(['Antarctica', 'Siachen Glacier']);

export const COUNTRY_ROWS: CountryRow[] = RAW.map((r) => ({
  ne: r[0], iso3: r[1], iso2: r[2], en: r[3], es: r[4], capEn: r[5], capEs: r[6], lat: r[7], lon: r[8], pop: r[9], gdp: r[10],
  region: R[r[11]],
}));

const BY_NE = new Map<string, CountryRow>(COUNTRY_ROWS.map((c) => [c.ne, c]));

export function countryRowByNeName(name: string): CountryRow | undefined {
  return BY_NE.get(name);
}

/**
 * Geopolitical weight 0..1 blending population and GDP on log scales (China/USA ~1, Spain ~0.5, micro-states ~0.05).
 * Used by AI nation selection and starting bonuses.
 */
export function countryWeight(pop: number, gdp: number): number {
  const p = Math.log10(1 + Math.max(0, pop)) / Math.log10(1 + 1430);
  const g = Math.log10(1 + Math.max(0, gdp)) / Math.log10(1 + 27400);
  const w = Math.pow(Math.max(0, 0.5 * p + 0.5 * g), 1.5);
  return Math.round(Math.min(1, w) * 1000) / 1000;
}

/**
 * Signature colors (flag / board-game conventions) for the big players; the palette pass picks the nearest free
 * palette color that stays distinct from the neighbours.
 */
export const PREFERRED_COLORS: Record<string, number> = {
  USA: 0x2f6fd6, CAN: 0xd8342f, MEX: 0x1f9e5a, BRA: 0x2bb34a, ARG: 0x63b8f0, CHL: 0xc0283a, COL: 0xf2c230, PER: 0xc2185b,
  VEN: 0xf5a524, GBR: 0xd62839, FRA: 0x3a7bd5, DEU: 0x3d3d45, ESP: 0xe0312f, PRT: 0x0f7a3e, ITA: 0x2ea44f, NLD: 0xf28c28,
  BEL: 0xf2c14e, CHE: 0xb3202b, AUT: 0xe05780, POL: 0xd63aaf, SWE: 0xf2c14e, NOR: 0x9b2335, FIN: 0x4ea8de, DNK: 0xcc3344,
  RUS: 0x8e3b8a, UKR: 0xf5c518, TUR: 0xd7263d, GRC: 0x3fa7f5, ROU: 0x2e5eaa, CHN: 0xc62828, JPN: 0xff3864, KOR: 0x3d8bfd,
  PRK: 0x8b1e2d, IND: 0xf57c1f, PAK: 0x0f6b3a, IRN: 0x1b998b, IRQ: 0x7a7a52, SAU: 0x137a3b, EGY: 0xc9a227, ISR: 0x4f7fd9,
  NGA: 0x2bb673, ZAF: 0x167d6b, ETH: 0x9bc53d, KEN: 0x8c2a2a, DZA: 0x0f8a4d, MAR: 0xb23a48, AUS: 0xf2a900, NZL: 0x5fe0a0,
  IDN: 0xe4572e, THA: 0x3a2f8f, VNM: 0xdb2b39, PHL: 0x2350a8, KAZ: 0x22c1c3, MNG: 0x2f5fa7, AFG: 0x4b4b4b, UZB: 0x3fc1c9,
  CUB: 0x2d4fa0, IRL: 0x38b000, ISL: 0x2c4fa3, HUN: 0x436f38, CZE: 0x3b5ba5, SRB: 0xa33b3b, BLR: 0xb8323f, SYR: 0x7d8a8a,
};
