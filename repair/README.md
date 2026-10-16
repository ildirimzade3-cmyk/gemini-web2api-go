# Self-repair and browser transport

Two small pieces that keep the bridge useful when gemini.google.com changes, both
running in one memory-limited Playwright + headless Chromium image that is only
started while the bridge's canary fails:

| Mode | Lifetime | What it does |
|---|---|---|
| `learn` | one shot, exits | Opens `/app` with the account cookies, reads what the bridge's direct protocol needs from the page (build label `bl`, XSRF present or not, signed-in state, web model catalogue) and proves the UI still works with a canary chat. Posts the result to the bridge. |
| `serve` | long running, only during an outage | HTTP server on `:9000` that answers prompts by driving the web UI (the **browser transport**). The bridge calls it when its direct generation cannot work. |

A host script (`systemd/check-and-repair.sh`) climbs the ladder: canary fails, then
`learn`, then, if the bridge's own re-check still fails, start the browser transport;
when the canary is ok again, stop it.

## Why two modes (verified 17 October 2026)

- The gemini.google.com UI no longer calls `StreamGenerate`. Prompts go through
  `geminiweb-pa.clients6.google.com/v1/processSession` (an opaque browser channel)
  and `batchexecute`, so capturing the UI's request is no longer a way to learn the
  protocol (the previous capture-and-replay design of this job was removed).
- The bridge's direct `StreamGenerate` call still works. What it needs from the page
  is small: `bl` (from `WIZ_global_data.cfb2h`), the XSRF token's presence
  (`SNlM0e`, only issued to signed-in sessions) and the model ids. `learn` collects
  exactly that.
- When the direct call breaks anyway, driving the UI is the way left: the browser
  transport.

## Files

| File | Purpose |
|---|---|
| `run.mjs` | Entry point. `node run.mjs learn [--dry-run --out f.json]`, `node run.mjs serve [--anonymous]`. Orchestration, exit codes. |
| `learn.mjs` | `learn` mode: facts, model catalogue, UI canary. |
| `serve.mjs` | HTTP server of the browser transport: auth, validation, request queue, idle exit. Works on a session interface (tests use a fake). |
| `session.mjs` | Chromium session and every UI action: open chat, model picker, attach files, send, wait for the finished answer, read it. Ordered selectors with AI fallback. |
| `dom.mjs` | Functions that run inside the page (`page.evaluate`): DOM facts, model menu, alerts, chat state and answer text. |
| `facts.mjs` | Pure: build label / XSRF presence from page source, model catalogue parsing, model lookup. |
| `answer.mjs` | Pure: rate-limit / sign-in / failure text detection, JSON extraction, canary comparison. |
| `ai.mjs` | AI selector fallback through the official Gemini API (prompt box + send button, and the answer container). |
| `bridge.mjs` | Client for the bridge contract below. |
| `secrets.mjs` | Guard: refuses to emit a document containing a cookie value. |
| `Dockerfile` | Playwright image `v1.64.1-noble` (must match `playwright-core` 1.64.1), non-root `pwuser`, `npm ci --omit=dev`, entrypoint `node run.mjs` (the mode is the container command). |
| `systemd/` | `gemini-web-repair.service`, `.timer`, `check-and-repair.sh`: the host ladder. |
| `test/` | `node --test` unit tests (no network; one suite uses Chromium when available). |

## Bridge contract (admin API)

All calls carry `Authorization: Bearer <BRIDGE_ADMIN_TOKEN>` and use JSON.
`BRIDGE_URL` is the bridge base URL reachable from the container, for example
`http://gemini-web.internal:18083`.

### `GET {BRIDGE_URL}/admin/api/repair/context`

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

- `cookies`: the Google cookies of the account to use (required array; empty means
  anonymous). Only `.google.com` domains are used. This response carries secrets:
  serve it on the internal network only.
- `account_id`: opaque; echoed back in the learned post.
- `canary_prompt` / `canary_expect`: optional; defaults above. `expect` is compared
  after lower-casing and stripping everything but letters and digits.
- Any non-2xx or non-JSON answer, or a missing `cookies` array, fails the job
  (`learn` exit 1; `serve` does not start).

### `POST {BRIDGE_URL}/admin/api/repair/learned` (from `learn`)

