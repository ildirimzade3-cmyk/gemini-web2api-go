// A small "news desk" app for the real-traffic proof: reads a public RSS feed, asks
// the hub (Gemini protocol, JSON schema) to classify and summarise each headline,
// and checks every answer. Runs in its own container on the VPS.
//
//   HUB=http://host.docker.internal:18090 KEY_FILE=/run/key node newsdesk.mjs [count]
// Prints metadata only (no headline or answer text).

import fs from 'node:fs';

const hub = process.env.HUB;
const key = fs.readFileSync(process.env.KEY_FILE, 'utf8').trim();
const count = Number(process.argv[2] ?? 3);
const model = process.env.MODEL ?? 'gemini-3.8-flash';

const rss = await (await fetch('https://feeds.bbci.co.uk/news/world/rss.xml')).text();
const titles = [...rss.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].map((m) => m[1]).slice(0, count);
const schema = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    category: { type: 'STRING', enum: ['politics', 'conflict', 'economy', 'science', 'health', 'disaster', 'sport', 'culture', 'other'] },
    summary: { type: 'STRING' },
    countries: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['headline', 'category', 'summary', 'countries'],
};

const results = await Promise.all(
  titles.map(async (title, i) => {
    const t0 = Date.now();
    const res = await fetch(`${hub}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You are a news desk assistant. Copy the headline exactly into "headline".' }] },
        contents: [{ role: 'user', parts: [{ text: `Headline: ${title}` }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
      }),
    });
    const rec = { i, status: res.status, seconds: (Date.now() - t0) / 1000, model_label: res.headers.get('x-hub-model-label'), account: res.headers.get('x-hub-account') };
    const body = await res.json();
    if (res.ok) {
      try {
        const d = JSON.parse(body.candidates[0].content.parts[0].text);
        rec.verified = d.headline.trim() === title.trim() && schema.properties.category.enum.includes(d.category) && d.summary.length > 20 && Array.isArray(d.countries);
        rec.model_ok = body.modelVersion === model;
      } catch (e) {
        rec.verified = false;
        rec.error = e.message;
      }
    } else rec.error = body.error?.message?.slice(0, 160);
    return rec;
  }),
);
console.log(JSON.stringify({ app: 'vps-newsdesk', model, headlines: titles.length, results }));
