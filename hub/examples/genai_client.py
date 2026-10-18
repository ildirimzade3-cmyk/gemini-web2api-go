"""Use the hub like the Gemini API with Google's own SDK (google-genai).

    python genai_client.py <key-file> [model]
"""
import sys
from google import genai
from google.genai import types

key = open(sys.argv[1]).read().strip()
model = sys.argv[2] if len(sys.argv) > 2 else "gemini-3.8-flash"
client = genai.Client(api_key=key, http_options=types.HttpOptions(base_url="http://100.102.156.33:18090", timeout=None))

schema = {"type": "OBJECT", "properties": {"city": {"type": "STRING"}, "country": {"type": "STRING"}}, "required": ["city", "country"]}
r = client.models.generate_content(
    model=model,
    contents="Which city hosts the Flame Towers? Answer as JSON.",
    config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=schema),
)
print(r.text)
