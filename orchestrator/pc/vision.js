// PC capability: vision — capture an image (camera or screen) then ask Gemini
// about it. capture fns + describe are injected (see capture.js, vision-answer.js).
export function makeVision({ camera, screen, describe } = {}) {
  return {
    async look({ source, query } = {}) {
      const cap = source === 'screen' ? screen : camera;
      const shot = await cap();
      if (!shot.ok) return { ok: false, speak: shot.speak };
      const speak = await describe(query, shot.data, shot.mime);
      return { ok: true, speak };
    },
  };
}
