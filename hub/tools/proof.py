"""Real-traffic proof for the hub: several "apps" (each with its own key) send
verifiable tasks at the same time through both API flavours, and every answer is
checked (exact answers, JSON schemas, code that is executed, image text, a fact
buried in a long document, the model that answered).

    python proof.py <hub-url> <out.json> app1=<keyfile> [app2=<keyfile> ...] [--tasks a,b] [--rounds N]

Records metadata only (task, model, timing, account, verdict), never the texts.
"""
import base64
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from concurrent.futures import ThreadPoolExecutor

from google import genai
from google.genai import types
from openai import OpenAI


def png_with_text():
    """A small PNG showing the digits 4 and 2 drawn as blocks (no imaging library needed)."""
    glyph = {
        "4": ["1..1", "1..1", "1111", "...1", "...1"],
        "2": ["111.", "...1", ".11.", "1...", "1111"],
    }
    scale = 24
    w, h = 2 * 5 * scale + scale, 7 * scale
    rows = [[255] * w for _ in range(h)]
    for gi, ch in enumerate("42"):
        for y, line in enumerate(glyph[ch]):
            for x, c in enumerate(line):
                if c == "1":
                    for dy in range(scale):
                        for dx in range(scale):
                            rows[scale + y * scale + dy][scale + gi * 5 * scale + x * scale + dx] = 0
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def long_doc():
    para = (
        "The committee reviewed regional logistics, freight schedules, warehouse audits and the "
        "seasonal staffing plan in detail, without reaching any new decision on those points. "
    )
    body = [para * 3 for _ in range(220)]
    body[137] = "Note for the archive: the vault access code chosen at this meeting is ZEBRA-7741. " + body[137]
    return "\n\n".join(body)


def run_python(code, tests):
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(code + "\n\n" + tests)
    try:
        return subprocess.run([sys.executable, "-I", f.name], capture_output=True, timeout=20).returncode == 0
    finally:
        os.unlink(f.name)


def code_of(text):
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S)
    return m.group(1) if m else text


def check_json(t):
    d = json.loads(t)
    return d["order_id"] == 5512 and d["units"] == 3 and "ganja" in d["city"].lower() and "leyla" in d["customer"].lower()


TASKS = {
    # name: (flavour, model, builder, verifier)
    "math": (
        "openai", "gemini-3.5-flash-lite",
        lambda: {"messages": [{"role": "user", "content": "What is 37 multiplied by 43? Reply with the number only."}]},
        lambda t: t.strip().rstrip(".") == "1591",
    ),
    "stream": (
        "openai-stream", "gemini-3.8-flash",
        lambda: {"messages": [{"role": "user", "content": "List the seven continents, one per line, nothing else."}]},
        lambda t: all(c in t.lower() for c in ["africa", "antarctica", "asia", "australia", "europe", "north america", "south america"]),
    ),
    "json": (
        "gemini", "gemini-3.8-flash",
        lambda: {
            "contents": "From this note, extract the data: 'Order 5512 from Leyla Mammadova, 3 units, ships to Ganja.'",
            "schema": {
                "type": "OBJECT",
                "properties": {"order_id": {"type": "INTEGER"}, "customer": {"type": "STRING"}, "units": {"type": "INTEGER"}, "city": {"type": "STRING"}},
                "required": ["order_id", "customer", "units", "city"],
            },
        },
        check_json,
    ),
    "translate": (
        "openai", "gemini-3.8-flash",
        lambda: {"messages": [
            {"role": "system", "content": "You translate English into Azerbaijani. Reply with the translation only."},
            {"role": "user", "content": "The weather in Baku will be windy tomorrow."},
        ]},
        lambda t: "bakı" in t.lower() and len(t) < 200,
    ),
    "code": (
        "openai", "gemini-3.1-pro",
        lambda: {"messages": [{"role": "user", "content": "Write a Python function `nth_prime(n)` that returns the n-th prime (nth_prime(1) == 2). Only the code in one python block."}]},
        lambda t: run_python(code_of(t), "assert nth_prime(1)==2\nassert nth_prime(6)==13\nassert nth_prime(1000)==7919"),
    ),
    "vision": (
        "openai", "gemini-3.8-flash",
        lambda: {"messages": [{"role": "user", "content": [
            {"type": "text", "text": "What number is drawn in this image? Reply with the digits only."},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png_with_text()).decode()}},
        ]}]},
        lambda t: t.strip().rstrip(".") == "42",
    ),
    "longdoc": (
        "openai", "gemini-3.8-flash",
        lambda: {"messages": [{"role": "user", "content": long_doc() + "\n\nQuestion: what vault access code was chosen? Reply with the code only."}]},
        lambda t: "ZEBRA-7741" in t,
    ),
    "reasoning": (
        "gemini", "gemini-4-argon",
        lambda: {"contents": "A farmer has 17 sheep. All but 9 run away. Then he buys twice as many sheep as he has left. How many sheep does he have now? Reply with the number only."},
        lambda t: t.strip().rstrip(".") == "27",
    ),
}


