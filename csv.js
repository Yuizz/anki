// Parser CSV (RFC 4180) y conversión a tarjetas. Funciones puras.

export const FIELDS = ['front', 'back', 'type', 'example', 'exampleTranslation'];

export const FIELD_LABELS = {
  front: 'Frente (francés)',
  back: 'Reverso (español)',
  type: 'Tipo',
  example: 'Ejemplo',
  exampleTranslation: 'Traducción del ejemplo',
};

export function stripBOM(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Detecta el separador (coma, tab o punto y coma) contando fuera de comillas en las primeras líneas. */
export function detectDelimiter(text) {
  const candidates = [',', '\t', ';'];
  const counts = { ',': [], '\t': [], ';': [] };
  let inQuotes = false;
  let line = { ',': 0, '\t': 0, ';': 0 };
  let lines = 0;
  for (let i = 0; i < text.length && lines < 20; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      for (const c of candidates) counts[c].push(line[c]);
      line = { ',': 0, '\t': 0, ';': 0 };
      lines++;
    } else if (!inQuotes && ch in line) {
      line[ch]++;
    }
  }
  if (lines < 20) for (const c of candidates) counts[c].push(line[c]);
  // Puntaje: líneas con el separador y consistencia de la cantidad.
  let best = ',';
  let bestScore = -1;
  for (const c of candidates) {
    const arr = counts[c].filter((n, idx) => n > 0 || idx === 0);
    const first = counts[c][0] || 0;
    if (first === 0) continue;
    const consistent = arr.filter((n) => n === first).length;
    const score = consistent * 1000 + first;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** Parsea texto CSV/TSV. Devuelve un arreglo de filas (arreglos de strings). Omite filas vacías. */
export function parseCSV(input, delimiter) {
  const text = stripBOM(String(input));
  const sep = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      field = '';
      inQuotes = true;
      i++;
    } else if (ch === sep) {
      pushField();
      i++;
    } else if (ch === '\r') {
      pushRow();
      i += text[i + 1] === '\n' ? 2 : 1;
    } else if (ch === '\n') {
      pushRow();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) pushRow();
  return { rows, delimiter: sep };
}

export function normalizeHeader(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const HEADER_MAP = {
  frances: 'front',
  french: 'front',
  francais: 'front',
  espanol: 'back',
  spanish: 'back',
  tipo: 'type',
  type: 'type',
  ejemplo: 'example',
  example: 'example',
  ejemploes: 'exampleTranslation',
  ejemplospanish: 'exampleTranslation',
  ejemplotraduccion: 'exampleTranslation',
};

/**
 * Analiza las filas: si el encabezado es el formato principal devuelve
 * { format: 'principal', hasHeader: true, mapping }, si no { format: 'generico', hasHeader: false, mapping: col1→front, col2→back }.
 * mapping: { front: índice, back: índice, type: índice|-1, ... }
 */
export function detectFormat(rows) {
  const header = (rows[0] || []).map(normalizeHeader);
  const mapping = Object.fromEntries(FIELDS.map((f) => [f, -1]));
  header.forEach((h, idx) => {
    const f = HEADER_MAP[h];
    if (f && mapping[f] === -1) mapping[f] = idx;
  });
  if (mapping.front !== -1 && mapping.back !== -1) {
    return { format: 'principal', hasHeader: true, mapping, columns: rows[0].length };
  }
  const columns = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
  return {
    format: 'generico',
    hasHeader: false,
    columns,
    mapping: { front: 0, back: columns > 1 ? 1 : -1, type: -1, example: -1, exampleTranslation: -1 },
  };
}

/** Convierte filas en datos de tarjeta según el mapeo. Omite filas sin frente o sin reverso. */
export function rowsToCards(rows, mapping, hasHeader) {
  const data = hasHeader ? rows.slice(1) : rows;
  const out = [];
  for (const r of data) {
    const card = {};
    for (const f of FIELDS) {
      const idx = mapping[f];
      card[f] = idx != null && idx >= 0 && idx < r.length ? String(r[idx]).trim() : '';
    }
    if (card.front && card.back) out.push(card);
  }
  return out;
}

export function frontKey(s) {
  return String(s || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Separa las tarjetas nuevas de las duplicadas (mismo frente en el mazo o repetido en el archivo). */
export function dedupe(incoming, existingFronts) {
  const seen = new Set([...existingFronts].map(frontKey));
  const toAdd = [];
  let skipped = 0;
  for (const c of incoming) {
    const k = frontKey(c.front);
    if (seen.has(k)) {
      skipped++;
      continue;
    }
    seen.add(k);
    toAdd.push(c);
  }
  return { toAdd, skipped };
}
