// Lookups for AIS codes: flag from the MMSI, ship type, navigation status.

// Flag state from the first three digits of an MMSI (the "MID"), for the common registries.
// Full ITU list: https://www.itu.int/en/ITU-R/terrestrial/fmd/Pages/mid.aspx
const MID = {
  201: 'Albania', 203: 'Austria', 205: 'Belgium', 207: 'Bulgaria', 209: 'Cyprus', 210: 'Cyprus', 212: 'Cyprus',
  211: 'Germany', 218: 'Germany', 215: 'Malta', 229: 'Malta', 248: 'Malta', 249: 'Malta', 256: 'Malta',
  219: 'Denmark', 220: 'Denmark', 224: 'Spain', 225: 'Spain', 226: 'France', 227: 'France', 228: 'France',
  230: 'Finland', 232: 'United Kingdom', 233: 'United Kingdom', 234: 'United Kingdom', 235: 'United Kingdom',
  236: 'Gibraltar', 237: 'Greece', 239: 'Greece', 240: 'Greece', 241: 'Greece', 244: 'Netherlands', 245: 'Netherlands',
  246: 'Netherlands', 247: 'Italy', 250: 'Ireland', 251: 'Iceland', 253: 'Luxembourg', 255: 'Portugal (Madeira)',
  257: 'Norway', 258: 'Norway', 259: 'Norway', 261: 'Poland', 263: 'Portugal', 265: 'Sweden', 266: 'Sweden',
  269: 'Switzerland', 271: 'Türkiye', 272: 'Ukraine', 273: 'Russia', 275: 'Latvia', 276: 'Estonia', 277: 'Lithuania',
  304: 'Antigua and Barbuda', 305: 'Antigua and Barbuda', 308: 'Bahamas', 309: 'Bahamas', 311: 'Bahamas',
  310: 'Bermuda', 316: 'Canada', 319: 'Cayman Islands', 338: 'United States', 366: 'United States',
  367: 'United States', 368: 'United States', 369: 'United States', 345: 'Mexico',
  351: 'Panama', 352: 'Panama', 353: 'Panama', 354: 'Panama', 355: 'Panama', 356: 'Panama', 357: 'Panama',
  370: 'Panama', 371: 'Panama', 372: 'Panama', 373: 'Panama', 374: 'Panama',
  375: 'St Vincent and the Grenadines', 376: 'St Vincent and the Grenadines', 377: 'St Vincent and the Grenadines',
  403: 'Saudi Arabia', 405: 'Bangladesh', 412: 'China', 413: 'China', 414: 'China', 416: 'Taiwan', 419: 'India',
  422: 'Iran', 428: 'Israel', 431: 'Japan', 432: 'Japan', 440: 'South Korea', 441: 'South Korea',
  445: 'North Korea', 447: 'Kuwait', 461: 'Oman', 463: 'Pakistan', 466: 'Qatar', 470: 'United Arab Emirates',
  471: 'United Arab Emirates', 477: 'Hong Kong', 503: 'Australia', 512: 'New Zealand', 525: 'Indonesia',
  533: 'Malaysia', 538: 'Marshall Islands', 548: 'Philippines', 553: 'Papua New Guinea', 563: 'Singapore',
  564: 'Singapore', 565: 'Singapore', 566: 'Singapore', 567: 'Thailand', 574: 'Vietnam', 576: 'Vanuatu',
  577: 'Vanuatu', 620: 'Comoros', 636: 'Liberia', 637: 'Liberia', 657: 'Nigeria', 667: 'Sierra Leone',
  672: 'Tunisia', 677: 'Tanzania', 701: 'Argentina', 710: 'Brazil', 725: 'Chile', 735: 'Ecuador', 760: 'Peru',
};

export function flagFromMmsi(mmsi) {
  const s = String(mmsi);
  if (s.length !== 9) return 'Unknown';
  if (s.startsWith('00')) return 'Coast station';
  if (s.startsWith('111')) return 'SAR aircraft';
  return MID[Number(s.slice(0, 3))] || `Unknown (MID ${s.slice(0, 3)})`;
}

// Ship type groups used for colours and filters.
export const SHIP_GROUPS = {
  cargo: { label: 'Cargo', color: '#46d38a' },
  tanker: { label: 'Tanker', color: '#ff6b5e' },
  passenger: { label: 'Passenger', color: '#5aa9ff' },
  fishing: { label: 'Fishing', color: '#ffb547' },
  service: { label: 'Tugs & service', color: '#e6d45a' },
  leisure: { label: 'Leisure', color: '#c08cff' },
  other: { label: 'Other / unknown', color: '#9aa6b5' },
};

export function shipGroup(type) {
  if (type >= 70 && type <= 79) return 'cargo';
  if (type >= 80 && type <= 89) return 'tanker';
  if (type >= 60 && type <= 69) return 'passenger';
  if (type === 30) return 'fishing';
  if (type === 36 || type === 37) return 'leisure';
  if ((type >= 31 && type <= 35) || (type >= 50 && type <= 59)) return 'service';
  return 'other';
}

const TYPE_NAMES = {
  30: 'Fishing', 31: 'Towing', 32: 'Towing (large)', 33: 'Dredging / underwater ops', 34: 'Diving ops', 35: 'Military ops',
  36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender',
  54: 'Anti-pollution', 55: 'Law enforcement', 58: 'Medical transport', 59: 'Special craft',
};

export function typeName(type) {
  if (!type) return 'Not reported';
  if (TYPE_NAMES[type]) return TYPE_NAMES[type];
  if (type >= 20 && type <= 29) return 'Wing in ground';
  if (type >= 40 && type <= 49) return 'High-speed craft';
  if (type >= 60 && type <= 69) return 'Passenger';
  if (type >= 70 && type <= 79) return 'Cargo';
  if (type >= 80 && type <= 89) return 'Tanker';
  return 'Other';
}

const NAV = [
  'Under way (engine)', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by draught',
  'Moored', 'Aground', 'Fishing', 'Under way (sailing)',
];
export const navStatus = (n) => (n === null || n === undefined ? '—' : NAV[n] || 'Not defined');
