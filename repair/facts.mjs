// Pure helpers that turn what the page exposes into the "page facts" the bridge
// needs for its direct protocol: build label (bl), XSRF presence, signed-in state
// and the web model catalogue. No value of a secret ever leaves these functions:
// the XSRF token is only reported as present / absent.

/**
 * Reads the build label and the XSRF presence from the page source, where
 * `window.WIZ_global_data = {...,"cfb2h":"boq_gemini-web-uiserver_...","SNlM0e":"<token>",...}`
 * is inlined. `source` is page.content() (or any text holding that snippet).
 */
export function extractWizFacts(source) {
  const text = String(source ?? '');
  const bl = /"cfb2h"\s*:\s*"([^"\\]{3,200})"/.exec(text)?.[1] ?? '';
  const xsrf_present = /"SNlM0e"\s*:\s*"[^"]{8,}"/.test(text);
  return { bl, xsrf_present };
}

/** The public shape of a catalogue entry (what is posted to the bridge). */
export function toCatalogue(models) {
  return models.map(({ id, label, description, enabled, selected }) => ({ id, label, description, enabled, selected }));
}

/** Splits the visible text of a model menu item into the name and the description. */
export function splitModelText(text) {
  const lines = String(text ?? '')
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return { label: lines[0] ?? '', description: lines.slice(1).join(' ') };
}

/**
 * Turns raw menu items (collectModelMenu) into the catalogue. Items without a
 * label are dropped; `index` is the position in the raw menu. An item the page does
 * not give an id for (locked models of an anonymous visitor) is kept with `id: ""`
 * and `enabled: false`.
 */
export function parseModelItems(raw) {
  const out = [];
  const seen = new Set();
  const items = Array.isArray(raw) ? raw : [];
  for (let index = 0; index < items.length; index++) {
    const it = items[index];
    const { label, description } = splitModelText(it?.text);
    if (!label) continue;
    const id = typeof it.id === 'string' ? it.id : '';
    const key = id || `label:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ index, id, label, description, enabled: it.enabled !== false && id !== '', selected: Boolean(it.selected) });
  }
  return out;
}

/** "Open mode picker, currently Flash-Lite" -> "Flash-Lite" ("" when it does not match). */
export function parsePickerLabel(ariaLabel) {
  return /currently\s+(.+)$/i.exec(String(ariaLabel ?? '').trim())?.[1]?.trim() ?? '';
}

/**
 * Combines the source facts and the DOM facts. `signed_in` needs the XSRF token
 * (only issued to signed-in sessions) and no sign-in link on the page.
 */
export function derivePageFacts({ source, dom }) {
  const wiz = extractWizFacts(source);
  const bl = wiz.bl || (typeof dom?.bl === 'string' ? dom.bl : '');
  const xsrf_present = wiz.xsrf_present || Boolean(dom?.xsrf_present);
  return {
    bl,
    xsrf_present,
    signed_in: xsrf_present && !dom?.sign_in_link,
    picker_label: parsePickerLabel(dom?.picker_label),
  };
}

/** Finds the catalogue entry the caller asked for. Returns { model } or { error: "not_found" | "ambiguous" }. */
export function findModel(models, wanted) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const w = norm(wanted);
  if (!w) return { error: 'not_found' };
  const exact = models.filter((m) => norm(m.label) === w || (m.id && norm(m.id) === w));
  if (exact.length === 1) return { model: exact[0] };
  if (exact.length > 1) return { error: 'ambiguous' };
  const partial = models.filter((m) => norm(m.label).includes(w) || w.includes(norm(m.label)));
  if (partial.length === 1) return { model: partial[0] };
  return { error: partial.length ? 'ambiguous' : 'not_found' };
}
