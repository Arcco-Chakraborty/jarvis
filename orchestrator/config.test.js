import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertEsp32Configured } from './config.js';

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
