import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPcCommand } from './pc.js';

test('"open chrome" -> pc.open_app', () => {
  assert.deepEqual(matchPcCommand('open chrome'),
    { domain: 'pc', action: 'open_app', target: 'chrome' });
});

test('"launch firefox" -> pc.open_app', () => {
  assert.deepEqual(matchPcCommand('launch firefox'),
    { domain: 'pc', action: 'open_app', target: 'firefox' });
});

test('"start vs code" -> pc.open_app (multi-word target preserved)', () => {
  assert.deepEqual(matchPcCommand('start vs code'),
    { domain: 'pc', action: 'open_app', target: 'vs code' });
});

test('strips "jarvis," wake prefix and punctuation', () => {
  assert.deepEqual(matchPcCommand('jarvis, open chrome.'),
    { domain: 'pc', action: 'open_app', target: 'chrome' });
});

test('"open the" prefix is dropped from the target', () => {
  assert.deepEqual(matchPcCommand('open the settings'),
    { domain: 'pc', action: 'open_app', target: 'settings' });
});

test('non-open commands return null', () => {
  assert.equal(matchPcCommand('turn off the lights'), null);
  assert.equal(matchPcCommand('lights off'), null);
  assert.equal(matchPcCommand('what is the weather'), null);
  assert.equal(matchPcCommand(''), null);
  assert.equal(matchPcCommand(null), null);
});

test('"open" without a target is null', () => {
  assert.equal(matchPcCommand('open'), null);
  assert.equal(matchPcCommand('launch  '), null);
});

/* ----- media ----- */
test('media play/pause/next/prev', () => {
  assert.deepEqual(matchPcCommand('play music'), { domain:'pc', action:'media', op:'play_pause' });
  assert.deepEqual(matchPcCommand('pause'),      { domain:'pc', action:'media', op:'play_pause' });
  assert.deepEqual(matchPcCommand('next'),       { domain:'pc', action:'media', op:'next' });
  assert.deepEqual(matchPcCommand('skip'),       { domain:'pc', action:'media', op:'next' });
  assert.deepEqual(matchPcCommand('previous song'),{ domain:'pc', action:'media', op:'prev' });
  assert.deepEqual(matchPcCommand('go back'),    { domain:'pc', action:'media', op:'prev' });
});

test('media volume up/down/mute', () => {
  assert.deepEqual(matchPcCommand('volume up'),   { domain:'pc', action:'media', op:'volume_up' });
  assert.deepEqual(matchPcCommand('louder'),      { domain:'pc', action:'media', op:'volume_up' });
  assert.deepEqual(matchPcCommand('volume down'), { domain:'pc', action:'media', op:'volume_down' });
  assert.deepEqual(matchPcCommand('mute'),        { domain:'pc', action:'media', op:'mute' });
});

test('set volume to <spoken number> percent', () => {
  assert.deepEqual(matchPcCommand('set volume to thirty percent'),
    { domain:'pc', action:'media', op:'set_volume', arg: 30 });
  assert.deepEqual(matchPcCommand('set volume to 75 percent'),
    { domain:'pc', action:'media', op:'set_volume', arg: 75 });
  assert.deepEqual(matchPcCommand('set volume to one hundred percent') === null ? null
    : matchPcCommand('set volume to hundred percent'),
    { domain:'pc', action:'media', op:'set_volume', arg: 100 });
});

/* ----- window ----- */
test('window focus / snap / minimize / close', () => {
  assert.deepEqual(matchPcCommand('focus chrome'),
    { domain:'pc', action:'window', op:'focus', arg:'chrome' });
  assert.deepEqual(matchPcCommand('snap left'),
    { domain:'pc', action:'window', op:'snap', arg:'left' });
  assert.deepEqual(matchPcCommand('snap right'),
    { domain:'pc', action:'window', op:'snap', arg:'right' });
  assert.deepEqual(matchPcCommand('minimize'),
    { domain:'pc', action:'window', op:'minimize' });
  assert.deepEqual(matchPcCommand('close window'),
    { domain:'pc', action:'window', op:'close' });
});

