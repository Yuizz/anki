// Repaso espaciado SM-2 al estilo Anki. Funciones puras (sin DOM ni almacenamiento).

export const MIN = 60 * 1000;
export const DAY = 24 * 60 * MIN;

export const RATING = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

export const DEFAULTS = {
  learningSteps: [1, 10], // minutos
  relearningSteps: [10], // minutos
  graduatingInterval: 1, // días
  easyInterval: 4, // días
  startingEase: 2.5,
  minEase: 1.3,
  hardFactor: 1.2,
  easyBonus: 1.3,
  lapseFactor: 0.5,
  fuzz: 0.05, // ±5 %
  fuzzMinInterval: 2, // solo se aplica a intervalos > 2 días
  maxInterval: 36500,
  dayCutoffHour: 4, // el día de estudio empieza a las 4:00 AM hora local
  learnAheadMinutes: 20,
};

export function newSchedulingState(cfg = DEFAULTS) {
  return { state: 'new', due: 0, interval: 0, ease: cfg.startingEase, reps: 0, lapses: 0, step: 0 };
}

// ---------- Días de estudio (corte a las 4:00 AM) ----------

export function studyDayStart(now, cutoffHour = DEFAULTS.dayCutoffHour) {
  const d = new Date(now);
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1);
  d.setHours(cutoffHour, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function studyDayEnd(now, cutoffHour = DEFAULTS.dayCutoffHour) {
  return addDays(studyDayStart(now, cutoffHour), 1);
}

export function dayKey(now, cutoffHour = DEFAULTS.dayCutoffHour) {
  const d = new Date(studyDayStart(now, cutoffHour));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- Respuesta ----------

function applyFuzz(ivl, rng, cfg) {
  if (ivl <= cfg.fuzzMinInterval) return ivl;
  const factor = 1 + (rng() * 2 - 1) * cfg.fuzz;
  return Math.max(1, Math.round(ivl * factor));
}

function graduate(c, ivl, now, cfg) {
  const interval = Math.min(cfg.maxInterval, Math.max(1, ivl));
  return { ...c, state: 'review', step: 0, interval, due: addDays(studyDayStart(now, cfg.dayCutoffHour), interval) };
}

function learningAnswer(c, rating, now, cfg, relearn) {
  const steps = relearn ? cfg.relearningSteps : cfg.learningSteps;
  const state = relearn ? 'relearning' : 'learning';
  const step = Math.min(Math.max(0, c.step || 0), steps.length - 1);
  switch (rating) {
    case RATING.AGAIN:
      return { ...c, state, step: 0, due: now + steps[0] * MIN };
    case RATING.HARD: {
      let delay;
      if (steps.length === 1) delay = steps[0] * 1.5;
      else if (step === 0) delay = (steps[0] + steps[1]) / 2;
      else delay = steps[step];
      return { ...c, state, step, due: now + delay * MIN };
    }
    case RATING.GOOD:
      if (step + 1 < steps.length) return { ...c, state, step: step + 1, due: now + steps[step + 1] * MIN };
      return graduate(c, relearn ? Math.max(1, c.interval || 1) : cfg.graduatingInterval, now, cfg);
    case RATING.EASY:
      return graduate(c, relearn ? Math.max(1, c.interval || 1) + 1 : cfg.easyInterval, now, cfg);
    default:
      throw new Error(`Calificación inválida: ${rating}`);
  }
}

function reviewAnswer(c, rating, now, cfg, rng) {
  const ivl = Math.max(1, c.interval || 1);
  const ease = c.ease || cfg.startingEase;
  if (rating === RATING.AGAIN) {
    return {
      ...c,
      state: 'relearning',
      step: 0,
      ease: Math.max(cfg.minEase, ease - 0.2),
      lapses: (c.lapses || 0) + 1,
      interval: Math.max(1, Math.round(ivl * cfg.lapseFactor)),
      due: now + cfg.relearningSteps[0] * MIN,
    };
  }
  // Intervalos sin fuzz; cada botón da al menos un día más que el anterior.
  const hard = Math.max(ivl + 1, Math.round(ivl * cfg.hardFactor));
  const good = Math.max(hard + 1, Math.round(ivl * ease));
  const easy = Math.max(good + 1, Math.round(ivl * ease * cfg.easyBonus));
  let next, newEase;
  if (rating === RATING.HARD) [next, newEase] = [hard, ease - 0.15];
  else if (rating === RATING.GOOD) [next, newEase] = [good, ease];
  else if (rating === RATING.EASY) [next, newEase] = [easy, ease + 0.15];
  else throw new Error(`Calificación inválida: ${rating}`);
  next = Math.min(cfg.maxInterval, applyFuzz(next, rng, cfg));
  return {
    ...c,
    state: 'review',
    step: 0,
    ease: Math.max(cfg.minEase, Math.round(newEase * 100) / 100),
    interval: next,
    due: addDays(studyDayStart(now, cfg.dayCutoffHour), next),
  };
}

/** Devuelve una copia de la tarjeta con el nuevo estado tras calificarla (1–4). */
export function answerCard(card, rating, now = Date.now(), options = {}) {
  const { rng = Math.random, ...over } = options;
  const cfg = { ...DEFAULTS, ...over };
  const c = { ...card, ease: card.ease || cfg.startingEase, reps: (card.reps || 0) + 1 };
  if (c.state === 'review') return reviewAnswer(c, rating, now, cfg, rng);
  return learningAnswer(c, rating, now, cfg, c.state === 'relearning');
}

// ---------- Etiquetas de intervalo ----------

function num(n) {
  const r = Math.round(n * 10) / 10;
  return String(r).replace('.', ',');
}

export function formatDays(days) {
  if (days < 30) return `${Math.round(days)} d`;
  if (days < 365) return `${num(days / 30)} m`;
  return `${num(days / 365)} a`;
}

export function formatMinutes(min) {
  if (min < 1) return '<1 min';
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 1440) return `${num(min / 60)} h`;
  return formatDays(min / 1440);
}

/** Etiqueta del próximo intervalo para cada botón (sin fuzz). */
export function intervalLabels(card, now = Date.now(), options = {}) {
  const out = {};
  for (const r of [1, 2, 3, 4]) {
    const next = answerCard(card, r, now, { ...options, rng: () => 0.5 });
    out[r] = next.state === 'review' ? formatDays(next.interval) : formatMinutes((next.due - now) / MIN);
  }
  return out;
}

// ---------- Cola de estudio ----------

const isLearning = (c) => c.state === 'learning' || c.state === 'relearning';

/** Reparte `b` de forma pareja entre los elementos de `a`. */
export function interleave(a, b) {
  const out = [];
  let ia = 0;
  let ib = 0;
  const na = a.length;
  const nb = b.length;
  while (ia < na || ib < nb) {
    const takeB = ib < nb && (ia >= na || (ib + 1) * (na + 1) <= (ia + 1) * (nb + 1));
    if (takeB) out.push(b[ib++]);
    else out.push(a[ia++]);
  }
  return out;
}

function byDue(a, b) {
  return a.due - b.due || String(a.id).localeCompare(String(b.id));
}

/** Hash estable (FNV-1a) para ordenar las nuevas al azar sin que el orden cambie entre recargas. */
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function byRandom(a, b) {
  return hashStr(String(a.pairId || a.id)) - hashStr(String(b.pairId || b.id)) || (a.dir === 'rev') - (b.dir === 'rev');
}

function byCreated(a, b) {
  return (a.createdAt || 0) - (b.createdAt || 0) || (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id));
}

