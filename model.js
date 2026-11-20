// Modelo de tarjeta: usos (ejemplos) múltiples, migración y fusión al importar. Funciones puras.

const clean = (s) => String(s ?? '').trim();
const exKey = (s) => clean(s).normalize('NFC').replace(/\s+/g, ' ').toLowerCase();

/** Limpia una lista de usos: { fr, es, use }. Descarta los que no tienen frase en francés y los repetidos. */
export function cleanExamples(list) {
  const out = [];
  const seen = new Set();
  for (const e of list || []) {
    const ex = { fr: clean(e?.fr), es: clean(e?.es), use: clean(e?.use) };
    if (!ex.fr) continue;
    const k = exKey(ex.fr);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ex);
  }
  return out;
}

/** Mantiene `example`/`exampleTranslation` (formato original) sincronizados con el primer uso. */
export function withLegacyFields(card) {
  const first = card.examples[0];
  return { ...card, example: first ? first.fr : '', exampleTranslation: first ? first.es : '' };
}

/** Migra tarjetas del formato 1.0 (un solo ejemplo) al formato con varios usos. */
export function normalizeCard(card) {
  let examples = Array.isArray(card.examples)
    ? card.examples
    : card.example
      ? [{ fr: card.example, es: card.exampleTranslation, use: '' }]
      : [];
  examples = cleanExamples(examples);
  return withLegacyFields({ ...card, notes: card.notes ?? '', examples });
}

/** Elige un uso al azar, evitando repetir el último mostrado si hay más de uno. Devuelve el índice o -1. */
export function pickExample(card, avoid = -1, rng = Math.random) {
  const n = card.examples?.length || 0;
  if (n === 0) return -1;
  if (n === 1) return 0;
  if (avoid < 0 || avoid >= n) return Math.floor(rng() * n);
  const i = Math.floor(rng() * (n - 1));
  return i >= avoid ? i + 1 : i;
}

/**
 * Fusiona los datos de una fila de CSV sobre una tarjeta existente.
 * - Campos de texto: un valor no vacío reemplaza al actual; una celda vacía no borra nada.
 * - Usos: se agregan los nuevos; si la frase ya existe se actualizan su traducción y su etiqueta.
 * Devuelve { card, changed }.
 */
export function mergeIntoCard(card, incoming) {
  const next = { ...card, examples: (card.examples || []).map((e) => ({ ...e })) };
  for (const f of ['back', 'type', 'notes']) {
    const v = clean(incoming[f]);
    if (v && v !== (card[f] || '')) next[f] = v;
  }
  for (const ex of cleanExamples(incoming.examples)) {
    const cur = next.examples.find((e) => exKey(e.fr) === exKey(ex.fr));
    if (!cur) next.examples.push(ex);
    else {
      if (ex.es) cur.es = ex.es;
      if (ex.use) cur.use = ex.use;
    }
  }
  const result = withLegacyFields(next);
  const fields = ['back', 'type', 'notes', 'example', 'exampleTranslation'];
  const changed =
    fields.some((f) => (result[f] || '') !== (card[f] || '')) || JSON.stringify(result.examples) !== JSON.stringify(card.examples || []);
  return { card: result, changed };
}

/**
 * Plan de importación contra las tarjetas existentes del mazo (por frente).
 * mode: 'update' (agrega nuevas y actualiza existentes) | 'add' (solo agrega nuevas).
 * Una fila nueva sin reverso no se puede agregar (invalid); una existente sí se actualiza.
 * Devuelve { toAdd: [datos], toUpdate: [tarjetas fusionadas], unchanged, duplicates, invalid }.
 */
export function planImport(incoming, existing, mode = 'update', keyFn = exKey) {
  const byFront = new Map(existing.map((c) => [keyFn(c.front), c]));
  const seen = new Set();
  const toAdd = [];
  const toUpdate = [];
  let unchanged = 0;
  let duplicates = 0;
  let invalid = 0;
  for (const row of incoming) {
    const k = keyFn(row.front);
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    const cur = byFront.get(k);
    if (!cur) {
      if (String(row.back ?? '').trim()) toAdd.push(row);
      else invalid++;
    }
    else if (mode === 'add') unchanged++;
    else {
      const { card, changed } = mergeIntoCard(cur, row);
      if (changed) toUpdate.push(card);
      else unchanged++;
    }
  }
  return { toAdd, toUpdate, unchanged, duplicates, invalid };
}
