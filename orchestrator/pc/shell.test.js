import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShell } from './shell.js';

const RECIPES = {
  'free space': 'df -h /',
  'update system': 'sudo apt update',
};

test('lookup() resolves a recipe name to its shell command', () => {
  const s = makeShell({ recipes: RECIPES });
  assert.equal(s.lookup('free space'), 'df -h /');
  assert.equal(s.lookup('  Free Space '), 'df -h /');  // case/whitespace tolerant
  assert.equal(s.lookup('not-a-recipe'), null);
});

test('execute() spawns sh -c with the command and reports ok:true', () => {
  const calls = [];
  const proc = { unref: () => {} };
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; };
  const s = makeShell({ recipes: RECIPES, spawn });
  const r = s.execute('df -h /');
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], { bin: 'sh', args: ['-c', 'df -h /'], opts: { detached: true, stdio: 'ignore' } });
});

test('execute() with an empty command refuses', () => {
  const s = makeShell({ recipes: RECIPES, spawn: () => ({ unref: () => {} }) });
  assert.equal(s.execute('').ok, false);
  assert.equal(s.execute(null).ok, false);
});

test('execute() catches spawn errors', () => {
  const s = makeShell({ recipes: RECIPES, spawn: () => { throw new Error('ENOENT'); } });
  const r = s.execute('df -h /');
  assert.equal(r.ok, false);
  assert.match(r.speak, /couldn'?t/i);
});
