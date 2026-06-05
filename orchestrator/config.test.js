import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertEsp32Configured, parseGeminiKeys, parsePcAgents } from './config.js';

test('assertEsp32Configured throws when baseUrl is missing', () => {
  assert.throws(
    () => assertEsp32Configured({ esp32: { baseUrl: undefined } }),
    /ESP32_BASE_URL is required/,
  );
});

test('assertEsp32Configured passes when baseUrl is set', () => {
  assert.doesNotThrow(
    () => assertEsp32Configured({ esp32: { baseUrl: 'http://192.168.1.50' } }),
  );
});

test('parseGeminiKeys splits and trims GEMINI_API_KEYS', () => {
  assert.deepEqual(parseGeminiKeys({ GEMINI_API_KEYS: 'a, b ,c' }), ['a', 'b', 'c']);
});
test('parseGeminiKeys falls back to a lone GEMINI_API_KEY', () => {
  assert.deepEqual(parseGeminiKeys({ GEMINI_API_KEY: 'solo' }), ['solo']);
});
test('parseGeminiKeys returns [] when nothing is set', () => {
  assert.deepEqual(parseGeminiKeys({}), []);
});

test('parsePcAgents parses name=url pairs', () => {
  assert.deepEqual(parsePcAgents('desktop=http://x:7000, htpc=http://y:7000'),
    [{ name: 'desktop', baseUrl: 'http://x:7000' }, { name: 'htpc', baseUrl: 'http://y:7000' }]);
});
test('parsePcAgents drops malformed / empty', () => {
  assert.deepEqual(parsePcAgents(''), []);
  assert.deepEqual(parsePcAgents('garbage,desktop='), []);
});
