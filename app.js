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
import { parseCSV, detectFormat, rowsToCards, dedupe, frontKey, FIELDS, FIELD_LABELS } from './csv.js';
import { initTTS, speak, hasFrenchVoice, voicesLoaded, frenchVoices, ttsSupported } from './tts.js';

export const VERSION = '1.0.0';

const DEFAULT_SETTINGS = {
  newPerDay: 10,
  reviewsPerDay: 200,
  voiceLang: 'fr-FR',
  voiceURI: '',
  rate: 0.9,
  autoplay: true,
  lastBackup: null,
};

const S = { decks: [], cards: [], logs: [], settings: { ...DEFAULT_SETTINGS }, persisted: null };
let study = null; // sesión de estudio activa
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- datos ----------

async function loadAll() {
  const [decks, cards, logs, settings] = await Promise.all([
    db.getAll('decks'),
    db.getAll('cards'),
    db.getAll('reviews'),
    db.getAll('settings'),
  ]);
  S.decks = decks.sort((a, b) => a.createdAt - b.createdAt);
  S.cards = cards;
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

function studyCardsOf(deck) {
  const dir = deck.direction || 'fr-es';
  return cardsOf(deck.id).filter((c) => {
    const d = c.dir || 'fwd';
    return dir === 'both' || (dir === 'fr-es' ? d === 'fwd' : d === 'rev');
  });
}

function makeCard(deckId, fields, extra = {}) {
  return {
    id: uid(),
    deckId,
    front: fields.front || '',
    back: fields.back || '',
    type: fields.type || '',
    example: fields.example || '',
    exampleTranslation: fields.exampleTranslation || '',
    createdAt: Date.now(),
    dir: 'fwd',
    ...newSchedulingState(),
    ...extra,
  };
}

function reverseOf(card) {
  return makeCard(card.deckId, card, { dir: 'rev', pairId: card.id, createdAt: card.createdAt, order: card.order });
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
  // Las tarjetas hermanas (la otra dirección) se dejan para mañana.
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

function topbar(title, { back, right = '' } = {}) {
  return `<header class="topbar">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Volver">‹</a>` : '<span class="icon-spacer"></span>'}
    <h1>${h(title)}</h1>
    ${right || '<span class="icon-spacer"></span>'}
  </header>`;
}

const CSV_ACCEPT = '.csv,.tsv,text/csv,text/plain,text/tab-separated-values';

function csvButton(label = 'Importar CSV', deckId = '') {
  return `<label class="btn">${h(label)}<input class="file-input" type="file" accept="${CSV_ACCEPT}" data-change="csv-file" data-deck="${h(deckId)}"></label>`;
}

// ---------- Inicio ----------

function backupWarning() {
  if (!S.cards.length) return '';
  const last = S.settings.lastBackup;
  const ref = last || Math.min(...S.cards.map((c) => c.createdAt || Date.now()));
  if (Date.now() - ref < 14 * DAY) return '';
  const msg = last
    ? `Tu último respaldo fue hace ${Math.floor((Date.now() - last) / DAY)} días.`
    : 'Todavía no has hecho un respaldo.';
  return `<div class="banner">${msg} Todo vive solo en este teléfono: <a href="#/ajustes">exporta un respaldo</a> de vez en cuando.</div>`;
}

function renderHome() {
  const logs = todayLogs();
  const keys = [...new Set(S.logs.map((l) => l.dayKey))];
  const st = streak(keys, dayKey(Date.now()));
  const decks = S.decks
    .map((d) => {
      const c = countsFor(studyCardsOf(d), queueOpts(d));
      const total = forwardCardsOf(d.id).length;
      const pending = c.new + c.learning + c.review;
      return `<li class="deck">
        <a class="deck-main" href="#/mazo/${d.id}">
          <span class="deck-name">${h(d.name)}</span>
          <span class="deck-meta">${plural(total, 'tarjeta', 'tarjetas')}</span>
          <span class="counts">
            <span class="c-new" title="Nuevas">${c.new} nuevas</span>
            <span class="c-learn" title="En aprendizaje">${c.learning} aprendiendo</span>
            <span class="c-rev" title="Por repasar">${c.review} repaso</span>
          </span>
        </a>
        <a class="btn ${pending ? 'primary' : ''} study-btn" href="#/estudiar/${d.id}">Estudiar</a>
      </li>`;
    })
    .join('');
  app.innerHTML = `
    ${topbar('Tarjetas', { right: '<a class="icon-btn" href="#/ajustes" aria-label="Ajustes">⚙︎</a>' })}
    <main class="content">
      ${backupWarning()}
      <section class="stats">
        <div><strong>${st}</strong><span>${st === 1 ? 'día de racha' : 'días de racha'}</span></div>
        <div><strong>${logs.length}</strong><span>repasos hoy</span></div>
        <div><strong>${new Set(logs.map((l) => l.cardId)).size}</strong><span>tarjetas hoy</span></div>
      </section>
      ${
        S.decks.length
          ? `<ul class="decks">${decks}</ul>`
          : `<div class="empty"><p>Aún no tienes mazos.</p><p>Importa un CSV desde la app Archivos o crea un mazo y agrega tarjetas a mano.</p></div>`
      }
      <div class="actions">
        ${csvButton()}
        <button class="btn" data-action="new-deck">Nuevo mazo</button>
      </div>
    </main>`;
}

// ---------- Estudio ----------

function renderStudy(deckId) {
  const deck = deckById(deckId);
  if (!deck) return go('#/');
  if (!study || study.deckId !== deckId) {
    study = { deckId, current: null, showing: false, undo: [], done: 0, audioUnlocked: false };
  }
  const cards = studyCardsOf(deck);
  const opts = queueOpts(deck);
  const counts = countsFor(cards, opts);
  if (!study.current || !S.cards.includes(study.current)) {
    study.current = nextCard(cards, opts);
    study.showing = false;
  }
  const card = study.current;
  const remaining = counts.new + counts.learning + counts.review;
  const pct = study.done + remaining ? Math.round((study.done / (study.done + remaining)) * 100) : 100;
  const kind = card ? (card.state === 'new' ? 'new' : card.state === 'review' ? 'rev' : 'learn') : '';
  const header = `<header class="topbar study-top">
      <a class="icon-btn" href="#/" aria-label="Salir">✕</a>
      <div class="counts big" aria-label="Pendientes">
        <span class="c-new ${kind === 'new' ? 'cur' : ''}">${counts.new}</span>
        <span class="c-learn ${kind === 'learn' ? 'cur' : ''}">${counts.learning}</span>
        <span class="c-rev ${kind === 'rev' ? 'cur' : ''}">${counts.review}</span>
      </div>
      <button class="icon-btn" data-action="undo" aria-label="Deshacer" ${study.undo.length ? '' : 'disabled'}>↶</button>
    </header>
    <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>`;

  if (!card) {
    const later = buildQueue(cards, opts).learnToday;
    let extra = '';
    if (later.length) {
      const mins = Math.max(1, Math.ceil((later[0].due - Date.now()) / MIN));
      extra = `<p>${plural(later.length, 'tarjeta sigue', 'tarjetas siguen')} en aprendizaje. La próxima vuelve en ${formatMinutes(mins)}.</p>
        <button class="btn" data-action="refresh">Revisar de nuevo</button>`;
      studyTimer = setTimeout(() => {
        if (location.hash === `#/estudiar/${deckId}`) renderStudy(deckId);
      }, Math.min(Math.max(1000, later[0].due - Date.now() - 20 * MIN + 1000), 2 ** 31 - 1));
    }
    app.innerHTML = `${header}<main class="content done">
      <div class="done-box"><div class="big-emoji">🎉</div><h2>¡Listo por hoy!</h2>
      <p>${deck.name ? h(deck.name) + ': ' : ''}${plural(study.done, 'respuesta', 'respuestas')} en esta sesión.</p>
      ${extra}
      <a class="btn primary" href="#/">Volver al inicio</a></div></main>`;
    return;
  }

  const rev = card.dir === 'rev';
  const fr = { word: card.front, example: card.example };
  const question = rev ? card.back : card.front;
  const answer = rev ? card.front : card.back;
  const labels = intervalLabels(card, Date.now());
  const speakWord = `<button class="speak" data-action="speak" data-text="${h(fr.word)}" aria-label="Escuchar palabra">🔊</button>`;
  const warn = voicesLoaded() && ttsSupported() && !hasFrenchVoice() ? noVoiceWarning() : '';

  app.innerHTML = `${header}
    <main class="study-area" data-action="reveal">
      ${warn}
      <div class="flash">
        ${card.type ? `<div class="ftype">${h(card.type)}</div>` : ''}
        <div class="question">${h(question)}</div>
        ${!rev ? speakWord : ''}
        ${
          study.showing
            ? `<hr><div class="answer">${h(answer)}</div>
               ${rev ? speakWord : ''}
               ${
                 card.example
                   ? `<div class="example"><p lang="fr">${h(card.example)}
                        <button class="speak small" data-action="speak" data-text="${h(card.example)}" aria-label="Escuchar ejemplo">🔊</button></p>
                      ${card.exampleTranslation ? `<p class="ex-tr">${h(card.exampleTranslation)}</p>` : ''}</div>`
                   : ''
               }`
            : ''
        }
      </div>
    </main>
    <footer class="answer-bar">
      ${
        study.showing
          ? `<div class="grades">
              <button class="grade again" data-action="grade" data-r="1"><small>${labels[1]}</small>Otra vez</button>
              <button class="grade hard" data-action="grade" data-r="2"><small>${labels[2]}</small>Difícil</button>
              <button class="grade good" data-action="grade" data-r="3"><small>${labels[3]}</small>Bien</button>
              <button class="grade easy" data-action="grade" data-r="4"><small>${labels[4]}</small>Fácil</button>
            </div>`
          : `<button class="btn primary wide" data-action="reveal">Mostrar respuesta</button>`
      }
    </footer>`;

  // Auto-reproducción: solo tras el primer toque de la sesión (requisito de iOS).
  if (S.settings.autoplay && study.audioUnlocked && study.autoSpoken !== `${card.id}:${study.showing}`) {
    if ((!rev && !study.showing) || (rev && study.showing)) {
      study.autoSpoken = `${card.id}:${study.showing}`;
      speak(fr.word, S.settings);
    }
  }
}

