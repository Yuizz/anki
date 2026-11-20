// Parser CSV (RFC 4180), detección de formato y exportación. Funciones puras.

export const FIELDS = ['front', 'back', 'type', 'notes', 'example', 'exampleTranslation', 'use'];

export const FIELD_LABELS = {
  front: 'Frente (francés)',
  back: 'Reverso (español)',
  type: 'Tipo',
  notes: 'Notas',
  example: 'Ejemplo',
  exampleTranslation: 'Traducción del ejemplo',
  use: 'Uso (etiqueta del ejemplo)',
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
  let best = ',';
  let bestScore = -1;
  for (const c of candidates) {
    const first = counts[c][0] || 0;
    if (first === 0) continue;
    const consistent = counts[c].filter((n) => n === first).length;
    const score = consistent * 1000 + first;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** Parsea texto CSV/TSV. Devuelve { rows, delimiter }. Omite filas vacías. */
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
    if (!row.every((f) => f.trim() === '')) rows.push(row);
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

const SIMPLE = {
  frances: 'front',
  french: 'front',
  francais: 'front',
  front: 'front',
  espanol: 'back',
  spanish: 'back',
  back: 'back',
  tipo: 'type',
  type: 'type',
  notas: 'notes',
  nota: 'notes',
  notes: 'notes',
};

/** Interpreta un encabezado. Devuelve { field } o { ex: n, part: 'fr'|'es'|'use' } o null. */
export function headerField(raw) {
  const h = normalizeHeader(raw);
  if (SIMPLE[h]) return { field: SIMPLE[h] };
  let m = h.match(/^(?:ejemplo|example)(\d*)(es|traduccion|spanish|espanol)$/);
  if (m) return { ex: Number(m[1] || 1), part: 'es' };
  m = h.match(/^(?:ejemplo|example)(\d*)(?:fr)?$/);
  if (m) return { ex: Number(m[1] || 1), part: 'fr' };
  m = h.match(/^(?:uso|use|sentido|acepcion)(\d*)$/);
  if (m) return { ex: Number(m[1] || 1), part: 'use' };
  return null;
}

const emptyMapping = () => ({ front: -1, back: -1, type: -1, notes: -1, examples: [] });

/**
 * Analiza las filas. Con encabezado reconocido devuelve el formato 'principal' y su mapeo
 * (incluye Ejemplo2, Ejemplo2_ES, Uso2…). Si no, formato 'generico': columna 1 → frente, columna 2 → reverso.
 * mapping: { front, back, type, notes, examples: [{ fr, es, use }] } con índices de columna (o -1).
 */
export function detectFormat(rows) {
  const header = rows[0] || [];
  const mapping = emptyMapping();
  const exByN = new Map();
  header.forEach((raw, idx) => {
    const f = headerField(raw);
    if (!f) return;
    if (f.field) {
      if (mapping[f.field] === -1) mapping[f.field] = idx;
      return;
    }
    if (!exByN.has(f.ex)) exByN.set(f.ex, { fr: -1, es: -1, use: -1 });
    const e = exByN.get(f.ex);
    if (e[f.part] === -1) e[f.part] = idx;
  });
  mapping.examples = [...exByN.keys()].sort((a, b) => a - b).map((n) => exByN.get(n)).filter((e) => e.fr !== -1);
  const columns = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
  if (mapping.front !== -1 && mapping.back !== -1) return { format: 'principal', hasHeader: true, mapping, columns };
  const generic = emptyMapping();
  generic.front = 0;
  generic.back = columns > 1 ? 1 : -1;
  return { format: 'generico', hasHeader: false, mapping: generic, columns };
}

/** Convierte filas en datos de tarjeta. Omite filas sin frente (el reverso se valida al planear la importación). */
export function rowsToCards(rows, mapping, hasHeader) {
  const data = hasHeader ? rows.slice(1) : rows;
  const cell = (r, idx) => (idx != null && idx >= 0 && idx < r.length ? String(r[idx]).trim() : '');
  const out = [];
  for (const r of data) {
    const examples = [];
    for (const m of mapping.examples || []) {
      const fr = cell(r, m.fr);
      if (fr) examples.push({ fr, es: cell(r, m.es), use: cell(r, m.use) });
    }
    const card = {
      front: cell(r, mapping.front),
      back: cell(r, mapping.back),
      type: cell(r, mapping.type),
      notes: cell(r, mapping.notes),
      examples,
      example: examples[0]?.fr || '',
      exampleTranslation: examples[0]?.es || '',
    };
    if (card.front) out.push(card);
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
    if (seen.has(k) || !c.back) {
      skipped++;
      continue;
    }
    seen.add(k);
    toAdd.push(c);
  }
  return { toAdd, skipped };
}

// ---------- Exportación ----------

function quote(v) {
  const s = String(v ?? '');
  return /[",\r\n;\t]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows) {
  return rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}

/** Encabezado del formato 1.1: compatible con el original (Frances,Espanol,Tipo,Ejemplo,Ejemplo_ES). */
export function headerFor(nExamples) {
  const h = ['Frances', 'Espanol', 'Tipo', 'Ejemplo', 'Ejemplo_ES', 'Uso'];
  for (let i = 2; i <= nExamples; i++) h.push(`Ejemplo${i}`, `Ejemplo${i}_ES`, `Uso${i}`);
  h.push('Notas');
  return h;
}

/** Exporta tarjetas (con `examples`) a CSV en el formato 1.1. */
export function cardsToCSV(cards) {
  const n = Math.max(1, ...cards.map((c) => c.examples?.length || 0));
  const rows = [headerFor(n)];
  for (const c of cards) {
    const r = [c.front, c.back, c.type || ''];
    for (let i = 0; i < n; i++) {
      const e = c.examples?.[i];
      r.push(e?.fr || '', e?.es || '', e?.use || '');
    }
    r.push(c.notes || '');
    rows.push(r);
  }
  return toCSV(rows);
}

export const TEMPLATE_CSV = toCSV([
  headerFor(3),
  [
    'le, la, les',
    'el, la, los/las; lo, la, los',
    'artículo / pronombre',
    'Le chat dort sur la chaise.',
    'El gato duerme en la silla.',
    'artículo',
    'Je la vois tous les jours.',
    'La veo todos los días.',
    'pronombre',
    '',
    '',
    '',
    'Delante de vocal: l’',
  ],
  ['être', 'ser, estar', 'verbo', 'Je suis ingénieur.', 'Soy ingeniero.', 'profesión', 'Nous sommes à Paris.', 'Estamos en París.', 'lugar', 'Il est midi.', 'Es mediodía.', 'hora', 'Irregular'],
  ['aujourd’hui', 'hoy', 'adverbio', 'Aujourd’hui, il fait froid.', 'Hoy hace frío.', '', '', '', '', '', '', '', ''],
]);
