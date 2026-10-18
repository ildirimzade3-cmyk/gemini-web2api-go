// Turns OpenAI chat requests and Gemini generateContent requests into the one thing
// the Gemini web app takes: a single message (plus attached files) in a fresh chat.
// Also JSON-mode helpers: the instruction appended to the prompt, extraction of the
// JSON value from the answer, and a small JSON-schema check.

export class RequestError extends Error {
  constructor(message, code = 'invalid_request') {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
};

function fileFromBase64(mime, b64, name, n) {
  const data = Buffer.from(String(b64 ?? ''), 'base64');
  if (!data.length) throw new RequestError('empty inline file');
  if (data.length > MAX_FILE_BYTES) throw new RequestError(`inline file larger than ${MAX_FILE_BYTES} bytes`);
  const m = String(mime || 'application/octet-stream').toLowerCase();
  return { name: name || `file${n}.${EXT[m] ?? 'bin'}`, mime: m, data };
}

function fileFromDataUrl(url, name, n) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url ?? ''));
  if (!m || !m[2]) throw new RequestError('only base64 data: URLs are accepted for files and images (the hub never fetches remote URLs)');
  return fileFromBase64(m[1], m[3], name, n);
}

/** OpenAI chat body -> { system: [], turns: [{ role, text, files }] }. */
export function fromOpenAI(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) throw new RequestError('messages must be a non-empty array');
  const system = [];
  const turns = [];
  let n = 0;
  for (const msg of body.messages) {
    const role = msg?.role;
    const parts = typeof msg?.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg?.content) ? msg.content : [];
    const texts = [];
    const files = [];
    for (const p of parts) {
      if (p?.type === 'text' || p?.type === 'input_text') texts.push(String(p.text ?? ''));
      else if (p?.type === 'image_url') files.push(fileFromDataUrl(p.image_url?.url ?? p.image_url, null, ++n));
      else if (p?.type === 'file') files.push(fileFromDataUrl(p.file?.file_data, p.file?.filename, ++n));
      else if (p?.type === 'input_audio') files.push(fileFromBase64(`audio/${p.input_audio?.format || 'wav'}`, p.input_audio?.data, null, ++n));
      else throw new RequestError(`unsupported content part type "${p?.type}"`);
    }
    const text = texts.join('\n');
    if (role === 'system' || role === 'developer') system.push(text);
    else if (role === 'user') turns.push({ role: 'user', text, files });
    else if (role === 'assistant') turns.push({ role: 'assistant', text, files: [] });
    else if (role === 'tool') turns.push({ role: 'user', text: `Tool result:\n${text}`, files });
    else throw new RequestError(`unsupported role "${role}"`);
  }
  return { system, turns };
}

/** Gemini generateContent body -> { system, turns }. */
export function fromGemini(body) {
  const system = [];
  const si = body?.systemInstruction ?? body?.system_instruction;
  if (si) system.push((si.parts ?? []).map((p) => p.text ?? '').join('\n'));
  if (!Array.isArray(body?.contents) || !body.contents.length) throw new RequestError('contents must be a non-empty array');
  const turns = [];
  let n = 0;
  for (const c of body.contents) {
    const texts = [];
    const files = [];
    for (const p of c?.parts ?? []) {
      const inline = p.inlineData ?? p.inline_data;
      if (typeof p.text === 'string') texts.push(p.text);
      else if (inline) files.push(fileFromBase64(inline.mimeType ?? inline.mime_type, inline.data, null, ++n));
      else if (p.fileData || p.file_data) throw new RequestError('fileData (uploaded file URIs) is not supported; send the file inline');
      else throw new RequestError('unsupported part (only text and inlineData)');
    }
    turns.push({ role: c.role === 'model' ? 'assistant' : 'user', text: texts.join('\n'), files });
  }
  return { system, turns };
}

/**
 * One message for a fresh chat. A single user turn without system text is sent as
 * it is; otherwise instructions and the earlier conversation are laid out above
 * the current message.
 */
