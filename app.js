import * as db from './db.js';
import {
  answerCard,
  intervalLabels,
  nextCard,
  countsFor,
  buildQueue,
  dayKey,
  streak,
  newSchedulingState,
  formatMinutes,
  MIN,
  DAY,
} from './scheduler.js';
import { parseCSV, detectFormat, rowsToCards, frontKey, FIELD_LABELS, cardsToCSV, TEMPLATE_CSV } from './csv.js';
import { normalizeCard, cleanExamples, withLegacyFields, pickExample, planImport } from './model.js';
import { initTTS, speak, hasFrenchVoice, voicesLoaded, frenchVoices, ttsSupported } from './tts.js';
import { icon } from './icons.js';

export const VERSION = '1.1.0';

const DEFAULT_SETTINGS = {
  newPerDay: 10,
  reviewsPerDay: 200,
  newOrder: 'added',
  voiceLang: 'fr-FR',
  voiceURI: '',
  rate: 0.9,
  autoplay: true,
  lastBackup: null,
};

const S = { decks: [], cards: [], logs: [], settings: { ...DEFAULT_SETTINGS } };
let study = null;
let importState = null;
let toastTimer;
let studyTimer;

const app = document.getElementById('app');

// ---------- utilidades ----------

const uid = () =>
  globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const h = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const fmtDate = (ts) => new Date(ts).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });

function downloadFile(name, content, type) {
  const file = new File([content], name, { type });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return file;
}

// ---------- datos ----------

async function loadAll() {
  const [decks, cards, logs, settings] = await Promise.all(['decks', 'cards', 'reviews', 'settings'].map((s) => db.getAll(s)));
  S.decks = decks.sort((a, b) => a.createdAt - b.createdAt);
  // Migración 1.0 → 1.1: varios usos por tarjeta.
  const migrated = [];
  S.cards = cards.map((c) => {
    if (Array.isArray(c.examples) && c.notes !== undefined) return c;
    const n = normalizeCard(c);
    migrated.push(n);
    return n;
  });
  if (migrated.length) await db.putMany('cards', migrated);
  S.logs = logs.sort((a, b) => a.time - b.time);
  S.settings = { ...DEFAULT_SETTINGS };
  for (const { key, value } of settings) S.settings[key] = value;
}

async function setSetting(key, value) {
  S.settings[key] = value;
  await db.put('settings', { key, value });
}

const deckById = (id) => S.decks.find((d) => d.id === id);
const cardsOf = (deckId) => S.cards.filter((c) => c.deckId === deckId);
const forwardCardsOf = (deckId) => cardsOf(deckId).filter((c) => c.dir !== 'rev');
const siblingsOf = (card) => S.cards.filter((c) => c.id === card.id || c.pairId === card.id);

function studyCardsOf(deck) {
  const dir = deck.direction || 'fr-es';
  return cardsOf(deck.id).filter((c) => {
    const d = c.dir || 'fwd';
    return dir === 'both' || (dir === 'fr-es' ? d === 'fwd' : d === 'rev');
  });
}

const CONTENT = ['front', 'back', 'type', 'notes', 'examples', 'example', 'exampleTranslation'];

function makeCard(deckId, fields, extra = {}) {
  return normalizeCard({
    id: uid(),
    deckId,
    front: fields.front || '',
    back: fields.back || '',
    type: fields.type || '',
    notes: fields.notes || '',
    examples: fields.examples || [],
    createdAt: Date.now(),
    dir: 'fwd',
    ...newSchedulingState(),
    ...extra,
  });
}

function reverseOf(card) {
  return makeCard(card.deckId, card, { dir: 'rev', pairId: card.id, createdAt: card.createdAt, order: card.order });
}

/** Copia el contenido de una tarjeta a ella y a su hermana inversa (sin tocar el progreso). */
function contentUpdates(card) {
  return siblingsOf(card).map((c) => {
    const next = { ...c };
    for (const f of CONTENT) next[f] = card[f];
    return next;
  });
}

function replaceInMemory(cards) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  S.cards = S.cards.map((c) => byId.get(c.id) || c);
}

async function addCards(deck, fieldsList) {
  const now = Date.now();
  const cards = [];
  fieldsList.forEach((f, i) => {
    const c = makeCard(deck.id, f, { createdAt: now, order: i + (deck.nextOrder || 0) });
    cards.push(c);
    if ((deck.direction || 'fr-es') !== 'fr-es') cards.push(reverseOf(c));
  });
  deck.nextOrder = (deck.nextOrder || 0) + fieldsList.length;
  await db.batch([
    { store: 'cards', put: cards },
    { store: 'decks', put: [deck] },
  ]);
  S.cards.push(...cards);
}

async function createDeck(name) {
  const deck = { id: uid(), name: name.trim() || 'Mazo', direction: 'fr-es', createdAt: Date.now(), nextOrder: 0 };
  await db.put('decks', deck);
  S.decks.push(deck);
  return deck;
}

async function setDirection(deck, direction) {
  deck.direction = direction;
  const toAdd = [];
  if (direction !== 'fr-es') {
    const revOf = new Set(cardsOf(deck.id).filter((c) => c.dir === 'rev').map((c) => c.pairId));
    for (const c of forwardCardsOf(deck.id)) if (!revOf.has(c.id)) toAdd.push(reverseOf(c));
  }
  await db.batch([
    { store: 'decks', put: [deck] },
    { store: 'cards', put: toAdd },
  ]);
  S.cards.push(...toAdd);
}

function todayLogs() {
  const k = dayKey(Date.now());
  return S.logs.filter((l) => l.dayKey === k);
}

function queueOpts(deck) {
  const today = todayLogs().filter((l) => l.deckId === deck.id);
  const firstToday = new Map();
  for (const l of today) if (!firstToday.has(l.cardId)) firstToday.set(l.cardId, l.prevState);
  let newDone = 0;
  let reviewsDone = 0;
  for (const st of firstToday.values()) {
    if (st === 'new') newDone++;
    else if (st === 'review') reviewsDone++;
  }
  // La otra dirección de una palabra ya vista hoy se deja para mañana.
  const buried = new Set();
  const byId = new Map();
  const revByPair = new Map();
  for (const c of S.cards) {
    byId.set(c.id, c);
    if (c.pairId) revByPair.set(c.pairId, c.id);
  }
  for (const l of today) {
    const c = byId.get(l.cardId);
    if (!c) continue;
    if (c.pairId) buried.add(c.pairId);
    else if (revByPair.has(c.id)) buried.add(revByPair.get(c.id));
  }
  for (const id of firstToday.keys()) buried.delete(id);
  return {
    now: Date.now(),
    newPerDay: Number(S.settings.newPerDay),
    reviewsPerDay: Number(S.settings.reviewsPerDay),
    newOrder: S.settings.newOrder,
    newDone,
    reviewsDone,
    buried,
  };
}

