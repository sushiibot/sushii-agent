#!/usr/bin/env python3
"""Print all assistant text responses from a feedback JSON file."""

import json
import sys

data = json.load(open(sys.argv[1]))
for i, msg in enumerate(data.get("conversation", [])):
    if msg.get("role") != "assistant":
        continue
    content = msg.get("content", [])
    if not isinstance(content, list):
        continue
    for p in content:
        if isinstance(p, dict) and p.get("type") == "text" and p.get("text", "").strip():
            print(f"=== Turn {i} ===")
            print(p["text"])
            print()
