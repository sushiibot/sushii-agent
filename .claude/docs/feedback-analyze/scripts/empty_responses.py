#!/usr/bin/env python3
"""Find assistant turns that have no text output (empty/silent responses)."""

import json
import sys

data = json.load(open(sys.argv[1]))
turns = data.get("conversation", [])
print(f"Total turns: {len(turns)}")

empty = []
for i, msg in enumerate(turns):
    if msg.get("role") != "assistant":
        continue
    content = msg.get("content", [])
    has_text = any(
        isinstance(p, dict) and p.get("type") == "text" and p.get("text", "").strip()
        for p in (content if isinstance(content, list) else [])
    )
    if not has_text:
        empty.append(i)
        print(f"  Empty assistant at turn {i}")

print(f"Empty assistant turns: {len(empty)}")
