// Client side of the repair <-> bridge contract (see README.md, "Bridge contract").

export class BridgeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const EVENT_DETAIL_MAX = 500; // the bridge truncates at 500 as well

export class BridgeClient {
  constructor({ baseUrl, token, fetchImpl = fetch, timeoutMs = 30000 }) {
    if (!baseUrl) throw new BridgeError('BRIDGE_URL is not set');
    if (!token) throw new BridgeError('BRIDGE_ADMIN_TOKEN is not set');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #call(method, path, body) {
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new BridgeError(`${method} ${path} failed: ${e.message}`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON body: handled below
    }
    return { status: res.status, ok: res.ok, data };
  }

  /** GET /admin/api/repair/context -> { cookies, account_id, canary_prompt, canary_expect? } */
  async getContext() {
    const r = await this.#call('GET', '/admin/api/repair/context');
    if (!r.ok || !r.data) throw new BridgeError(`repair context returned HTTP ${r.status}`, r.status);
    if (!Array.isArray(r.data.cookies)) throw new BridgeError('repair context has no cookies array', r.status);
    return r.data;
  }

  /**
   * POST /admin/api/repair/learned -> { ok, validated, event_id, error? }.
   * A non-2xx answer that still carries the JSON shape (the bridge refusing the
   * template) is returned as-is; transport errors and non-JSON answers throw.
   */
  async postLearned(learned) {
    const r = await this.#call('POST', '/admin/api/repair/learned', learned);
    if (!r.data || typeof r.data.ok !== 'boolean') {
      throw new BridgeError(`repair/learned returned HTTP ${r.status} without a result`, r.status);
    }
    return r.data;
  }

  /** POST /admin/api/events. Best effort: never throws, returns whether it was accepted. */
  async postEvent(kind, detail) {
    try {
      const r = await this.#call('POST', '/admin/api/events', {
        kind,
        detail: String(detail ?? '').slice(0, EVENT_DETAIL_MAX),
      });
      return r.ok;
    } catch {
      return false;
    }
  }
}
