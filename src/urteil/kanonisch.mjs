// Canonical JSON: a subset of RFC 8785 (JSON Canonicalization Scheme) that is enough for the verdict.
// Object keys sorted (by UTF-16 code units, as RFC 8785 says), no white space, strings and numbers
// exactly as ECMAScript serializes them (RFC 8785 is built on that). Only JSON data: null, booleans,
// finite numbers, strings, arrays, plain objects. A property whose value is undefined is left out (as
// JSON.stringify does, so a verdict over an object that travels as JSON stays the same after the trip);
// everything else that is not JSON (NaN, Infinity, BigInt, functions, symbols) throws a TypeError, because
// a signature over something that cannot be rebuilt by the other side is worth nothing.
import crypto from 'node:crypto';

export function kanonisch(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonical JSON: number must be finite');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : kanonisch(x))).join(',')}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('canonical JSON: plain objects only');
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${kanonisch(v[k])}`).join(',')}}`;
    }
    default: throw new TypeError(`canonical JSON: ${typeof v} is not JSON`);
  }
}

export const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
// sha-256 of the canonical JSON of a value, lower-case hex.
export const kanonischSha256 = (v) => sha256Hex(kanonisch(v));
