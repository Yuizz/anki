import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCard, pickExample, mergeIntoCard, planImport } from '../model.js';

test('migra tarjetas 1.0 (un ejemplo) a usos', () => {
  const c = normalizeCard({ id: 'a', front: 'être', back: 'ser', example: 'Je suis.', exampleTranslation: 'Soy.' });
  assert.deepEqual(c.examples, [{ fr: 'Je suis.', es: 'Soy.', use: '' }]);
  assert.equal(c.notes, '');
  assert.deepEqual(normalizeCard({ front: 'x', back: 'y' }).examples, []);
  // idempotente
  assert.deepEqual(normalizeCard(c), c);
});

test('pickExample: al azar y sin repetir el último', () => {
  const card = { examples: [{ fr: 'a' }, { fr: 'b' }, { fr: 'c' }] };
  assert.equal(pickExample({ examples: [] }), -1);
  assert.equal(pickExample({ examples: [{ fr: 'a' }] }, 0), 0);
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const k = pickExample(card, 1);
    assert.notEqual(k, 1);
    seen.add(k);
  }
  assert.deepEqual([...seen].sort(), [0, 2]);
  const all = new Set();
  for (let i = 0; i < 300; i++) all.add(pickExample(card));
  assert.equal(all.size, 3);
});

test('mergeIntoCard: celdas vacías no borran; agrega usos nuevos y conserva el progreso', () => {
  const card = normalizeCard({
    id: 'a', front: 'le', back: 'el', type: 'artículo', notes: 'n', state: 'review', interval: 9, ease: 2.2,
    examples: [{ fr: 'Le chat.', es: 'El gato.', use: '' }],
  });
  const { card: m, changed } = mergeIntoCard(card, {
    back: 'el; lo', type: '', notes: '',
    examples: [{ fr: 'Le chat.', es: '', use: 'artículo' }, { fr: 'Je le vois.', es: 'Lo veo.', use: 'pronombre' }],
  });
  assert.ok(changed);
  assert.equal(m.back, 'el; lo');
  assert.equal(m.type, 'artículo');
  assert.equal(m.notes, 'n');
  assert.deepEqual(m.examples, [
    { fr: 'Le chat.', es: 'El gato.', use: 'artículo' },
    { fr: 'Je le vois.', es: 'Lo veo.', use: 'pronombre' },
  ]);
  assert.equal(m.state, 'review');
  assert.equal(m.interval, 9);
  assert.equal(mergeIntoCard(m, { back: 'el; lo', examples: [{ fr: 'Je le vois.' }] }).changed, false);
});

test('planImport: nuevas, actualizadas, sin cambios y repetidas', () => {
  const existing = [
    normalizeCard({ id: '1', front: 'être', back: 'ser' }),
    normalizeCard({ id: '2', front: 'avoir', back: 'tener' }),
  ];
  const incoming = [
    { front: 'Être', back: 'ser, estar', examples: [] },
    { front: 'avoir', back: 'tener', examples: [] },
    { front: 'aller', back: 'ir', examples: [] },
    { front: 'aller', back: 'ir', examples: [] },
  ];
  const p = planImport(incoming, existing, 'update');
  assert.equal(p.toAdd.length, 1);
  assert.equal(p.toUpdate.length, 1);
  assert.equal(p.toUpdate[0].id, '1');
  assert.equal(p.toUpdate[0].back, 'ser, estar');
  assert.equal(p.unchanged, 1);
  assert.equal(p.duplicates, 1);
  const a = planImport(incoming, existing, 'add');
  assert.equal(a.toAdd.length, 1);
  assert.equal(a.toUpdate.length, 0);
  assert.equal(a.unchanged, 2);
});

test('planImport: fila sin reverso actualiza una existente pero no crea una nueva', () => {
  const existing = [normalizeCard({ id: '1', front: 'être', back: 'ser' })];
  const p = planImport(
    [
      { front: 'être', back: '', examples: [{ fr: 'Je suis.', es: 'Soy.', use: '' }] },
      { front: 'aller', back: '', examples: [] },
    ],
    existing,
  );
  assert.equal(p.toUpdate.length, 1);
  assert.equal(p.toUpdate[0].back, 'ser');
  assert.equal(p.toUpdate[0].examples.length, 1);
  assert.equal(p.toAdd.length, 0);
  assert.equal(p.invalid, 1);
});