Body, the page facts plus `account_id`:

```json
{
  "kind": "page_facts",
  "bl": "boq_gemini-web-uiserver_20261015.13_p0",
  "xsrf_present": true,
  "signed_in": true,
  "models": [
    {"id": "cf41b0e0dd7d53e5", "label": "3.5 Flash-Lite", "description": "Fastest answers", "selected": true}
  ],
  "models_locked": ["3.6 Flash", "3.6 Thinking", "3.1 Pro", "4 Argon"],
  "models_source": "picker",
  "picker_label": "Flash-Lite",
  "ui_ok": true,
  "ui_error": "optional error code when ui_ok is false",
  "ui_method": "selectors",
  "ui_selectors_learned": {"input": ["div.new-input"]},
  "anonymous": false,
  "user_agent": "Mozilla/5.0 ...",
  "captured_at": "2026-10-17T00:00:00.000Z",
  "account_id": "acc-7"
}
```

| Field | Meaning |
|---|---|
| `bl` | Build label from `WIZ_global_data.cfb2h`. Required: the job fails (exit 1) if the page has none. |
| `xsrf_present` | The page carries a non-empty `SNlM0e`. The value is never read out. |
| `signed_in` | `xsrf_present` and no "Sign in" link on the page. `false` with cookies means the account's cookies are no longer valid. |
| `models` | Models the account can use now, from the mode picker menu: `id` is the picker's `data-mode-id` (the same hex ids the bridge sends in `x-goog-ext-525001261-jspb`, e.g. `fbb127bbb056c959`), `label` the menu name, `selected` the active one. |
| `models_locked` | Menu labels the page shows but gives no id for (anonymous visitors: the locked models). |
| `models_source` | `picker`, or `none` when the picker menu could not be read (then `models` is empty). |
| `picker_label` | Short name on the picker button ("Flash-Lite"). |
| `ui_ok` | The UI canary chat worked: the typed canary prompt produced the expected word. |
| `ui_error` | Only when `ui_ok` is false: `upstream_protocol_changed`, `upstream_rate_limited`, `upstream_unavailable`, `no_valid_account`, `unexpected_answer` or `error`. |
| `ui_method` / `ui_selectors_learned` | `selectors`, or `ai-selectors` plus the selectors the AI fallback had to learn. |

The document is scanned for every cookie value before it is sent; a hit aborts the
run. It never contains cookie values, the XSRF token, prompts or answers.

Response (JSON):

```json
{"ok": true, "validated": true, "event_id": 123, "error": "optional text"}
```

The bridge validates the facts (for example by applying `bl` and running its own
canary) before adopting them. Outcomes seen by the job:

| Bridge answer | Job result |
|---|---|
| `ok: true, validated: true` | adopted, exit 0 |
| `ok: true, validated: false` or `ok: false` (any HTTP status, JSON body) | learned but not validated, exit 2 |
| transport error, 5xx or non-JSON body | failure, exit 1 |

### `POST {BRIDGE_URL}/admin/api/events`

Body `{"kind": "...", "detail": "..."}`; `detail` is a plain string of at most 500
characters. Posting is best effort and never blocks the work. Details never contain
cookies, tokens, prompts or answers.

| Kind | Posted by | When |
|---|---|---|
| `repair_started` / `repair_adopted` / `repair_unvalidated` / `repair_failed` | `learn` | job start; bridge adopted; bridge did not validate; context, learn or post failed (`<stage>: <code>: <message>`) |
| `browser_selectors_learned` | `learn`, `serve` | the AI fallback learned new selectors; `detail` is JSON `{"input":[...],"send":[...],"answer":[...],"stop":[...]}`, selectors only |
| `browser_started` | `serve` | the warm-up page load worked (`signed_in=... anonymous=...`) |
| `browser_idle_exit` | `serve` | exited after the idle time |
| `repair_trigger`, `repair_recovered`, `repair_not_recovered` | host script | decided to run `learn`; canary ok again after it; still failing after it |
| `browser_fallback_started` / `browser_fallback_stopped` / `browser_fallback_failed` | host script | browser container started / stopped / could not be started or stopped |

### `GET {BRIDGE_URL}/healthz` (read by the host script)

