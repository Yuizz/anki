import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, detectDelimiter, detectFormat, rowsToCards, dedupe } from '../csv.js';

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
  const r = dedupe([{ front: 'chat' }, { front: ' Chat ' }, { front: 'chien' }], []);
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

test('filas vacías y sin reverso se ignoran; sin salto final', () => {
  const { rows } = parseCSV('chat,gato\n\nsolo\nchien,perro');
  const cards = rowsToCards(rows, { front: 0, back: 1 }, false);
  assert.equal(cards.length, 2);
});
