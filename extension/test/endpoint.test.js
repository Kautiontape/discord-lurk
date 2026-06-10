const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeEndpoint, catchupUrl, originPatternFor } = require('../lib/endpoint.js');

test('strips trailing slashes', () => {
  assert.strictEqual(normalizeEndpoint('http://localhost:8111/'), 'http://localhost:8111');
  assert.strictEqual(normalizeEndpoint('https://lurk.kautiontape.com//'), 'https://lurk.kautiontape.com');
});

test('adds http:// when scheme is missing', () => {
  assert.strictEqual(normalizeEndpoint('localhost:8111'), 'http://localhost:8111');
});

test('returns null for empty/invalid', () => {
  assert.strictEqual(normalizeEndpoint(''), null);
  assert.strictEqual(normalizeEndpoint('   '), null);
});

test('builds the catchup url', () => {
  assert.strictEqual(catchupUrl('http://localhost:8111'), 'http://localhost:8111/api/catchup');
  assert.strictEqual(catchupUrl(''), null);
});

test('builds a port-less origin match pattern', () => {
  assert.strictEqual(originPatternFor('http://localhost:8111'), 'http://localhost/*');
  assert.strictEqual(originPatternFor('https://lurk.kautiontape.com'), 'https://lurk.kautiontape.com/*');
});