export function buildPrompt({ system, turns }, json = null) {
  if (!turns.length || turns[turns.length - 1].role !== 'user') throw new RequestError('the last message must come from the user');
  const files = turns.flatMap((t) => t.files);
  if (files.length > MAX_FILES) throw new RequestError(`at most ${MAX_FILES} files per request`);
  const sys = system.map((s) => s.trim()).filter(Boolean);
  const last = turns[turns.length - 1];
  const earlier = turns.slice(0, -1);
  let text;
  if (!sys.length && !earlier.length) {
    text = last.text;
  } else {
    const blocks = [];
    if (sys.length) blocks.push(`Instructions (follow them):\n${sys.join('\n\n')}`);
    if (earlier.length) {
      blocks.push(
        'Conversation so far:\n' + earlier.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n\n'),
      );
      blocks.push(`Current message from the user:\n${last.text}`);
    } else {
      blocks.push(last.text);
    }
    text = blocks.join('\n\n');
  }
  if (json) text += jsonInstruction(json.schema);
  if (!text.trim() && !files.length) throw new RequestError('empty prompt');
  return { text, files };
}

export function jsonInstruction(schema) {
  let s = '\n\nReply with only one valid JSON value: no prose before or after it, no code fence.';
  if (schema) s += ` It must conform to this JSON Schema:\n${JSON.stringify(schema)}`;
  return s;
}

/** JSON mode of an OpenAI body: null, { schema: null } or { schema }. */
export function openAIJson(body) {
  const rf = body?.response_format;
  if (!rf || rf.type === 'text') return null;
  if (rf.type === 'json_object') return { schema: null };
  if (rf.type === 'json_schema') return { schema: rf.json_schema?.schema ?? null };
  throw new RequestError(`unsupported response_format "${rf.type}"`);
}

export function geminiJson(body) {
  const gc = body?.generationConfig ?? body?.generation_config ?? {};
  const mime = gc.responseMimeType ?? gc.response_mime_type;
  const schema = gc.responseJsonSchema ?? gc.response_json_schema ?? gc.responseSchema ?? gc.response_schema ?? null;
  if (mime === 'application/json' || schema) return { schema };
  return null;
}

// --- answer side ------------------------------------------------------------

function tryParse(s) {
  try {
    return { value: JSON.parse(s) };
  } catch {
    return null;
  }
}

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

/** The JSON text inside an answer: whole answer, fenced block, or first balanced value. */
export function extractJson(text) {
  const whole = String(text ?? '').trim();
  if (tryParse(whole)) return whole;
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(whole);
  if (fence && tryParse(fence[1].trim())) return fence[1].trim();
  return findJsonSlice(whole);
}

/** Minimal JSON-schema check (JSON Schema and Gemini's OpenAPI subset). Returns error strings. */
export function checkSchema(value, schema, at = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errs = [];
  const types = [].concat(schema.type ?? []).map((t) => String(t).toLowerCase());
  const nullable = schema.nullable === true || types.includes('null');
  if (value === null) return nullable || !types.length ? [] : [`${at}: null not allowed`];
  const actual = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const okType =
    !types.length || types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
  if (!okType) return [`${at}: expected ${types.join('|')}, got ${actual}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errs.push(`${at}: not one of the allowed values`);
  }
  if (actual === 'object') {
    for (const r of schema.required ?? []) if (!(r in value)) errs.push(`${at}.${r}: required`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in value) errs.push(...checkSchema(value[k], sub, `${at}.${k}`));
  }
  if (actual === 'array' && schema.items) value.forEach((v, i) => errs.push(...checkSchema(v, schema.items, `${at}[${i}]`)));
  return errs.slice(0, 20);
}

/** { text, valid, errors } for a JSON-mode answer. */
export function judgeJson(answer, schema) {
  const text = extractJson(answer);
  if (!text) return { text: String(answer ?? '').trim(), valid: false, errors: ['no JSON value found'] };
  const errors = checkSchema(JSON.parse(text), schema);
  return { text, valid: errors.length === 0, errors };
}