// ---------- router ----------

function route() {
  const hash = location.hash || '#/';
  const [, view, id] = hash.split('/');
  clearTimeout(studyTimer);
  if (view !== 'estudiar') study = null;
  document.body.dataset.view = view || 'inicio';
  if (view === 'estudiar' && id) return renderStudy(id);
  if (view === 'mazo' && id) return renderDeck(id);
  if (view === 'ajustes') return renderSettings();
  if (view === 'importar') return renderImport();
  return renderHome();
}

const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

function topbar(title, { back, right = '', large = false } = {}) {
  return `<header class="topbar ${large ? 'large' : ''}">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Volver">${icon('back')}</a>` : ''}
    <h1>${h(title)}</h1>
    <div class="topbar-right">${right}</div>
  </header>`;
}

const CSV_ACCEPT = '.csv,.tsv,text/csv,text/plain,text/tab-separated-values';

function csvButton(label = 'Importar CSV', deckId = '', cls = '') {
  return `<label class="btn ${cls}">${icon('upload')}<span>${h(label)}</span><input class="file-input" type="file" accept="${CSV_ACCEPT}" data-change="csv-file" data-deck="${h(deckId)}"></label>`;
}

function banner(text, kind = 'warn') {
  return `<div class="banner ${kind}">${icon(kind === 'warn' ? 'alert' : 'info')}<div>${text}</div></div>`;
}

const noVoiceWarning = () =>
  banner('No hay voces en francés. Instala una en Ajustes → Accesibilidad → Contenido leído → Voces.');

// ---------- Inicio ----------

function backupWarning() {
  if (!S.cards.length) return '';
  const last = S.settings.lastBackup;
  const ref = last || Math.min(...S.cards.map((c) => c.createdAt || Date.now()));
  if (Date.now() - ref < 14 * DAY) return '';
  const msg = last ? `Tu último respaldo fue hace ${Math.floor((Date.now() - last) / DAY)} días.` : 'Todavía no has hecho un respaldo.';
  return banner(`${msg} Todo vive solo en este teléfono: <a href="#/ajustes">exporta un respaldo</a>.`);
}

function deckStats(d) {
  const c = countsFor(studyCardsOf(d), queueOpts(d));
  const fwd = forwardCardsOf(d.id);
  const learned = fwd.filter((x) => x.state === 'review').length;
  return { c, total: fwd.length, learned, pct: fwd.length ? Math.round((learned / fwd.length) * 100) : 0 };
}

function countPills(c, cur = '') {
  return `<div class="pills">
    <span class="pill new ${cur === 'new' ? 'cur' : ''}"><b>${c.new}</b> nuevas</span>
    <span class="pill learn ${cur === 'learn' ? 'cur' : ''}"><b>${c.learning}</b> aprendiendo</span>
    <span class="pill rev ${cur === 'rev' ? 'cur' : ''}"><b>${c.review}</b> repaso</span>
  </div>`;
}

function renderHome() {
  const logs = todayLogs();
  const keys = [...new Set(S.logs.map((l) => l.dayKey))];
  const st = streak(keys, dayKey(Date.now()));
  const date = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
  const decks = S.decks
    .map((d) => {
      const { c, total, learned, pct } = deckStats(d);
      const pending = c.new + c.learning + c.review;
      return `<li class="deck">
        <a class="deck-main" href="#/mazo/${d.id}" aria-label="Abrir mazo ${h(d.name)}">
          <div class="deck-head"><span class="deck-name">${h(d.name)}</span>${icon('chevron', 'muted-ic')}</div>
          <div class="deck-meta">${plural(total, 'palabra', 'palabras')} · ${learned} ${learned === 1 ? 'aprendida' : 'aprendidas'}</div>
          <div class="meter" aria-hidden="true"><span style="width:${pct}%"></span></div>
        </a>
        <div class="deck-foot">
          ${countPills(c)}
          ${
            pending
              ? `<a class="btn primary study-btn" href="#/estudiar/${d.id}">${icon('play')}<span>Estudiar</span></a>`
              : `<a class="btn ghost study-btn" href="#/estudiar/${d.id}">${icon('check')}<span>Al día</span></a>`
          }
        </div>
      </li>`;
    })
    .join('');
  app.innerHTML = `
    ${topbar('Tarjetas', { large: true, right: `<a class="icon-btn" href="#/ajustes" aria-label="Ajustes">${icon('sliders')}</a>` })}
    <main class="content">
      <p class="date">${h(date)}</p>
      <section class="stats" aria-label="Resumen de hoy">
        <div class="stat">${icon('flame')}<div><strong>${st}</strong><span>${st === 1 ? 'día de racha' : 'días de racha'}</span></div></div>
        <div class="stat">${icon('checkCircle')}<div><strong>${new Set(logs.map((l) => l.cardId)).size}</strong><span>tarjetas hoy</span></div></div>
      </section>
      ${backupWarning()}
      <div class="section-head"><h2>Mazos</h2><button class="icon-btn" data-action="new-deck" aria-label="Nuevo mazo">${icon('plus')}</button></div>
      ${
        S.decks.length
          ? `<ul class="decks">${decks}</ul>`
          : `<div class="empty">${icon('cards', 'big-ic')}<p><strong>Aún no tienes mazos</strong></p><p>Importa un CSV desde la app Archivos o crea un mazo y agrega palabras a mano.</p></div>`
      }
      <div class="actions">
        ${csvButton('Importar CSV')}
        <button class="btn" data-action="new-deck">${icon('plus')}<span>Nuevo mazo</span></button>
      </div>
    </main>`;
}

// ---------- Estudio ----------

function setCurrent(card) {
  study.current = card;
  study.showing = false;
  study.exIdx = card ? pickExample(card, card.lastEx ?? -1) : -1;
}

function renderStudy(deckId) {
  const deck = deckById(deckId);
  if (!deck) return go('#/');
  if (!study || study.deckId !== deckId) {
    study = { deckId, current: null, showing: false, undo: [], done: 0, audioUnlocked: false, exIdx: -1 };
  }
  const cards = studyCardsOf(deck);
  const opts = queueOpts(deck);
  const counts = countsFor(cards, opts);
  if (!study.current || !S.cards.includes(study.current)) setCurrent(nextCard(cards, opts));
  const card = study.current;
  const remaining = counts.new + counts.learning + counts.review;
  const pct = study.done + remaining ? Math.round((study.done / (study.done + remaining)) * 100) : 100;
  const kind = card ? (card.state === 'new' ? 'new' : card.state === 'review' ? 'rev' : 'learn') : '';
  const header = `<header class="topbar study-top">
      <a class="icon-btn" href="#/" aria-label="Salir">${icon('close')}</a>
      <div class="study-progress">
        <div class="progress" role="progressbar" aria-label="Progreso de la sesión" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
        ${countPills(counts, kind)}
      </div>
      <button class="icon-btn" data-action="undo" aria-label="Deshacer" ${study.undo.length ? '' : 'disabled'}>${icon('undo')}</button>
    </header>`;

  if (!card) {
    const later = buildQueue(cards, opts).learnToday;
    let extra = '';
    if (later.length) {
      const mins = Math.max(1, Math.ceil((later[0].due - Date.now()) / MIN));
      extra = `<p class="muted">${plural(later.length, 'tarjeta sigue', 'tarjetas siguen')} en aprendizaje. La próxima vuelve en ${formatMinutes(mins)}.</p>
        <button class="btn" data-action="refresh">${icon('reset')}<span>Revisar de nuevo</span></button>`;
      studyTimer = setTimeout(
        () => {
          if (location.hash === `#/estudiar/${deckId}`) renderStudy(deckId);
        },
        Math.min(Math.max(1000, later[0].due - Date.now() - 20 * MIN + 1000), 2 ** 31 - 1),
      );
    }
    app.innerHTML = `${header}<main class="content done">
      <div class="done-box">${icon('checkCircle', 'hero-ic')}<h2>¡Listo por hoy!</h2>
      <p>${h(deck.name)} · ${plural(study.done, 'respuesta', 'respuestas')} en esta sesión.</p>
      ${extra}
      <a class="btn primary" href="#/">Volver al inicio</a></div></main>`;
    return;
  }

  const rev = card.dir === 'rev';
  const question = rev ? card.back : card.front;
  const answer = rev ? card.front : card.back;
  const labels = intervalLabels(card, Date.now());
  const ex = card.examples[study.exIdx];
  const nEx = card.examples.length;
  const speakBtn = (text, label, cls = '') =>
    `<button class="speak ${cls}" data-action="speak" data-text="${h(text)}" aria-label="${label}">${icon('sound')}</button>`;
  const warn = voicesLoaded() && ttsSupported() && !hasFrenchVoice() ? noVoiceWarning() : '';

  app.innerHTML = `${header}
    <main class="study-area" data-action="reveal">
      ${warn}
      <article class="flash ${study.showing ? 'shown' : ''}">
        ${card.type ? `<div class="ftype">${h(card.type)}</div>` : ''}
        <div class="question" ${rev ? '' : 'lang="fr"'}>${h(question)}</div>
        ${!rev ? speakBtn(card.front, 'Escuchar palabra') : ''}
        ${
          study.showing
            ? `<div class="reveal">
                <div class="answer" ${rev ? 'lang="fr"' : ''}>${h(answer)}</div>
                ${rev ? speakBtn(card.front, 'Escuchar palabra') : ''}
                ${
                  ex
                    ? `<div class="usage">
                        <div class="usage-head">
                          <span class="usage-label">${ex.use ? h(ex.use) : nEx > 1 ? `Uso ${study.exIdx + 1}` : 'Ejemplo'}</span>
                          ${nEx > 1 ? `<button class="chip-btn" data-action="next-example" aria-label="Ver otro uso">${icon('shuffle')}<span>${study.exIdx + 1}/${nEx}</span></button>` : ''}
                        </div>
                        <p class="ex-fr" lang="fr">${h(ex.fr)}</p>
                        ${ex.es ? `<p class="ex-es">${h(ex.es)}</p>` : ''}
                        ${speakBtn(ex.fr, 'Escuchar ejemplo', 'small')}
                      </div>`
                    : ''
                }
                ${card.notes ? `<p class="notes">${h(card.notes)}</p>` : ''}
              </div>`
            : `<p class="tap-hint">Toca para ver la respuesta</p>`
        }
      </article>
    </main>
    <footer class="answer-bar">
      ${
        study.showing
          ? `<div class="grades">
              <button class="grade again" data-action="grade" data-r="1"><span>Otra vez</span><small>${labels[1]}</small></button>
              <button class="grade hard" data-action="grade" data-r="2"><span>Difícil</span><small>${labels[2]}</small></button>
              <button class="grade good" data-action="grade" data-r="3"><span>Bien</span><small>${labels[3]}</small></button>
              <button class="grade easy" data-action="grade" data-r="4"><span>Fácil</span><small>${labels[4]}</small></button>
            </div>`
          : `<button class="btn primary wide big" data-action="reveal">Mostrar respuesta</button>`
      }
    </footer>`;

  // Auto-reproducción: solo después del primer toque de la sesión (requisito de iOS).
  if (S.settings.autoplay && study.audioUnlocked && study.autoSpoken !== `${card.id}:${study.showing}`) {
    if ((!rev && !study.showing) || (rev && study.showing)) {
      study.autoSpoken = `${card.id}:${study.showing}`;
      speak(card.front, S.settings);
    }
  }
}

