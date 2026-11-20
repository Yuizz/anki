import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, detectDelimiter, detectFormat, rowsToCards, dedupe, cardsToCSV, TEMPLATE_CSV, headerField } from '../csv.js';

const FIXTURE = `Frances,Espanol,Tipo,Ejemplo,Ejemplo_ES
"le, la, les","el, la, los/las (artículo); lo, la, los (pronombre)",artículo / pronombre,Le chat dort sur la chaise.,El gato duerme en la silla.
être,"ser, estar",verbo,Je suis ingénieur.,Soy ingeniero.
aujourd'hui,hoy,adverbio,"Aujourd'hui, il fait froid.",Hoy hace frío.
`;

function importFixture(text) {
  const { rows } = parseCSV(text);
  const det = detectFormat(rows);
  return { det, cards: rowsToCards(rows, det.mapping, det.hasHeader) };
}

test('fixture: 3 tarjetas con comas y comillas bien interpretadas', () => {
  const { det, cards } = importFixture(FIXTURE);
  assert.equal(det.format, 'principal');
  assert.equal(cards.length, 3);
  assert.deepEqual(cards[0], {
    front: 'le, la, les',
    back: 'el, la, los/las (artículo); lo, la, los (pronombre)',
    type: 'artículo / pronombre',
    notes: '',
    examples: [{ fr: 'Le chat dort sur la chaise.', es: 'El gato duerme en la silla.', use: '' }],
    example: 'Le chat dort sur la chaise.',
    exampleTranslation: 'El gato duerme en la silla.',
  });
  assert.equal(cards[1].front, 'être');
  assert.equal(cards[1].back, 'ser, estar');
  assert.equal(cards[2].front, "aujourd'hui");
  assert.equal(cards[2].example, "Aujourd'hui, il fait froid.");
  assert.equal(cards[2].exampleTranslation, 'Hoy hace frío.');
});

test('fixture: el separador es coma aunque haya punto y coma dentro de comillas', () => {
  assert.equal(detectDelimiter(FIXTURE), ',');
});

test('reimportar el fixture: 0 nuevas y 3 omitidas', () => {
  const first = dedupe(importFixture(FIXTURE).cards, []);
  assert.equal(first.toAdd.length, 3);
  assert.equal(first.skipped, 0);
  const existing = first.toAdd.map((c) => c.front);
  const second = dedupe(importFixture(FIXTURE).cards, existing);
  assert.equal(second.toAdd.length, 0);
  assert.equal(second.skipped, 3);
});

test('duplicados dentro del mismo archivo se omiten', () => {
  const r = dedupe([{ front: 'chat', back: 'gato' }, { front: ' Chat ', back: 'gato' }, { front: 'chien', back: 'perro' }], []);
  assert.equal(r.toAdd.length, 2);
  assert.equal(r.skipped, 1);
});

test('UTF-8 con BOM y CRLF', () => {
  const text = '﻿Frances,Espanol\r\nêtre,"ser, estar"\r\navoir,tener\r\n';
  const { cards, det } = importFixture(text);
  assert.equal(det.format, 'principal');
  assert.deepEqual(
    cards.map((c) => [c.front, c.back]),
    [
      ['être', 'ser, estar'],
      ['avoir', 'tener'],
    ],
  );
});

test('saltos de línea y comillas escapadas dentro de un campo', () => {
  const { rows } = parseCSV('a,"línea 1\nlínea 2"\r\nb,"dice ""hola"""\n');
  assert.deepEqual(rows, [
    ['a', 'línea 1\nlínea 2'],
    ['b', 'dice "hola"'],
  ]);
});

test('detecta tabulador y punto y coma', () => {
  const tsv = 'chat\tgato\tsustantivo\nchien\tperro\tsustantivo\n';
  assert.equal(detectDelimiter(tsv), '\t');
  assert.deepEqual(parseCSV(tsv).rows[1], ['chien', 'perro', 'sustantivo']);
  const ssv = 'chat;gato, felino\nchien;perro\n';
  assert.equal(detectDelimiter(ssv), ';');
  assert.deepEqual(parseCSV(ssv).rows[0], ['chat', 'gato, felino']);
});

