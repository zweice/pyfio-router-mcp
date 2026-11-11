// A small validator for the subset of JSON Schema that the tool definitions use: type (string, integer,
// number, boolean, array, object), required, additionalProperties false, properties, items, enum, minimum,
// maximum, minLength, maxLength. Deterministic; the messages name properties and constraints, never values.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOk(t, v) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return isObj(v);
    default: return true;
  }
}

// -> array of messages, empty = valid.
export function validate(schema, value, at = 'arguments') {
  const out = [];
  if (!schema) return out;
  if (schema.type && !typeOk(schema.type, value)) return [`${at}: type ${schema.type} expected`];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: not one of the allowed values`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: above maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (isObj(value) && (schema.properties || schema.required || schema.additionalProperties === false)) {
    for (const k of schema.required || []) if (value[k] === undefined) out.push(`${at}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (schema.properties?.[k]) out.push(...validate(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${k.slice(0, 40)}: not allowed`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => { if (i < 50) out.push(...validate(schema.items, v, `${at}[${i}]`)); });
  return out;
}
