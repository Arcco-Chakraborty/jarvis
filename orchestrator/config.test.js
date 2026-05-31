import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertEsp32Configured, parseGeminiKeys } from './config.js';

test('assertEsp32Configured throws when baseUrl is missing', () => {
  assert.throws(
    () => assertEsp32Configured({ esp32: { baseUrl: undefined } }),
    /ESP32_BASE_URL is required/,
  );
});

test('assertEsp32Configured passes when baseUrl is set', () => {
  assert.doesNotThrow(
    () => assertEsp32Configured({ esp32: { baseUrl: 'http://192.168.0.202' } }),
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
