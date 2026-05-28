// Turns an intent into board actions and a spoken sentence.
// `board` is an Esp32Switch (set/allOff throw when unreachable; isOn is cached).

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function route(intent, { board, registry }) {
  try {
    if (intent.action === 'all_off') {
      await board.allOff();
      return { ok: true, speak: 'Everything is off.' };
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
    if (registry.getGroupNames().includes(intent.target)) {
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