function reveal() {
  if (!study || !study.current || study.showing) return;
  study.showing = true;
  renderStudy(study.deckId);
}

function nextExample() {
  if (!study?.current || study.current.examples.length < 2) return;
  study.exIdx = (study.exIdx + 1) % study.current.examples.length;
  renderStudy(study.deckId);
}

async function grade(rating) {
  if (!study || !study.current || !study.showing) return;
  const card = study.current;
  const now = Date.now();
  const next = { ...answerCard(card, rating, now), lastEx: study.exIdx };
  const log = {
    id: uid(),
    cardId: card.id,
    deckId: card.deckId,
    rating,
    time: now,
    dayKey: dayKey(now),
    prevState: card.state,
    interval: next.interval,
    ease: next.ease,
    before: { ...card },
  };
  await db.batch([
    { store: 'cards', put: [next] },
    { store: 'reviews', put: [log] },
  ]);
  S.cards[S.cards.indexOf(card)] = next;
  S.logs.push(log);
  study.undo.push(log.id);
  study.done++;
  study.current = null;
  renderStudy(study.deckId);
}

async function undo() {
  if (!study || !study.undo.length) return;
  const logId = study.undo.pop();
  const log = S.logs.find((l) => l.id === logId);
  if (!log) return;
  await db.batch([
    { store: 'cards', put: [log.before] },
    { store: 'reviews', del: [logId] },
  ]);
  const idx = S.cards.findIndex((c) => c.id === log.cardId);
  if (idx >= 0) S.cards[idx] = log.before;
  else S.cards.push(log.before);
  S.logs = S.logs.filter((l) => l.id !== logId);
  study.done = Math.max(0, study.done - 1);
  setCurrent(log.before);
  study.showing = true;
  study.autoSpoken = `${log.before.id}:true`;
  renderStudy(study.deckId);
  toast('Respuesta deshecha');
}