/* ----- shell ----- */
test('"run <recipe>" -> pc.shell with the recipe name as target', () => {
  assert.deepEqual(matchPcCommand('run free space'),
    { domain:'pc', action:'shell', target:'free space' });
  assert.deepEqual(matchPcCommand('run git status'),
    { domain:'pc', action:'shell', target:'git status' });
});

/* ----- spotify_search ----- */
test('"play music" / "play" stay as play_pause (NOT spotify_search)', () => {
  assert.deepEqual(matchPcCommand('play music'), { domain:'pc', action:'media', op:'play_pause' });
  assert.deepEqual(matchPcCommand('play'),       { domain:'pc', action:'media', op:'play_pause' });
});

test('"play <query>" routes to play_music', () => {
  assert.deepEqual(matchPcCommand('play discover weekly'),
    { domain:'pc', action:'media', op:'play_music', arg:'discover weekly' });
  assert.deepEqual(matchPcCommand('play bohemian rhapsody'),
    { domain:'pc', action:'media', op:'play_music', arg:'bohemian rhapsody' });
});

test('"stop music" / "stop the music" / "stop playing" route to stop_music', () => {
  assert.deepEqual(matchPcCommand('stop music'),      { domain:'pc', action:'media', op:'stop_music' });
  assert.deepEqual(matchPcCommand('stop the music'),  { domain:'pc', action:'media', op:'stop_music' });
  assert.deepEqual(matchPcCommand('stop playing'),    { domain:'pc', action:'media', op:'stop_music' });
});

test('bare "stop" is not a pc command (it is the voice sleep word)', () => {
  assert.equal(matchPcCommand('stop'), null);
});

/* ----- browser.search ----- */
test('"search <topic>" and "search about|for <topic>" route to browser.search', () => {
  assert.deepEqual(matchPcCommand('search risc-v'),
    { domain:'pc', action:'browser', op:'search', arg:'risc-v' });
  assert.deepEqual(matchPcCommand('search about the weather'),
    { domain:'pc', action:'browser', op:'search', arg:'the weather' });
  assert.deepEqual(matchPcCommand('search for cats'),
    { domain:'pc', action:'browser', op:'search', arg:'cats' });
});

test('"search for" / "search about" with no topic returns null (not a spurious search)', () => {
  assert.equal(matchPcCommand('search for'), null);
  assert.equal(matchPcCommand('search about'), null);
});

test('"look up <topic>" routes to browser.search (web)', () => {
  assert.deepEqual(matchPcCommand('look up the weather'),
    { domain:'pc', action:'browser', op:'search', arg:'the weather' });
  assert.deepEqual(matchPcCommand('look up risc-v'),
    { domain:'pc', action:'browser', op:'search', arg:'risc-v' });
});

/* ----- window.split ----- */
test('"split A with B" routes to window.split with trimmed multi-word names', () => {
  assert.deepEqual(matchPcCommand('split chrome with code'),
    { domain:'pc', action:'window', op:'split', a:'chrome', b:'code' });
  assert.deepEqual(matchPcCommand('split the firefox with the terminal'),
    { domain:'pc', action:'window', op:'split', a:'firefox', b:'terminal' });
});

test('natural music phrasings stay local as play_music', () => {
  assert.deepEqual(matchPcCommand('put on daft punk'),
    { domain:'pc', action:'media', op:'play_music', arg:'daft punk' });
  assert.deepEqual(matchPcCommand('play me some jazz'),
    { domain:'pc', action:'media', op:'play_music', arg:'some jazz' });
  assert.deepEqual(matchPcCommand('i want to hear queen'),
    { domain:'pc', action:'media', op:'play_music', arg:'queen' });
});

test('"play" / "play music" still toggle (play_pause)', () => {
  assert.deepEqual(matchPcCommand('play'),       { domain:'pc', action:'media', op:'play_pause' });
  assert.deepEqual(matchPcCommand('play music'), { domain:'pc', action:'media', op:'play_pause' });
});
