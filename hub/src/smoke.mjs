// Feasibility smoke test (temporary): headful Chrome on Xvfb with its sandbox, anonymous Gemini.
import { spawn } from 'node:child_process';
import { chromium } from 'patchright-core';
const xvfb = spawn('Xvfb', [':91', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const t0 = Date.now();
const ctx = await chromium.launchPersistentContext('/data/smoke-profile', {
  executablePath: process.env.CHROME_PATH, headless: false, env: { ...process.env, DISPLAY: ':91' },
  viewport: null, locale: 'en-US', ignoreDefaultArgs: ['--enable-automation'], args: ['--window-size=1920,1040', '--window-position=0,0'],
});
console.log('launch_ms', Date.now() - t0);
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://gemini.google.com' });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
console.log('ua', await page.evaluate(() => navigator.userAgent), 'webdriver', await page.evaluate(() => navigator.webdriver));
const input = page.locator('div.ql-editor[contenteditable="true"]').first();
await input.waitFor({ timeout: 30000 });
await input.click();
await page.evaluate(() => document.execCommand('insertText', false, 'Reply with a two-item markdown list and a ```json {"ok":true}``` block.'));
const t1 = Date.now();
await page.keyboard.press('Enter');
await page.waitForSelector('model-response message-content', { timeout: 60000 });
for (;;) { const busy = await page.locator('model-response [aria-busy="true"]').count(); const stop = await page.locator('button[aria-label*="Stop" i]').count(); if (!busy && !stop) break; await page.waitForTimeout(300); }
await page.locator('model-response message-actions button[aria-label="Copy"]').last().click();
await page.waitForTimeout(500);
console.log('answer_ms', Date.now() - t1, JSON.stringify(await page.evaluate(() => navigator.clipboard.readText())));
const sb = await ctx.newPage(); await sb.goto('chrome://sandbox'); console.log((await sb.innerText('body')).replace(/\s+/g, ' ').slice(0, 400));
await ctx.close(); xvfb.kill();
