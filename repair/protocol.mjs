// Pure helpers for the gemini.google.com StreamGenerate protocol: parsing a
// captured browser request, building the "learned" template and rendering it
// back into a request. No network, no browser, no secrets handling beyond the
// final assertNoSecrets() guard.

export const PROMPT_PLACEHOLDER = '__PROMPT__';
export const UUID_PLACEHOLDER = '__UUID__';
export const INNER_PLACEHOLDER = '__INNER__';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_FULL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Conversation / response / candidate ids: c_<hex>, r_<hex>, rc_<hex>.
const CONV_ID_RE = /^(?:c|r|rc)_[0-9a-f]{8,}$/i;
const HEADER_KEEP_RE = /^(?:x-goog-ext-[\w-]+|x-same-domain)$/i;
// Query parameters that are per-request or per-session and must not be replayed.
const QUERY_DROP = ['_reqid', 'f.sid'];

export function isStreamGenerateUrl(u) {
  return /\/StreamGenerate(?:\?|$)/.test(u);
}

/** Splits a StreamGenerate URL into endpoint path, bl and replayable query. */
export function parseEndpoint(urlStr) {
  const u = new URL(urlStr);
  const query = {};
  const dropped = [];
  for (const [k, v] of u.searchParams) {
    if (QUERY_DROP.includes(k)) dropped.push(k);
    else query[k] = v;
  }
  return { endpoint_path: u.pathname, bl: query.bl ?? null, query, query_dropped: dropped };
}

/**
 * Parses the x-www-form-urlencoded body of a StreamGenerate POST.
 * Returns { outer, inner, form_fields } where inner is the decoded 97-slot array.
 * Throws on anything that does not have the [null, "<json>"] shape.
 */
export function parseFReq(body) {
  const params = new URLSearchParams(body ?? '');
  const raw = params.get('f.req');
  if (!raw) throw new Error('f.req field missing');
  const outer = JSON.parse(raw);
  if (!Array.isArray(outer)) throw new Error('f.req is not an array');
  const idx = outer.findIndex((v) => typeof v === 'string');
  if (idx < 0) throw new Error('f.req has no inner JSON string');
  const inner = JSON.parse(outer[idx]);
  if (!Array.isArray(inner)) throw new Error('inner is not an array');
  return { outer, inner_index: idx, inner, form_fields: [...new Set(params.keys())] };
}

/** The value of the `at` (XSRF) form field, or null. Used only for the secret guard. */
export function formAt(body) {
  return new URLSearchParams(body ?? '').get('at');
}

/**
 * Depth-first search for the prompt text inside inner. Exact string match wins;
 * otherwise the first string that contains the prompt. Returns a path array or null.
 */
export function findPromptPath(inner, prompt) {
  let contains = null;
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (node === prompt) return path;
      if (contains === null && prompt && node.includes(prompt)) contains = path;
      return null;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const hit = walk(node[i], [...path, i]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(inner, []) ?? contains;
}

function getAt(root, path) {
  return path.reduce((n, k) => (n == null ? undefined : n[k]), root);
}

function setAt(root, path, value) {
  const parent = getAt(root, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

/**
 * Turns a captured inner array into a reusable template:
 *  - the prompt becomes "__PROMPT__" (the whole string when it was an exact match,
 *    otherwise the prompt substring is replaced inside the surrounding string),
 *  - per-request uuids become "__UUID__",
 *  - conversation / response ids become null.
 */
export function buildTemplate(inner, promptPath, prompt) {
  const template = structuredClone(inner);
  const current = getAt(template, promptPath);
  setAt(
    template,
    promptPath,
    current === prompt ? PROMPT_PLACEHOLDER : current.replace(prompt, PROMPT_PLACEHOLDER),
  );
  const uuidPaths = [];
  const nulledPaths = [];
  const walk = (node, path) => {
    if (!Array.isArray(node)) return;
    node.forEach((v, i) => {
      const p = [...path, i];
      if (typeof v === 'string') {
        if (UUID_FULL_RE.test(v)) {
          node[i] = UUID_PLACEHOLDER;
          uuidPaths.push(p);
        } else if (CONV_ID_RE.test(v)) {
          node[i] = null;
          nulledPaths.push(p);
        }
      } else {
        walk(v, p);
      }
    });
  };
  walk(template, []);
  return { template, uuid_paths: uuidPaths, nulled_paths: nulledPaths };
}

/** Keeps only x-goog-ext-* and x-same-domain headers (lower-cased names). */
export function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (HEADER_KEEP_RE.test(k)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

/** Replaces per-request uuids inside header values with "__UUID__". */
export function templateHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = v.replace(UUID_RE, UUID_PLACEHOLDER);
  return out;
}

/**
 * Pulls the answer text(s) out of a StreamGenerate response body. Looks at the
 * known answer path first (payload[4][*][1][*]); if that yields nothing, falls
 * back to every string in every wrb.fr payload so a moved path still works.
 */
export function extractAnswerTexts(raw) {
  const known = [];
  const any = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.includes('"wrb.fr"')) continue;
    let arr;
    try {
      arr = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || typeof entry[2] !== 'string') continue;
      let payload;
      try {
        payload = JSON.parse(entry[2]);
      } catch {
        continue;
      }
      const parts = Array.isArray(payload) ? payload[4] : null;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          const texts = Array.isArray(p) ? p[1] : null;
          if (Array.isArray(texts)) known.push(...texts.filter((t) => typeof t === 'string' && t));
        }
      }
      collectStrings(payload, any);
    }
  }
  return known.length ? known : any;
}