function noVoiceWarning() {
  return `<div class="banner">No hay voces en francés. Instala una voz francesa en Ajustes → Accesibilidad → Contenido leído.</div>`;
}

function reveal() {
  if (!study || !study.current || study.showing) return;
  study.showing = true;
  renderStudy(study.deckId);
}

async function grade(rating) {
  if (!study || !study.current || !study.showing) return;
  const card = study.current;
  const now = Date.now();
  const next = answerCard(card, rating, now);
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
  study.current = log.before;
  study.showing = true;
  study.autoSpoken = `${log.before.id}:true`;
  renderStudy(study.deckId);
  toast('Respuesta deshecha');
}

// ---------- Mazo ----------

function stateBadge(c) {
  const map = { new: ['Nueva', 'c-new'], learning: ['Aprendiendo', 'c-learn'], relearning: ['Reaprendiendo', 'c-learn'], review: ['Repaso', 'c-rev'] };
  const [t, cls] = map[c.state] || map.new;
  return `<span class="badge ${cls}">${t}</span>`;
}

function cardListHTML(deckId, q) {
  const key = frontKey(q);
  const list = forwardCardsOf(deckId)
    .filter((c) => !key || frontKey(`${c.front} ${c.back} ${c.example}`).includes(key))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.order || 0) - (b.order || 0));
  if (!list.length) return `<li class="empty">${q ? 'Sin resultados.' : 'Este mazo no tiene tarjetas.'}</li>`;
  return list
    .slice(0, 500)
    .map(
      (c) => `<li><button class="card-row" data-action="edit-card" data-id="${c.id}">
        <span class="cr-front">${h(c.front)}</span><span class="cr-back">${h(c.back)}</span>${stateBadge(c)}
      </button></li>`,
    )
    .join('');
}

