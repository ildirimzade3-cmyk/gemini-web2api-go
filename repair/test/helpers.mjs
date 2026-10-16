// Synthetic StreamGenerate capture shaped like the Go bridge's own request builder
// (97-slot inner, prompt in inner[0][0], model header with a trailing uuid).

export const PROMPT = 'Reply with exactly one word: pong';
export const COOKIE_VALUE = 'g.a000SECRETCOOKIEVALUE_abcdefghijklmnop';
export const AT_TOKEN = 'AEXAMPLE-xsrf-token-1234567890:1792000000000';
export const REQ_UUID = '3f2b6a52-1c1e-4d0e-9a49-0d2a6c3b7e11';
export const HDR_UUID = '9c1d8f40-7a55-4a86-b3b1-5f0f2f1c8d22';

export function makeInner(prompt = PROMPT) {
  const inner = new Array(97).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ['en'];
  inner[2] = ['', '', '', null, null, null, null, null, null, ''];
  inner[7] = 1;
  inner[17] = [[0]];
  inner[59] = REQ_UUID;
  inner[79] = 1;
  inner[80] = 0;
  return inner;
}

export function makeCapture({ prompt = PROMPT, withAt = true, answer = 'pong' } = {}) {
  const inner = makeInner(prompt);
  const form = new URLSearchParams();
  form.set('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  if (withAt) form.set('at', AT_TOKEN);
  const payload = JSON.stringify([null, ['c_1a2b3c4d5e6f7a8b', 'r_8b7a6f5e4d3c2b1a'], null, null, [['rc_0123456789abcdef', [answer]]]]);
  const title = JSON.stringify([null, null, null, null, [['rc_x', ['Reply with exactly one word: pong']]]]);
  const frame = (p) => JSON.stringify([['wrb.fr', null, p]]);
  const raw = [")]}'", '123', frame(payload), '45', frame(title)].join('\n');
  return {
    url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_gemini-web-uiserver_20261015.13_p0&f.sid=-123456789&hl=en&_reqid=345678&rt=c',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'user-agent': 'Mozilla/5.0',
      cookie: `SAPISID=${COOKIE_VALUE}`,
      authorization: `SAPISIDHASH ${COOKIE_VALUE}`,
      'x-same-domain': '1',
      'X-Goog-Ext-73010989-Jspb': '[0]',
      'x-goog-ext-525001261-jspb': `[1,null,null,null,"fbb127bbb056c959",null,null,0,[4,5,6,8],null,null,1,null,null,1,0,"${HDR_UUID}"]`,
      'x-goog-ext-525005358-jspb': `["${REQ_UUID}",1]`,
    },
    body: form.toString(),
    raw,
  };
}
