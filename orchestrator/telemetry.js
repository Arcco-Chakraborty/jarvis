// In-memory voice + command telemetry for the dashboard. Not persisted (command_log handles audit).
const MAX = 50;

const STATUS_BY_TYPE = {
  ready: 'listening',
  listening: 'listening',
  awake: 'awake',
  recording: 'recording',
  transcript: 'transcribing',
  idle: 'idle',
};

export function createTelemetry(now = Date.now) {
  const events = [];
  const commands = [];
  const current = { status: 'idle', wakeScore: 0, threshold: 0, lastTranscript: '', lastEventAt: 0 };

  function recordVoiceEvent(event = {}) {
    const type = event.type;
    current.lastEventAt = now();
    if (type === 'wake_score') {
      if (typeof event.score === 'number') current.wakeScore = event.score;
      if (typeof event.threshold === 'number') current.threshold = event.threshold;
    } else {
      if (STATUS_BY_TYPE[type]) current.status = STATUS_BY_TYPE[type];
      if (type === 'transcript' && typeof event.text === 'string') current.lastTranscript = event.text;
    }
    events.unshift({ ...event, ts: current.lastEventAt });
    if (events.length > MAX) events.length = MAX;
  }

  function recordCommand({ text, intent = null, via = null, ok = false, speak = '' } = {}) {
    commands.unshift({ text, intent, via, ok, speak, ts: now() });
    if (commands.length > MAX) commands.length = MAX;
  }

  function voiceSnapshot() {
    const { status, wakeScore, threshold, lastTranscript, lastEventAt } = current;
    return {
      status, wakeScore, threshold, lastTranscript, lastEventAt,
      ageMs: lastEventAt ? now() - lastEventAt : null,
      events: events.slice(0, MAX),
    };
  }

  function recentCommands(n = MAX) {
    return commands.slice(0, n);
  }

  return { recordVoiceEvent, recordCommand, voiceSnapshot, recentCommands };
}
