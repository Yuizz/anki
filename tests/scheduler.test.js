import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  answerCard,
  newSchedulingState,
  intervalLabels,
  studyDayStart,
  dayKey,
  buildQueue,
  nextCard,
  countsFor,
  interleave,
  streak,
  MIN,
} from '../scheduler.js';

const noFuzz = { rng: () => 0.5 };
const NOW = new Date(2026, 10, 20, 15, 0, 0).getTime(); // 20 nov 2026 15:00 local
const daysBetween = (a, b) => Math.round((b - a) / 86400000);

const card = (over = {}) => ({ id: Math.random().toString(36), ...newSchedulingState(), ...over });

test('nueva: Otra vez → 1 min, Bien → 10 min (paso 2)', () => {
  const c = card();
  const again = answerCard(c, 1, NOW, noFuzz);
  assert.equal(again.state, 'learning');
  assert.equal(again.due, NOW + 1 * MIN);
  const good = answerCard(c, 3, NOW, noFuzz);
  assert.equal(good.state, 'learning');
  assert.equal(good.step, 1);
  assert.equal(good.due, NOW + 10 * MIN);
  assert.equal(good.reps, 1);
});

test('aprendizaje: Bien en el último paso → review a 1 día; Fácil → 4 días', () => {
  const c = card({ state: 'learning', step: 1 });
  const good = answerCard(c, 3, NOW, noFuzz);
  assert.equal(good.state, 'review');
  assert.equal(good.interval, 1);
  assert.equal(good.due, studyDayStart(NOW) + 86400000);
  const easy = answerCard(card(), 4, NOW, noFuzz);
  assert.equal(easy.state, 'review');
  assert.equal(easy.interval, 4);
  assert.equal(easy.ease, 2.5);
});

test('review: Otra vez → ease −0.20, relearning a 10 min, lapses +1, intervalo × 0.5', () => {
  const c = card({ state: 'review', interval: 10, ease: 2.5, reps: 5 });
  const r = answerCard(c, 1, NOW, noFuzz);
  assert.equal(r.state, 'relearning');
  assert.equal(r.ease, 2.3);
  assert.equal(r.lapses, 1);
  assert.equal(r.interval, 5);
  assert.equal(r.due, NOW + 10 * MIN);
  // mínimo 1 día
  assert.equal(answerCard(card({ state: 'review', interval: 1 }), 1, NOW, noFuzz).interval, 1);
});

test('relearning: Bien → vuelve a review con el intervalo reducido', () => {
  const c = card({ state: 'relearning', interval: 5, ease: 2.3, step: 0 });
  const r = answerCard(c, 3, NOW, noFuzz);
  assert.equal(r.state, 'review');
  assert.equal(r.interval, 5);
});

test('review: Difícil ×1.2 y ease −0.15; Bien × ease; Fácil × ease × 1.3 y ease +0.15', () => {
  const c = card({ state: 'review', interval: 10, ease: 2.5 });
  const hard = answerCard(c, 2, NOW, noFuzz);
  assert.equal(hard.interval, 12);
  assert.equal(hard.ease, 2.35);
  const good = answerCard(c, 3, NOW, noFuzz);
  assert.equal(good.interval, 25);
  assert.equal(good.ease, 2.5);
  const easy = answerCard(c, 4, NOW, noFuzz);
  assert.equal(easy.interval, 33); // 10 × 2.5 × 1.3 = 32.5
  assert.equal(easy.ease, 2.65);
  assert.equal(daysBetween(studyDayStart(NOW), good.due), 25);
});

test('ease mínimo 1.3', () => {
  const c = card({ state: 'review', interval: 10, ease: 1.35 });
  assert.equal(answerCard(c, 1, NOW, noFuzz).ease, 1.3);
  assert.equal(answerCard(c, 2, NOW, noFuzz).ease, 1.3);
});

test('fuzz de ±5 % solo en intervalos > 2 días', () => {
  const c = card({ state: 'review', interval: 40, ease: 2.5 }); // Bien = 100 d
  const lo = answerCard(c, 3, NOW, { rng: () => 0 });
  const hi = answerCard(c, 3, NOW, { rng: () => 0.999999 });
  assert.equal(lo.interval, 95);
  assert.equal(hi.interval, 105);
  for (let i = 0; i < 200; i++) {
    const r = answerCard(c, 3, NOW).interval;
    assert.ok(r >= 95 && r <= 105, `fuera de rango: ${r}`);
  }
  // intervalo de 2 días: sin fuzz
  const small = card({ state: 'learning', step: 1 });
  assert.equal(answerCard(small, 3, NOW, { rng: () => 0 }).interval, 1);
});

test('los botones siempre dan intervalos crecientes', () => {
  const c = card({ state: 'review', interval: 1, ease: 1.3 });
  const ivls = [2, 3, 4].map((r) => answerCard(c, r, NOW, noFuzz).interval);
  assert.ok(ivls[0] < ivls[1] && ivls[1] < ivls[2], ivls.join(','));
});

