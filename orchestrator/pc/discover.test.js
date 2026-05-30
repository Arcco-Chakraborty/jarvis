import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { discoverApps, parseDesktopEntry, stripFieldCodes } from './discover.js';

const FIXTURE = join(import.meta.dirname, 'test-fixtures/desktop');

test('stripFieldCodes removes %f %u %F %U %i %c %k', () => {
  assert.equal(stripFieldCodes('firefox %u'), 'firefox');
  assert.equal(stripFieldCodes('/usr/share/code/code --new-window %F'), '/usr/share/code/code --new-window');
  assert.equal(stripFieldCodes('app %i %c %k %f %u'), 'app');
  assert.equal(stripFieldCodes('wrapper --percent=50%%'), 'wrapper --percent=50%');
});

test('parseDesktopEntry returns {name, exec} for a normal entry', () => {
  const raw = '[Desktop Entry]\nName=Firefox\nExec=firefox %u\nType=Application\n';
  assert.deepEqual(parseDesktopEntry(raw), { name: 'Firefox', exec: 'firefox', hidden: false, type: 'Application' });
});

test('parseDesktopEntry honors NoDisplay=true', () => {
  const raw = '[Desktop Entry]\nName=X\nExec=x\nType=Application\nNoDisplay=true\n';
  assert.equal(parseDesktopEntry(raw).hidden, true);
});

test('parseDesktopEntry honors Hidden=true', () => {
  const raw = '[Desktop Entry]\nName=X\nExec=x\nType=Application\nHidden=true\n';
  assert.equal(parseDesktopEntry(raw).hidden, true);
});

test('parseDesktopEntry returns null when Exec is missing', () => {
  const raw = '[Desktop Entry]\nName=X\nType=Application\n';
  assert.equal(parseDesktopEntry(raw), null);
});

test('parseDesktopEntry returns null when Type is not Application', () => {
  const raw = '[Desktop Entry]\nName=X\nExec=x\nType=Link\nURL=https://x\n';
  assert.equal(parseDesktopEntry(raw), null);
});

test('discoverApps walks a directory and yields {lower(name): exec}', async () => {
  const map = await discoverApps({ dirs: [FIXTURE] });
  assert.equal(map['firefox'], 'firefox');
  assert.equal(map['visual studio code'], '/usr/share/code/code --new-window');
  assert.equal(map['should not show'], undefined, 'NoDisplay entry must be skipped');
});

test('discoverApps tolerates missing directories', async () => {
  const map = await discoverApps({ dirs: ['/nonexistent/path/zz'] });
  assert.deepEqual(map, {});
});

test('discoverApps uses injected readDir + readFile (no real fs access)', async () => {
  const readDir = async (dir) => ['app.desktop', 'noise.txt'];
  const readFile = async (path) => {
    if (path.endsWith('app.desktop')) return '[Desktop Entry]\nName=Stubby\nExec=stubby\nType=Application\n';
    throw new Error('should not read non-.desktop files');
  };
  const map = await discoverApps({ dirs: ['/fake'], readDir, readFile });
  assert.deepEqual(map, { stubby: 'stubby' });
});

test('discoverApps merges entries from multiple dirs (later wins on collision)', async () => {
  let call = 0;
  const readDir = async () => ['firefox.desktop'];
  const readFileFn = async () => {
    call++;
    const exec = call === 1 ? 'first' : 'second';
    return `[Desktop Entry]\nName=Firefox\nExec=${exec}\nType=Application\n`;
  };
  const map = await discoverApps({ dirs: ['/d1', '/d2'], readDir, readFile: readFileFn });
  assert.equal(map['firefox'], 'second');
});
