// Operator alerts: an event row always, plus a push through ntfy when a topic is set.
// Messages carry no secrets and no prompt text: account label, what happened, what
// to do. The same alert is pushed at most once per `everyMs`.

export class Alerts {
  constructor({ store, server, topic, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { store, server, topic, fetchImpl, log });
    this.sent = new Map();
  }

  async notify({ key, title, message, priority = 'default', accountId = null, everyMs = 6 * 3_600_000 }) {
    this.store.event('alert', key.split(':')[0], accountId, { title, message });
    const last = this.sent.get(key) ?? 0;
    if (Date.now() - last < everyMs) return false;
    this.sent.set(key, Date.now());
    if (!this.topic) return false;
    try {
      const res = await this.fetchImpl(`${this.server}/${encodeURIComponent(this.topic)}`, {
        method: 'POST',
        headers: { Title: `Gemini hub: ${title}`.slice(0, 120), Priority: priority, Tags: 'robot' },
        body: message.slice(0, 1000),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) this.log('alert_push_failed', { status: res.status });
      return res.ok;
    } catch (e) {
      this.log('alert_push_failed', { error: e.message });
      return false;
    }
  }
}