function collectStrings(node, out) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => collectStrings(n, out));
}

/** True when some answer text is just the expected word (case/punctuation tolerant). */
export function responseHasWord(raw, word = 'pong') {
  const re = new RegExp(`^\\s*${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\W*$`, 'i');
  return extractAnswerTexts(raw).some((t) => re.test(t));
}

/**
 * Throws when any secret value appears anywhere in the serialised object.
 * Values shorter than 8 chars are ignored (cookie flags like "1" would false-positive).
 */
export function assertNoSecrets(obj, secrets) {
  const text = JSON.stringify(obj);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8 && text.includes(s)) {
      throw new Error('learned protocol would leak a secret value; refusing to emit it');
    }
  }
}

/**
 * Reference renderer for a learned protocol: what the bridge must do with it.
 * Returns the URL, headers and form body for one request. `uuid` is a string or a
 * function returning a fresh uuid per occurrence. `at` is optional.
 */
export function renderRequest(learned, { prompt, uuid, reqid, at, origin = 'https://gemini.google.com' }) {
  const nextUuid = typeof uuid === 'function' ? uuid : () => uuid;
  const swapUuid = (s) => s.replace(new RegExp(UUID_PLACEHOLDER, 'g'), () => nextUuid());
  const fill = (node) => {
    if (node === PROMPT_PLACEHOLDER) return prompt;
    if (node === UUID_PLACEHOLDER) return nextUuid();
    if (typeof node === 'string' && node.includes(PROMPT_PLACEHOLDER)) {
      return node.split(PROMPT_PLACEHOLDER).join(prompt);
    }
    return Array.isArray(node) ? node.map(fill) : node;
  };
  const inner = fill(learned.inner_template);
  const outer = learned.outer_template.map((v) => (v === INNER_PLACEHOLDER ? JSON.stringify(inner) : v));
  const u = new URL(learned.endpoint_path, origin);
  for (const [k, v] of Object.entries(learned.query)) u.searchParams.set(k, v);
  u.searchParams.set('_reqid', String(reqid));
  const form = new URLSearchParams();
  form.set('f.req', JSON.stringify(outer));
  if (at) form.set('at', at);
  const headers = {};
  for (const [k, v] of Object.entries(learned.headers)) headers[k] = swapUuid(v);
  return { url: u.toString(), headers, body: form.toString() };
}

/**
 * Builds the learned-protocol document from one captured request/response.
 * `capture` = { url, headers, body, raw }, `ui` = { input, send, method, ai_proposal }.
 */
export function buildLearned({ capture, prompt, expect = 'pong', ui, userAgent, anonymous, now = new Date() }) {
  const endpoint = parseEndpoint(capture.url);
  const parsed = parseFReq(capture.body);
  const promptPath = findPromptPath(parsed.inner, prompt);
  if (!promptPath) throw new Error('prompt text not found inside the captured f.req');
  const { template, uuid_paths, nulled_paths } = buildTemplate(parsed.inner, promptPath, prompt);
  const outerTemplate = parsed.outer.map((v, i) => (i === parsed.inner_index ? INNER_PLACEHOLDER : v));
  const headers = templateHeaders(filterHeaders(capture.headers));
  const modelHeader = headers['x-goog-ext-525001261-jspb'] ?? null;
  return {
    schema: 1,
    captured_at: now.toISOString(),
    source: 'browser',
    anonymous: Boolean(anonymous),
    user_agent: userAgent,
    endpoint_path: endpoint.endpoint_path,
    bl: endpoint.bl,
    query: endpoint.query,
    query_dropped: endpoint.query_dropped,
    form_fields: parsed.form_fields,
    headers,
    outer_template: outerTemplate,
    inner_template: template,
    prompt_path: promptPath,
    uuid_paths,
    nulled_paths,
    model_header: modelHeader,
    http_status: capture.status ?? null,
    response_ok: responseHasWord(capture.raw, expect),
    selectors_used: { input: ui.input, send: ui.send },
    method: ui.method,
    ...(ui.ai_proposal ? { ai_proposal: ui.ai_proposal } : {}),
  };
}