/**
 * Construye la cola del día.
 * opts: now, newPerDay, reviewsPerDay, newDone, reviewsDone, buried (Set de ids a omitir hoy), cutoffHour,
 * learnAheadMinutes, newOrder ('added' | 'random')
 */
export function buildQueue(cards, opts = {}) {
  const now = opts.now ?? Date.now();
  const cutoff = opts.cutoffHour ?? DEFAULTS.dayCutoffHour;
  const end = studyDayEnd(now, cutoff);
  const buried = opts.buried || new Set();
  const newLeft = Math.max(0, (opts.newPerDay ?? 10) - (opts.newDone || 0));
  const revLeft = Math.max(0, (opts.reviewsPerDay ?? 200) - (opts.reviewsDone || 0));

  const learning = cards.filter(isLearning).sort(byDue);
  const learnDueNow = learning.filter((c) => c.due <= now);
  const learnToday = learning.filter((c) => c.due < end);
  const reviews = cards
    .filter((c) => c.state === 'review' && c.due < end && !buried.has(c.id))
    .sort(byDue)
    .slice(0, revLeft);
  const news = cards
    .filter((c) => (c.state === 'new' || !c.state) && !buried.has(c.id))
    .sort(opts.newOrder === 'random' ? byRandom : byCreated)
    .slice(0, newLeft);
  return { learnDueNow, learnToday, reviews, news, main: interleave(reviews, news) };
}

/** Siguiente tarjeta: aprendizaje vencido → repasos/nuevas intercaladas → aprendizaje adelantado (20 min). */
export function nextCard(cards, opts = {}) {
  const now = opts.now ?? Date.now();
  const q = buildQueue(cards, opts);
  if (q.learnDueNow.length) return q.learnDueNow[0];
  if (q.main.length) return q.main[0];
  const ahead = (opts.learnAheadMinutes ?? DEFAULTS.learnAheadMinutes) * MIN;
  const soon = q.learnToday.find((c) => c.due <= now + ahead);
  return soon || null;
}

/** Contadores para la pantalla de inicio: nuevas, en aprendizaje y por repasar hoy. */
export function countsFor(cards, opts = {}) {
  const q = buildQueue(cards, opts);
  return { new: q.news.length, learning: q.learnToday.length, review: q.reviews.length };
}

/** Racha de días consecutivos con al menos un repaso (hoy o hasta ayer). */
export function streak(dayKeys, todayKey) {
  const set = new Set(dayKeys);
  const prev = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d - 1));
    return dt.toISOString().slice(0, 10);
  };
  let k = set.has(todayKey) ? todayKey : prev(todayKey);
  let n = 0;
  while (set.has(k)) {
    n++;
    k = prev(k);
  }
  return n;
}
