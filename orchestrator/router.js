// Turns an intent into board actions and a spoken sentence.
// `board` is an Esp32Switch (set/allOff throw when unreachable; isOn is cached).

const REMOTE_MEDIA_OPS = new Set(['play_pause', 'next', 'prev', 'volume_up', 'volume_down', 'mute']);

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function remoteSpeak(r, machine) {
  if (r.ok) return { ok: true, speak: r.detail || `Done on ${machine}.` };
  const unreachable = !r.detail || r.detail === 'unreachable';
  return { ok: false, speak: unreachable ? `I couldn't reach the ${machine}.` : r.detail };
}

async function _route(intent, { board, registry, openApp, media, window: win, browser, music, knowledge, vision, agentClient, pcAgents } = {}) {
  if (intent.domain === 'ask') {
    if (!knowledge) return { ok: false, speak: 'Knowledge capability not configured.' };
    return knowledge.answer(intent.query);
  }
  if (intent.domain === 'vision') {
    if (!vision) return { ok: false, speak: 'Vision capability not configured.' };
    return vision.look({ source: intent.source, query: intent.query });
  }
  // PC domain: each sub-action goes to its injected capability.
  if (intent.domain === 'pc') {
    if (intent.action === 'open_app') {
      if (intent.machine) {
        const a = pcAgents?.get?.(intent.machine);
        if (!a) return { ok: false, speak: `I don't know a PC called ${intent.machine}.` };
        if (!agentClient) return { ok: false, speak: 'PC agent client not configured.' };
        const r = await agentClient.run(a.base_url, { capability: 'apps', action: 'open', params: { name: intent.target } });
        return remoteSpeak(r, intent.machine);
      }
      if (!openApp) return { ok: false, speak: 'PC capability not configured.' };
      return openApp({ name: intent.target });
    }
    if (intent.action === 'media') {
      if (intent.machine) {
        if (!REMOTE_MEDIA_OPS.has(intent.op)) return { ok: false, speak: `I can't do that on the ${intent.machine} yet.` };
        const a = pcAgents?.get?.(intent.machine);
        if (!a) return { ok: false, speak: `I don't know a PC called ${intent.machine}.` };
        if (!agentClient) return { ok: false, speak: 'PC agent client not configured.' };
        const r = await agentClient.run(a.base_url, { capability: 'media', action: intent.op, params: {} });
        return remoteSpeak(r, intent.machine);
      }
      const nc = (w) => ({ ok: false, speak: `${w} capability not configured.` });
      switch (intent.op) {
        case 'play_music':   return music ? music.play({ query: intent.arg }) : nc('Music');
        case 'play_pause':   return music ? music.pauseResume() : nc('Music');
        case 'stop_music':   return music ? music.stop() : nc('Music');
        case 'next':         return media ? media.next() : nc('Media');
        case 'prev':         return media ? media.prev() : nc('Media');
        case 'volume_up':    return media ? media.volumeUp() : nc('Media');
        case 'volume_down':  return media ? media.volumeDown() : nc('Media');
        case 'mute':         return media ? media.mute() : nc('Media');
        case 'set_volume':   return media ? media.setVolume(intent.arg) : nc('Media');
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
        case 'split':    return win.splitWith({ a: intent.a, b: intent.b }, { openApp });
        case 'list':     return win.list();
        default:         return { ok: false, speak: "I don't know how to do that." };
      }
    }
    if (intent.action === 'browser') {
      if (!browser) return { ok: false, speak: 'Browser capability not configured.' };
      if (intent.op === 'search') return browser.search({ query: intent.arg });
      return { ok: false, speak: "I don't know how to do that." };
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

export async function route(intent, deps = {}) {
  const result = await _route(intent, deps);
  if (result?.ok && deps?.persona) {
    const quip = deps.persona.phrase(intent);
    if (quip) return { ...result, speak: quip };
  }
  return result;
}