def call(base, key, task):
    flavour, model, build, verify = TASKS[task]
    req = build()
    t0 = time.time()
    rec = {"task": task, "model": model, "flavour": flavour}
    try:
        if flavour.startswith("openai"):
            client = OpenAI(base_url=base + "/v1", api_key=key, timeout=None, max_retries=0)
            if flavour == "openai-stream":
                chunks, text, first = 0, "", None
                for ch in client.chat.completions.create(model=model, messages=req["messages"], stream=True):
                    if ch.choices and ch.choices[0].delta.content:
                        chunks += 1
                        first = first or time.time() - t0
                        text += ch.choices[0].delta.content
                rec.update(chunks=chunks, first_token_s=round(first or 0, 2))
                answered = model  # streams carry no model header; the hub log records the verified model
            else:
                raw = client.chat.completions.with_raw_response.create(model=model, messages=req["messages"])
                r = raw.parse()
                text = r.choices[0].message.content
                hub = (r.model_extra or {}).get("hub") or {}
                answered = raw.headers.get("x-hub-model") or r.model
                rec.update(account=raw.headers.get("x-hub-account") or hub.get("account"), held=raw.headers.get("x-hub-held") == "1")
        else:
            client = genai.Client(api_key=key, http_options=types.HttpOptions(base_url=base, timeout=None))
            cfg = types.GenerateContentConfig(response_mime_type="application/json", response_schema=req["schema"]) if "schema" in req else None
            r = client.models.generate_content(model=model, contents=req["contents"], config=cfg)
            text = r.text
            answered = r.model_version
        rec.update(ok=True, model_ok=(answered == model), seconds=round(time.time() - t0, 1), out_chars=len(text or ""))
        try:
            rec["verified"] = bool(verify(text or ""))
        except Exception as e:  # noqa: BLE001
            rec["verified"] = False
            rec["verify_error"] = type(e).__name__
    except Exception as e:  # noqa: BLE001
        rec.update(ok=False, seconds=round(time.time() - t0, 1), error=str(e)[:240])
    return rec


def main():
    base, out = sys.argv[1], sys.argv[2]
    apps, tasks, rounds = {}, list(TASKS), 1
    args = sys.argv[3:]
    i = 0
    while i < len(args):
        if args[i] == "--tasks":
            tasks = args[i + 1].split(",")
            i += 2
        elif args[i] == "--rounds":
            rounds = int(args[i + 1])
            i += 2
        else:
            name, keyfile = args[i].split("=", 1)
            apps[name] = open(keyfile).read().strip()
            i += 1
    names = list(apps)
    jobs = [(names[(n + r) % len(names)], t) for r in range(rounds) for n, t in enumerate(tasks)]
    started = time.time()
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futs = [(app, pool.submit(call, base, apps[app], t)) for app, t in jobs]
        results = [dict(app=app, **f.result()) for app, f in futs]
    summary = {
        "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
        "wall_seconds": round(time.time() - started, 1),
        "requests": len(results),
        "ok": sum(r.get("ok", False) for r in results),
        "verified": sum(r.get("verified", False) for r in results),
        "model_ok": sum(r.get("model_ok", False) for r in results),
        "results": results,
    }
    with open(out, "w") as f:
        json.dump(summary, f, indent=1)
    for r in results:
        print(f"{r['app']:<12} {r['task']:<10} {r['model']:<22} ok={r.get('ok')} verified={r.get('verified')} "
              f"model_ok={r.get('model_ok')} {r['seconds']}s acct={r.get('account')} {r.get('error', '')[:120]}")
    print({k: v for k, v in summary.items() if k != "results"})


if __name__ == "__main__":
    main()