function renderDeck(deckId) {
  const deck = deckById(deckId);
  if (!deck) return go('#/');
  const dir = deck.direction || 'fr-es';
  const n = forwardCardsOf(deckId).length;
  app.innerHTML = `
    ${topbar(deck.name, { back: '#/' })}
    <main class="content">
      <section class="panel">
        <label class="field"><span>Nombre del mazo</span>
          <input type="text" value="${h(deck.name)}" data-change="rename-deck" data-id="${deck.id}" maxlength="80"></label>
        <div class="field"><span>Dirección</span>
          <div class="segmented" role="radiogroup">
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
        <div class="actions">
          <a class="btn primary" href="#/estudiar/${deck.id}">Estudiar</a>
          <button class="btn" data-action="add-card" data-deck="${deck.id}">Agregar tarjeta</button>
          ${csvButton('Importar CSV', deck.id)}
        </div>
      </section>
      <section>
        <label class="field search"><span class="sr-only">Buscar</span>
          <input type="search" placeholder="Buscar en ${plural(n, 'tarjeta', 'tarjetas')}…" data-input="search" data-id="${deck.id}"></label>
        <ul class="card-list" id="card-list">${cardListHTML(deckId, '')}</ul>
      </section>
      <section class="actions danger-zone">
        <button class="btn" data-action="reset-deck" data-id="${deck.id}">Reiniciar progreso</button>
        <button class="btn danger" data-action="delete-deck" data-id="${deck.id}">Borrar mazo</button>
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

function editCard(deckId, cardId) {
  const card = cardId ? S.cards.find((c) => c.id === cardId) : null;
  const v = card || { front: '', back: '', type: '', example: '', exampleTranslation: '' };
  const field = (name, label, ta) =>
    `<label class="field"><span>${label}</span>${
      ta ? `<textarea name="${name}" rows="2">${h(v[name])}</textarea>` : `<input type="text" name="${name}" value="${h(v[name])}">`
    }</label>`;
  openDialog(
    `<form method="dialog" class="sheet">
      <h2>${card ? 'Editar tarjeta' : 'Nueva tarjeta'}</h2>
      ${field('front', 'Francés')}
      ${field('back', 'Español')}
      ${field('type', 'Tipo (verbo, sustantivo…)')}
      ${field('example', 'Ejemplo', true)}
      ${field('exampleTranslation', 'Traducción del ejemplo', true)}
      <div class="actions">
        <button class="btn primary" value="save">Guardar</button>
        <button class="btn" value="cancel" formnovalidate>Cancelar</button>
        ${card ? '<button class="btn danger" value="delete" formnovalidate>Borrar</button>' : ''}
      </div>
    </form>`,
    (dlg) => {
      const form = dlg.querySelector('form');
      form.front.required = true;
      form.back.required = true;
      form.addEventListener('submit', async (e) => {
        const action = e.submitter?.value;
        if (action === 'cancel') return;
        if (action === 'delete') {
          if (!confirm('¿Borrar esta tarjeta?')) {
            e.preventDefault();
            return;
          }
          const ids = S.cards.filter((c) => c.id === card.id || c.pairId === card.id).map((c) => c.id);
          await db.delMany('cards', ids);
          S.cards = S.cards.filter((c) => !ids.includes(c.id));
          toast('Tarjeta borrada');
          return renderDeck(deckId);
        }
        const data = Object.fromEntries(FIELDS.map((f) => [f, form[f].value.trim()]));
        const dup = forwardCardsOf(deckId).find((c) => c.id !== card?.id && frontKey(c.front) === frontKey(data.front));
        if (dup) {
          e.preventDefault();
          toast('Ya existe una tarjeta con ese frente en el mazo');
          return;
        }
        if (card) {
          const updated = S.cards.filter((c) => c.id === card.id || c.pairId === card.id).map((c) => Object.assign(c, data));
          await db.putMany('cards', updated);
          toast('Tarjeta guardada');
        } else {
          await addCards(deckById(deckId), [data]);
          toast('Tarjeta agregada');
        }
        renderDeck(deckId);
      });
    },
  );
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
  importState = {
    fileName: file.name || 'importado.csv',
    rows,
    delimiter,
    ...det,
    deckChoice: deckId || (S.decks.length ? S.decks[S.decks.length - 1].id : '__new'),
    newDeckName: (file.name || 'Mazo').replace(/\.(csv|tsv|txt)$/i, ''),
    result: null,
  };
  go('#/importar');
}

function renderImport() {
  const st = importState;
  if (!st) return go('#/');
  if (st.result) {
    const deck = deckById(st.result.deckId);
    app.innerHTML = `${topbar('Importar CSV', { back: '#/' })}
      <main class="content"><div class="done-box">
        <div class="big-emoji">✅</div>
        <h2>Importación lista</h2>
        <p class="result" id="import-result">Se importaron <strong>${st.result.added}</strong> · se omitieron <strong>${st.result.skipped}</strong> (ya existían)</p>
        <div class="actions">
          ${deck ? `<a class="btn primary" href="#/estudiar/${deck.id}">Estudiar</a><a class="btn" href="#/mazo/${deck.id}">Ver mazo</a>` : ''}
          <a class="btn" href="#/">Inicio</a>
        </div></div></main>`;
    return;
  }
  const cards = rowsToCards(st.rows, st.mapping, st.hasHeader);
  const sepName = { ',': 'coma', '\t': 'tabulador', ';': 'punto y coma' }[st.delimiter];
  const colOptions = (sel) =>
    `<option value="-1" ${sel === -1 ? 'selected' : ''}>— ninguna —</option>` +
    Array.from({ length: st.columns }, (_, i) => {
      const sample = st.rows[0]?.[i] ?? '';
      return `<option value="${i}" ${sel === i ? 'selected' : ''}>Columna ${i + 1}${sample ? ` (${h(sample.slice(0, 20))})` : ''}</option>`;
    }).join('');
  const mappingUI =
    st.format === 'generico'
      ? `<section class="panel">
          <h2>Columnas</h2>
          <p class="hint">No reconocí el encabezado <code>Frances,Espanol,Tipo,Ejemplo,Ejemplo_ES</code>. Elige qué columna va en cada campo.</p>
          ${FIELDS.map(
            (f) => `<label class="field"><span>${FIELD_LABELS[f]}</span>
              <select data-change="map" data-field="${f}">${colOptions(st.mapping[f])}</select></label>`,
          ).join('')}
          <label class="check"><input type="checkbox" data-change="has-header" ${st.hasHeader ? 'checked' : ''}> La primera fila es un encabezado</label>
        </section>`
      : '';
  const deckOpts =
    S.decks.map((d) => `<option value="${d.id}" ${st.deckChoice === d.id ? 'selected' : ''}>${h(d.name)}</option>`).join('') +
    `<option value="__new" ${st.deckChoice === '__new' ? 'selected' : ''}>+ Nuevo mazo…</option>`;
  app.innerHTML = `${topbar('Importar CSV', { back: '#/' })}
    <main class="content">
      <p class="hint">${h(st.fileName)} · separador: ${sepName} · formato ${st.format === 'principal' ? 'principal' : 'genérico'}</p>
      ${mappingUI}
      <section class="panel">
        <h2>Vista previa <span class="muted">(${plural(cards.length, 'tarjeta', 'tarjetas')} en total)</span></h2>
        <div class="table-wrap"><table class="preview">
          <thead><tr><th>Francés</th><th>Español</th><th>Tipo</th><th>Ejemplo</th></tr></thead>
          <tbody>${cards
            .slice(0, 5)
            .map(
              (c) =>
                `<tr><td>${h(c.front)}</td><td>${h(c.back)}</td><td>${h(c.type)}</td><td>${h(c.example)}${
                  c.exampleTranslation ? `<br><span class="muted">${h(c.exampleTranslation)}</span>` : ''
                }</td></tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </section>
      <section class="panel">
        <label class="field"><span>Mazo de destino</span><select data-change="import-deck">${deckOpts}</select></label>
        ${
          st.deckChoice === '__new'
            ? `<label class="field"><span>Nombre del mazo nuevo</span><input type="text" value="${h(st.newDeckName)}" data-input="new-deck-name" maxlength="80"></label>`
            : ''
        }
        <button class="btn primary wide" data-action="do-import" ${cards.length ? '' : 'disabled'}>Importar ${plural(cards.length, 'tarjeta', 'tarjetas')}</button>
      </section>
    </main>`;
}

async function doImport() {
  const st = importState;
  const incoming = rowsToCards(st.rows, st.mapping, st.hasHeader);
  let deck = st.deckChoice === '__new' ? await createDeck(st.newDeckName || 'Mazo') : deckById(st.deckChoice);
  if (!deck) return;
  const { toAdd, skipped } = dedupe(
    incoming,
    forwardCardsOf(deck.id).map((c) => c.front),
  );
  if (toAdd.length) await addCards(deck, toAdd);
  st.result = { added: toAdd.length, skipped, deckId: deck.id };
  renderImport();
}

// ---------- Ajustes ----------

async function renderSettings() {
  const s = S.settings;
  const voices = frenchVoices();
  const langs = [
    ['fr-FR', 'Francés (Francia)'],
    ['fr-CA', 'Francés (Canadá)'],
  ];
  const shareable = typeof navigator.canShare === 'function';
  let storageInfo = 'No disponible en este navegador';
  if (navigator.storage?.persisted) {
    const p = await navigator.storage.persisted().catch(() => null);
    storageInfo = p ? 'Persistente ✓ (el navegador no lo borrará por falta de espacio)' : 'No persistente: el sistema podría borrarlo si falta espacio. Instala la app en la pantalla de inicio y respalda seguido.';
  }
  let usage = '';
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate().catch(() => null);
    if (est?.usage != null) usage = ` · usando ${(est.usage / 1024).toFixed(0)} KB`;
  }
  if (!location.hash.startsWith('#/ajustes')) return; // cambió la vista mientras esperábamos
  app.innerHTML = `${topbar('Ajustes', { back: '#/' })}
    <main class="content">
      <section class="panel">
        <h2>Estudio</h2>
        <label class="field row"><span>Nuevas al día</span><input type="number" inputmode="numeric" min="0" max="9999" value="${h(s.newPerDay)}" data-change="setting-num" data-key="newPerDay"></label>
        <label class="field row"><span>Repasos máximos al día</span><input type="number" inputmode="numeric" min="0" max="99999" value="${h(s.reviewsPerDay)}" data-change="setting-num" data-key="reviewsPerDay"></label>
      </section>
      <section class="panel">
        <h2>Audio</h2>
        ${voicesLoaded() && !hasFrenchVoice() ? noVoiceWarning() : ''}
        <label class="field row"><span>Acento</span><select data-change="setting" data-key="voiceLang">
          ${langs.map(([v, t]) => `<option value="${v}" ${s.voiceLang === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></label>
        <label class="field row"><span>Voz</span><select data-change="setting" data-key="voiceURI">
          <option value="">Automática</option>
          ${voices.map((v) => `<option value="${h(v.voiceURI)}" ${s.voiceURI === v.voiceURI ? 'selected' : ''}>${h(v.name)} (${h(v.lang)})</option>`).join('')}
        </select></label>
        <label class="field row"><span>Velocidad <output id="rate-out">${Number(s.rate).toFixed(2)}×</output></span>
          <input type="range" min="0.5" max="1.5" step="0.05" value="${h(s.rate)}" data-change="setting-num" data-input="rate" data-key="rate"></label>
        <label class="check"><input type="checkbox" ${s.autoplay ? 'checked' : ''} data-change="setting-bool" data-key="autoplay"> Reproducir audio automáticamente</label>
        <button class="btn" data-action="test-voice">🔊 Probar voz</button>
      </section>
      <section class="panel">
        <h2>Respaldo</h2>
        <p>Último respaldo: <strong id="last-backup">${s.lastBackup ? fmtDate(s.lastBackup) : 'nunca'}</strong></p>
        ${backupWarning()}
        <div class="actions">
          <button class="btn primary" data-action="export">Exportar JSON</button>
          ${shareable ? '<button class="btn" data-action="share-export">Compartir respaldo…</button>' : ''}
        </div>
        <fieldset class="field"><legend>Al importar un respaldo</legend>
          <label class="check"><input type="radio" name="import-mode" value="replace" checked> Reemplazar todo</label>
          <label class="check"><input type="radio" name="import-mode" value="merge"> Combinar con lo actual</label>
        </fieldset>
        <label class="btn">Importar JSON<input class="file-input" type="file" accept=".json,application/json" data-change="json-file"></label>
      </section>
      <section class="panel">
        <h2>Almacenamiento</h2>
        <p id="storage-status">${storageInfo}${usage}</p>
      </section>
      <p class="muted center">Tarjetas v${VERSION} · todo se guarda en este dispositivo</p>
    </main>`;
}

// ---------- Respaldo JSON ----------

async function buildBackup() {
  await setSetting('lastBackup', Date.now());
  const [decks, cards, reviews, settings] = await Promise.all(['decks', 'cards', 'reviews', 'settings'].map((s) => db.getAll(s)));
  const data = { app: 'tarjetas', format: 1, version: VERSION, exportedAt: new Date().toISOString(), decks, cards, reviews, settings };
  const name = `tarjetas-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
  return new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });
}

