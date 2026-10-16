# Self-repair job

Re-learns the gemini.google.com web protocol when Google changes it, so the
bridge can heal itself. It is started on demand only (by a host systemd unit
when the bridge's canary fails), runs in its own memory-limited container
(Playwright + headless Chromium) and exits.

What one run does:

1. Opens `https://gemini.google.com/app` in headless Chromium (desktop Chrome
   user agent), with the bridge's Google cookies when it can get them, else
   anonymous. Consent dialogs: the privacy-preserving option (reject
   non-essential) is clicked; terms or agreements are never accepted.
2. Finds the prompt box and send button from an ordered selector list, types
   the canary prompt `Reply with exactly one word: pong` and sends it.
3. If no selector works within about 20 s, it asks the official Gemini API for
   selectors (AI fallback, below), validates them in the page and continues.
4. Captures the `StreamGenerate` request and response, turns them into a
   "learned protocol" JSON and hands it to the bridge, which validates it with
   its own canary before adopting it.

## Files

| File | Purpose |
|---|---|
| `run.mjs` | Orchestrator and exit codes. `--dry-run --out file.json` runs anonymously without a bridge. |
| `learn.mjs` | Browser automation: consent, selectors, capture. |
| `protocol.mjs` | Pure helpers: parse `f.req`, find the prompt path, build the template, filter headers, secret guard, and `renderRequest` (reference for what the bridge does with a template). |
| `ai.mjs` | AI selector fallback: page summary, Gemini API call, proposal validation. |
| `bridge.mjs` | Client for the bridge contract below. |
| `Dockerfile` | Playwright image `v1.64.1-noble` (must match `playwright-core` 1.64.1), non-root `pwuser`, `npm ci --omit=dev`, entrypoint `node run.mjs`. |
| `systemd/` | `gemini-web-repair.service`, `.timer`, `check-and-repair.sh` (host trigger). |
| `test/` | `node --test` unit tests (no network, no browser). |

## Bridge contract

The bridge side is implemented separately. Everything below is what this job
sends and expects. All three calls carry `Authorization: Bearer <BRIDGE_ADMIN_TOKEN>`
and use JSON. `BRIDGE_URL` is the bridge base URL reachable from the repair
container, for example `http://gemini-web.internal:8083`.

### `GET {BRIDGE_URL}/admin/api/repair/context`

Response `200`:

```json
{
  "cookies": [
    {"name": "SID", "value": "...", "domain": ".google.com", "path": "/", "secure": true, "httpOnly": true}
  ],
  "account_id": "acc-7",
  "canary_prompt": "Reply with exactly one word: pong",
  "canary_expect": "pong"
}
```

- `cookies`: the Google cookies of the account to repair with (required array;
  an empty array means anonymous). Only `.google.com` domains are used. This
  response carries secrets: serve it on the internal network only.
- `account_id`: opaque; echoed back in the learned post.
- `canary_prompt`: optional, default `Reply with exactly one word: pong`.
- `canary_expect`: optional, default `pong`; the word a correct answer consists of.
- Any non-2xx, non-JSON answer or missing `cookies` array fails the job (exit 1).

### `POST {BRIDGE_URL}/admin/api/repair/learned`

Body: the learned-protocol JSON (next section) plus `"account_id"` from the
context. Response (JSON):

```json
{"ok": true, "validated": true, "event_id": 123, "error": "optional text"}
```

The bridge must validate before adopting: render the template for its own
canary prompt (rules below), send it with the account's cookies through its
normal client, and adopt the learned protocol (bl, query, headers, templates)
only if the canary answer is correct. Outcomes seen by the job:

| Bridge answer | Job result |
|---|---|
| `ok: true, validated: true` | adopted, exit 0 |
| `ok: true, validated: false` or `ok: false` (any HTTP status, JSON body) | learned but not validated, exit 2 |
| transport error, 5xx or non-JSON body | failure, exit 1 |

Rendering rules (`renderRequest` in `protocol.mjs` is the reference
implementation, covered by tests):

- URL = `https://gemini.google.com` + `endpoint_path` + `?` + every entry of `query`
  (includes `bl`) + `_reqid=<n>`. `f.sid` and `_reqid` are never stored.
- `inner_template`: replace the string `"__PROMPT__"` by the prompt (when the
  prompt was only part of a longer string it is a substring replacement), and
  every string `"__UUID__"` by a fresh uuid. `prompt_path` / `uuid_paths` /
  `nulled_paths` list where those are (informational).
- `outer_template`: replace the string `"__INNER__"` by `JSON.stringify(inner)`.
  The form field `f.req` is `JSON.stringify(outer)`. Add the form field `at`
  (XSRF) when `form_fields` contains `at`.
- `headers` (lower-case names, only `x-goog-ext-*` and `x-same-domain`):
  replace every `__UUID__` substring by a fresh uuid, then add them on top of
  the bridge's own header set. Cookies, `Authorization`, `Origin`, `Referer`
  etc. stay the bridge's own. `model_header` is the template of
  `x-goog-ext-525001261-jspb` (the model selection) for the model the browser
  had selected (the default/anonymous model). The bridge keeps its per-model
  override of that header, taking the learned one only as shape.

### `POST {BRIDGE_URL}/admin/api/events`

Body `{"kind": "repair_started", "detail": "..."}`; `detail` is a plain string
of at most 500 characters. The job posts:

| kind | when |
|---|---|
| `repair_started` | job start |
| `repair_adopted` | bridge validated and adopted (detail has `bl` and method) |
| `repair_unvalidated` | learned, but the bridge did not validate (detail has the bridge's error) |
| `repair_failed` | context, learn or post failed (detail is `<stage>: <message>`) |

Event posting is best effort; a failure is ignored. Details never contain
cookies, tokens, prompts or answers.

### `GET {BRIDGE_URL}/healthz` (used by the host trigger)

Must be unauthenticated and contain `last_canary`:

```json
{"last_canary": {"ok": false, "at": 1792000000}}
```

`check-and-repair.sh` starts a repair only when `last_canary.ok` is exactly
`false`. A missing field, a never-run canary or an unreachable bridge do not
trigger it.

## Learned protocol JSON

Written by `learn.mjs`, posted by `run.mjs`. Never contains cookie values, the
`at` token, per-request uuids, conversation ids or the page snapshot.

| Field | Meaning |
|---|---|
| `schema` | `1` |
| `captured_at`, `source` | ISO time; always `"browser"` |
| `anonymous` | true when no cookies were used |
| `user_agent` | UA the browser used (informational) |
| `endpoint_path` | path of the StreamGenerate endpoint |
| `bl` | build label from the query |
| `query`, `query_dropped` | replayable query parameters; names of dropped per-request ones |
| `form_fields` | names of the POST form fields (`f.req`, `at`) |
| `headers` | `x-goog-ext-*` and `x-same-domain`, uuids replaced by `__UUID__` |
| `outer_template`, `inner_template` | decoded `f.req` with placeholders |
| `prompt_path`, `uuid_paths`, `nulled_paths` | index paths inside the inner array |
| `model_header` | template of `x-goog-ext-525001261-jspb` or null |
| `http_status`, `response_ok` | browser-side result; `response_ok` = the answer text was `pong` |
| `selectors_used` | `{input, send}`; `send` is `"Enter"` when no button matched |
| `method` | `"selectors"` or `"ai-selectors"` |
| `ai_proposal` | only for `ai-selectors`: the proposed selectors and notes |

Before it is emitted, the document is scanned for every cookie value and the
`at` token; a hit aborts the run.

## AI fallback

When the default selectors fail (no prompt box within about 20 s, or the send
produced no request), the job collects a trimmed summary of inputs, buttons and
links (tag, role, aria-label, placeholder, short class names, button text; at
most 30 KB; no input values, no cookies, no tokens) and calls

`POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`

with header `x-goog-api-key` from `GEMINI_REPAIR_API_KEY`, `responseMimeType`
`application/json` and the schema `{input_selector, send_selector, notes}`.
The proposal is checked (CSS only, bounded, single line), tried in the page and
recorded as `method: "ai-selectors"`. Without a key the fallback is skipped and
the run fails with the reason.

## Environment

| Variable | Default | Use |
|---|---|---|
| `BRIDGE_URL`, `BRIDGE_ADMIN_TOKEN` | required (not for `--dry-run`) | bridge contract |
| `GEMINI_REPAIR_API_KEY` | unset | AI selector fallback |
| `GEMINI_REPAIR_MODEL` | `gemini-3.6-flash` | model for the fallback |
| `REPAIR_TIMEOUT_S` | `120` | hard limit for the browser part |
| `CHROMIUM_PATH` | Playwright's bundled Chromium | use another Chromium binary (local dry runs) |
| `CHROMIUM_NO_SANDBOX` | `1` in the image | pass `--no-sandbox` (the container is the sandbox) |

Exit codes: `0` adopted (or dry run captured), `2` learned but not validated,
`1` failure.

## Run

Local dry run (anonymous, writes the learned JSON, no bridge):

```sh
npm ci
npx playwright-core install chromium     # or set CHROMIUM_PATH to an existing Chromium
node run.mjs --dry-run --out learned.json
```

Container (what the host trigger runs):

```sh
docker build -t gemini-web-repair:1 repair/
docker run --rm --init --name gemini-web-repair \
  --memory 1g --memory-swap 1g --cpus 1 --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp --tmpfs /home/pwuser \
  --network <docker network that resolves BRIDGE_URL> \
  -e BRIDGE_URL -e BRIDGE_ADMIN_TOKEN -e GEMINI_REPAIR_API_KEY \
  gemini-web-repair:1
```

(Verified locally: the image builds, and `--dry-run` runs inside it with exactly
these limits.)

## Host trigger

`systemd/gemini-web-repair.timer` fires 5 minutes after boot and then every
2 minutes after the previous run finished. It starts
`gemini-web-repair.service` (oneshot), which runs `check-and-repair.sh`:

1. take a lock (no parallel runs);
2. `GET /healthz`; unreachable bridge or `last_canary.ok != false` -> nothing to do;
3. skip when the last repair started less than `COOLDOWN_S` (1800 s) ago
   (the stamp is written before the run, so failing repairs are throttled too);
4. `docker run` the container with the limits above.

The unit treats exit code 2 (learned, not validated) as success; the bridge's
event log already records it. Install on the VPS:

```sh
apt install jq curl util-linux            # jq is required by the script
install -d /opt/gemini-web2api/repair && cp -r systemd /opt/gemini-web2api/repair/
install -m 600 /dev/null /etc/gemini-web-repair.env   # then fill it, see below
cp systemd/gemini-web-repair.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now gemini-web-repair.timer
```

`/etc/gemini-web-repair.env` (mode 600; `KEY=value` lines):
`BRIDGE_URL`, `BRIDGE_ADMIN_TOKEN`, optionally `REPAIR_IMAGE` (default
`gemini-web-repair:1`), `REPAIR_DOCKER_NETWORK`, `GEMINI_REPAIR_API_KEY`,
`GEMINI_REPAIR_MODEL`, `COOLDOWN_S`, `STATE_DIR`.

## Tests

`npm test` (Node 22+; 36 tests, no network, no browser): `f.req`/inner parsing,
prompt-path discovery, header filtering (cookies and `at` never present),
placeholder substitution and the render round trip, AI proposal validation and
the Gemini API request shape, and the `run.mjs` exit codes against a fake bridge
on a local HTTP server. The test capture is synthetic, built like the Go
bridge's own request; see the limit below for why there is no real fixture.

## Known limit: the anonymous web UI no longer uses StreamGenerate

A real anonymous dry run in October 2026 (local and in the container) completed a
chat in the UI, but no `StreamGenerate` call was made. The page (bl
`boq_gemini-web-uiserver_20261015.13_p0`, model label "Flash-Lite") sent the
prompt through `geminiweb-pa.clients6.google.com/v1/processSession` (a
browser-channel stream with an opaque `req0___data__` payload) and
`gemini.google.com/_/BardChatUi/data/batchexecute`. The job reports this as
`transport_changed` (exit 1, with `post_endpoints_after_send` in the log) instead
of guessing. Whether a signed-in session still uses `StreamGenerate` could not be
checked without cookies and is the first thing to verify when the bridge side is
wired. If signed-in sessions also moved, the repair job can only detect and report
it; the new transport would need a bridge implementation first.