Unauthenticated, must contain `last_canary`:

```json
{"last_canary": {"ok": false, "at": 1792000000, "error_class": "upstream_protocol_changed"}}
```

`at` is unix seconds (milliseconds and ISO 8601 strings are also understood).
`error_class` is only logged. A missing `last_canary` or a never-run canary counts as
"no result" and triggers nothing.

## `learn` mode

Steps: open `https://gemini.google.com/app` in headless Chromium with a desktop
Chrome user agent and the account cookies (anonymous when there are none); reject
non-essential cookie dialogs (terms and agreements are never accepted); wait for the
prompt box; read `bl` and the XSRF presence from the page source and the sign-in
state from the DOM; open the mode picker and read the model menu
(`[data-test-id^="bard-mode-option-"]`, ids in `data-mode-id`); type the canary prompt
through the prompt box (ordered selectors, AI fallback when they stop matching),
wait for the finished answer in the DOM and compare it with `canary_expect`; post the
facts.

Exit codes: `0` adopted by the bridge (or dry run captured), `2` learned but not
validated, `1` failure (no `bl`, page unreachable, bridge errors). A failing UI
canary is not a failure by itself: the facts are still posted with `ui_ok: false`.

## `serve` mode: the browser transport

### Contract for the bridge (Go side)

Runtime configuration of the bridge:

| Key | Example | Meaning |
|---|---|---|
| `browser_fallback_url` | `http://gemini-web-browser.internal:9000` | Base URL of the browser transport. |
| `browser_fallback_token` | (secret) | Sent as `Authorization: Bearer <token>`; equals `BROWSER_TOKEN` of the container. |

When to use it:

- A direct generation just failed with `upstream_protocol_changed`: retry the same
  request through the browser transport, or
- the last canary failed with the protocol class (`error_class: upstream_protocol_changed`)
  and the browser transport's `GET /healthz` says `ok: true`: send generation there
  first.
- Do not use it for `upstream_rate_limited` (same account, it would only burn the
  quota again), `no_valid_account`, or caller errors. If the container is not running
  (connection refused) the transport is simply unavailable: keep the original error.
- The call has no time limit of its own (the UI can take minutes on long answers).
  Use a connect timeout of a few seconds and no overall deadline; the server enforces
  a 600 s safety ceiling per request.

`GET {url}/healthz` (no auth):

```json
{"ok": true, "signed_in": true, "queue": 0}
```

`ok` is true once the warm-up page load worked and the last request did not fail
with a UI problem (`upstream_unavailable` / `upstream_protocol_changed`); a usage
limit or an unknown model does not flip it. `signed_in` comes from the last loaded
page. `queue` counts waiting plus running requests.

`POST {url}/generate`, header `Authorization: Bearer <token>`, JSON body:

```json
{
  "prompt": "text",
  "model_label": "3.6 Flash",
  "attachments": [{"name": "notes.txt", "mime": "text/plain", "data_b64": "..."}],
  "json": false
}
```

| Field | Meaning |
|---|---|
| `prompt` | Required, non-empty. Above 30 KB it is attached as `prompt.txt` and a short instruction is typed instead. |
| `model_label` | Optional: menu label (`"3.6 Flash"`), `short name` or model id from the `models` catalogue (exact match first, then a unique partial match). Omitted: the page's default model. |
| `attachments` | Optional, at most 8 files, uploaded through the UI's file chooser (signed-in accounts only). |
| `json` | Optional. When true the text of the code block that parses as JSON is returned (longest one), else the whole answer, else the first JSON object inside it. |

Response `200`:

```json
{"text": "answer", "model_label_seen": "Flash-Lite", "elapsed_ms": 9862, "json_valid": true}
```

`model_label_seen` is the short name on the mode-picker button after the answer
finished. `json_valid` is only present for `json: true` and says whether the returned
text parses. `text` of a normal request is the answer rebuilt from the DOM (headings
as `#`, list items as `- `, code blocks as fenced blocks).

Errors are `{"error": {"code": "...", "message": "..."}}`:

