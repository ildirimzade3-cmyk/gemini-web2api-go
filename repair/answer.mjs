// Pure helpers around the answer text: classifying UI messages (rate limit,
// sign-in wall, generic failure), JSON extraction and the canary comparison.

/** Lower-cases and strips everything but letters and digits ("Pong." -> "pong"). */
export function normalizeWord(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function canaryMatches(answer, expect = 'pong') {
  return normalizeWord(answer) === normalizeWord(expect);
}

// Alerts, snackbars and dialogs are short system messages, so a loose match is safe there.
const ALERT_RATE_LIMIT = /(limit|try again (later|tomorrow|in)|too many requests|quota)/i;
const ALERT_SIGN_IN = /(sign in to (continue|use|try)|you need to sign in|please sign in)/i;
const ALERT_FAILURE = /(something went wrong|an error occurred|there was an error|couldn[’']t (complete|generate|process)|having trouble)/i;

// A model answer is free text, so only short answers that read like a system message count.
const ANSWER_MAX = 400;
const ANSWER_RATE_LIMIT =
  /(you(?:[’']ve| have) reached (?:your|the)[\w\s-]{0,40}limit|usage limit|try again (?:later|tomorrow|in \d)|too many requests|exceeded (?:your|the)[\w\s]{0,30}(?:limit|quota))/i;
const ANSWER_FAILURE = /^(?:sorry,? )?(?:something went wrong|there was an error|an error occurred)/i;

/**
 * Classifies a UI message. `source` is "alert" (snackbar / dialog text) or
 * "answer" (the model answer text). Returns "rate_limited", "sign_in_required",
 * "failure" or null.
 */
export function classifyUiMessage(text, source = 'alert') {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (source === 'answer') {
    if (t.length > ANSWER_MAX) return null;
    if (ANSWER_RATE_LIMIT.test(t)) return 'rate_limited';
    if (ANSWER_FAILURE.test(t)) return 'failure';
    return null;
  }
  if (ALERT_RATE_LIMIT.test(t)) return 'rate_limited';
  if (ALERT_SIGN_IN.test(t)) return 'sign_in_required';
  if (ALERT_FAILURE.test(t)) return 'failure';
  return null;
}

function tryParse(s) {
  try {
    return { value: JSON.parse(s) };
  } catch {
    return null;
  }
}

/** First balanced {...} or [...] slice of `text` that parses as JSON, or null. */
function findJsonSlice(text) {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        const slice = text.slice(start, i + 1);
        if (tryParse(slice)) return slice;
        break;
      }
    }
  }
  return null;
}

/**
 * Chooses the text to return for a JSON request. Order: the longest code block
 * that parses as JSON, the whole answer, the answer without a ```json fence, the
 * first JSON object / array inside the text. When none parses, the answer text is
 * returned unchanged with `json_valid: false`.
 */
export function pickJsonText(text, codeBlocks = []) {
  const fromBlocks = codeBlocks
    .map((b) => String(b).trim())
    .filter((b) => b && tryParse(b))
    .sort((a, b) => b.length - a.length)[0];
  if (fromBlocks) return { text: fromBlocks, json_valid: true };
  const whole = String(text ?? '').trim();
  if (tryParse(whole)) return { text: whole, json_valid: true };
  const unfenced = whole.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if (unfenced && tryParse(unfenced)) return { text: unfenced, json_valid: true };
  const slice = findJsonSlice(whole);
  if (slice) return { text: slice, json_valid: true };
  return { text: whole, json_valid: false };
}