async function exportJSON(share) {
  const file = await buildBackup();
  if (share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Respaldo de Tarjetas' });
    } catch {
      /* cancelado */
    }
  } else {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
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
  const stores = { decks: data.decks, cards: data.cards, reviews: data.reviews || [], settings: data.settings || [] };
  if (mode === 'replace') {
    if (!confirm('Esto reemplazará todos tus mazos, tarjetas y progreso. ¿Continuar?')) return;
    await db.batch(Object.entries(stores).map(([store, put]) => ({ store, clear: true, put })));
  } else {
    const ops = [];
    for (const [store, items] of Object.entries(stores)) {
      if (store === 'settings') continue; // al combinar se conservan los ajustes actuales
      const key = 'id';
      const existing = new Set((await db.getAll(store)).map((x) => x[key]));
      ops.push({ store, put: items.filter((x) => !existing.has(x[key])) });
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
  if (a === 'reveal') return reveal();
  if (a === 'grade') return grade(Number(el.dataset.r));
  if (a === 'undo') return undo();
  if (a === 'refresh') return study && ((study.current = null), renderStudy(study.deckId));
  if (a === 'new-deck') {
    const name = prompt('Nombre del mazo nuevo:', 'Francés');
    if (name && name.trim()) {
      const d = await createDeck(name);
      go(`#/mazo/${d.id}`);
    }
    return;
  }
  if (a === 'add-card') return editCard(el.dataset.deck, null);
  if (a === 'edit-card') return editCard(location.hash.split('/')[2], el.dataset.id);
  if (a === 'reset-deck') {
    if (!confirm('¿Reiniciar el progreso de este mazo? Todas las tarjetas volverán a ser nuevas.')) return;
    const id = el.dataset.id;
    const updated = cardsOf(id).map((c) => Object.assign(c, newSchedulingState()));
    const logIds = S.logs.filter((l) => l.deckId === id).map((l) => l.id);
    await db.batch([
      { store: 'cards', put: updated },
      { store: 'reviews', del: logIds },
    ]);
    S.logs = S.logs.filter((l) => l.deckId !== id);
    toast('Progreso reiniciado');
    return renderDeck(id);
  }
  if (a === 'delete-deck') {
    const id = el.dataset.id;
    const deck = deckById(id);
    if (!confirm(`¿Borrar el mazo "${deck.name}" y sus ${forwardCardsOf(id).length} tarjetas? No se puede deshacer.`)) return;
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
    importState.mapping[el.dataset.field] = Number(el.value);
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
  if (c === 'setting') return setSetting(el.dataset.key, el.value);
  if (c === 'setting-bool') return setSetting(el.dataset.key, el.checked);
  if (c === 'setting-num') {
    const v = Number(el.value);
    if (Number.isFinite(v) && v >= 0) await setSetting(el.dataset.key, v);
    return;
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
    if (study.showing) grade(3);
    else reveal();
  } else if (/^[1-4]$/.test(e.key) && study.showing) {
    study.audioUnlocked = true;
    grade(Number(e.key));
  } else if (e.key === 'z' || e.key === 'u') {
    undo();
  }
});

window.addEventListener('hashchange', route);

// ---------- arranque ----------

async function start() {
  try {
    await loadAll();
  } catch (err) {
    app.innerHTML = `<main class="content"><div class="banner">No se pudo abrir el almacenamiento local (${h(err?.message || err)}). En Safari, desactiva la navegación privada.</div></main>`;
    return;
  }
  if (navigator.storage?.persist) {
    navigator.storage
      .persist()
      .then((p) => (S.persisted = p))
      .catch(() => {});
  }
  initTTS(() => {
    if (location.hash.startsWith('#/ajustes')) renderSettings();
  });
  route();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW no registrado', err));
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      if (!study) location.reload();
      else toast('Hay una versión nueva; se usará la próxima vez que abras la app');
    });
  }
}

start();
