// Network allowlist, app keys and failed-auth throttling.
//
// A key alone is never enough: every app key is bound to the source networks it was
// issued for (a tailnet address is WireGuard-authenticated, a docker bridge address
// is local to the VPS). Keys are 256-bit random values stored as SHA-256 hashes.

import crypto from 'node:crypto';
import net from 'node:net';

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function randomToken(prefix, bytes = 32) {
  const buf = crypto.randomBytes(bytes);
  let n = BigInt('0x' + buf.toString('hex'));
  let s = '';
  while (n > 0n) {
    s = B62[Number(n % 62n)] + s;
    n /= 62n;
  }
  return prefix + s.padStart(43, '0');
}

/** "::ffff:1.2.3.4" -> "1.2.3.4"; anything else unchanged. */
export function normalizeIp(ip) {
  const s = String(ip ?? '');
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

export function parseCidr(cidr) {
  const [addr, bitsRaw] = String(cidr).trim().split('/');
  if (net.isIPv4(addr)) {
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`bad CIDR ${cidr}`);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return { v: 4, base: ipv4ToInt(addr) & mask, mask };
  }
  if (net.isIPv6(addr)) {
    const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) throw new Error(`bad CIDR ${cidr}`);
    return { v: 6, base: ipv6ToBig(addr) >> BigInt(128 - bits), bits };
  }
  throw new Error(`bad CIDR ${cidr}`);
}

function ipv6ToBig(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].reduce((n, g) => (n << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

export function ipInCidrs(ip, cidrs) {
  const a = normalizeIp(ip);
  for (const c of cidrs) {
    const p = typeof c === 'string' ? parseCidr(c) : c;
    if (p.v === 4 && net.isIPv4(a) && (ipv4ToInt(a) & p.mask) === p.base) return true;
    if (p.v === 6 && net.isIPv6(a) && ipv6ToBig(a) >> BigInt(128 - p.bits) === p.base) return true;
  }
  return false;
}

/** Key from the places the OpenAI and Gemini SDKs put it. */
export function extractKey(req, url) {
  const auth = req.headers.authorization || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return (req.headers['x-goog-api-key'] || req.headers['x-api-key'] || url.searchParams.get('key') || '').trim();
}

/** Blocks a source address after repeated failed authentications. */
export class AuthThrottle {
  constructor({ maxFailures = 10, windowMs = 10 * 60_000, blockMs = 30 * 60_000 } = {}) {
    Object.assign(this, { maxFailures, windowMs, blockMs });
    this.fails = new Map();
  }
  blocked(ip, now = Date.now()) {
    const f = this.fails.get(ip);
    return Boolean(f?.blockedUntil && f.blockedUntil > now);
  }
  fail(ip, now = Date.now()) {
    let f = this.fails.get(ip);
    if (!f || now - f.first > this.windowMs) f = { first: now, n: 0, blockedUntil: 0 };
    f.n += 1;
    if (f.n >= this.maxFailures) f.blockedUntil = now + this.blockMs;
    this.fails.set(ip, f);
    return f.blockedUntil > now;
  }
  ok(ip) {
    this.fails.delete(ip);
  }
}

/** Authenticates an API request. Returns { app } or { error, status }. Same message for every failure. */
export function authenticate(store, req, url, ip) {
  const key = extractKey(req, url);
  const fail = { status: 401, error: 'invalid key or source' };
  if (!key || key.length > 200) return { ...fail, reason: 'no_key' };
  const app = store.appByHash(sha256(key));
  if (!app) return { ...fail, reason: 'unknown_key' };
  const cidrs = app.cidrs.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ipInCidrs(ip, cidrs)) return { ...fail, reason: 'source_not_bound', app_id: app.id };
  return { app };
}

export function timingSafeEqualStr(a, b) {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(x, y);
}
