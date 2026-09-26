// FRONT ULTRA — world places for alerts, fronts and names (DESIGN_V2 §8.4, §14.9; owner: data, built by W3).
// Worker-safe, hand-curated. Every national capital comes from the country catalog (rank 1); the table below adds
// the major cities, regional capitals and strategic ports a war report would name (rank 2 = large city or regional
// capital, rank 3 = notable town, port or strait). Coordinates are accurate to about 0.05°.

import { COUNTRY_ROWS } from './countries';

export interface Place {
  nameEs: string;
  nameEn: string;
  lat: number;
  lon: number;
  iso3: string;
  /** 1 = national capital, 2 = major city, 3 = notable town or port. */
  rank: number;
}

// "Español|English|lat|lon|ISO3|rank" (English omitted when identical).
const CITIES = `
Barcelona||41.39|2.17|ESP|2
Valencia||39.47|-0.38|ESP|2
Sevilla|Seville|37.39|-5.98|ESP|2
Bilbao||43.26|-2.93|ESP|2
Zaragoza||41.65|-0.89|ESP|2
Málaga||36.72|-4.42|ESP|2
La Coruña|A Coruña|43.36|-8.41|ESP|3
Vigo||42.24|-8.72|ESP|3
Valladolid||41.65|-4.72|ESP|3
Cádiz||36.53|-6.29|ESP|3
Palma||39.57|2.65|ESP|3
Las Palmas||28.12|-15.43|ESP|3
Oporto|Porto|41.15|-8.61|PRT|2
Faro||37.02|-7.93|PRT|3
Lyon||45.76|4.84|FRA|2
Marsella|Marseille|43.30|5.37|FRA|2
Burdeos|Bordeaux|44.84|-0.58|FRA|2
Toulouse||43.60|1.44|FRA|2
Nantes||47.22|-1.55|FRA|2
Estrasburgo|Strasbourg|48.57|7.75|FRA|2
Lille||50.63|3.06|FRA|2
Brest||48.39|-4.49|FRA|3
Niza|Nice|43.70|7.27|FRA|3
Rennes||48.11|-1.68|FRA|3
Hamburgo|Hamburg|53.55|9.99|DEU|2
Múnich|Munich|48.14|11.58|DEU|2
Colonia|Cologne|50.94|6.96|DEU|2
Fráncfort|Frankfurt|50.11|8.68|DEU|2
Stuttgart||48.78|9.18|DEU|2
Dresde|Dresden|51.05|13.74|DEU|2
Leipzig||51.34|12.37|DEU|3
Bremen||53.08|8.80|DEU|3
Hannover||52.37|9.74|DEU|3
Kiel||54.32|10.14|DEU|3
Milán|Milan|45.46|9.19|ITA|2
Nápoles|Naples|40.85|14.27|ITA|2
Turín|Turin|45.07|7.69|ITA|2
Palermo||38.12|13.36|ITA|2
Génova|Genoa|44.41|8.93|ITA|2
Venecia|Venice|45.44|12.33|ITA|2
Florencia|Florence|43.77|11.26|ITA|2
Bari||41.12|16.87|ITA|3
Cagliari||39.22|9.12|ITA|3
Manchester||53.48|-2.24|GBR|2
Birmingham||52.49|-1.89|GBR|2
Glasgow||55.86|-4.25|GBR|2
Edimburgo|Edinburgh|55.95|-3.19|GBR|2
Liverpool||53.41|-2.98|GBR|2
Belfast||54.60|-5.93|GBR|2
Cardiff||51.48|-3.18|GBR|2
Plymouth||50.38|-4.14|GBR|3
Aberdeen||57.15|-2.09|GBR|3
Cork||51.90|-8.47|IRL|3
Róterdam|Rotterdam|51.92|4.48|NLD|2
Amberes|Antwerp|51.22|4.40|BEL|2
Zúrich|Zurich|47.38|8.54|CHE|2
Ginebra|Geneva|46.20|6.14|CHE|2
Salzburgo|Salzburg|47.80|13.04|AUT|3
Cracovia|Kraków|50.06|19.94|POL|2
Gdansk|Gdańsk|54.35|18.65|POL|2
Breslavia|Wrocław|51.11|17.03|POL|2
Poznań||52.41|16.93|POL|3
Brno||49.20|16.61|CZE|3
Košice||48.72|21.26|SVK|3
Cluj-Napoca||46.77|23.60|ROU|2
Constanza|Constanța|44.18|28.65|ROU|2
Iași||47.16|27.59|ROU|3
Varna||43.21|27.91|BGR|2
Plovdiv||42.14|24.75|BGR|3
Salónica|Thessaloniki|40.64|22.94|GRC|2
El Pireo|Piraeus|37.94|23.65|GRC|3
Split||43.51|16.44|HRV|3
Novi Sad||45.27|19.83|SRB|3
Gotemburgo|Gothenburg|57.71|11.97|SWE|2
Malmö||55.60|13.00|SWE|2
Kiruna||67.86|20.23|SWE|3
Bergen||60.39|5.32|NOR|2
Trondheim||63.43|10.40|NOR|3
Tromsø||69.65|18.96|NOR|3
Narvik||68.44|17.43|NOR|3
Turku||60.45|22.27|FIN|3
Oulu||65.01|25.47|FIN|3
Aarhus||56.16|10.20|DNK|3
Tartu||58.38|26.72|EST|3
Kaunas||54.90|23.90|LTU|3
San Petersburgo|Saint Petersburg|59.94|30.31|RUS|2
Nóvgorod|Nizhny Novgorod|56.33|44.00|RUS|2
Kazán|Kazan|55.79|49.11|RUS|2
Samara||53.20|50.15|RUS|2
Volgogrado|Volgograd|48.71|44.51|RUS|2
Rostov del Don|Rostov-on-Don|47.24|39.71|RUS|2
Ekaterimburgo|Yekaterinburg|56.84|60.61|RUS|2
Novosibirsk||55.03|82.92|RUS|2
Omsk||54.99|73.37|RUS|2
Krasnoyarsk||56.01|92.87|RUS|2
Irkutsk||52.29|104.28|RUS|2
Vladivostok||43.12|131.89|RUS|2
Jabárovsk|Khabarovsk|48.48|135.08|RUS|2
Múrmansk|Murmansk|68.97|33.07|RUS|2
Arcángel|Arkhangelsk|64.54|40.54|RUS|3
Kaliningrado|Kaliningrad|54.71|20.51|RUS|2
Sochi||43.60|39.73|RUS|3
Perm||58.01|56.25|RUS|3
Ufá|Ufa|54.74|55.97|RUS|3
Cheliábinsk|Chelyabinsk|55.16|61.40|RUS|3
Tomsk||56.48|84.95|RUS|3
Yakutsk||62.03|129.73|RUS|3
Magadán|Magadan|59.56|150.80|RUS|3
Petropávlovsk|Petropavlovsk-Kamchatsky|53.02|158.65|RUS|3
Norilsk||69.35|88.20|RUS|3
Chitá|Chita|52.03|113.50|RUS|3
Vorónezh|Voronezh|51.67|39.18|RUS|3
Smolensk||54.78|32.05|RUS|3
Járkov|Kharkiv|49.99|36.23|UKR|2
Odesa|Odesa|46.48|30.72|UKR|2
Leópolis|Lviv|49.84|24.03|UKR|2
Dnipró|Dnipro|48.46|35.05|UKR|2
Donetsk||48.02|37.80|UKR|3
Sebastopol|Sevastopol|44.62|33.52|UKR|3
Brest||52.10|23.69|BLR|3
Gómel|Gomel|52.44|30.98|BLR|3
Estambul|Istanbul|41.01|28.98|TUR|2
Esmirna|Izmir|38.42|27.14|TUR|2
Antalya||36.90|30.70|TUR|3
Adana||37.00|35.32|TUR|3
Trebisonda|Trabzon|41.00|39.72|TUR|3
Erzurum||39.90|41.27|TUR|3
Diyarbakır||37.91|40.23|TUR|3
Batumi||41.64|41.64|GEO|3
Gyumri||40.79|43.85|ARM|3
Ganja||40.68|46.36|AZE|3
Almaty||43.24|76.89|KAZ|2
Karagandá|Karaganda|49.81|73.10|KAZ|3
Aktau||43.65|51.17|KAZ|3
Samarcanda|Samarkand|39.65|66.96|UZB|2
Bujará|Bukhara|39.77|64.42|UZB|3
Mazar-i-Sharif||36.71|67.11|AFG|3
Kandahar||31.61|65.71|AFG|2
Herat||34.35|62.20|AFG|3
Karachi||24.86|67.01|PAK|2
Lahore||31.55|74.34|PAK|2
Peshawar||34.01|71.58|PAK|2
Quetta||30.18|66.99|PAK|3
Bombay|Mumbai|19.08|72.88|IND|2
Calcuta|Kolkata|22.57|88.36|IND|2
Chennai||13.08|80.27|IND|2
Bangalore|Bengaluru|12.97|77.59|IND|2
Hyderabad||17.39|78.49|IND|2
Ahmedabad||23.02|72.57|IND|2
Pune||18.52|73.86|IND|3
Jaipur||26.91|75.79|IND|3
Lucknow||26.85|80.95|IND|3
Srinagar||34.08|74.80|IND|3
Guwahati||26.14|91.74|IND|3
Kochi||9.93|76.27|IND|3
Visakhapatnam||17.69|83.22|IND|3
Chittagong|Chattogram|22.36|91.78|BGD|2
Colombo||6.93|79.86|LKA|2
Mandalay||21.96|96.08|MMR|2
Rangún|Yangon|16.87|96.20|MMR|2
Chiang Mai||18.79|98.99|THA|3
Phuket||7.88|98.39|THA|3
Ciudad Ho Chi Minh|Ho Chi Minh City|10.82|106.63|VNM|2
Da Nang||16.05|108.20|VNM|3
Haiphong||20.86|106.68|VNM|3
Siem Riep|Siem Reap|13.36|103.86|KHM|3
Penang||5.41|100.33|MYS|3
Kuching||1.55|110.34|MYS|3
Surabaya||-7.25|112.75|IDN|2
Medan||3.60|98.67|IDN|2
Bandung||-6.92|107.61|IDN|3
Makasar|Makassar|-5.15|119.43|IDN|3
Balikpapan||-1.27|116.83|IDN|3
Denpasar||-8.65|115.22|IDN|3
Jayapura||-2.53|140.72|IDN|3
Cebú|Cebu|10.32|123.89|PHL|2
Davao||7.19|125.46|PHL|2
Shanghái|Shanghai|31.23|121.47|CHN|2
Cantón|Guangzhou|23.13|113.26|CHN|2
Shenzhen||22.54|114.06|CHN|2
Chongqing||29.56|106.55|CHN|2
Chengdu||30.57|104.07|CHN|2
Wuhan||30.59|114.31|CHN|2
Tianjin||39.13|117.20|CHN|2
Xi'an||34.34|108.94|CHN|2
Nankín|Nanjing|32.06|118.80|CHN|2
Hangzhou||30.27|120.16|CHN|2
Shenyang||41.81|123.43|CHN|2
Harbin||45.80|126.53|CHN|2
Dalian||38.91|121.61|CHN|2
Qingdao||36.07|120.38|CHN|2
Xiamen||24.48|118.09|CHN|3
Kunming||25.04|102.71|CHN|2
Lanzhou||36.06|103.83|CHN|3
Urumqi|Ürümqi|43.83|87.62|CHN|2
Kasgar|Kashgar|39.47|75.99|CHN|3
Lhasa||29.65|91.11|CHN|3
Hohhot||40.84|111.75|CHN|3
Hong Kong||22.32|114.17|CHN|2
Haikou||20.04|110.35|CHN|3
Busan||35.18|129.08|KOR|2
Incheon||37.46|126.71|KOR|3
Chongjin||41.80|129.78|PRK|3
Osaka|Osaka|34.69|135.50|JPN|2
Nagoya||35.18|136.91|JPN|2
Sapporo||43.06|141.35|JPN|2
Fukuoka||33.59|130.40|JPN|2
Hiroshima||34.39|132.46|JPN|3
Sendai||38.27|140.87|JPN|3
Naha||26.21|127.68|JPN|3
Kaohsiung||22.63|120.30|TWN|2
Taichung||24.15|120.67|TWN|3
Erdenet||49.03|104.07|MNG|3
Dubái|Dubai|25.20|55.27|ARE|2
Yeda|Jeddah|21.49|39.19|SAU|2
La Meca|Mecca|21.39|39.86|SAU|2
Medina||24.47|39.61|SAU|3
Dammam||26.43|50.10|SAU|2
Tabuk||28.38|36.57|SAU|3
Basora|Basra|30.51|47.78|IRQ|2
Mosul||36.34|43.13|IRQ|2
Erbil||36.19|44.01|IRQ|3
Alepo|Aleppo|36.20|37.13|SYR|2
Homs||34.73|36.72|SYR|3
Latakia||35.52|35.78|SYR|3
Haifa||32.79|34.99|ISR|3
Tel Aviv||32.09|34.78|ISR|2
Áqaba|Aqaba|29.53|35.01|JOR|3
Isfahán|Isfahan|32.65|51.67|IRN|2
Mashhad||36.30|59.61|IRN|2
Tabriz||38.08|46.29|IRN|2
Shiraz||29.59|52.58|IRN|2
Bandar Abbas||27.18|56.27|IRN|3
Ahvaz||31.32|48.67|IRN|3
Adén|Aden|12.79|45.02|YEM|2
Hodeida|Hodeidah|14.80|42.95|YEM|3
Salalah||17.02|54.09|OMN|3
Alejandría|Alexandria|31.20|29.92|EGY|2
Asuán|Aswan|24.09|32.90|EGY|3
Port Said||31.26|32.30|EGY|3
Suez||29.97|32.53|EGY|3
Bengasi|Benghazi|32.12|20.09|LBY|2
Misrata||32.38|15.09|LBY|3
Sfax||34.74|10.76|TUN|3
Orán|Oran|35.70|-0.63|DZA|2
Constantina|Constantine|36.37|6.61|DZA|3
Casablanca||33.57|-7.59|MAR|2
Tánger|Tangier|35.76|-5.83|MAR|2
Marrakech|Marrakesh|31.63|-8.01|MAR|2
Agadir||30.43|-9.60|MAR|3
El Aaiún|Laayoune|27.15|-13.20|MAR|3
Nuadibú|Nouadhibou|20.94|-17.04|MRT|3
Tombuctú|Timbuktu|16.77|-3.01|MLI|3
Kano||12.00|8.52|NGA|2
Lagos||6.52|3.38|NGA|2
Port Harcourt||4.82|7.03|NGA|3
Ibadán|Ibadan|7.38|3.94|NGA|3
Kumasi||6.69|-1.62|GHA|3
Abiyán|Abidjan|5.36|-4.01|CIV|2
Duala|Douala|4.05|9.77|CMR|2
Puerto Sudán|Port Sudan|19.62|37.22|SDN|3
El Obeid||13.18|30.22|SDN|3
Mombasa||-4.04|39.67|KEN|2
Kisumu||-0.09|34.77|KEN|3
Dar es Salaam||-6.79|39.21|TZA|2
Mogadiscio|Mogadishu|2.05|45.32|SOM|1
Hargeisa||9.56|44.06|SOM|3
Lubumbashi||-11.66|27.48|COD|2
Kisangani||0.52|25.20|COD|3
Goma||-1.68|29.23|COD|3
Pointe-Noire||-4.78|11.86|COG|3
Luanda||-8.84|13.23|AGO|1
Benguela||-12.58|13.41|AGO|3
Beira||-19.84|34.84|MOZ|3
Bulawayo||-20.15|28.58|ZWE|3
Ciudad del Cabo|Cape Town|-33.92|18.42|ZAF|2
Johannesburgo|Johannesburg|-26.20|28.05|ZAF|2
Durban||-29.86|31.02|ZAF|2
Port Elizabeth|Gqeberha|-33.96|25.60|ZAF|3
Walvis Bay||-22.96|14.51|NAM|3
Toamasina||-18.15|49.40|MDG|3
Nueva York|New York|40.71|-74.01|USA|2
Los Ángeles|Los Angeles|34.05|-118.24|USA|2
Chicago||41.88|-87.63|USA|2
Houston||29.76|-95.37|USA|2
Filadelfia|Philadelphia|39.95|-75.17|USA|2
Phoenix||33.45|-112.07|USA|2
San Antonio||29.42|-98.49|USA|3
San Diego||32.72|-117.16|USA|2
Dallas||32.78|-96.80|USA|2
San Francisco||37.77|-122.42|USA|2
Seattle||47.61|-122.33|USA|2
Denver||39.74|-104.99|USA|2
Boston||42.36|-71.06|USA|2
Atlanta||33.75|-84.39|USA|2
Miami||25.76|-80.19|USA|2
Nueva Orleans|New Orleans|29.95|-90.07|USA|2
Detroit||42.33|-83.05|USA|2
Mineápolis|Minneapolis|44.98|-93.27|USA|2
San Luis|St. Louis|38.63|-90.20|USA|3
Kansas City||39.10|-94.58|USA|3
Salt Lake City||40.76|-111.89|USA|3
Las Vegas||36.17|-115.14|USA|3
Portland||45.52|-122.68|USA|3
Norfolk||36.85|-76.29|USA|3
Anchorage||61.22|-149.90|USA|2
Honolulu||21.31|-157.86|USA|2
El Paso||31.76|-106.49|USA|3
Albuquerque||35.08|-106.65|USA|3
Oklahoma City||35.47|-97.52|USA|3
Toronto||43.65|-79.38|CAN|2
Montreal|Montréal|45.50|-73.57|CAN|2
Vancouver||49.28|-123.12|CAN|2
Calgary||51.05|-114.07|CAN|2
Edmonton||53.55|-113.49|CAN|2
Winnipeg||49.90|-97.14|CAN|2
Quebec|Québec|46.81|-71.21|CAN|2
Halifax||44.65|-63.58|CAN|2
Churchill||58.77|-94.16|CAN|3
Yellowknife||62.45|-114.37|CAN|3
Iqaluit||63.75|-68.52|CAN|3
Whitehorse||60.72|-135.06|CAN|3
San Juan de Terranova|St. John's|47.56|-52.71|CAN|3
Guadalajara||20.66|-103.35|MEX|2
Monterrey||25.69|-100.32|MEX|2
Tijuana||32.51|-117.04|MEX|2
Veracruz||19.17|-96.13|MEX|2
Mérida||20.97|-89.62|MEX|3
Chihuahua||28.63|-106.09|MEX|3
Acapulco||16.85|-99.82|MEX|3
Cancún|Cancun|21.16|-86.85|MEX|3
Santiago de Cuba||20.02|-75.82|CUB|3
San Pedro Sula||15.50|-88.03|HND|3
Colón|Colon|9.36|-79.90|PAN|3
Medellín|Medellin|6.24|-75.58|COL|2
Cali||3.45|-76.53|COL|2
Barranquilla||10.96|-74.80|COL|2
Cartagena||10.39|-75.48|COL|3
Maracaibo||10.65|-71.64|VEN|2
Valencia||10.16|-68.01|VEN|3
Ciudad Guayana||8.36|-62.64|VEN|3
Guayaquil||-2.19|-79.89|ECU|2
Arequipa||-16.41|-71.54|PER|2
Trujillo||-8.11|-79.03|PER|3
Iquitos||-3.75|-73.25|PER|3
Cuzco|Cusco|-13.53|-71.97|PER|3
Santa Cruz de la Sierra|Santa Cruz|-17.81|-63.16|BOL|2
São Paulo||-23.55|-46.63|BRA|2
Río de Janeiro|Rio de Janeiro|-22.91|-43.17|BRA|2
Salvador||-12.97|-38.50|BRA|2
Fortaleza||-3.73|-38.52|BRA|2
Belo Horizonte||-19.92|-43.94|BRA|2
Manaos|Manaus|-3.12|-60.02|BRA|2
Recife||-8.05|-34.88|BRA|2
Porto Alegre||-30.03|-51.23|BRA|2
Belém||-1.46|-48.49|BRA|2
Curitiba||-25.43|-49.27|BRA|2
Cuiabá||-15.60|-56.10|BRA|3
Porto Velho||-8.76|-63.90|BRA|3
Campo Grande||-20.47|-54.62|BRA|3
Natal||-5.79|-35.21|BRA|3
Santos||-23.96|-46.33|BRA|3
Córdoba||-31.42|-64.18|ARG|2
Rosario||-32.95|-60.64|ARG|2
Mendoza||-32.89|-68.83|ARG|2
Bahía Blanca||-38.72|-62.27|ARG|3
Mar del Plata||-38.00|-57.56|ARG|3
Comodoro Rivadavia||-45.86|-67.48|ARG|3
Ushuaia||-54.80|-68.30|ARG|3
Salta||-24.78|-65.41|ARG|3
Tucumán|San Miguel de Tucumán|-26.82|-65.22|ARG|3
Valparaíso||-33.05|-71.62|CHL|2
Antofagasta||-23.65|-70.40|CHL|3
Concepción||-36.83|-73.05|CHL|3
Punta Arenas||-53.16|-70.91|CHL|3
Arica||-18.48|-70.31|CHL|3
Ciudad del Este||-25.51|-54.61|PRY|3
Salto||-31.38|-57.96|URY|3
Sídney|Sydney|-33.87|151.21|AUS|2
Melbourne||-37.81|144.96|AUS|2
Brisbane||-27.47|153.03|AUS|2
Perth||-31.95|115.86|AUS|2
Adelaida|Adelaide|-34.93|138.60|AUS|2
Darwin||-12.46|130.84|AUS|2
Hobart||-42.88|147.33|AUS|3
Cairns||-16.92|145.77|AUS|3
Townsville||-19.26|146.82|AUS|3
Alice Springs||-23.70|133.88|AUS|3
Port Hedland||-20.31|118.58|AUS|3
Auckland||-36.85|174.76|NZL|2
Christchurch||-43.53|172.64|NZL|2
Lae||-6.72|146.99|PNG|3
Numea|Nouméa|-22.27|166.44|NCL|3
Nuuk||64.18|-51.72|GRL|1
Reikiavik|Reykjavík|64.15|-21.94|ISL|1
Akureyri||65.68|-18.09|ISL|3
Gibraltar||36.14|-5.35|GBR|3
Estrecho de Ormuz|Strait of Hormuz|26.57|56.25|OMN|3
Canal de Suez|Suez Canal|30.70|32.34|EGY|3
Canal de Panamá|Panama Canal|9.08|-79.68|PAN|3
Estrecho de Malaca|Strait of Malacca|2.50|101.50|MYS|3
Bósforo|Bosphorus|41.12|29.07|TUR|3
`;