// ---------- Mazo ----------

function stateDot(c) {
  const map = { new: ['Nueva', 'new'], learning: ['Aprendiendo', 'learn'], relearning: ['Reaprendiendo', 'learn'], review: ['Repaso', 'rev'] };
  const [t, cls] = map[c.state] || map.new;
  return `<span class="state ${cls}">${t}</span>`;
}

function cardListHTML(deckId, q) {
  const key = frontKey(q);
  const list = forwardCardsOf(deckId)
    .filter((c) => !key || frontKey(`${c.front} ${c.back} ${c.examples.map((e) => `${e.fr} ${e.es}`).join(' ')}`).includes(key))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.order || 0) - (b.order || 0));
  if (!list.length) return `<li class="empty small">${q ? 'Sin resultados.' : 'Este mazo no tiene palabras.'}</li>`;
  return list
    .slice(0, 500)
    .map(
      (c) => `<li><button class="card-row" data-action="edit-card" data-id="${c.id}">
        <span class="cr-front" lang="fr">${h(c.front)}</span>
        <span class="cr-back">${h(c.back)}</span>
        <span class="cr-side">${stateDot(c)}${c.examples.length > 1 ? `<span class="uses">${c.examples.length} usos</span>` : ''}</span>
      </button></li>`,
    )
    .join('');
}

function renderDeck(deckId) {
  const deck = deckById(deckId);
  if (!deck) return go('#/');
  const dir = deck.direction || 'fr-es';
  const { c, total, learned, pct } = deckStats(deck);
  app.innerHTML = `
    ${topbar(deck.name, { back: '#/' })}
    <main class="content">
      <section class="panel summary">
        <div class="summary-top">
          <div><strong class="big-num">${total}</strong> <span class="muted">${total === 1 ? 'palabra' : 'palabras'}</span>
            <div class="muted small">${learned} ${learned === 1 ? 'aprendida' : 'aprendidas'} · ${pct}%</div></div>
          <a class="btn primary" href="#/estudiar/${deck.id}">${icon('play')}<span>Estudiar</span></a>
        </div>
        <div class="meter"><span style="width:${pct}%"></span></div>
        ${countPills(c)}
      </section>

      <section class="group">
        <h2>Agregar y actualizar</h2>
        <div class="list-btns">
          <button class="row-btn" data-action="add-card" data-deck="${deck.id}">${icon('plus')}<span>Agregar palabra</span>${icon('chevron', 'muted-ic')}</button>
          <label class="row-btn">${icon('upload')}<span>Importar o actualizar con CSV</span>${icon('chevron', 'muted-ic')}
            <input class="file-input" type="file" accept="${CSV_ACCEPT}" data-change="csv-file" data-deck="${deck.id}"></label>
          <button class="row-btn" data-action="export-csv" data-id="${deck.id}">${icon('download')}<span>Exportar mazo a CSV</span>${icon('chevron', 'muted-ic')}</button>
        </div>
        <p class="hint">Para editar muchas palabras: exporta el CSV, edítalo en Numbers o Excel y vuelve a importarlo. Las palabras que ya existen se actualizan sin perder tu progreso.</p>
      </section>

      <section class="group">
        <h2>Ajustes del mazo</h2>
        <div class="panel">
          <label class="field"><span>Nombre</span>
            <input type="text" value="${h(deck.name)}" data-change="rename-deck" data-id="${deck.id}" maxlength="80"></label>
          <div class="field"><span>Dirección</span>
            <div class="segmented" role="radiogroup" aria-label="Dirección">
              ${[
                ['fr-es', 'FR → ES'],
                ['es-fr', 'ES → FR'],
                ['both', 'Ambas'],
              ]
                .map(
                  ([v, t]) =>
                    `<label><input type="radio" name="dir" value="${v}" ${dir === v ? 'checked' : ''} data-change="direction" data-id="${deck.id}"><span>${t}</span></label>`,
                )
                .join('')}
            </div>
          </div>
        </div>
      </section>

      <section class="group">
        <h2>Palabras</h2>
        <label class="search">${icon('search')}<span class="sr-only">Buscar</span>
          <input type="search" placeholder="Buscar en ${plural(total, 'palabra', 'palabras')}" data-input="search" data-id="${deck.id}"></label>
        <ul class="card-list" id="card-list">${cardListHTML(deckId, '')}</ul>
      </section>

      <section class="group">
        <div class="list-btns">
          <button class="row-btn" data-action="reset-deck" data-id="${deck.id}">${icon('reset')}<span>Reiniciar progreso</span></button>
          <button class="row-btn danger" data-action="delete-deck" data-id="${deck.id}">${icon('trash')}<span>Borrar mazo</span></button>
        </div>
      </section>
    </main>`;
}

function openDialog(html, onReady) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  onReady?.(dlg);
  return dlg;
}

function usageRow(e = { fr: '', es: '', use: '' }) {
  return `<div class="usage-edit">
    <div class="usage-edit-head"><input type="text" name="use" value="${h(e.use)}" placeholder="Uso (opcional): p. ej. pronombre" aria-label="Etiqueta del uso">
      <button type="button" class="icon-btn" data-dlg="remove-usage" aria-label="Quitar uso">${icon('trash')}</button></div>
    <textarea name="ex-fr" rows="2" placeholder="Frase en francés" lang="fr" aria-label="Frase en francés">${h(e.fr)}</textarea>
    <textarea name="ex-es" rows="2" placeholder="Traducción" aria-label="Traducción">${h(e.es)}</textarea>
  </div>`;
}