test('etiquetas de intervalo', () => {
  assert.deepEqual(intervalLabels(card(), NOW), { 1: '1 min', 2: '6 min', 3: '10 min', 4: '4 d' });
  assert.deepEqual(intervalLabels(card({ state: 'learning', step: 1 }), NOW), { 1: '1 min', 2: '10 min', 3: '1 d', 4: '4 d' });
  const l = intervalLabels(card({ state: 'review', interval: 100, ease: 2.5 }), NOW);
  assert.equal(l[1], '10 min');
  assert.equal(l[3], '8,3 m');
});

test('el día de estudio se corta a las 4:00 AM', () => {
  const at3 = new Date(2026, 10, 20, 3, 59).getTime();
  const at4 = new Date(2026, 10, 20, 4, 0).getTime();
  assert.equal(dayKey(at3), '2026-11-19');
  assert.equal(dayKey(at4), '2026-11-20');
  assert.equal(studyDayStart(at3), new Date(2026, 10, 19, 4, 0).getTime());
});

test('orden: aprendizaje vencido, luego repasos, luego nuevas (intercaladas)', () => {
  const learn = card({ id: 'L', state: 'learning', due: NOW - 1000 });
  const rev = [1, 2, 3, 4].map((i) => card({ id: `R${i}`, state: 'review', interval: 3, due: NOW - i * 1000 }));
  const news = [1, 2].map((i) => card({ id: `N${i}`, createdAt: i }));
  const cards = [...news, ...rev, learn];
  assert.equal(nextCard(cards, { now: NOW }).id, 'L');
  const q = buildQueue(cards, { now: NOW });
  assert.deepEqual(
    q.main.map((c) => c.id),
    ['R4', 'N1', 'R3', 'R2', 'N2', 'R1'],
  );
  assert.equal(nextCard([...news, ...rev], { now: NOW }).id, 'R4');
});

test('límites diarios de nuevas y repasos', () => {
  const news = Array.from({ length: 15 }, (_, i) => card({ createdAt: i }));
  const revs = Array.from({ length: 5 }, () => card({ state: 'review', interval: 2, due: NOW - 1 }));
  const c = countsFor([...news, ...revs], { now: NOW, newPerDay: 10, reviewsPerDay: 3, newDone: 4, reviewsDone: 1 });
  assert.deepEqual(c, { new: 6, learning: 0, review: 2 });
  assert.equal(countsFor(news, { now: NOW }).new, 10); // 10 nuevas por defecto
});

test('repasos que vencen más tarde hoy (antes de las 4 AM) cuentan para hoy', () => {
  const tonight = new Date(2026, 10, 21, 2, 0).getTime();
  const tomorrow = new Date(2026, 10, 21, 5, 0).getTime();
  const cards = [card({ state: 'review', interval: 1, due: tonight }), card({ state: 'review', interval: 1, due: tomorrow })];
  assert.equal(countsFor(cards, { now: NOW }).review, 1);
});

test('aprendizaje adelantado: si no queda nada, muestra la de aprendizaje que vence en ≤ 20 min', () => {
  const soon = card({ id: 'S', state: 'learning', due: NOW + 5 * MIN });
  const later = card({ id: 'T', state: 'learning', due: NOW + 60 * MIN });
  assert.equal(nextCard([soon, later], { now: NOW }).id, 'S');
  assert.equal(nextCard([later], { now: NOW }), null);
  assert.equal(countsFor([soon, later], { now: NOW }).learning, 2);
});

test('deshacer = restaurar la copia previa (las funciones son puras)', () => {
  const c = card({ state: 'review', interval: 10, ease: 2.5 });
  const snapshot = structuredClone(c);
  answerCard(c, 1, NOW);
  assert.deepEqual(c, snapshot);
});

test('interleave reparte las nuevas', () => {
  assert.deepEqual(interleave([1, 2, 3], []), [1, 2, 3]);
  assert.deepEqual(interleave([], ['a']), ['a']);
  assert.deepEqual(interleave([1, 2, 3, 4, 5], ['a']), [1, 2, 'a', 3, 4, 5]);
});

test('racha', () => {
  assert.equal(streak(['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-20'), 3);
  assert.equal(streak(['2026-11-18', '2026-11-19'], '2026-11-20'), 2);
  assert.equal(streak(['2026-11-17'], '2026-11-20'), 0);
  assert.equal(streak(['2026-02-28', '2026-03-01'], '2026-03-01'), 2);
});

test('la versión del service worker coincide con la de la app', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').match(/VERSION = '([^']+)'/)[1];
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8').match(/VERSION = '([^']+)'/)[1];
  assert.equal(app, sw);
});

test('orden aleatorio de nuevas: estable y distinto del orden de creación', () => {
  const news = Array.from({ length: 30 }, (_, i) => card({ id: `n${i}`, createdAt: i }));
  const a = buildQueue(news, { now: NOW, newPerDay: 30, newOrder: 'random' }).news.map((c) => c.id);
  const b = buildQueue([...news].reverse(), { now: NOW, newPerDay: 30, newOrder: 'random' }).news.map((c) => c.id);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, news.map((c) => c.id));
  assert.equal(new Set(a).size, 30);
});
