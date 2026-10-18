"""Use the hub like the OpenAI API (works with any OpenAI SDK or tool).

    python openai_client.py <key-file> [model]

The base URL is the hub's tailnet address; the key only works from the machine it
was issued for.
"""
import sys
from openai import OpenAI

key = open(sys.argv[1]).read().strip()
model = sys.argv[2] if len(sys.argv) > 2 else "gemini-3.8-flash"
client = OpenAI(base_url="http://100.102.156.33:18090/v1", api_key=key, timeout=None)

print([m.id for m in client.models.list().data])
stream = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "Explain in three short bullet points why the sky is blue."}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