function editCard(deckId, cardId) {
  const card = cardId ? S.cards.find((c) => c.id === cardId) : null;
  const v = card || { front: '', back: '', type: '', notes: '', examples: [] };
  const field = (name, label, ta) =>
    `<label class="field"><span>${label}</span>${
      ta ? `<textarea name="${name}" rows="2">${h(v[name])}</textarea>` : `<input type="text" name="${name}" value="${h(v[name])}">`
    }</label>`;
  openDialog(
    `<form method="dialog" class="sheet">
      <div class="sheet-head">
        <button class="text-btn" value="cancel" formnovalidate>Cancelar</button>
        <h2>${card ? 'Editar palabra' : 'Nueva palabra'}</h2>
        <button class="text-btn strong" value="save">Guardar</button>
      </div>
      <div class="sheet-body">
        ${field('front', 'Francés')}
        ${field('back', 'Español')}
        ${field('type', 'Tipo (verbo, sustantivo…)')}
        <div class="field"><span>Usos y ejemplos</span>
          <p class="hint">En cada repaso se muestra uno al azar.</p>
          <div class="usages">${(v.examples.length ? v.examples : [undefined]).map(usageRow).join('')}</div>
          <button type="button" class="btn small" data-dlg="add-usage">${icon('plus')}<span>Agregar uso</span></button>
        </div>
        ${field('notes', 'Notas', true)}
        ${card ? `<button class="btn danger wide" value="delete" formnovalidate>${icon('trash')}<span>Borrar palabra</span></button>` : ''}
      </div>
    </form>`,
    (dlg) => {
      const form = dlg.querySelector('form');
      form.front.required = true;
      form.back.required = true;
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest('[data-dlg]');
        if (!b) return;
        if (b.dataset.dlg === 'add-usage') {
          dlg.querySelector('.usages').insertAdjacentHTML('beforeend', usageRow());
          dlg.querySelector('.usage-edit:last-child textarea').focus();
        } else if (b.dataset.dlg === 'remove-usage') b.closest('.usage-edit').remove();
      });
      form.addEventListener('submit', async (e) => {
        const action = e.submitter?.value;
        if (action === 'cancel') return;
        if (action === 'delete') {
          if (!confirm('¿Borrar esta palabra?')) return e.preventDefault();
          const ids = siblingsOf(card).map((c) => c.id);
          await db.delMany('cards', ids);
          S.cards = S.cards.filter((c) => !ids.includes(c.id));
          toast('Palabra borrada');
          return renderDeck(deckId);
        }
        const examples = cleanExamples(
          [...form.querySelectorAll('.usage-edit')].map((el) => ({
            use: el.querySelector('[name=use]').value,
            fr: el.querySelector('[name=ex-fr]').value,
            es: el.querySelector('[name=ex-es]').value,
          })),
        );
        const data = {
          front: form.front.value.trim(),
          back: form.back.value.trim(),
          type: form.type.value.trim(),
          notes: form.notes.value.trim(),
          examples,
        };
        const dup = forwardCardsOf(deckId).find((c) => c.id !== card?.id && frontKey(c.front) === frontKey(data.front));
        if (dup) {
          e.preventDefault();
          return toast('Ya existe esa palabra en el mazo');
        }
        if (card) {
          const updated = contentUpdates(withLegacyFields({ ...card, ...data }));
          await db.putMany('cards', updated);
          replaceInMemory(updated);
          toast('Palabra guardada');
        } else {
          await addCards(deckById(deckId), [data]);
          toast('Palabra agregada');
        }
        renderDeck(deckId);
      });
    },
  );
}

function exportDeckCSV(deckId) {
  const deck = deckById(deckId);
  const cards = forwardCardsOf(deckId).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.order || 0) - (b.order || 0));
  const safe = deck.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'mazo';
  downloadFile(`${safe}.csv`, '﻿' + cardsToCSV(cards), 'text/csv');
  toast('CSV exportado');
}

// ---------- Importar CSV ----------

async function startImport(file, deckId) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    return toast('No se pudo leer el archivo');
  }
  const { rows, delimiter } = parseCSV(text);
  if (!rows.length) return toast('El archivo está vacío');
  const det = detectFormat(rows);
  if (det.columns < 2 && det.format === 'generico') return toast('El archivo necesita al menos 2 columnas');
  const baseName = (file.name || 'Mazo').replace(/\.(csv|tsv|txt)$/i, '');
  const sameName = S.decks.find((d) => frontKey(d.name) === frontKey(baseName));
  importState = {
    fileName: file.name || 'importado.csv',
    rows,
    delimiter,
    ...det,
    deckChoice: deckId || sameName?.id || (S.decks.length ? S.decks[S.decks.length - 1].id : '__new'),
    newDeckName: baseName,
    mode: 'update',
    result: null,
  };
  go('#/importar');
}

function importPlan() {
  const st = importState;
  const incoming = rowsToCards(st.rows, st.mapping, st.hasHeader);
  const existing = st.deckChoice === '__new' ? [] : forwardCardsOf(st.deckChoice);
  return { incoming, plan: planImport(incoming, existing, st.mode, frontKey) };
}

