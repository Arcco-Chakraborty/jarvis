// Offline persona quips for control confirmations. phrase(intent) -> a witty
// line for a recognised control success, or null to keep the plain response.
// Small and curated on purpose; no API calls.

function cap(s) {
  return String(s ?? '').charAt(0).toUpperCase() + String(s ?? '').slice(1);
}

export function phrase(intent) {
  if (!intent) return null;
  const { domain, action, target } = intent;
  if (domain === 'switch') {
    if (action === 'all_off') return 'Powering down. Good night, sir.';
    if (action === 'all_on') return 'Everything is online.';
    if (action === 'off' && target) return `${cap(target)} powered down.`;
    if (action === 'on' && target) return `${cap(target)} online.`;
  }
  if (domain === 'pc' && action === 'media' && intent.op === 'play_music') {
    return 'Spinning it up.';
  }
  return null;
}
