# gemini-web2api-go

**Gemini web → OpenAI-compatible API.** A self-hosted proxy that turns the free [gemini.google.com](https://gemini.google.com) web app into `/v1/chat/completions` — **no Google API key, no paid quota**. Single Go binary, real Chrome TLS fingerprint, cookie pool with automatic renewal, proxy pool, built-in admin dashboard, SQLite / MySQL / PostgreSQL. Image, music, canvas and video generation (`/v1/videos`) included.

<img src="docs/banner.svg" alt="gemini-web2api-go — Gemini web to OpenAI-compatible API proxy" width="100%">

[![Release](https://img.shields.io/github/v/release/zexadev/gemini-web2api-go?label=release)](https://github.com/zexadev/gemini-web2api-go/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/zexadev/gemini-web2api-go/total?label=downloads)](https://github.com/zexadev/gemini-web2api-go/releases)
[![Stars](https://img.shields.io/github/stars/zexadev/gemini-web2api-go?style=flat&label=stars)](https://github.com/zexadev/gemini-web2api-go/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/go-1.21%2B-00ADD8.svg)](https://golang.org)
[![Docker](https://img.shields.io/badge/docker-distroless-blue)](Dockerfile)

[中文文档](README.md) | English

Turn the Google Gemini web app into an OpenAI-compatible API. **Single binary**, **no account needed** (anonymous works), **real Chrome 146 fingerprint**, **SQLite persistence**, ships with an **admin dashboard**.

---

## What this is

It turns a call like this:
```
[OpenAI SDK / Cherry Studio / Cursor / dify / newapi / ...]
    ↓ http://localhost:8083/v1/chat/completions
[gemini-web2api-go]
    ↓ reverse-engineered gemini.google.com web protocol
[Google Gemini web app]
```

This is not a wrapper around Google's official API ([generativelanguage.googleapis.com](https://generativelanguage.googleapis.com)) — it proxies **the browser protocol directly**, so **no Google API key and no paid quota are required**.

## Features

**API**
- OpenAI-compatible: `/v1/chat/completions`, `/v1/models`, `/v1/responses`
- `/v1/videos`: OpenAI (Sora)-shaped async video generation — `POST` to create, `GET /v1/videos/{id}` to poll, `GET /v1/videos/{id}/content` to download the MP4 (needs a signed-in Pro cookie)
- Real incremental streaming for plain chat (requests with `tools`, and `/v1/responses`, are buffered then sent)
- Bearer token / `x-api-key` auth; the key can be rotated from the panel
- `usage` computed with tiktoken; `reasoning_tokens` counted separately, not folded
  into `completion_tokens`

**Models**
- `gemini-3.6-flash` and `gemini-3.5-flash-lite` work anonymously, web search included
- `gemini-3.1-pro` needs a cookie; every reply carries a reasoning chain
- Each of the three models has a `-thinking` variant (extended thinking), available with a cookie
  (`reasoning_content`)
- Every response records which model the backend **actually** used, so silent
  downgrades are visible

**Staying unblocked, and scaling past one IP**
- Real Chrome 146 TLS fingerprint via utls, not a default SDK handshake
- Per-exit-IP limits: concurrency / RPM / RPH
- Proxy pool: runtime CRUD, failure circuit breaker, rotation — each proxy is its
  own rate-limit slot
- Cookie pool: several Google accounts rotated least-recently-used first, auto-refreshed and kept alive, each account pinned to its own exit

**Operations**
- Single binary, cross-compiled for 6 platforms; container image built on distroless
- SQLite persistence: 30 days of per-request detail plus permanent aggregates (optional MySQL / PostgreSQL via `SQL_DSN`)
- Admin panel: overview / requests / proxy pool / cookie pool / settings, with
  config changes applied without a restart
- **Prompt and response bodies are never stored** — metadata only (length, latency,
  model, status)

## Quick start

### Prebuilt binary (simplest)

Grab the one for your platform from
[Releases](https://github.com/zexadev/gemini-web2api-go/releases). No Go, no Docker —
the single file is the whole thing:

```bash
chmod +x gemini-web2api-go_*
./gemini-web2api-go_* --port 8083 --admin-token your-admin-token
```

Data lands in `./data/gemini.db` by default; pass `--db /your/path.db` to move it.

To use MySQL / PostgreSQL, just set the `SQL_DSN` env var (unset = SQLite, nothing to change):

```bash
# MySQL (also accepts the native go-sql-driver form user:pass@tcp(host:3306)/dbname)
SQL_DSN="mysql://user:pass@host:3306/dbname"
# PostgreSQL
SQL_DSN="postgres://user:pass@host:5432/dbname?sslmode=disable"
```

Tables are created automatically; all three backends share one schema. Single instance? Stick with the default SQLite. You only need MySQL/PG when several instances share one pool.

### Docker (no source needed)

```bash
docker run -d --name gemini-web2api \
  -p 127.0.0.1:8083:8083 \
  -v "$PWD/data:/data" \
  -e ADMIN_TOKEN=your-admin-token \
  ghcr.io/zexadev/gemini-web2api-go:latest
```

For compose, just grab the file — no clone required:

```bash
curl -O https://raw.githubusercontent.com/zexadev/gemini-web2api-go/main/docker-compose.yml
ADMIN_TOKEN=your-admin-token docker compose up -d
```

### From source

If you have Go, skip Docker entirely:

```bash
git clone https://github.com/zexadev/gemini-web2api-go
cd gemini-web2api-go
go build -o gemini-web2api-go .
./gemini-web2api-go --port 8083 --admin-token your-admin-token
```

Changed the code and want it in a container? Uncomment the two `build:` lines in
`docker-compose.yml`, then `docker compose up -d --build`.

The startup banner:

```
gemini-web2api-go v4.0.0
  Listening:   http://0.0.0.0:8083
  Base URL:    http://localhost:8083/v1
  API key:     sk-gemini-XX...XXXX  (mutable in admin UI)
  Admin UI:    http://localhost:8083/admin  (token auth)
  DB:          ./data/gemini.db
  Models:      [gemini-3.5-flash-lite gemini-3.6-flash]
  Cookie:      none (anonymous)
  Proxy:       none
  Impersonate: chrome_146
  Tokenizer:   tiktoken cl100k_base
  Per-IP 限流: 并发=5 / RPM=30 / RPH=80
  Retry:       3x / 2s
```

An API key is generated on first boot. The banner masks it; the full value is on the **Settings** page of the admin panel.

### Making a call

```bash
curl http://localhost:8083/v1/chat/completions \
  -H "Authorization: Bearer sk-gemini-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The OpenAI Python SDK works as-is:

```python
from openai import OpenAI
client = OpenAI(
    base_url="http://localhost:8083/v1",
    api_key="sk-gemini-..."  # find it in the admin panel
)
resp = client.chat.completions.create(
    model="gemini-3.6-flash",
    messages=[{"role": "user", "content": "Explain quantum entanglement"}]
)
print(resp.choices[0].message.content)
```

On Windows PowerShell, `curl` is an alias for `Invoke-WebRequest` and will reinterpret the JSON quoting, so use `curl.exe` with `--%`:

```powershell
curl.exe --% http://127.0.0.1:8083/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer sk-gemini-..." -d "{\"model\":\"gemini-3.6-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello!\"}]}"
```

## Connecting clients

Every OpenAI-compatible client (Cherry Studio / ChatBox / Open WebUI / dify / Cursor / …) is configured the same way:

| Field | Value |
|---|---|
| Base URL | `http://localhost:8083/v1` (some clients want just `http://localhost:8083` and append `/v1` themselves) |
| API key | the `sk-gemini-…` shown on the admin panel's Settings page |
| Model | `gemini-3.6-flash` |

**newapi / one-api channel**: pick the OpenAI type, set the base URL to `http://localhost:8083` (use `http://host.docker.internal:8083` or the container name if newapi runs in Docker too), paste the API key, and list the models as `gemini-3.6-flash,gemini-3.5-flash-lite`.

**Codex CLI** uses `/v1/responses` — point its base URL at `http://localhost:8083/v1`. The endpoint is implemented, but it is not incrementally streamed (see the protocol coverage table).

**Gemini CLI cannot connect.** It expects Google's native `/v1beta/models/{model}:generateContent`; this project only exposes OpenAI-shaped endpoints and does not implement `/v1beta`.

There is also an unauthenticated health check at `GET /` returning `{"status":"ok","version":…,"models":[…]}`.

## MCP (web_search tool)

Besides the OpenAI API, the same process and port also serves an **MCP server** at `/mcp`,
exposing Gemini's web-grounded **search** as a `web_search` tool. This lets MCP clients
(Claude Desktop / Claude Code / Cursor) "search the web through Gemini" and get a
**synthesized answer plus source links** back.

No separate process or deployment — running the backend gives you this. The transport is
HTTP (Streamable HTTP), so remote clients just point at the URL, reusing the backend's
account pool / proxy pool / rate limiting. Search works anonymously; no cookie required.

**Client config** (Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gemini-search": {
      "url": "http://your-server:8083/mcp",
      "headers": { "Authorization": "Bearer sk-gemini-your-key" }
    }
  }
}
```

- `url` points at the backend's `/mcp`; locally it's `http://localhost:8083/mcp`.
- `Authorization` is the same API key as the OpenAI endpoint (shown on the Settings page).
- Claude Code: `claude mcp add --transport http gemini-search http://localhost:8083/mcp --header "Authorization: Bearer sk-gemini-your-key"`.

The `web_search(query)` tool takes a query/question and returns Gemini's web-grounded
answer with a `Sources:` list appended. It's the only tool for now (`url_context` — reading
a specific URL's content — is not implemented yet).

## Admin panel

`http://localhost:8083/admin`, log in with `--admin-token`.

- **Overview** — 24h KPIs, request volume / P50 latency dual-axis chart, per-model and per-proxy breakdowns, IP rate-limit usage, one-click connectivity check
- **Requests** — request log (metadata only, no prompt/response content), status/model filters, pagination
- **Proxy pool** — runtime CRUD, enable/disable, circuit breaker on repeated failures (each proxy is its own IP slot)
- **Cookie pool** — import multiple signed-in Google accounts; requests rotate through them **least-recently-used first**. One-click "check" tells you whether an account is still signed in, and **dead accounts are flagged in red** so you know which to re-import; `__Secure-1PSIDTS` is rotated automatically plus a 10-minute keepalive; each account is pinned to its own exit. The list shows redacted summaries only (cookie count / key entries / last 4 of SAPISID / failure count)
- **Settings** — runtime config form (saved settings take effect immediately), API key rotation, read-only view of deploy-time config

The frontend is a single HTML file and Chart.js is embedded in the binary, **not loaded from a CDN**, so the panel also works on air-gapped or intranet deployments.

**Serving it under a path prefix needs no extra configuration**: every URL in the panel is relative, so forwarding `https://example.com/gemini/` to this service's `/` is enough to open `https://example.com/gemini/admin`. (Requesting `/admin` without the trailing slash 301s to `admin/` — relative URLs resolve against the document URL's *directory*, and the two forms differ by one level, so they have to be normalised first.)

## Models

Gemini's backend only recognises three models (the list comes from `batchexecute?rpcids=otAQ7b`):

| Model | Description |
|---|---|
| `gemini-3.6-flash` | All-round, default |
| `gemini-3.5-flash-lite` | Fast and lightweight |
| `gemini-3.1-pro` | Most capable, **needs a cookie**; every reply carries a reasoning chain |
| `gemini-3.8-flash` | Newer Flash, **needs a cookie from a PAID Gemini account** (free accounts get downgraded to 3.5 Flash-Lite). `gemini-3.7-flash` is an alias — Google bumped that same hex from 3.7 to 3.8 in place |
| `gemini-4-argon` | 4 Argon (complex tasks), **needs a cookie from a PAID/Ultra Gemini account** (free accounts get downgraded to 3.5 Flash-Lite) |
| `gemini-3.6-flash-thinking` | 3.6 Flash with extended thinking; **needs a cookie** |
| `gemini-3.5-flash-lite-thinking` | 3.5 Flash-Lite with extended thinking; **needs a cookie** |
| `gemini-3.1-pro-thinking` | 3.1 Pro with extended thinking; **needs a cookie** |
| `gemini-3.8-flash-thinking` | 3.8 Flash with extended thinking; **needs a paid-account cookie** (`gemini-3.7-flash-thinking` is an alias) |
| `gemini-4-argon-thinking` | 4 Argon with extended thinking (upstream "High" tier), carries `reasoning_content`; **needs a PAID/Ultra account cookie** |
| `gemini-image` | Image generation (Nano Banana); base64 output; **needs a cookie** |
| `gemini-music` | Music (Lyria, ~30s); base64 output; **needs a cookie** |
| `gemini-canvas` | Canvas: generates an interactive HTML document (returned inline as a ```html block); **needs a cookie** |
| `gemini-video` | Video generation (async, tens of seconds to a few minutes); base64 MP4 output; **needs a Pro/paid account** (free accounts are refused by the upstream content policy) |

Without a cookie, `/v1/models` returns only the first two, and asking for `gemini-3.1-pro` fails with an explanation. An anonymous request for it is always silently downgraded to 3.5 Flash-Lite — better to fail at model selection than to hand back a reply that "succeeded" but isn't Pro.

With a valid cookie it really is Pro: six consecutive calls all had the backend report `3.1 Pro` itself.

Only those three are exposed. The old names `gemini-3.5-flash`, `gemini-3.5-flash-thinking`, `gemini-3.5-flash-thinking-lite`, `gemini-auto` and `gemini-flash-lite` were **removed** (they now return 400): the backend has no entries for them, and keeping them only suggested there were five distinct models to choose from.

> **`@think=N` is deprecated.** The suffix was written into `inner[17]` and long treated as "thinking depth", but captures show it is the **turn index within a conversation** (first turn `[[0]]`, the follow-up carrying a conversation id `[[1]]`, incrementing from there) — nothing to do with reasoning depth. We open a fresh conversation for every request, so the value is always 0 and the parameter never did anything. The suffix is still accepted and ignored, so existing client configs don't break.

### Reasoning chain (`reasoning_content`)

`gemini-3.1-pro` emits its own reasoning before every answer. The project exposes it
as `reasoning_content`, the de-facto standard field, so clients like newapi, Cherry
Studio and ChatBox render it as a collapsible "thinking" panel. The other two models
produce no reasoning chain and the field is then omitted entirely.

Non-streaming:

```json
{"choices":[{"message":{
  "role":"assistant",
  "content":"The core rule of this classic puzzle is...",
  "reasoning_content":"**Defining the Constraints**\n\nI've successfully defined..."
}}],
 "usage":{"prompt_tokens":26,"completion_tokens":337,"reasoning_tokens":77,"total_tokens":363}}
```

Streaming sends it as `delta.reasoning_content`, and **the whole reasoning chain is
streamed before any answer text** — that is the order the upstream itself uses, so the
experience matches the Gemini web UI.

`reasoning_tokens` is counted **separately and is not included in `completion_tokens`**:
clients collapse the reasoning by default, so billing it would charge users for output
they never see (newapi bills on `completion_tokens`). Add the two together yourself if
you do want to bill for it.

### Known capability boundaries

Anonymous calls (no cookie) only reach the two text models above plus Gemini's built-in web search. `gemini-3.1-pro` is silently downgraded to 3.5 Flash-Lite anonymously, which is why it isn't exposed at all in that case.

Attaching a cookie additionally unlocks `gemini-3.1-pro`, **extended thinking for all three models**, **image / video input**, **a longer context** (over-long conversations are sent as a text attachment, see below), and **image generation (`gemini-image`), music (`gemini-music`), canvas (`gemini-canvas`), video generation (`gemini-video`, needs a Pro account)**.

Deep research is still **not implemented** (a multi-step async flow). The panel's "actual model" column always shows which model the backend really used, so any downgrade is visible.

### Image & music

`gemini-image` (Nano Banana) and `gemini-music` (Lyria, ~30s) go through `/v1/chat/completions` just like a normal chat — put the image/music description in the user message. The bytes come back as a **base64 data URL** inside `content`: images as `![image](data:image/png;base64,…)`, audio as `[audio](data:audio/mpeg;base64,…)`. Markdown-capable clients render the image inline; to save a file, decode the base64 after the comma.

```bash
curl http://127.0.0.1:8083/v1/chat/completions \
  -H "Authorization: Bearer sk-gemini-..." -H "Content-Type: application/json" \
  -d '{"model":"gemini-image","messages":[{"role":"user","content":"an orange cat in an astronaut helmet"}]}'
```

Not returning a URL is deliberate — Gemini's artifact links need the cookie to download, so a bare link would be dead on the client side; the server fetches the bytes and inlines them. The base64 is **not counted in `completion_tokens`** (a single image is millions of tokens; billing that downstream would be absurd), only the caption text is. Both need a cookie, so they don't appear in `/v1/models` without one. Params like `size` / `n` have no upstream knob and are ignored.

**Multi-turn context is implemented by flattening `messages` into a single prompt** (the web protocol's native multi-turn needs a token that only a browser JS runtime can produce, which plain HTTP cannot forge). The cost is that every turn resends the whole history, which runs into the single-request length wall: about **130,000 UTF-8 bytes**. Past that the upstream **silently truncates from the tail without an error** — and since the newest message sits at the end, what gets eaten is exactly what you just asked, which reads as "the model suddenly got dumb".

With a cookie, an over-long conversation is uploaded as a `message.txt` attachment instead, which gets around the request-body wall — **but the attachment has a wall of its own**: the model only ever sees about **160,000 bytes** of content in total; anything past that is uploaded but never read (measured with the total size held fixed and only the marker's offset moved: readable at 157,833, not readable at 163,371; splitting into several attachments does not raise the budget). So a cookie takes the usable length from 130K to about 160K — **a genuinely long conversation still has to be compacted by the client**. Without a cookie the request is rejected with 400 `context_length_exceeded` rather than losing data silently.

## Configuration

There are only two places to configure things, split by whether a change needs a restart.

### Runtime config → admin panel, Settings page

Saving takes effect **immediately**, no restart. Values live in the database and take precedence over `config.json` and command-line flags.

| Item | Notes |
|---|---|
| Default model | used when the client doesn't send `model` |
| Per-slot concurrency / RPM / RPH | rate limits, 0 = unlimited |
| Prompt byte cap | over the cap: with a cookie the history is sent as a text attachment (usable length up to ~160,000 bytes), without one the request is rejected with 400 `context_length_exceeded`. Neither path truncates silently. Counted in UTF-8 bytes (the upstream limit is byte-based, not token-based), default 128000. 0 = unlimited |
| Multi-turn (`multi_turn`) | off by default. When on, uses Gemini's native conversation_id server-side continuation — the client resends full history each turn, the server detects the continuation and sends only the newest message while history stays server-side, so long conversations no longer hit the single-request byte wall. Works signed-in or anonymous. **Note**: it does not enlarge the model's context window; content past the window is still evicted (recent-kept sliding window). It solves "long chat without hitting the wall + keep recent context", not "feed a huge document". |
| Auto-delete conversation (`auto_delete_conversation`) | off by default. When on, each finished request deletes the conversation it left on gemini.google.com, so signed-in accounts don't pile them up. Signed-in only; async best-effort, a failed delete doesn't affect the response. |
| Temporary chat (`temporary_chat`) | off by default. When on, uses Gemini web's native **Temporary Chat** (`inner[45]=1`): the conversation never enters the account's chat list and isn't used for model training — cleaner than auto-delete, and it saves that extra delete request. Only meaningful signed-in; automatically inactive when server-side multi-turn is on (a temporary chat leaves no list entry, while multi-turn relies on the server keeping the conversation). |
| Anonymous-first (`anon_first`) | off by default. When on, requests that don't need a signed-in session (plain text, no thinking, no tool, no image) go out anonymously without consuming a cookie account, saving account quota; only 3.1 Pro / 3.8 Flash / extended thinking / image gen / file upload etc. pick an account. When off, any request uses an account as long as the pool has one. |
| Retry attempts / retry delay / upstream timeout | |
| Detail retention days | only request details expire; aggregates are kept forever |
| TLS fingerprint | `chrome_146` (default) / `chrome_144` / `chrome_133` / `firefox_147` / `safari_16_0` / `safari_ios_17_0` |
| Gemini `bl` version | upstream frontend build id, change it here when it expires |
| Static proxy | fallback when the proxy pool is empty; normally use the Proxy pool page |
| Request logging | |

Every value is range-checked on the server (for example `retry_attempts` accepts 1-10, timeouts 5-600 seconds) and illegal values are rejected with a reason — browser-side limits are trivial to bypass, so the real gate is server-side.

### Credentials → also in the panel

| Item | Notes |
|---|---|
| API key | generated on first boot, rotatable or replaceable from the panel |
| Google cookie | paste it on the Settings page, effective on save. Once set, `gemini-3.1-pro` appears in the model list |

Both live in the database. Saved values are never echoed back (the cookie only reports how many cookies were recognised and whether the key ones are present).

### Deploy-time config → `docker-compose.yml`

What's left is only what requires restarting the process:

| Item | Where |
|---|---|
| Listening port | `ports` + `command: --port` |
| Database path | `volumes` + `command: --db` |
| `ADMIN_TOKEN` | `environment`, the panel login token |

The `API_KEY` environment variable pins the API key (the panel can't change it), for deployments that must not be changed at runtime.

`--proxy` and `--cookie-file` are **seed parameters, not a second configuration layer**: at startup their values are imported into the proxy pool / cookie pool (deduplicated by URL and by cookie contents), and everything is managed from the panel afterwards. Change them and restart to take effect.

Command-line flags still work and are meant as temporary overrides during local debugging. Precedence: **panel changes > CLI flags / `config.json` > built-in defaults**.

When running the binary directly, copy `config.example.json` to `config.json` as a starting template. Without `--config` the program looks for `./config.json` first, then `$HOME/.config/gemini-web2api/config.json`. Tunables in that file only seed the first boot; once changed in the panel, the panel wins.

All flags:

| Flag | Notes |
|---|---|
| `--port` | listening port, default 8083 |
| `--config` | path to `config.json` |
| `--db` | SQLite path, default `./data/gemini.db` |
| `--admin-token` | panel login token; empty = no auth (only acceptable when bound to 127.0.0.1) |
| `--api-key` | pins the `/v1/*` key so the panel can't change it, same as the `API_KEY` env var |
| `--cookie-file` | imports the cookie in this file into the cookie pool at startup |
| `--proxy` | imports this proxy into the proxy pool at startup |
| `--impersonate` | TLS fingerprint profile |
| `--version` | print version and exit (this is what the Docker healthcheck runs) |

## Cookie (optional)

Attaching a Google account cookie makes requests run as a signed-in session. What it buys you is **`gemini-3.1-pro` plus its reasoning chain** (see the reasoning section above). Verified on a free account: six consecutive calls all reported `3.1 Pro`.

> Signed-in requests must carry an extra XSRF token. The project fetches it from the Gemini page automatically, caches it per cookie and re-fetches on expiry — nothing to configure. (Missing it makes **every** request fail with 400 while anonymous traffic keeps working — an earlier version hit exactly that.)

A signed-in session unlocks `gemini-3.1-pro` + reasoning chain, image/video input, **image generation (`gemini-image`) / music (`gemini-music`)** (see "Image & music" above), **canvas (`gemini-canvas`)** — an interactive HTML document returned inline — and **video generation (`gemini-video`, needs a Pro account)**. Deep research also needs a signed-in session but **is not implemented here yet**.

1. Sign in to [gemini.google.com](https://gemini.google.com)
2. DevTools (F12) → Application → Cookies → `https://gemini.google.com`
3. Copy: `SID` / `HSID` / `SSID` / `APISID` / `SAPISID` / `__Secure-1PSID` / `__Secure-1PSIDTS`
4. Add it in the panel under Cookie pool → Add account, or write it to `cookie.txt` and start with `--cookie-file cookie.txt` (imported into the pool at startup, managed from the panel afterwards):
```
SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-1PSID=...; __Secure-1PSIDTS=...
```

The JSON form `{"cookie": "SID=...; ...", "sapisid": "..."}` is also accepted. Requests carrying `SAPISID` get a computed `SAPISIDHASH` authorization header, so that entry cannot be missing.

**The Cookie pool page is the only place cookies live.** Each request picks an enabled account least-recently-used first and advances the rotation. As soon as the pool holds an enabled account, `gemini-3.1-pro` appears in the model list.

An account's "failure count" and "last success" columns update automatically. Only **401/403 counts as the cookie's fault** — network errors, proxy failures and Google blocks (302) are excluded, because residential exits degrade often enough that counting them would turn the failure count into proxy noise and make healthy cookies look like the worst offenders.

Note that "last success" only means a request involving this cookie succeeded; it does **not** prove the cookie is still valid. An expired cookie doesn't error — Gemini just treats you as anonymous. Use the **Check** button in the list to tell "still signed in" from "expired/invalid" without spending a real conversation on it.

**Cookies renew themselves.** Two things run together:

- Nearly every upstream response refreshes `SIDCC` / `__Secure-1PSIDCC` / `__Secure-3PSIDCC` via `Set-Cookie`, and we merge those back into the account.
- Every 10 minutes (first ping 15 seconds after boot) we hit `accounts.google.com/RotateCookies`: first the sentinel payload that mints a fresh `__Secure-1PSIDTS` (the ~30-minute ticket — without it Gemini treats you as anonymous), then the browser iframe flow that refreshes SIDCC. The same account is not pinged twice within 60 seconds, to avoid HTTP 429.

> **Export cookies from Firefox.** Recent Chrome enables Device Bound Session Credentials, so a session exported from Chrome is bound to that machine and `*PSIDTS` cannot be rotated — it dies in about 30 minutes to a few hours. Firefox has no such binding, and the same keepalive will keep the session alive. If you must use Chrome: log in in a fresh private window, export immediately, and **close that window** so the browser does not rotate the same session out from under you.

**Each account is pinned to its own exit.** If the cookie pool and proxy pool rotated independently, one Google account would emit requests from dozens of different IPs, which is exactly what account sharing looks like to Google. An account binds to the first exit it uses and stays there until that exit becomes unusable.

**A dead account no longer kills the request** — the next account in the pool is tried instead. Otherwise a bigger pool would only mean more ways to hit a bad one.

## Proxy pool (the core of running this for free)

**Why you need it**: a single IP sending in bursts eventually gets redirected to `google.com/sorry/index`. That threshold is **80-180 requests**, and the wide range is driven by **connection strategy, exit quality and pacing** together:

| Exit | Connection strategy | Concurrency | Pacing | Successful requests when blocked |
|---|---|---|---|---|
| residential | Reused connection pool | 10 | no delay | 151 / 172 / 177 |
| residential | Reused connection pool | 3 | no delay | 103 / 111 |
| residential | Fresh connection each time | 10 | no delay | 106 / 109 |
| residential | Fresh connection each time | 1 | 24s apart | 81 / 166 |
| static | Reused connection pool | 10 | no delay | 188 |
| static | Reused connection pool | 1 | **10 per minute** | **800, never blocked** |

Only a 302 to `/sorry/` counts as blocked, and every exit was pre-screened.

**Connection reuse is worth about 60%**: concurrency pinned at 10, both arms started together, each run lasting only 80 seconds (too short for exits to drift) — reused connections reached 172/177, fresh connections 106/109.

**A steady pace matters more than anything else.** On the same static IP, a burst run was blocked after 188 requests, while a steady 10 requests/minute ran **800 requests over 110 minutes without ever being blocked**. The default `per_ip_rph=80` is therefore a very conservative floor; a deployment that deliberately paces itself can raise it a lot.

> This section previously said "slowing down does not help", based on the burst arm (103-177) and the slow arm (81-166) overlapping almost completely on residential exits. The observation was right but the attribution was wrong: residential exits degrade over long runs (6 of 8 pre-screened exits exceeded a 40% failure rate partway through the slow run), and that degradation swamped the effect of pacing. Once a static IP removes that confound, pacing turns out to matter a great deal.

**Proxy failures consume the budget early**: the dirtier the path, the sooner the block, because some of those "failed" requests did reach Google and were counted (the slow arm actually sent 195 requests to get 166 successes, 17% more than the success count suggests). Don't expect to squeeze out capacity by retrying failures.

**Once blocked, the block is hard, and it clears after roughly two hours.** Two independent re-probes of 30 requests each, 20s apart, spanning about 10 minutes: **60 requests, zero successes**. Continued probing recovered somewhere between **106 and 121 minutes**. That is where the proxy pool's default 120-minute cooldown comes from.

Control group: 10 IPs × 50 requests each (418 requests) produced zero rejections from Google. The default `per_ip_rph=80` sits at the low end of the measured burst range.

**The fix**: add several proxies on the Proxy pool page. **Each proxy is an independent IP slot** with its own concurrency/RPM/RPH allowance, so N proxies means N times the total capacity.

Supported proxy schemes:
- `http://user:pass@host:port`
- `https://user:pass@host:port`
- `socks5://user:pass@host:port`
- `socks5h://user:pass@host:port` (remote DNS resolution, avoids local DNS poisoning)

**Scheduling rules**:
- Once any proxy is configured, requests **never fall back to a direct connection** (so a full pool can't end up burning the host IP)
- 5 failures trip the circuit breaker (resettable from the panel)
- All proxies full → HTTP 429 (no Google quota consumed; retry once a slot frees up)

**Environment variables `HTTPS_PROXY` / `ALL_PROXY` are ignored.** Proxies come only from the proxy pool (`--proxy` / `config.json` merely seed the pool at startup). Otherwise a stray `export` on the host would silently change the exit IP while the panel still showed a direct connection, which makes troubleshooting misleading.

## Fingerprint simulation

Direct connections (no proxy) go through [bogdanfinn/tls-client](https://github.com/bogdanfinn/tls-client): the TLS handshake, HTTP/2 SETTINGS frames and ALPS all match a real Chrome 146. From Google's risk-control point of view this is indistinguishable from a real browser.

Proxied connections switch to stdlib `net/http` with `http.ProxyURL` (best compatibility), but the application-layer headers (`Sec-CH-UA`, `Sec-Fetch-*`, `User-Agent`) are still spoofed with Chrome 146's real values.

**Note that through a proxy the TLS fingerprint is still ours, not the exit node's.** HTTP CONNECT only builds a tunnel; the TLS handshake is end-to-end between us and Google. JA3 echo tests confirm it: through the same proxy, stdlib and tls-client produce different JA3s (so the proxy isn't rewriting anything), while stdlib direct and stdlib through a proxy produce identical JA3s (so the proxy layer doesn't touch TLS). **So once a proxy is configured, what Google sees is the Go standard library's fingerprint, not Chrome 146's.**

This does not change the blocking threshold, though: in a same-start comparison, tls-client Chrome_146 reached 111 requests and Go stdlib 103 — a gap of 8, while the variance between exits under identical settings reaches 36% (151 vs 111). Making the proxy path use the Chrome fingerprint needs a different justification (long-term account profiling, say); it won't buy throughput.

**An observation from testing**: a naive SDK call (e.g. Python urllib) that trips risk control gets **HTTP 429**; once disguised as Chrome, tripping it yields **HTTP 302** to `google.com/sorry/index` (the CAPTCHA page). Both are IP blocks, but the 302 confirms Google really does take us for a browser.

## Privacy

- **Prompt and response bodies are never stored** — only metadata: model, proxy id, latency, token counts, status code, error type
- Legacy `prompt_preview` / `response_preview` columns are dropped automatically when migrating from older versions
- Token counts are computed with the [tiktoken-go](https://github.com/pkoukk/tiktoken-go) cl100k_base BPE tokenizer (accurate for both English and Chinese), not a `len/4` estimate
- Gemini's web app does not return real token counts (no token/usage field appears anywhere in the response), so local estimation is the only option

## OpenAI protocol coverage

| Endpoint | Status | Notes |
|---|---|---|
| `POST /v1/chat/completions` | ✅ | Real streaming: every upstream frame is forwarded as a delta (a 400-character Chinese answer produced 40 chunks). Chunk sequence is `delta{role}` → `delta{content}`×N → empty `delta` + `finish_reason` → `[DONE]`. **Degrades to buffered when `tools` are present** — a tool_call block needs the complete text to parse |
| `POST /v1/responses` | ✅ | OpenAI Responses API (used by Codex CLI). **Not incrementally streamed** — still buffered, then emitted as the event sequence |
| `GET /v1/models` | ✅ | 2 models anonymously, the third appears once a cookie is set |
| `GET /` | ✅ | Health check, unauthenticated, returns status/version/models |
| `/v1beta/models/…` (Gemini API native) | ✅ | Miraz fork: `generateContent`, `streamGenerateContent`, model list/get, JSON mode, thinking levels, inline files. See "Miraz fork changes" below | 
| `/v1/embeddings`, `/v1/images/*`, `/v1/audio/*` | ❌ | Not implemented, return 404 |
| Function calling | ⚠️ | Prompt-level implementation (the model emits a ` ```tool_call``` ` block that we parse with a regex), not a real protocol layer. **Reliable for looking up private data or internal systems**, but anything Gemini can answer itself (the weather) gets answered directly, and side-effecting actions (sending email) are refused. **Agentic clients (Codex, etc.) now work**: before 4.11.0 their tens-of-KB system prompts buried our tool instructions and caused off-topic replies; fixed now. Since 4.12.0 tool results are condensed into a clear success/failure signal, so weak models no longer misread a no-output success as a failure and loop retrying (measured: the same task dropped from 26 loops to 2-4 before it concludes) |
| `tool_choice` | ⚠️ | `none` injects no tool definitions at all; `required` and a named function add mandatory wording and drop the other tools from the prompt. A prompt-level layer **cannot truly force it** — in testing, questions the model can answer itself (weather, 2+2) were answered directly even under `required` |
| `stream_options.include_usage` | ✅ | Emits a usage chunk with an empty `choices` array after `finish_reason` |
| `usage` token counts | ✅ | tiktoken cl100k_base, the same basis as the panel's requests table |
| `n` > 1 | ❌ | Returns 400. Upstream yields a single candidate; silently treating it as 1 would short-change the client |
| Sampling params | ➖ | `temperature` / `top_p` / `max_tokens` / `stop` / `seed` / `presence_penalty` / `frequency_penalty` are **accepted and ignored, not rejected**. Gemini's web protocol has no such knobs |
| `response_format` | ✅ | Miraz fork: `json_object` and `json_schema` are enforced (validate + one repair round), also `text.format` on `/v1/responses`. See "Structured JSON output" below | 
| `logprobs` | ➖ | Not implemented, accepted and ignored |
| Vision / image input | ⚠️ | **Works with a cookie**: both `image_url` (chat) and `input_image` (responses) are accepted, from `data:` URLs or http(s) links, up to 12MB per image (other files and video: see "Files, video and audio" below). Anonymous is refused (503 `no_valid_account`) — anonymous upload **does** work (`content-push.googleapis.com/upload/`, two-step resumable), but referencing the uploaded file in a conversation is refused upstream (`BardErrorInfo 1100`) |
| Audio input | ⚠️ | Miraz fork: `input_audio` is accepted and uploaded as a file attachment (kind 3, real audio mime). Whether Google's web app actually reads it is to be verified live. The web app also has music generation (Lyria 3), signed-in only |

## Project layout

```
main.go                    just calls app.Run(); the entry stays at the root so `go build .` works
internal/app/              everything else
  app.go                   flag parsing + route registration + startup
  config.go                config loading + defaults
  client.go                tls-client (chrome146) + stdlib (when proxied)
  gemini.go                model table + 80-slot payload + model header + StreamGenerate + wrb.fr parsing
  xsrf.go                  XSRF token required with a cookie: fetch + per-cookie cache + self-heal
  messages.go              OpenAI messages → prompt, tool_call parsing
  server.go                /v1/* + rate-limit entry + request validation + metrics
  sse.go                   SSE writer (lazy header, so early failures still return 502 JSON)
  ratelimit.go             per-IP-slot concurrency / RPM / RPH
  tokenizer.go             tiktoken cl100k_base singleton
  apikey.go                API key (locked by flag / rotatable from the panel)
  db.go                    SQLite schema: sessions / requests / accounts / kv
  proxy.go                 proxy pool CRUD + capacity scheduling + circuit breaker
  cookie_pool.go           cookie pool data layer (CRUD + least-recently-used pick + health writeback + refresh merge)
  rotate.go                session keepalive (RotateCookies: 1PSIDTS sentinel + SIDCC iframe, server-dictated interval)
  upload.go                attachment upload (content-push, two-step resumable)
  context_file.go          over-long conversations as a text attachment
  vision.go                image input: data: URL / http(s) link -> pending attachment
  bl.go                    upstream frontend version (bl) auto-follow
  scheduler.go             hourly/daily aggregation + retention cleanup
  runtime.go               runtime config snapshot (panel edits apply instantly)
  admin.go                 /admin/api/* auth + REST
  admin_cookies.go         cookie pool admin REST (redacted before returning)
  admin_ui.go              embeds admin_ui/
  admin_ui/                admin panel frontend (single page + Chart.js, embedded, no CDN)
  gemini_test.go           protocol-layer tests: payload slots, wrb.fr parsing, model gating, rate limits
Dockerfile                 multi-stage (alpine builder → distroless runtime)
docker-compose.yml         single container, pulls the ghcr image by default, sqlite on a volume
.github/workflows/         docker.yml pushes images / release.yml publishes binaries on tag
```

## Limitations

- **Per-IP ceiling**: when sending in bursts, measured at **80-180 requests** before the sorry-page redirect (connection reuse buys about 60%: at concurrency 10, a reused pool reached 172/177 versus 106/109 for a fresh connection per request). But **a steady pace barely reaches the ceiling at all** — 10 requests/minute on a static IP ran 800 requests without a block. `per_ip_rph=80` sits at the bottom of the burst range → use the proxy pool to scale, or pace yourself and raise the limit
- **Signed-in features**: image generation (`gemini-image`), music (`gemini-music`), canvas (`gemini-canvas`) and video generation (`gemini-video`, Pro accounts only — free accounts are refused by the content policy) are implemented; deep research is not (a multi-step async flow)
- **Function calling**: prompt-level, the model doesn't always answer in the expected format (a real protocol layer isn't available to us)
- **Multimodal**: image/video input needs a cookie. Image, music, canvas and video generation work with a cookie; video generation additionally needs a Pro/paid account
- **Long context hits two walls**: ~130,000 bytes for the request body and ~160,000 bytes for attachments (the latter is the **total** amount of content the model can see — splitting it across several attachments does not raise the budget). A cookie only takes the usable length from 130K to ~160K; genuinely long conversations still have to be compacted by the client
- **Token counts**: tiktoken estimates (Gemini's real tokenizer is not public), within about ±20% of the true value
- **Cookie pool never auto-removes a bad account**: outcomes are written back (only 401/403 count as the cookie's fault — network errors and 302 blocks don't), but failures never trigger an automatic disable, so you have to do it from the panel. Also `last_ok_at` only means "a request using this cookie succeeded", not that the cookie is still valid — an expired cookie doesn't error, Gemini just treats you as anonymous and plain text requests still return 200
- **Cookies exported from Chrome may not renew**: recent Chrome Device Bound Session Credentials bind the session to the machine, and rotating `__Secure-1PSIDTS` then returns 401. Export from Firefox for a session that can be kept alive
- **Streaming is only half real**: `/v1/responses` and chat requests carrying `tools` are buffered; only plain chat streams incrementally

## Troubleshooting

| Symptom | Most likely cause | What to do |
|---|---|---|
| We return **429** | Every IP slot is at its concurrency/RPM/RPH limit. **This is not Google refusing** and no upstream quota was consumed | Add proxies, or raise the limits on the Settings page |
| Panel diagnostics show **302 → `google.com/sorry/index`** | This exit IP is blocked by Google (after 80-180 requests, depending on connection strategy and exit quality) | Change exit / add proxies. **The block is hard, not probabilistic** (60 probes after a block, zero successes), so retrying in place is pointless |
| Occasional empty responses, logged as an upstream refusal | Upstream transient refusal (`1155`). There is no predictable threshold — it correlates with neither rate, concurrency, nor cumulative count | Resend once and it usually works. **Lowering RPM does not help**: measured, it is unrelated to request rate |
| Every request times out | This host can't reach `gemini.google.com` | Configure a proxy (panel or `--proxy`). Note that **`HTTPS_PROXY` is not read** |
| Exits at startup with `unable to open database file (14)` | The container runs as nonroot (uid 65532) but the bind-mounted host directory is owned by root, so it can't be written | Use a named volume (the default in compose), or `sudo chown -R 65532:65532 ./data` |
| `gemini-3.1-pro` errors out immediately | It isn't exposed without a cookie, by design | Add an account on the Cookie pool page and it becomes available |
| Every request returns 503 `no_valid_account` after attaching a cookie | The cookie expired, so the XSRF token can't be fetched | Re-export the cookie. Quick check: if `gemini-3.1-pro` reports 3.5 Flash-Lite, it's expired |
| Cookie dies in about 30 minutes; keepalive does nothing | Chrome device-bound session; rotating `__Secure-1PSIDTS` returns 401 | Re-login in **Firefox** and export again. The panel Keep-alive button should report that `__Secure-1PSIDTS` was refreshed |
| Panel won't open / 401 | `--admin-token` (or `ADMIN_TOKEN`) doesn't match | An empty token disables auth, which is only acceptable when bound to 127.0.0.1 |

With Docker's default bridge network, upstream may return empty content (Google rejects certain NAT ranges). We have **never reproduced it here**. If you hit it, try `network_mode: host` to confirm whether that is the cause.

## FAQ

### How is this different from the official Gemini API? Do I need an API key?

No API key. This project does not wrap `generativelanguage.googleapis.com`; it reverse-proxies the protocol of the
gemini.google.com web app itself, so there is no key and no paid quota. The trade-off is that capabilities follow the
web app: what the web app can do (web search, image, music, canvas, video generation) works here; what it can't
(deep research) doesn't. Anonymous use — no cookie at all — already gives you the text models.

### How does this relate to Sophomoresty/gemini-web2api (Python) and other Go projects named gemini-web2api?

This is an independent Go implementation. Its early protocol work was informed by the Python project (see Links);
it is **not a port**, and other Go repositories with a similar name are unrelated. What this one brings: a single
static binary, a real Chrome TLS fingerprint via utls, a proxy pool plus a cookie pool (automatic renewal, each
account pinned to one exit), a built-in admin dashboard, SQLite / MySQL / PostgreSQL, the async `/v1/videos`
endpoint, and an MCP `web_search` tool.

### Why does my cookie die after about 30 minutes? How do I keep it alive?

The ticket that expires is `__Secure-1PSIDTS` (roughly 30 minutes). The proxy re-mints it on a timer with a sentinel
payload and runs a keepalive, so **a cookie exported from Firefox stays alive indefinitely**. Recent Chrome enables
Device Bound Session Credentials: a session exported from Chrome returns 401 on rotation and dies within 30 minutes
to a few hours. Export from Firefox instead — no browser extension or always-on machine needed.

### Will my account get banned? Is the limit per account or per IP?

Per **exit IP + TLS fingerprint**, not per account. Measured: a burst of roughly 80–180 requests from one exit
triggers the sorry-page redirect, which clears itself after about two hours; a steady pace (e.g. 10 requests per
minute) ran 800 requests without a block. A paid plan (Google AI Pro) does **not** raise this ceiling. To scale,
spread requests across exits with the proxy pool rather than adding accounts.

### What do I get with a free account versus Pro / paid?

Anonymous (no cookie): `gemini-3.6-flash` and `gemini-3.5-flash-lite`, web search included.
A free account's cookie additionally unlocks `gemini-3.1-pro`, the `-thinking` variants of all three models,
image / video input, image generation, music and canvas.
Paid accounts only: `gemini-3.8-flash`, `gemini-4-argon` (and their `-thinking` variants; free accounts are
downgraded to 3.5 Flash-Lite) and video generation (`gemini-video` / `/v1/videos`).

### Why does every message create a new conversation on gemini.google.com?

Each request is its own conversation by default. Enable **server-side multi-turn** (`multi_turn`) on the panel's
Settings page and consecutive messages of one conversation reuse the same web session, sending only the newest
turn while history stays server-side. To stop conversations piling up in the web app, you have two options:
enable **temporary chat** (`temporary_chat`) so the conversation never enters the list at all (cleaner, not used
for training, nothing to delete — recommended), or enable **auto-delete web conversation**
(`auto_delete_conversation`) to delete it after each reply. Both only matter for signed-in accounts.

### Can I use it as the backend for Cursor / Dify / WorkBuddy-style agents?

You can connect them (it is OpenAI-compatible), and plain chat and coding work fine. But the web app caps a single
request at roughly **130,000 bytes** (about 160,000 with a cookie); agent tools that push tens of kilobytes of system
prompt and history per request will get off-topic answers and look "dumb" — a limit of the web model itself, not of
the proxy. Function calling is prompt-level, so the model does not always answer in the expected format.

### Is gemini-3.8-flash available?

Yes: `gemini-3.8-flash` and `gemini-3.8-flash-thinking`, for paid Gemini accounts; requests from free accounts are
downgraded server-side to 3.5 Flash-Lite. `gemini-3.7-flash` remains as an alias so older clients keep working.

### Which model does image generation use? Can it output 2K?

`gemini-image` uses the web app's image-generation tool slot rather than a pinned model: whatever backend the web
app currently uses (e.g. Nano Banana 2) is what you get, automatically. Resolution is capped by the web app at
roughly one megapixel; there is no 2K.

### Why does streaming turn into a single response behind Dify / a reverse proxy?

Plain chat streams for real (every upstream frame is forwarded as it arrives); requests carrying `tools`, and
`/v1/responses`, are buffered and sent whole. Responses already carry `X-Accel-Buffering: no`; if output still
arrives in one piece behind Nginx or similar, check the reverse proxy's own buffering — connected directly, the
proxy streams chunk by chunk.

### Does it support MySQL / PostgreSQL?

Yes. Set `SQL_DSN` (`mysql://user:pass@host:3306/db` or `postgres://user:pass@host:5432/db?sslmode=disable`);
unset means SQLite. Tables are created automatically and all three share one schema. SQLite is the easy choice for a
single instance; MySQL / PostgreSQL only matter when several instances share one pool.

## Miraz fork changes

This fork (used behind the Miraz.tv newsroom pipeline) changes how upstream failures are reported, removes the
client-side generation timeout, adds health monitoring, structured JSON output, Gemini-native `/v1beta` endpoints and
inline file input. The base project's behaviour is otherwise unchanged.

### Error classes and HTTP status mapping

Every failure of a call to Google is classified where it is detected and mapped to a status in one place
(`internal/app/upstream_error.go`). Error bodies are OpenAI-shaped: `{"error":{"message","type","code"}}`.

| Failure | HTTP | `code` | Notes |
|---|---|---|---|
| Google 429, `RESOURCE_EXHAUSTED` / "usage limit" / "quota" / "rate limit" text in an error body or in an answer with no content, or a 302 to `google.com/sorry` (bot block) | 429 | `upstream_rate_limited` | `Retry-After` header in seconds: Google's own value (header, or a "retry in Ns" hint) if present, otherwise 60; 7200 for the sorry block |
| Google 5xx, network/DNS/TLS errors, truncated body, HTTP 200 with no content frame (the transient `1155`), 600 s safety ceiling hit, upload or media retrieval failure | 503 | `upstream_unavailable` | Retryable |
| Google answered in a shape we cannot parse: unexplained 400 (after one bl refresh, see below), 404/405/410, HTTP 200 without any `wrb.fr` frame, canvas without an HTML document | 503 | `upstream_protocol_changed` | Also written to the event log (throttled to one per minute) |
| No usable cookie: all accounts disabled/expired, XSRF token unobtainable, Google 401/403 for a signed-in request, a login-only model or image/video input with an empty pool | 503 | `no_valid_account` | |
| The model answered but not with JSON that satisfies `response_format` / `responseSchema`, even after the repair round | 503 | `upstream_invalid_json` | See "Structured JSON output"; the message never contains the answer |
| All local IP slots are full (the local limiter) | 429 | `ip_slot_full` | Unchanged; no Google quota was consumed |
| Prompt over `max_prompt_bytes` | 400 | `context_length_exceeded` | Unchanged |
| Client mistakes (bad JSON, unknown model, `n>1`, empty prompt, bad `response_format`) | 400 | none | Unchanged |
| Unsupported attachment type | 400 | `unsupported_input` | See "Files, video and audio" |
| Attachment over its size cap | 413 | `attachment_too_large` | 12 MB image, 50 MB video or file |
| Request body over 80 MB | 413 | `request_too_large` | `http.MaxBytesReader` on every route |
| Client disconnected | 499 (only in the request log) | | The Google call is cancelled; nothing is written back |

The same mapping applies to `/v1/chat/completions` and `/v1/responses` (and, in Google's error shape, to `/v1beta`). Once a stream has started, the HTTP status can no
longer change, so the class and code travel inside the stream: a chat stream ends with an `error` chunk carrying
`message`, `type`, `code` (and `retry_after`); a Responses stream emits `response.failed` with the same fields.
The admin error breakdown (`classifyError`) understands the new classes (`upstream_rate_limited`, `no_valid_account`,
`upstream_protocol_changed`, `upstream_timeout`, `client_closed`) next to the old ones.

An unexplained 400, or a response whose frames cannot be parsed, is what a stale `bl` build id looks like. The proxy then
re-scrapes `bl` immediately (at most once per 5 minutes, only with `gemini_bl_auto` on) and, if it changed, retries once
without spending a retry attempt. Every `bl` change is written to the event log.

### No generation timeout

Google's thinking and writing time is not bounded by this proxy.

- `request_timeout_sec` now bounds only small control requests: the `/app` page fetch (XSRF, `bl`), `RotateCookies`,
  uploads and media downloads. It no longer applies to `StreamGenerate` or conversation calls.
- Generation calls use clients without an `http.Client.Timeout`. The inbound request context is passed to the upstream
  call, so a client disconnect cancels the Google call and frees the IP slot.
- One safety ceiling of 600 s covers a whole generation, retries included (`generationCeiling` in `client.go`). It is a
  dead-connection guard only; hitting it is reported as `upstream_unavailable`.
- TCP keepalive (30 s) is enabled on upstream connections.
- The server `WriteTimeout` stays 0; `ReadTimeout` (30 s) covers reading the request only.

### Health, canary and events

- `GET /healthz` (no auth, no secrets): `{status, version, accounts:{total,enabled,healthy}, bl:{value_age_seconds, source:"auto"|"config"|"repair"}, xsrf_ok_last, last_canary:{ok, at, error_class, latency_ms}, last_repair:{at, kind, ok}, browser_fallback:{configured, last_used_at}, transport:{direct_ok_last, browser_used_last, browser_answers, direct_answers}, problems}`.
  The last three blocks belong to the self-repair feature below; `last_repair`, `last_used_at`, `direct_ok_last` and `browser_used_last` are `null` until there is something to report.
  Returns 200 when at least one healthy account exists (or the pool is empty, or `fallback_anon` is on) and the last canary did not
  fail; otherwise 503. "Healthy" means enabled with no consecutive failures. `value_age_seconds` and `xsrf_ok_last` are `null`
  until there is something to report.
- The canary sends the fixed prompt `Reply with the single word: pong` through the normal generation path and expects
  "pong" in the answer. The scheduler runs it every `canary_interval_min` minutes (runtime setting, default 30, 0 disables);
  `POST /admin/api/canary` runs it on demand (409 if one is already running). A run that only hit the local IP-slot limiter is
  not recorded. The last result is stored in the `kv` table.
- `GET /admin/api/events` (admin auth) lists the latest 200 rows of the `events(ts, kind, detail)` table, newest first.
  Kinds: `canary_failed`, `canary_recovered`, `bl_changed`, `account_disabled` (by account id only), `protocol_parse_failure`,
  and for self-repair `repair_context_served` (account id only), `repair_adopted`, `repair_unvalidated`, `browser_fallback_used`,
  plus whatever the repair job posts itself (`repair_started`, `repair_failed`, ...).
  Events never contain prompts, answers or cookies. They follow `retention_days`.
- `POST /admin/api/events` (admin auth) `{"kind", "detail"}` adds a row: `kind` must match `^[a-z_]{3,40}$`, `detail` is at most
  500 characters, otherwise `400`. Response `{"ok":true,"event_id":n}`. The repair job uses it for its progress events.

### Self-repair and the browser fallback

Google changes its private web protocol now and then. The Miraz fork handles that in three steps:

1. **Detect.** The canary (above) fails with `upstream_protocol_changed`; `/healthz.last_canary.ok` turns `false`, which is
   what the host trigger of the repair container (`repair/`) watches.
2. **Learn and validate.** The repair job opens `gemini.google.com` in a real headless browser, reads the page facts (build
   label `bl`, the model picker catalogue) and reports them to the bridge. The bridge **stages** the values, runs a canary on the
   **direct** path with them and keeps them only if it passes; otherwise it restores the previous values.
3. **Browser transport.** Until that works (or when it cannot), generations are answered through the repair container's `serve`
   mode, a browser session that really types the prompt into the web app.

Everything the repair job does goes through the admin API (`Authorization: Bearer <admin token>`):

| Endpoint | Purpose |
|---|---|
| `GET /admin/api/repair/context` | Cookies of the healthiest enabled account plus the canary spec. |
| `POST /admin/api/repair/learned` | The job reports page facts; the bridge validates and adopts or rolls back. |
| `POST /admin/api/events` | The job's own progress events (above). |

**`GET /admin/api/repair/context`** returns secrets, so it accepts only `Authorization: Bearer <admin token>`: no session cookie,
no `?token=`, and `403` when no admin token is configured at all (never open). The response is `Cache-Control: no-store` and is never
logged; the event `repair_context_served` records the account id only. Keep it on the internal network.

```json
{
  "cookies": [{"name":"SID","value":"...","domain":".google.com","path":"/","secure":true,"httpOnly":true}],
  "account_id": "acc-7",
  "canary_prompt": "Reply with exactly one word: pong",
  "canary_expect": "pong"
}
```

The account is the enabled one with the fewest consecutive failures, then the most recent success (reading a context does not
count as using it). With no enabled account `cookies` is `[]` and `account_id` is `null` (an anonymous repair).

**`POST /admin/api/repair/learned`** body:

```json
{"kind":"page_facts","bl":"boq_gemini-web-uiserver_20261016.04_p0","signed_in":true,
 "captured_at":"2026-10-17T10:00:00.000Z","account_id":"acc-7",
 "models":[{"id":"fbb127bbb056c959","label":"3.6 Flash"}]}
```

Shapes are validated (`400 {"ok":false,"error"}` otherwise): `kind` is `page_facts`; `bl` (optional) matches the same pattern the
auto-scraper accepts; `models` has at most 100 entries with an id of up to 64 safe characters and a printable label; `signed_in`
is a boolean; `captured_at` is RFC 3339; at least one of `bl` / `models` must be present. Extra fields from the job are ignored.
Then:

- **bl**: staged as the effective build label. A learned `bl` beats both the pinned `gemini_bl` and the scraped one and survives a
  restart (kv key `repair_learned`; the health report shows `bl.source: "repair"`). Saving a different `gemini_bl` in the panel drops it.
- **Models**: a catalogue entry is adopted only if its label names exactly one model family (matched case- and spacing-insensitively
  against the web labels in `modelFamilies`, `model_route.go`), its id is a 16-hex id, all entries of that family agree on one id and no
  other family claims the same id. The id then replaces the hex of the whole family (plain model, thinking variant, aliases); the
  catalogue value stays the reference for "needs a login". Anything that does not map unambiguously is recorded in the event but not adopted.
- **Canary**: runs on the direct path with the staged values (up to 25 s, so the job's 30 s HTTP timeout still gets an answer).
  Real traffic briefly sees the staged values while it runs.

Response: `{"ok":true,"validated":true,"event_id":123}` when adopted (event `repair_adopted`), or
`{"ok":true,"validated":false,"event_id":124,"error":"canary failed: upstream_protocol_changed"}` after a rollback (event
`repair_unvalidated`; also when another canary is still running or the local IP slots were full). `409` while another report is
being validated. The outcome is shown as `last_repair:{at, kind, ok}` in `/healthz`.

**Browser fallback.** Runtime setting `browser_fallback_url` (panel: request behaviour; empty = off), for example
`http://gemini-web-browser.internal:9000`, and the environment variable `BROWSER_FALLBACK_TOKEN` (the bearer token of the browser job;
it is never stored in the database or shown in the panel). A generation goes to the browser when

- the direct attempt failed with `upstream_protocol_changed` and nothing was streamed to the client yet, or
- the last canary failed with that class: then the browser is asked first and the direct path stays the last resort,

and the browser job's `GET /healthz` answers `{"ok":true}`. The canary itself always tests the direct path, so `/healthz` keeps
telling the truth about it and the repair trigger keeps working.

The bridge calls `POST {url}/generate` with `Authorization: Bearer $BROWSER_FALLBACK_TOKEN` and
`{"prompt","model_label","attachments":[{"name","mime","data_b64"}],"json":bool}`; the job answers
`{"text","model_label_seen"}`. There is no time limit apart from the usual 600 s dead-connection ceiling. Errors are classified like
Google's: `429` / `upstream_rate_limited` (`Retry-After` kept), `503` with `no_valid_account` / `upstream_protocol_changed` /
`upstream_unavailable`; any other answer is `upstream_unavailable`. If the direct attempt had failed with the protocol error, only a
browser rate limit or a missing account replaces it as the client's error; other browser failures leave the original verdict.
JSON mode (validation and the repair round), tool-call parsing and the request log work on the browser's text like on Google's.

| Model id | Label sent as `model_label` |
|---|---|
| `gemini-3.6-flash` | `3.6 Flash` |
| `gemini-3.5-flash-lite` | `3.5 Flash-Lite` |
| `gemini-3.1-pro` | `3.1 Pro` |
| `gemini-3.8-flash` (and alias `gemini-3.7-flash`) | `3.8 Flash` |
| `gemini-4-argon` | `4 Argon` |

The table is `WebLabel` in `modelFamilies`; the browser job picks the model whose picker label matches. A `-thinking` variant is
sent with its family's label (the browser transport has no separate thinking switch). Not served by the browser transport: media
models (`gemini-image`, `-music`, `-video`, `-canvas`), requests with more than 8 attachments, and streaming (the answer arrives
whole and is sent to a streaming client in one piece).

**Which transport answered** is recorded in the request log as `proxy_name = "browser"` (a direct answer shows its proxy, or nothing
for a direct connection), so the admin per-proxy breakdown shows browser answers as their own row. `/healthz` adds
`transport:{direct_ok_last, browser_used_last, browser_answers, direct_answers}` (counters since the process started) and
`browser_fallback:{configured, last_used_at}`. A fallback answer is also written to the event log as `browser_fallback_used`
(at most once a minute).

### Request size cap

Every request body is limited to 80 MB; larger bodies get `413` with `code: request_too_large`.

### Structured JSON output

Google's web app has no response-schema switch, so JSON mode is enforced by the bridge: a strict format block is
appended to the prompt, the answer is cut down to its outermost JSON value (markdown fences and prose around it are
dropped), parsed, and validated when a schema is given.

Requests that turn it on:

| API | Field |
|---|---|
| `/v1/chat/completions` | `response_format: {"type":"json_object"}` or `{"type":"json_schema","json_schema":{"name","schema","strict"}}` |
| `/v1/responses` | `text.format: {"type":"json_object"}` or `{"type":"json_schema","name","schema","strict"}` |
| `/v1beta/...:generateContent` | `generationConfig.responseMimeType: "application/json"`, optionally with `responseJsonSchema` (JSON Schema) or `responseSchema` (OpenAPI subset: upper-case types, `nullable`, `propertyOrdering`) |

Behaviour:

- **Validation subset**: `type` (including unions such as `["string","null"]` and `nullable`), `properties`, `required`,
  `additionalProperties` (false or a schema), `enum`, `const`, `items`, `anyOf` / `oneOf` / `allOf`, local `$ref`
  (`#/$defs/...`), `minItems` / `maxItems`, `minLength` / `maxLength`, `minimum` / `maximum`. Anything else (`pattern`,
  `format`, ...) is shown to the model but not enforced. The schema is validated whether or not `strict` is set; `strict`
  only adds a stronger sentence to the prompt.
- **One repair round**: if the answer is not valid JSON or violates the schema, the same request sends the original
  prompt, the invalid answer and the validation error back and asks for corrected JSON only. The repair runs on the **same
  cookie account** (and egress) as the first call, with the same attachments. It has no time limit of its own: each Google
  call is bounded only by the 600 s dead-connection ceiling and the client disconnecting. A Google failure in the first
  call is returned as is, without a repair.
- **Still invalid** after the repair: `503` with `code: upstream_invalid_json` (`type: upstream_error`; on the Gemini
  routes `status: UNAVAILABLE` with the code in `error.details[0].reason`). It is a 503 so a caller's pool fails over to
  another provider. The error message names a location and a rule (`$.items[2].title: expected string, got number`),
  never the model's text.
- **Result**: the clean JSON text is the message content (`choices[0].message.content`, `output_text`, or the
  candidate's text part). The first `{` (or `[` when the schema root is an array) starts the value, the matching close
  ends it.
- **Buffered**: the answer is checked before anything is sent, so streaming clients (`stream: true`,
  `streamGenerateContent`) receive the clean JSON in one piece at the end. JSON requests always use the single-turn
  prompt path (`multi_turn` is bypassed).
- **Not combinable with tools**: `response_format` / `text.format` together with `tools` is `400`.
- `temperature`, `top_p`, `max_tokens`, `maxOutputTokens`, `stop`, ... are accepted and ignored; output is never cut.

```bash
curl -s http://localhost:8083/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [{"role":"user","content":"Summarise: the parliament approved the 2027 budget."}],
    "response_format": {"type":"json_schema","json_schema":{"name":"story","strict":true,"schema":{
      "type":"object",
      "properties":{"headline":{"type":"string"},"topics":{"type":"array","items":{"type":"string"}}},
      "required":["headline","topics"],"additionalProperties":false}}}
  }'
# choices[0].message.content is {"headline":"...","topics":["..."]}
```

### Gemini-native endpoints (`/v1beta`)

A client that speaks the Gemini API (SDK with a custom base URL, or plain REST) can use the bridge directly.

| Endpoint | Notes |
|---|---|
| `GET /v1beta/models` | `{"models":[{name, displayName, description, inputTokenLimit, outputTokenLimit, supportedGenerationMethods, thinking, baseModelId?}]}` |
| `GET /v1beta/models/{model}` | One entry; `404 NOT_FOUND` for an unknown model |
| `POST /v1beta/models/{model}:generateContent` | One JSON response |
| `POST /v1beta/models/{model}:streamGenerateContent` | `?alt=sse`: `text/event-stream`, one `data: {GenerateContentResponse}` frame per update. Without `alt=sse`: a JSON array of the same objects (Google's default) |

- **Auth**: the bridge API key in the `x-goog-api-key` header or the `?key=` query parameter (`Authorization: Bearer` and
  `x-api-key` work too). Missing key: `401 UNAUTHENTICATED`; wrong key: `403 PERMISSION_DENIED`.
- **Models**: the ids in the mapping table below, with or without the `models/` prefix. `inputTokenLimit` /
  `outputTokenLimit` are the nominal Google numbers (1048576 / 65536), advisory only: the bridge enforces
  `max_prompt_bytes` and never cuts output. The list shows what is usable right now (the thinking variants need a cookie).
- **Request** (camelCase JSON): `contents[]` (`role` `user` / `model`; parts `text`, `inlineData{mimeType,data}`,
  `fileData{mimeType,fileUri}`), `systemInstruction`, `generationConfig{responseMimeType, responseJsonSchema |
  responseSchema, thinkingConfig{thinkingLevel, thinkingBudget, includeThoughts}, candidateCount: 1}`. `temperature`,
  `topP`, `topK`, `maxOutputTokens`, `stopSequences`, `safetySettings` are accepted and ignored. Not available:
  `tools` / function calling and code-execution parts (`400 INVALID_ARGUMENT`), `candidateCount > 1`,
  `responseMimeType` other than `text/plain` / `application/json`, Files API / `gs://` URIs in `fileData` (only
  http(s) links the bridge can fetch are accepted; otherwise send the bytes as `inlineData`), and the other methods
  (`countTokens`, `embedContent`, ...).
- **Response**: `candidates[0]` = `{content:{role:"model", parts:[{text}]}, finishReason:"STOP", index:0}`, plus
  `usageMetadata{promptTokenCount, candidatesTokenCount, totalTokenCount, thoughtsTokenCount?}`, `modelVersion` (the
  model actually served, for example `gemini-3.6-flash-thinking`) and `responseId`. With
  `thinkingConfig.includeThoughts: true` and a thinking model that produced thoughts, the thought text comes first as a
  part `{text, thought:true}`; otherwise thoughts are hidden (they still count in `thoughtsTokenCount`). Token counts
  use the same tokenizer as the rest of the bridge.
- **Errors** are Google-shaped, `{"error":{"code","message","status","details":[ErrorInfo]}}`, with the HTTP mapping of
  the OpenAI routes: `429 RESOURCE_EXHAUSTED` (+ `Retry-After`), `503 UNAVAILABLE`, `400 INVALID_ARGUMENT`,
  `404 NOT_FOUND`, `413` for oversized input. The bridge's own class (`upstream_rate_limited`, `upstream_unavailable`,
  `upstream_protocol_changed`, `no_valid_account`, `upstream_invalid_json`, ...) is `error.details[0].reason`. After a
  stream has started the error is sent as a final frame instead.

```bash
# Plain request
curl -s "http://localhost:8083/v1beta/models/gemini-3.6-flash:generateContent" \
  -H "x-goog-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": {"parts":[{"text":"Answer in one sentence."}]},
    "contents": [{"role":"user","parts":[{"text":"What is a budget deficit?"}]}]
  }'
# {"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]},"finishReason":"STOP","index":0}],
#  "usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":24,"totalTokenCount":36},
#  "modelVersion":"gemini-3.6-flash","responseId":"..."}

# Thinking + JSON schema + streaming (SSE)
curl -sN "http://localhost:8083/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse&key=$KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role":"user","parts":[{"text":"Classify: markets rallied after the rate decision."}]}],
    "generationConfig": {
      "thinkingConfig": {"thinkingLevel":"HIGH","includeThoughts":true},
      "responseMimeType": "application/json",
      "responseSchema": {"type":"OBJECT","properties":{"topic":{"type":"STRING"},"sentiment":{"type":"STRING","enum":["positive","neutral","negative"]}},"required":["topic","sentiment"]}
    }
  }'
# data: {"candidates":[{"content":{"role":"model","parts":[{"text":"{\"topic\":...}"}]},"finishReason":"STOP","index":0}],"usageMetadata":{...},"modelVersion":"gemini-3.8-flash-thinking",...}
```

### Model and thinking mapping

One table in code (`internal/app/model_route.go`) serves both API styles. Every real upstream model has a plain id and a
`-thinking` sibling (the web app's extended thinking, which also emits `reasoning_content` on `/v1/chat/completions`).

| Request | Served model |
|---|---|
| `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gemini-3.8-flash`, `gemini-4-argon` (also `gemini-3.7-flash`, an alias of 3.8; each with or without the `models/` prefix) | the same id |
| any of them + `thinkingLevel` `HIGH` or `MEDIUM` | `<id>-thinking` |
| any of them + `thinkingBudget` > 0 | `<id>-thinking` |
| any of them + `reasoning_effort` (chat) / `reasoning.effort` (responses) `high` or `medium` | `<id>-thinking` |
| any of them + `thinkingLevel` `LOW` / `MINIMAL`, `thinkingBudget` 0 or -1, effort `low` / `minimal` / `none`, or nothing | the plain id |
| `<id>-thinking` (named explicitly) | kept, whatever the thinking settings say |
| anything else | unknown: `404 NOT_FOUND` on `/v1beta`, `400` on the OpenAI routes |

If both `thinkingLevel` and `thinkingBudget` are sent the level wins. The thinking variants (and `gemini-3.1-pro`,
`gemini-3.8-flash`, `gemini-4-argon`) need a signed-in cookie, exactly as before; without one the request fails with `503
no_valid_account` instead of being silently downgraded. The media models (`gemini-image`, `gemini-music`, `gemini-video`,
`gemini-canvas`) stay OpenAI-route only and ignore thinking settings. `GET /v1/models` marks every entry with `thinking`
and links the pair with `thinking_variant` / `base_model`; `GET /v1beta/models` has `thinking` and `baseModelId`.

### Files, video and audio

Inline files are accepted on both API styles and uploaded as attachments of the request (signed-in accounts only; with
an empty pool the request fails fast with `503 no_valid_account`).

| Part | Where |
|---|---|
| `image_url`, `input_image`, `video_url`, `input_video` (data URL or http(s) link) | chat / responses (unchanged) |
| `{"type":"file","file":{"file_data":"data:<mime>;base64,...","filename"}}` | chat |
| `{"type":"input_file","file_data":"data:<mime>;base64,...","filename"}` or `"file_url"` (http(s)) | responses |
| `{"type":"input_audio","input_audio":{"data":"<base64>","format":"wav"}}` | chat (the old blanket rejection is gone) |
| `inlineData{mimeType,data}`, `fileData{mimeType,fileUri: http(s)}` | `/v1beta` |

Bare base64 (no `data:` prefix) needs a `filename` with a known extension. `file_id` references are rejected: there is no
file store.

The attachment kind (the type slot of the upload tuple, which decides how Google parses the file) follows the MIME type:

| MIME | Kind | Cap | Name shown to the model |
|---|---|---|---|
| `image/*` | 1 | 12 MB | `image<N>.<ext>` |
| `video/*` | 2 | 50 MB | `video<N>.<ext>` |
| `text/*`, `audio/*`, `application/pdf`, `application/json`, `application/xml`, `application/rtf`, `application/x-ndjson`, YAML, JavaScript, Word / Excel / PowerPoint (legacy and OOXML), OpenDocument | 3 (with the real mime) | 50 MB | the client's `filename` (extension added if missing), else `file<N>.<ext>` |

Anything else (zip, executables, `application/octet-stream`, unknown type) is `400` with `code: unsupported_input`
(`INVALID_ARGUMENT` on `/v1beta`); a file over its cap is `413` with `code: attachment_too_large`. Remote links are
downloaded by the bridge with the same caps.

Kinds 1 and 2 are the proven protocol (browser captures). **That Google's web app reads PDF, audio and office files
sent as kind 3 with their real MIME type is to be verified live; it cannot be tested offline.** If Google rejects a type,
the request fails with the normal upstream error classes.

`/v1/responses` now keeps the content parts of user messages (previously they were flattened to text, which dropped
`input_image` / `input_file` before they could be uploaded).

### Long prompts

The `max_prompt_bytes` behaviour is unchanged: a prompt over the budget is uploaded as the text attachment `message.txt`
and the request carries a short instruction plus the latest message. It works the same on `/v1beta`, and in the JSON repair
round (whose prompt also holds the invalid answer): the repair is uploaded as its own `message.txt` on the same account.
Without a cookie an over-long prompt is still `400 context_length_exceeded`.

## Acknowledgments

- [bogdanfinn/tls-client](https://github.com/bogdanfinn/tls-client) — real Chrome TLS fingerprints
- [pkoukk/tiktoken-go](https://github.com/pkoukk/tiktoken-go) — BPE tokenizer
- [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) — pure-Go SQLite (CGO-free, builds straight on alpine)

## License

MIT — see [LICENSE](LICENSE)

## Links

- [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api) — a Python implementation of the same idea; its approach informed our early work on the Gemini web protocol
- [LINUX DO](https://linux.do) — the community where this project is shared

[![LinuxDo](https://img.shields.io/badge/%E7%A4%BE%E5%8C%BA-LinuxDo-blue?style=for-the-badge)](https://linux.do/)

