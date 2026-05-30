// Turns an intent into board actions and a spoken sentence.
// `board` is an Esp32Switch (set/allOff throw when unreachable; isOn is cached).

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function route(intent, { board, registry, openApp, media, window: win } = {}) {
  // PC domain: each sub-action goes to its injected capability.
  if (intent.domain === 'pc') {
    if (intent.action === 'open_app') {
      if (!openApp) return { ok: false, speak: 'PC capability not configured.' };
      return openApp({ name: intent.target });
    }
    if (intent.action === 'media') {
      if (!media) return { ok: false, speak: 'Media capability not configured.' };
      switch (intent.op) {
        case 'play_pause':   return media.playPause();
        case 'next':         return media.next();
        case 'prev':         return media.prev();
        case 'volume_up':    return media.volumeUp();
        case 'volume_down':  return media.volumeDown();
        case 'mute':         return media.mute();
        case 'set_volume':   return media.setVolume(intent.arg);
        default:             return { ok: false, speak: "I don't know how to do that." };
      }
    }
    if (intent.action === 'window') {
      if (!win) return { ok: false, speak: 'Window capability not configured.' };
      switch (intent.op) {
        case 'focus':    return win.focus({ name: intent.arg });
        case 'snap':     return win.snap({ dir: intent.arg });
        case 'minimize': return win.minimize();
        case 'close':    return win.close();
        default:         return { ok: false, speak: "I don't know how to do that." };
      }
    }
    // shell is handled at the server layer (it needs the pending-confirmation slot).
    return { ok: false, speak: "I don't know how to do that." };
  }
  try {
    const groupNames = registry.getGroupNames();

    if (intent.action === 'all_off') {
      await board.allOff();
      return { ok: true, speak: 'Everything is off.' };
    }

    if (intent.action === 'all_on') {
      for (const name of registry.getSwitchNamesByChannel()) {
        await board.set(name, true);
      }
      return { ok: true, speak: 'Everything is on.' };
    }

    if (intent.action === 'all_off_except') {
      const keep = groupNames.includes(intent.target)
        ? new Set(registry.getSwitchNamesByGroup(intent.target))
        : new Set([intent.target]);
      const channels =
        intent.scope && groupNames.includes(intent.scope)
          ? registry.getSwitchNamesByGroup(intent.scope)
          : registry.getSwitchNamesByChannel();
      for (const name of channels) {
        if (!keep.has(name)) await board.set(name, false);
      }
      const scopeLabel = intent.scope && groupNames.includes(intent.scope)
        ? capitalize(intent.scope)
        : 'Everything';
      return { ok: true, speak: `${scopeLabel} off, except ${capitalize(intent.target)}.` };
    }

    if (intent.action === 'keep_only') {
      const isGroup = groupNames.includes(intent.target);
      const keep = isGroup
        ? new Set(registry.getSwitchNamesByGroup(intent.target))
        : new Set([intent.target]);
      for (const name of registry.getSwitchNamesByChannel()) {
        await board.set(name, keep.has(name));
      }
      return { ok: true, speak: `Only ${capitalize(intent.target)} ${isGroup ? 'are' : 'is'} on.` };
    }

    if (intent.action === 'status') {
      const state = board.isOn(intent.target);
      if (state === undefined) {
        return { ok: true, speak: "I haven't reached the smart switch yet." };
      }
      return { ok: true, speak: `The ${intent.target} is ${state ? 'on' : 'off'}.` };
    }

    // on / off
    const on = intent.action === 'on';
    if (groupNames.includes(intent.target)) {
      for (const name of registry.getSwitchNamesByGroup(intent.target)) {
        await board.set(name, on);
      }
      return { ok: true, speak: `${capitalize(intent.target)} are ${on ? 'on' : 'off'}.` };
    }
    await board.set(intent.target, on);
    return { ok: true, speak: `${capitalize(intent.target)} is ${on ? 'on' : 'off'}.` };
  } catch {
    return { ok: false, speak: "I couldn't reach the smart switch." };
  }
}
