#!/usr/bin/env python3
"""Print a quick summary of a feedback JSON file."""

import json
import sys

data = json.load(open(sys.argv[1]))
turns = data.get("conversation", [])

empty = sum(
    1
    for m in turns
    if m.get("role") == "assistant"
    and not any(
        isinstance(p, dict) and p.get("type") == "text" and p.get("text", "").strip()
        for p in (m.get("content", []) if isinstance(m.get("content", []), list) else [])
    )
)

print(f"Sentiment : {data.get('sentiment')}")
print(f"Username  : {data.get('username')}")
print(f"Timestamp : {data.get('timestamp')}")
print(f"Feedback  : {data.get('feedback', '')!r}")
print(f"Turns     : {len(turns)}  (empty assistant: {empty})")