| HTTP | `code` | Meaning |
|---|---|---|
| 401 | `unauthorized` | Missing or wrong token. |
| 400 | `invalid_request` | Malformed JSON or fields. |
| 400 | `model_not_found` | No (or more than one) picker entry matches `model_label`. |
| 413 | `payload_too_large` | Body above 64 MiB. |
| 429 | `upstream_rate_limited` | The UI showed a usage limit / "try again later" text, an HTTP 429, or Google's "unusual traffic" page. |
| 503 | `upstream_unavailable` | Page load failure, Gemini error text, queue full (32), 600 s ceiling. |
| 503 | `upstream_protocol_changed` | The prompt box, send button or answer container could not be found, even after the AI fallback. |
| 503 | `no_valid_account` | Redirected to sign-in, a sign-in wall, or the requested model is locked for this account. |

### Behaviour

- One browser context is reused; each request opens a fresh page on `/app` (a new
  chat) and closes it afterwards. Requests run strictly one at a time in arrival
  order; a client that disconnected while queued is skipped.
- Done means: no stop button, the answer text unchanged for 1.2 s and not marked
  `aria-busy`. There is no limit except the 600 s ceiling (`BROWSER_CEILING_S`).
- Selectors are tried in order (see `DEFAULT_SELECTORS` in `session.mjs`). When the
  prompt box, send button or answer container is not found, the official Gemini API
  proposes selectors from a trimmed page summary (needs `GEMINI_REPAIR_API_KEY`); they
  are checked in the page, kept in memory and reported with a
  `browser_selectors_learned` event (selectors only).
- The server exits (code 0) after `BROWSER_IDLE_EXIT_MIN` minutes without a
  `/generate` request (health checks do not count) and on SIGTERM.
- Prompts and answers are never logged, only their length and a short hash.

## Host orchestration (`systemd/`)

`gemini-web-repair.timer` fires 5 minutes after boot and every 2 minutes after the
previous run finished; it starts `gemini-web-repair.service` (oneshot), which runs
`check-and-repair.sh`:

1. take a lock (no parallel runs); `GET /healthz`; unreachable bridge or no canary
   result: nothing to do;
2. canary **ok**: if the browser container runs, stop it (`browser_fallback_stopped`);
3. canary **failing** and no `learn` run in the last `COOLDOWN_S` (1800 s): stamp,
   post `repair_trigger`, run `docker compose --profile repair run --rm -T gemini-web-repair learn`,
   then poll `/healthz` for up to `RECHECK_WAIT_S` (180 s) for the bridge's own
   re-check: ok again gives `repair_recovered`; a failure newer than the end of the
   learn run, or the deadline, gives `repair_not_recovered`;
4. canary still failing (also during the cooldown): start the browser container with
   `docker compose --profile browser up -d gemini-web-browser` (`browser_fallback_started`,
   or `browser_fallback_failed` with exit 1).

JSON is read with `python3` (present on the VPS; set `PYTHON` to change). `jq` is not
needed. The admin token reaches `curl` through a config on a pipe, never on a command
line.

Install on the VPS (paths as in `deploy/vps/gemini-web`):

```sh
apt install curl util-linux python3
install -d /opt/gemini-web2api/repair && cp -r systemd /opt/gemini-web2api/repair/
install -m 600 /dev/null /etc/gemini-web-repair.env   # then fill it, see below
cp systemd/gemini-web-repair.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now gemini-web-repair.timer
```

`/etc/gemini-web-repair.env` (mode 600; `KEY=value` lines): `BRIDGE_URL` (as seen from
the host, e.g. `http://127.0.0.1:18083`), `BRIDGE_ADMIN_TOKEN`, `GEMINI_WEB_COMMIT`
(the compose file interpolates it for every service), optionally `COMPOSE_FILE`,
`REPAIR_SERVICE`, `BROWSER_SERVICE`, `COOLDOWN_S`, `RECHECK_WAIT_S`, `RECHECK_POLL_S`,
`STATE_DIR`, `PYTHON`.

Compose services the script expects (profiles keep them out of a plain `up`):