function renderImport() {
  const st = importState;
  if (!st) return go('#/');
  if (st.result) {
    const r = st.result;
    const deck = deckById(r.deckId);
    app.innerHTML = `${topbar('Importar CSV', { back: '#/' })}
      <main class="content"><div class="done-box">
        ${icon('checkCircle', 'hero-ic')}
        <h2>Importación lista</h2>
        <p class="result" id="import-result">Se importaron <strong>${r.added}</strong> · se actualizaron <strong>${r.updated}</strong> · se omitieron <strong>${r.skipped}</strong></p>
        ${r.skipped ? `<p class="muted">Omitidas: palabras sin cambios, repetidas en el archivo o nuevas sin reverso.</p>` : ''}
        <div class="actions">
          ${deck ? `<a class="btn primary" href="#/estudiar/${deck.id}">${icon('play')}<span>Estudiar</span></a><a class="btn" href="#/mazo/${deck.id}">Ver mazo</a>` : ''}
        </div></div></main>`;
    return;
  }
  const { incoming, plan } = importPlan();
  const sepName = { ',': 'coma', '\t': 'tabulador', ';': 'punto y coma' }[st.delimiter];
  const maxEx = Math.max(0, ...incoming.map((c) => c.examples.length));
  const colOptions = (sel) =>
    `<option value="-1" ${sel === -1 ? 'selected' : ''}>— ninguna —</option>` +
    Array.from({ length: st.columns }, (_, i) => {
      const sample = st.rows[0]?.[i] ?? '';
      return `<option value="${i}" ${sel === i ? 'selected' : ''}>Columna ${i + 1}${sample ? ` (${h(sample.slice(0, 18))})` : ''}</option>`;
    }).join('');
  const ex0 = st.mapping.examples[0] || { fr: -1, es: -1, use: -1 };
  const mapSel = (key, sel) =>
    `<label class="field row"><span>${FIELD_LABELS[key]}</span><select data-change="map" data-field="${key}">${colOptions(sel)}</select></label>`;
  const mappingUI =
    st.format === 'generico'
      ? `<section class="group"><h2>Columnas</h2><div class="panel">
          <p class="hint">No reconocí el encabezado, así que la columna 1 es el frente y la 2 el reverso. Ajusta si hace falta.</p>
          ${mapSel('front', st.mapping.front)}${mapSel('back', st.mapping.back)}${mapSel('type', st.mapping.type)}
          ${mapSel('example', ex0.fr)}${mapSel('exampleTranslation', ex0.es)}${mapSel('use', ex0.use)}${mapSel('notes', st.mapping.notes)}
          <label class="check"><input type="checkbox" data-change="has-header" ${st.hasHeader ? 'checked' : ''}> La primera fila es un encabezado</label>
        </div></section>`
      : '';
  const deckOpts =
    S.decks.map((d) => `<option value="${d.id}" ${st.deckChoice === d.id ? 'selected' : ''}>${h(d.name)}</option>`).join('') +
    `<option value="__new" ${st.deckChoice === '__new' ? 'selected' : ''}>Nuevo mazo…</option>`;
  const existingDeck = st.deckChoice !== '__new';
  const total = plan.toAdd.length + plan.toUpdate.length;
  app.innerHTML = `${topbar('Importar CSV', { back: '#/' })}
    <main class="content">
      <div class="file-card">${icon('file')}<div><strong>${h(st.fileName)}</strong>
        <span class="muted">${plural(incoming.length, 'palabra', 'palabras')} · separador: ${sepName}${maxEx > 1 ? ` · hasta ${maxEx} usos por palabra` : ''}</span></div></div>
      ${mappingUI}
      <section class="group">
        <h2>Vista previa <span class="muted">· primeras 5 de ${incoming.length}</span></h2>
        <div class="preview-list">${incoming
          .slice(0, 5)
          .map(
            (c) => `<div class="preview-row">
              <div class="pr-main"><strong lang="fr">${h(c.front)}</strong>${c.type ? `<span class="muted"> · ${h(c.type)}</span>` : ''}</div>
              <div>${h(c.back)}</div>
              ${c.examples
                .map((e) => `<div class="pr-ex">${e.use ? `<span class="usage-label">${h(e.use)}</span> ` : ''}<span lang="fr">${h(e.fr)}</span>${e.es ? ` <span class="muted">— ${h(e.es)}</span>` : ''}</div>`)
                .join('')}
            </div>`,
          )
          .join('')}</div>
      </section>
      <section class="group">
        <h2>Destino</h2>
        <div class="panel">
          <label class="field"><span>Mazo</span><select data-change="import-deck">${deckOpts}</select></label>
          ${
            existingDeck
              ? `<fieldset class="field"><legend>Si la palabra ya existe en el mazo</legend>
                  <label class="check"><input type="radio" name="mode" value="update" ${st.mode === 'update' ? 'checked' : ''} data-change="import-mode"> Actualizarla (conserva el progreso y suma usos nuevos)</label>
                  <label class="check"><input type="radio" name="mode" value="add" ${st.mode === 'add' ? 'checked' : ''} data-change="import-mode"> Dejarla como está</label>
                </fieldset>`
              : `<label class="field"><span>Nombre del mazo nuevo</span><input type="text" value="${h(st.newDeckName)}" data-input="new-deck-name" maxlength="80"></label>`
          }
          <p class="plan" id="import-plan"><b>${plan.toAdd.length}</b> nuevas · <b>${plan.toUpdate.length}</b> por actualizar · <b>${plan.unchanged + plan.duplicates}</b> sin cambios${plan.invalid ? ` · <b>${plan.invalid}</b> sin reverso (se omiten)` : ''}</p>
          <button class="btn primary wide big" data-action="do-import" ${incoming.length ? '' : 'disabled'}>${
            total ? `Importar ${plural(total, 'palabra', 'palabras')}` : 'Nada nuevo que importar'
          }</button>
        </div>
      </section>
    </main>`;
}

async function doImport() {
  const st = importState;
  const deck = st.deckChoice === '__new' ? await createDeck(st.newDeckName || 'Mazo') : deckById(st.deckChoice);
  if (!deck) return;
  st.deckChoice = deck.id;
  const { plan } = importPlan();
  if (plan.toAdd.length) await addCards(deck, plan.toAdd);
  if (plan.toUpdate.length) {
    const updated = plan.toUpdate.flatMap(contentUpdates);
    await db.putMany('cards', updated);
    replaceInMemory(updated);
  }
  st.result = { added: plan.toAdd.length, updated: plan.toUpdate.length, skipped: plan.unchanged + plan.duplicates + plan.invalid, deckId: deck.id };
  renderImport();
}

// ---------- Ajustes ----------

async function offlineStatus() {
  if (!('serviceWorker' in navigator) || !('caches' in window)) return { ok: false, text: 'Este navegador no permite usar la app sin conexión.' };
  const keys = await caches.keys().catch(() => []);
  const mine = keys.find((k) => k === `tarjetas-v${VERSION}`);
  if (mine && navigator.serviceWorker.controller) return { ok: true, text: 'Lista para usarse sin conexión' };
  if (mine) return { ok: true, text: 'Descargada. Funcionará sin conexión desde la próxima vez que la abras.' };
  return { ok: false, text: 'Preparando el modo sin conexión… abre la app con internet una vez más.' };
}

function settingRow(label, control, sub = '') {
  return `<div class="setting"><div class="setting-label">${label}${sub ? `<small>${sub}</small>` : ''}</div>${control}</div>`;
}

