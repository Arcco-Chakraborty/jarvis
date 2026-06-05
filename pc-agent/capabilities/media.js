// Agent capability: media — send Windows media/volume keys via keybd_event
// (controls whatever app currently has media-key focus).
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };
const VK = { play_pause: '0xB3', next: '0xB0', prev: '0xB1', volume_up: '0xAF', volume_down: '0xAE', mute: '0xAD' };

function press(spawn, vk) {
  const script =
    "$s='[DllImport(\"user32.dll\")]public static extern void keybd_event(byte b,byte s,uint f,IntPtr e);';" +
    "$k=Add-Type -MemberDefinition $s -Name K -Namespace W -PassThru;" +
    `$k::keybd_event(${vk},0,0,[IntPtr]::Zero);` +
    `$k::keybd_event(${vk},0,2,[IntPtr]::Zero);`;
  try {
    const p = spawn('powershell', ['-NoProfile', '-Command', script], OPTS);
    p?.unref?.();
    return { ok: true, detail: 'Done.' };
  } catch {
    return { ok: false, detail: "I couldn't do that." };
  }
}

function setVolume(spawn, level) {
  const lvl = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  const ups = Math.round(lvl / 2); // each VK_VOLUME_UP ≈ 2%
  const script =
    "$s='[DllImport(\"user32.dll\")]public static extern void keybd_event(byte b,byte s,uint f,IntPtr e);';" +
    '$k=Add-Type -MemberDefinition $s -Name K -Namespace W -PassThru;' +
    'function vk($c){$k::keybd_event($c,0,0,[IntPtr]::Zero);$k::keybd_event($c,0,2,[IntPtr]::Zero)}' +
    '1..50 | % { vk 0xAE };' +
    `1..${ups} | % { vk 0xAF };`;
  try {
    const p = spawn('powershell', ['-NoProfile', '-Command', script], OPTS);
    p?.unref?.();
    return { ok: true, detail: `Volume set to ${lvl}.` };
  } catch {
    return { ok: false, detail: "I couldn't set the volume." };
  }
}

export function makeMedia({ spawn = _spawn } = {}) {
  const actions = {};
  for (const [name, vk] of Object.entries(VK)) actions[name] = () => press(spawn, vk);
  actions.set_volume = ({ level } = {}) => setVolume(spawn, level);
  return { name: 'media', actions };
}