function parse(): Place[] {
  const out: Place[] = [];
  for (const c of COUNTRY_ROWS) {
    if (!c.capEn && !c.capEs) continue;
    out.push({ nameEs: c.capEs || c.capEn, nameEn: c.capEn || c.capEs, lat: c.lat, lon: c.lon, iso3: c.iso3, rank: 1 });
  }
  const seen = new Set(out.map((p) => `${p.nameEn}|${p.iso3}`));
  for (const line of CITIES.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const [es, en, lat, lon, iso3, rank] = s.split('|');
    const r = Number(rank);
    if (!(r > 0)) continue;
    const p: Place = { nameEs: es, nameEn: en || es, lat: Number(lat), lon: Number(lon), iso3, rank: r };
    const k = `${p.nameEn}|${p.iso3}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export const PLACES: readonly Place[] = parse();

const RAD = Math.PI / 180;
function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The place nearest to (lat, lon) within `maxKm`, preferring larger places: a capital or a major city a little further
 * away wins over a small town (rank penalty of 30 km per rank step). Null when none is close enough.
 */
export function nearestPlace(lat: number, lon: number, maxKm = 150): (Place & { km: number }) | null {
  let best: Place | null = null, bestScore = Infinity, bestKm = 0;
  const cosLat = Math.cos(lat * RAD);
  const dDeg = maxKm / 111 + 0.5;
  for (const p of PLACES) {
    if (Math.abs(p.lat - lat) > dDeg) continue;
    let dl = Math.abs(p.lon - lon);
    if (dl > 180) dl = 360 - dl;
    if (dl * Math.max(0.05, cosLat) > dDeg) continue;
    const d = km(lat, lon, p.lat, p.lon);
    if (d > maxKm) continue;
    const score = d + (p.rank - 1) * 30;
    if (score < bestScore) {
      bestScore = score;
      best = p;
      bestKm = d;
    }
  }
  return best ? { ...best, km: bestKm } : null;
}

export { km as placeKm };