async function renderSettings() {
  const s = S.settings;
  const voices = frenchVoices();
  const shareable = typeof navigator.canShare === 'function';
  let storageInfo = 'No disponible en este navegador';
  let storageOk = false;
  if (navigator.storage?.persisted) {
    storageOk = await navigator.storage.persisted().catch(() => false);
    storageInfo = storageOk
      ? 'Persistente: el sistema no lo borrará por falta de espacio'
      : 'No persistente: el sistema podría borrarlo si falta espacio. Respalda seguido.';
  }
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate().catch(() => null);
    if (est?.usage != null) storageInfo += ` · ${(est.usage / 1024).toFixed(0)} KB`;
  }
  const off = await offlineStatus();
  if (!location.hash.startsWith('#/ajustes')) return;
  const sel = (key, options) =>
    `<select data-change="setting" data-key="${key}">${options.map(([v, t]) => `<option value="${h(v)}" ${String(s[key]) === String(v) ? 'selected' : ''}>${h(t)}</option>`).join('')}</select>`;
  const toggle = (key) =>
    `<label class="switch"><input type="checkbox" role="switch" ${s[key] ? 'checked' : ''} data-change="setting-bool" data-key="${key}"><span></span></label>`;
  app.innerHTML = `${topbar('Ajustes', { back: '#/' })}
    <main class="content">
      <section class="group"><h2>Estudio</h2><div class="panel rows">
        ${settingRow('Nuevas al día', `<input type="number" inputmode="numeric" min="0" max="9999" value="${h(s.newPerDay)}" data-change="setting-num" data-key="newPerDay">`)}
        ${settingRow('Repasos máximos', `<input type="number" inputmode="numeric" min="0" max="99999" value="${h(s.reviewsPerDay)}" data-change="setting-num" data-key="reviewsPerDay">`)}
        ${settingRow('Orden de las nuevas', sel('newOrder', [['added', 'En orden'], ['random', 'Al azar']]))}
      </div></section>

      <section class="group"><h2>Audio</h2>
        ${voicesLoaded() && !hasFrenchVoice() ? noVoiceWarning() : ''}
        <div class="panel rows">
          ${settingRow('Acento', sel('voiceLang', [['fr-FR', 'Francia'], ['fr-CA', 'Canadá']]))}
          ${settingRow('Voz', sel('voiceURI', [['', 'Automática'], ...voices.map((v) => [v.voiceURI, `${v.name} (${v.lang})`])]))}
          ${settingRow(`Velocidad <output id="rate-out">${Number(s.rate).toFixed(2)}×</output>`, `<input type="range" min="0.5" max="1.5" step="0.05" value="${h(s.rate)}" data-change="setting-num" data-input="rate" data-key="rate" aria-label="Velocidad">`)}
          ${settingRow('Reproducir automáticamente', toggle('autoplay'), 'Después del primer toque de cada sesión')}
          <button class="row-btn" data-action="test-voice">${icon('sound')}<span>Probar voz</span></button>
        </div>
      </section>

      <section class="group"><h2>Respaldo</h2>
        ${backupWarning()}
        <div class="panel rows">
          ${settingRow('Último respaldo', `<strong id="last-backup">${s.lastBackup ? fmtDate(s.lastBackup) : 'nunca'}</strong>`)}
          <button class="row-btn" data-action="export">${icon('download')}<span>Exportar respaldo (JSON)</span></button>
          ${shareable ? `<button class="row-btn" data-action="share-export">${icon('share')}<span>Compartir respaldo…</span></button>` : ''}
          <label class="row-btn">${icon('upload')}<span>Importar respaldo (JSON)</span><input class="file-input" type="file" accept=".json,application/json" data-change="json-file"></label>
          <fieldset class="setting radio-set"><legend class="setting-label">Al importar un respaldo</legend>
            <label class="check"><input type="radio" name="import-mode" value="replace" checked> Reemplazar todo</label>
            <label class="check"><input type="radio" name="import-mode" value="merge"> Combinar con lo actual</label>
          </fieldset>
        </div>
      </section>

      <section class="group"><h2>CSV</h2><div class="panel rows">
        <button class="row-btn" data-action="template">${icon('file')}<span>Descargar plantilla CSV</span></button>
        <details class="format"><summary>${icon('info')}<span>Formato del CSV</span></summary>
          <p>Primera fila con encabezado. Columnas: <code>Frances</code>, <code>Espanol</code>, <code>Tipo</code>, <code>Ejemplo</code>, <code>Ejemplo_ES</code>, <code>Uso</code>, <code>Notas</code>.</p>
          <p>Para más usos agrega <code>Ejemplo2</code>, <code>Ejemplo2_ES</code>, <code>Uso2</code>, <code>Ejemplo3</code>… (sin límite). En cada repaso se muestra uno al azar.</p>
          <p>Solo <code>Frances</code> y <code>Espanol</code> son obligatorias. Un archivo sin encabezado se lee como frente y reverso.</p>
        </details>
      </div></section>

      <section class="group"><h2>Dispositivo</h2><div class="panel rows">
        <div class="status ${off.ok ? 'ok' : ''}" id="offline-status">${icon(off.ok ? 'checkCircle' : 'offline')}<span>${off.text}</span></div>
        <div class="status ${storageOk ? 'ok' : ''}" id="storage-status">${icon(storageOk ? 'checkCircle' : 'info')}<span>${storageInfo}</span></div>
      </div></section>
      <p class="muted center small">Tarjetas v${VERSION} · todo se guarda en este dispositivo</p>
    </main>`;
}

// ---------- Respaldo JSON ----------