```yaml
  gemini-web-repair:                 # learn: no `command:` (the script passes `learn`)
    image: miraz/gemini-web-repair:${GEMINI_WEB_COMMIT:?}
    profiles: [repair]
    env_file: /etc/miraz/gemini-web-repair.env   # BRIDGE_ADMIN_TOKEN, GEMINI_REPAIR_API_KEY
    environment: { BRIDGE_URL: "http://gemini-web.internal:18083" }
    mem_limit: 1g
    memswap_limit: 1g
    cpus: 1.0
    pids_limit: 512
    shm_size: 256m
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    read_only: true
    tmpfs: ["/tmp", "/home/pwuser"]
    networks: [ops]

  gemini-web-browser:                # serve: started/stopped by the script
    image: miraz/gemini-web-repair:${GEMINI_WEB_COMMIT:?}
    profiles: [browser]
    command: ["serve"]
    env_file: /etc/miraz/gemini-web-repair.env   # + BROWSER_TOKEN
    environment: { BRIDGE_URL: "http://gemini-web.internal:18083" }
    restart: "no"
    mem_limit: 1536m
    memswap_limit: 1536m
    cpus: 1.0
    pids_limit: 512
    shm_size: 256m
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    read_only: true
    tmpfs: ["/tmp", "/home/pwuser"]
    networks:
      ops:
        aliases: [gemini-web-browser.internal]   # a network the bridge shares
```

No port is published: only containers on that network reach `:9000`.

## Environment

| Variable | Default | Use |
|---|---|---|
| `BRIDGE_URL`, `BRIDGE_ADMIN_TOKEN` | required (not for `learn --dry-run` / `serve --anonymous`) | bridge contract |
| `BROWSER_TOKEN` | required for `serve` | bearer token the bridge sends |
| `BROWSER_PORT` / `BROWSER_HOST` | `9000` / `0.0.0.0` | listen address |
| `BROWSER_IDLE_EXIT_MIN` | `30` | idle exit |
| `BROWSER_CEILING_S` | `600` | per-request safety ceiling |
| `GEMINI_REPAIR_API_KEY` | unset | AI selector fallback (skipped without it) |
| `GEMINI_REPAIR_MODEL` | `gemini-3.6-flash` | model for the fallback |
| `REPAIR_TIMEOUT_S` | `120` | hard limit of one `learn` run |
| `CHROMIUM_PATH` | Playwright's bundled Chromium | use another Chromium binary (local runs) |
| `CHROMIUM_NO_SANDBOX` | `1` in the image | pass `--no-sandbox` (the container is the sandbox) |

## Run

Local (anonymous, no bridge):

```sh
npm ci
npx playwright-core install chromium     # or set CHROMIUM_PATH to an existing Chromium
node run.mjs learn --dry-run --out facts.json
BROWSER_TOKEN=test BROWSER_HOST=127.0.0.1 node run.mjs serve --anonymous &
curl -s localhost:9000/generate -H 'Authorization: Bearer test' \
  -d '{"prompt":"Reply with exactly one word: pong"}'
```

Container:

```sh
docker build -t gemini-web-repair:1 repair/
docker run --rm --init --memory 1g --memory-swap 1g --cpus 1 --pids-limit 512 --shm-size 256m \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --tmpfs /home/pwuser \
  gemini-web-repair:1 learn --dry-run --out /tmp/facts.json
```

## Tests

`npm test` (Node 22+, no network): mode dispatch and exit codes against a fake bridge,
`serve` request validation / auth / queue serialisation / error mapping / idle exit
(fake session), answer and model-menu extraction from a static fixture page
(`test/fixtures/chat.html`, run in Chromium and skipped when none is available; set
`CHROMIUM_PATH`), page-facts extraction from a `WIZ_global_data` snippet, rate-limit
text detection, answer waiting and AI selector fallback against a scripted fake page,
and the host script's decisions with stubbed `curl`, `docker` and `flock` (needs
`bash` and `python3`/`python`).

## Known limits

- Signed-in behaviour is built from the anonymous page and the bridge's cookie contract
  but not verified with a real account: the file upload flow (`Upload & tools`, then
  the file chooser), the model ids of locked models (anonymous visitors get none) and
  answers of thinking models (only the final `message-content` is read).
- The UI changes without notice; the AI fallback repairs selectors, not flows. A new
  flow (an extra consent screen, a changed upload path) shows up as
  `upstream_protocol_changed`.
- Each request loads `/app` anew (about 3-5 s of the 10-15 s a short prompt takes).
