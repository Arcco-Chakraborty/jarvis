// PC capability: vision — capture an image (phone or screen) then ask Gemini
// about it. capture fns + describe are injected (see capture.js, vision-answer.js).
export function makeVision({ phone, screen, describe } = {}) {
  return {
    async look({ source, query } = {}) {
      const cap = source === 'screen' ? screen : phone;
      const shot = await cap();
      if (!shot.ok) return { ok: false, speak: shot.speak };
      // describe() already returns the { ok, speak } shape the router expects.
      return describe(query, shot.data, shot.mime);
    },
  };
}