async function buildBackup() {
  await setSetting('lastBackup', Date.now());
  const [decks, cards, reviews, settings] = await Promise.all(['decks', 'cards', 'reviews', 'settings'].map((s) => db.getAll(s)));
  const data = { app: 'tarjetas', format: 2, version: VERSION, exportedAt: new Date().toISOString(), decks, cards, reviews, settings };
  const name = `tarjetas-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
  return { name, json: JSON.stringify(data, null, 1) };
}

async function exportJSON(share) {
  const { name, json } = await buildBackup();
  const file = new File([json], name, { type: 'application/json' });
  if (share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Respaldo de Tarjetas' });
    } catch {
      /* cancelado */
    }
  } else downloadFile(name, json, 'application/json');
  toast('Respaldo exportado');
  if (location.hash.startsWith('#/ajustes')) renderSettings();
}

async function importJSON(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('El archivo no es un JSON válido');
  }
  if (data?.app !== 'tarjetas' || !Array.isArray(data.cards) || !Array.isArray(data.decks)) {
    return toast('Ese archivo no es un respaldo de Tarjetas');
  }
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'replace';
  const stores = { decks: data.decks, cards: data.cards.map(normalizeCard), reviews: data.reviews || [], settings: data.settings || [] };
  if (mode === 'replace') {
    if (!confirm('Esto reemplazará todos tus mazos, palabras y progreso. ¿Continuar?')) return;
    await db.batch(Object.entries(stores).map(([store, put]) => ({ store, clear: true, put })));
  } else {
    const ops = [];
    for (const [store, items] of Object.entries(stores)) {
      if (store === 'settings') continue;
      const existing = new Set((await db.getAll(store)).map((x) => x.id));
      ops.push({ store, put: items.filter((x) => !existing.has(x.id)) });
    }
    await db.batch(ops);
  }
  await loadAll();
  toast(mode === 'replace' ? 'Respaldo restaurado' : 'Respaldo combinado');
  renderSettings();
}

// ---------- eventos ----------

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (study) study.audioUnlocked = true;
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (a === 'speak') {
    e.stopPropagation();
    return speak(el.dataset.text, S.settings);
  }
  if (a === 'next-example') {
    e.stopPropagation();
    return nextExample();
  }
  if (a === 'reveal') return reveal();
  if (a === 'grade') return grade(Number(el.dataset.r));
  if (a === 'undo') return undo();
  if (a === 'refresh') {
    if (study) setCurrent(null), renderStudy(study.deckId);
    return;
  }
  if (a === 'new-deck') {
    const name = prompt('Nombre del mazo nuevo:', 'Francés');
    if (name && name.trim()) go(`#/mazo/${(await createDeck(name)).id}`);
    return;
  }
  if (a === 'add-card') return editCard(el.dataset.deck, null);
  if (a === 'edit-card') return editCard(location.hash.split('/')[2], el.dataset.id);
  if (a === 'export-csv') return exportDeckCSV(el.dataset.id);
  if (a === 'template') {
    downloadFile('plantilla-tarjetas.csv', '﻿' + TEMPLATE_CSV, 'text/csv');
    return toast('Plantilla descargada');
  }
  if (a === 'reset-deck') {
    if (!confirm('¿Reiniciar el progreso de este mazo? Todas las palabras volverán a ser nuevas.')) return;
    const id = el.dataset.id;
    const updated = cardsOf(id).map((c) => ({ ...c, ...newSchedulingState() }));
    const logIds = S.logs.filter((l) => l.deckId === id).map((l) => l.id);
    await db.batch([
      { store: 'cards', put: updated },
      { store: 'reviews', del: logIds },
    ]);
    replaceInMemory(updated);
    S.logs = S.logs.filter((l) => l.deckId !== id);
    toast('Progreso reiniciado');
    return renderDeck(id);
  }
  if (a === 'delete-deck') {
    const id = el.dataset.id;
    const deck = deckById(id);
    if (!confirm(`¿Borrar el mazo "${deck.name}" y sus ${forwardCardsOf(id).length} palabras? No se puede deshacer.`)) return;
    const cardIds = cardsOf(id).map((c) => c.id);
    const logIds = S.logs.filter((l) => l.deckId === id).map((l) => l.id);
    await db.batch([
      { store: 'decks', del: [id] },
      { store: 'cards', del: cardIds },
      { store: 'reviews', del: logIds },
    ]);
    S.decks = S.decks.filter((d) => d.id !== id);
    S.cards = S.cards.filter((c) => c.deckId !== id);
    S.logs = S.logs.filter((l) => l.deckId !== id);
    toast('Mazo borrado');
    return go('#/');
  }
  if (a === 'do-import') return doImport();
  if (a === 'test-voice') return speak('Bonjour ! Aujourd’hui, il fait beau.', S.settings);
  if (a === 'export') return exportJSON(false);
  if (a === 'share-export') return exportJSON(true);
});

app.addEventListener('change', async (e) => {
  const el = e.target;
  const c = el.dataset.change;
  if (!c) return;
  if (c === 'csv-file') {
    const f = el.files[0];
    el.value = '';
    return startImport(f, el.dataset.deck);
  }
  if (c === 'json-file') {
    const f = el.files[0];
    el.value = '';
    return importJSON(f);
  }
  if (c === 'rename-deck') {
    const d = deckById(el.dataset.id);
    if (d && el.value.trim()) {
      d.name = el.value.trim();
      await db.put('decks', d);
      document.querySelector('.topbar h1').textContent = d.name;
      toast('Nombre guardado');
    }
    return;
  }
  if (c === 'direction') {
    await setDirection(deckById(el.dataset.id), el.value);
    return toast('Dirección actualizada');
  }
  if (c === 'map') {
    const v = Number(el.value);
    const f = el.dataset.field;
    const m = importState.mapping;
    const exPart = { example: 'fr', exampleTranslation: 'es', use: 'use' }[f];
    if (exPart) {
      if (!m.examples[0]) m.examples[0] = { fr: -1, es: -1, use: -1 };
      m.examples[0][exPart] = v;
    } else m[f] = v;
    return renderImport();
  }
  if (c === 'has-header') {
    importState.hasHeader = el.checked;
    return renderImport();
  }
  if (c === 'import-deck') {
    importState.deckChoice = el.value;
    return renderImport();
  }
  if (c === 'import-mode') {
    importState.mode = el.value;
    return renderImport();
  }
  if (c === 'setting') return setSetting(el.dataset.key, el.value);
  if (c === 'setting-bool') return setSetting(el.dataset.key, el.checked);
  if (c === 'setting-num') {
    const v = Number(el.value);
    if (Number.isFinite(v) && v >= 0) await setSetting(el.dataset.key, v);
  }
});

app.addEventListener('input', (e) => {
  const el = e.target;
  const i = el.dataset.input;
  if (i === 'search') document.getElementById('card-list').innerHTML = cardListHTML(el.dataset.id, el.value);
  if (i === 'new-deck-name') importState.newDeckName = el.value;
  if (i === 'rate') document.getElementById('rate-out').textContent = `${Number(el.value).toFixed(2)}×`;
});

document.addEventListener('keydown', (e) => {
  if (!study || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, dialog')) return;
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    study.audioUnlocked = true;
    if (!study.showing) reveal();
  } else if (/^[1-4]$/.test(e.key) && study.showing) {
    study.audioUnlocked = true;
    grade(Number(e.key));
  } else if (e.key === 'z' || e.key === 'u') {
    undo();
  } else if (e.key === 'e' || e.key === 'o') {
    nextExample();
  }
});

window.addEventListener('hashchange', route);

// ---------- arranque ----------

async function start() {
  try {
    await loadAll();
  } catch (err) {
    app.innerHTML = `<main class="content">${banner(`No se pudo abrir el almacenamiento local (${h(err?.message || err)}). En Safari, desactiva la navegación privada.`)}</main>`;
    return;
  }
  navigator.storage?.persist?.().catch(() => {});
  initTTS(() => {
    if (location.hash.startsWith('#/ajustes')) renderSettings();
  });
  route();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW no registrado', err));
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) {
        if (location.hash.startsWith('#/ajustes')) renderSettings();
        return;
      }
      reloaded = true;
      if (!study) location.reload();
      else toast('Hay una versión nueva; se usará la próxima vez que abras la app');
    });
  }
}

start();
