#!/usr/bin/env python3
"""Summarize all feedback JSON files in a directory."""

import json
import sys
from pathlib import Path

directory = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("feedback-export/feedback")

for path in sorted(directory.glob("*.json")):
    data = json.load(path.open())
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
    print(path.name)
    print(f"  {data.get('sentiment')} | {data.get('username')} | {data.get('timestamp')}")
    print(f"  feedback: {data.get('feedback', '')!r}")
    print(f"  turns: {len(turns)}, empty assistant: {empty}")
    print()