test('formato genérico: columna 1 frente, columna 2 reverso, sin encabezado', () => {
  const { rows } = parseCSV('chat,gato\nchien,perro\n');
  const det = detectFormat(rows);
  assert.equal(det.format, 'generico');
  assert.equal(det.hasHeader, false);
  assert.equal(det.mapping.front, 0);
  assert.equal(det.mapping.back, 1);
  const cards = rowsToCards(rows, det.mapping, det.hasHeader);
  assert.deepEqual(
    cards.map((c) => [c.front, c.back]),
    [
      ['chat', 'gato'],
      ['chien', 'perro'],
    ],
  );
});

test('encabezado con acentos y mayúsculas se reconoce', () => {
  const { rows } = parseCSV('Francés;Español;Tipo;Ejemplo;Ejemplo ES\nchat;gato;sust.;Le chat.;El gato.\n');
  const det = detectFormat(rows);
  assert.equal(det.format, 'principal');
  const [c] = rowsToCards(rows, det.mapping, true);
  assert.equal(c.exampleTranslation, 'El gato.');
});

test('filas vacías se ignoran; sin reverso no se agregan como nuevas; sin salto final', () => {
  const { rows } = parseCSV('chat,gato\n\nsolo\nchien,perro');
  const cards = rowsToCards(rows, { front: 0, back: 1 }, false);
  assert.equal(cards.length, 3);
  const r = dedupe(cards, []);
  assert.equal(r.toAdd.length, 2);
  assert.equal(r.skipped, 1);
});

test('formato 1.1: varios usos numerados, etiquetas y notas', () => {
  const text = 'Frances,Espanol,Tipo,Ejemplo,Ejemplo_ES,Uso,Ejemplo2,Ejemplo2_ES,Uso2,Ejemplo 3,Ejemplo 3 ES,Notas\n' +
    'le,"el; lo",artículo / pronombre,Le chat dort.,El gato duerme.,artículo,Je le vois.,Lo veo.,pronombre,,,Delante de vocal: l’\n';
  const { rows } = parseCSV(text);
  const det = detectFormat(rows);
  assert.equal(det.format, 'principal');
  assert.equal(det.mapping.examples.length, 3);
  const [c] = rowsToCards(rows, det.mapping, true);
  assert.deepEqual(c.examples, [
    { fr: 'Le chat dort.', es: 'El gato duerme.', use: 'artículo' },
    { fr: 'Je le vois.', es: 'Lo veo.', use: 'pronombre' },
  ]);
  assert.equal(c.notes, 'Delante de vocal: l’');
  assert.equal(c.example, 'Le chat dort.');
});

test('encabezados de usos: variantes aceptadas', () => {
  assert.deepEqual(headerField('Ejemplo_ES'), { ex: 1, part: 'es' });
  assert.deepEqual(headerField('Ejemplo2_ES'), { ex: 2, part: 'es' });
  assert.deepEqual(headerField('ejemplo 12'), { ex: 12, part: 'fr' });
  assert.deepEqual(headerField('Uso3'), { ex: 3, part: 'use' });
  assert.deepEqual(headerField('Notas'), { field: 'notes' });
  assert.equal(headerField('Otra cosa'), null);
});

test('exportar a CSV y volver a importar da los mismos datos', () => {
  const cards = [
    { front: 'le, la, les', back: 'el "la"', type: 'art.', notes: 'nota\ncon salto', examples: [{ fr: 'A, b', es: 'c', use: 'x' }, { fr: 'D', es: '', use: '' }] },
    { front: 'être', back: 'ser', type: '', notes: '', examples: [] },
  ];
  const { rows } = parseCSV(cardsToCSV(cards));
  const det = detectFormat(rows);
  const back = rowsToCards(rows, det.mapping, det.hasHeader);
  assert.deepEqual(back.map(({ front, back, type, notes, examples }) => ({ front, back, type, notes, examples })), cards);
});

test('la plantilla se importa con varios usos', () => {
  const { rows } = parseCSV(TEMPLATE_CSV);
  const det = detectFormat(rows);
  const cards = rowsToCards(rows, det.mapping, det.hasHeader);
  assert.equal(cards.length, 3);
  assert.equal(cards[1].examples.length, 3);
});
