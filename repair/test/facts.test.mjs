import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePageFacts,
  extractWizFacts,
  findModel,
  parseModelItems,
  parsePickerLabel,
  splitModelText,
  toCatalogue,
} from '../facts.mjs';

const XSRF = 'AEXAMPLE-xsrf-token-fixture:1792000000000';
// Shaped like the inline script of the live page (keys and neighbours trimmed).
const SIGNED_IN_SNIPPET = `<script>window.WIZ_global_data = {"bTPVLd":"%.@.null,null,null,\\"https://x.corp.goog\\"]","cfb2h":"boq_gemini-web-uiserver_20261015.13_p0","d2zJAe":"AIzaSyFAKEKEY","SNlM0e":"${XSRF}","TuX5cc":"en-US"};</script>`;
const ANONYMOUS_SNIPPET = `<script>window.WIZ_global_data = {"cfb2h":"boq_gemini-web-uiserver_20261015.13_p0","SNlM0e":"","TuX5cc":"en-US"};</script>`;

test('extractWizFacts reads the build label and only the presence of the XSRF token', () => {
  const f = extractWizFacts(SIGNED_IN_SNIPPET);
  assert.deepEqual(f, { bl: 'boq_gemini-web-uiserver_20261015.13_p0', xsrf_present: true });
  assert.ok(!JSON.stringify(f).includes(XSRF));
});

test('extractWizFacts: anonymous page has no XSRF token, a changed page has no build label', () => {
  assert.deepEqual(extractWizFacts(ANONYMOUS_SNIPPET), { bl: 'boq_gemini-web-uiserver_20261015.13_p0', xsrf_present: false });
  assert.deepEqual(extractWizFacts('<html>no wiz data</html>'), { bl: '', xsrf_present: false });
  assert.deepEqual(extractWizFacts(undefined), { bl: '', xsrf_present: false });
});

test('derivePageFacts: signed in needs the XSRF token and no sign-in link', () => {
  const dom = { sign_in_link: false, picker_label: 'Open mode picker, currently Flash-Lite' };
  const ok = derivePageFacts({ source: SIGNED_IN_SNIPPET, dom });
  assert.equal(ok.signed_in, true);
  assert.equal(ok.picker_label, 'Flash-Lite');
  assert.equal(ok.bl, 'boq_gemini-web-uiserver_20261015.13_p0');
  assert.equal(derivePageFacts({ source: SIGNED_IN_SNIPPET, dom: { ...dom, sign_in_link: true } }).signed_in, false);
  assert.equal(derivePageFacts({ source: ANONYMOUS_SNIPPET, dom }).signed_in, false);
});

test('derivePageFacts falls back to the DOM values when the source has none', () => {
  const f = derivePageFacts({ source: '', dom: { bl: 'boq_x_1', xsrf_present: true, sign_in_link: false, picker_label: '' } });
  assert.deepEqual(f, { bl: 'boq_x_1', xsrf_present: true, signed_in: true, picker_label: '' });
});

test('splitModelText / parsePickerLabel', () => {
  assert.deepEqual(splitModelText('3.5 Flash-Lite\nFastest answers'), { label: '3.5 Flash-Lite', description: 'Fastest answers' });
  assert.deepEqual(splitModelText('Solo'), { label: 'Solo', description: '' });
  assert.deepEqual(splitModelText(''), { label: '', description: '' });
  assert.equal(parsePickerLabel('Open mode picker, currently Flash-Lite'), 'Flash-Lite');
  assert.equal(parsePickerLabel('something else'), '');
});

// Raw items as the live picker menu returned them (anonymous visitor), plus edge cases.
const RAW = [
  { id: 'cf41b0e0dd7d53e5', text: '3.5 Flash-Lite\nFastest answers', enabled: true, selected: true },
  { id: '', text: '3.6 Flash\nAll-around help', enabled: false, selected: false },
  { id: '', text: '3.1 Pro\nAdvanced reasoning', enabled: false, selected: false },
  { id: 'fbb127bbb056c959', text: '3.7 Flash\nAll-around help', enabled: true, selected: false },
  { id: 'fbb127bbb056c959', text: '3.7 Flash (duplicate)', enabled: true, selected: false },
  { id: 'x', text: '   ', enabled: true },
];

test('parseModelItems keeps ids, locks id-less items and drops blanks and duplicates', () => {
  const models = parseModelItems(RAW);
  assert.deepEqual(
    models.map((m) => [m.index, m.id, m.label, m.enabled, m.selected]),
    [
      [0, 'cf41b0e0dd7d53e5', '3.5 Flash-Lite', true, true],
      [1, '', '3.6 Flash', false, false],
      [2, '', '3.1 Pro', false, false],
      [3, 'fbb127bbb056c959', '3.7 Flash', true, false],
    ],
  );
  assert.deepEqual(parseModelItems(null), []);
});

test('toCatalogue drops the menu index', () => {
  const c = toCatalogue(parseModelItems(RAW));
  assert.ok(c.every((m) => !('index' in m)));
  assert.deepEqual(Object.keys(c[0]), ['id', 'label', 'description', 'enabled', 'selected']);
});

test('findModel matches exact label, id, then a unique partial match', () => {
  const models = parseModelItems(RAW);
  assert.equal(findModel(models, '3.5 flash-lite').model.index, 0);
  assert.equal(findModel(models, 'fbb127bbb056c959').model.index, 3);
  assert.equal(findModel(models, 'Flash-Lite').model.index, 0);
  assert.equal(findModel(models, '3.1 Pro').model.enabled, false);
  assert.equal(findModel(models, 'Flash').error, 'ambiguous');
  assert.equal(findModel(models, 'nope').error, 'not_found');
  assert.equal(findModel(models, '').error, 'not_found');
});
