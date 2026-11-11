// Canonical JSON (RFC 8785 subset): the bytes that are signed and hashed must be the same on every side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kanonisch, kanonischSha256, sha256Hex } from '../src/urteil/kanonisch.mjs';

test('keys are sorted recursively, no white space', () => {
  assert.equal(kanonisch({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(kanonisch({ b: 2, a: 1 }), kanonisch({ a: 1, b: 2 }), 'insertion order does not matter');
  assert.equal(kanonisch([]), '[]');
  assert.equal(kanonisch({}), '{}');
});

test('RFC 8785 section 3.2.3: keys sort by UTF-16 code units', () => {
  const o = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' };
  const keys = [...kanonisch(o).matchAll(/"((?:\\.|[^"\\])*)":"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  assert.deepEqual(keys, ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33']);
});

test('strings and numbers are serialized as ECMAScript does (the base of RFC 8785)', () => {
  assert.equal(kanonisch('a"b\\c\n\u0001\u007f\u2028'), JSON.stringify('a"b\\c\n\u0001\u007f\u2028'));
  assert.equal(kanonisch([1, 1.5, -0, 1e21, 1e-7, 123456789012345680000]), '[1,1.5,0,1e+21,1e-7,123456789012345680000]');
  assert.equal(kanonisch(true) + kanonisch(false) + kanonisch(null), 'truefalsenull');
  assert.equal(kanonisch('\ud800'), '"\\ud800"', 'a lone surrogate is escaped, as JSON.stringify does');
});

test('an undefined property is left out (as JSON.stringify), an undefined array item is null', () => {
  assert.equal(kanonisch({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(kanonisch([undefined, 1]), '[null,1]');
});

test('what is not JSON throws: a signature over it could not be rebuilt', () => {
  for (const bad of [NaN, Infinity, -Infinity, 10n, () => 1, Symbol('x'), undefined, new Date(0), new Map()]) assert.throws(() => kanonisch(bad), TypeError);
  assert.throws(() => kanonisch({ a: NaN }), TypeError);
});

test('a round trip through JSON does not change the canonical form', () => {
  const o = { z: [1, 2, { b: 'x', a: 'y' }], a: 'äöü€', n: 0.1 + 0.2 };
  assert.equal(kanonisch(JSON.parse(JSON.stringify(o))), kanonisch(o));
});

test('sha256 helpers: known vector and canonical hash', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(kanonischSha256({ a: 1 }), sha256Hex('{"a":1}'));
});
