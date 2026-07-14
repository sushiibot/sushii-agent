#!/usr/bin/env python3
"""Print full conversation with role labels and content previews."""

import json
import sys

data = json.load(open(sys.argv[1]))
for i, msg in enumerate(data.get("conversation", [])):
    role = msg.get("role", "?")
    content = msg.get("content", "")
    if isinstance(content, str):
        preview = content[:300]
    elif isinstance(content, list):
        parts = []
        for part in content:
            if not isinstance(part, dict):
                continue
            t = part.get("type", "?")
            if t == "text":
                parts.append("TEXT: " + part.get("text", "")[:200])
            elif t == "reasoning":
                parts.append("REASONING: " + part.get("text", "")[:150])
            elif t == "tool-call":
                parts.append(f"TOOL-CALL: {part.get('toolName')} args={str(part.get('args', {}))[:150]}")
            elif t == "tool-result":
                parts.append(f"TOOL-RESULT [{part.get('toolName')}]: {str(part.get('output', {}))[:150]}")
            else:
                parts.append(f"{t}: {str(part)[:100]}")
        preview = "\n    ".join(parts)
    else:
        preview = str(content)[:300]

    print(f"[{i}] {role}:")
    print(f"    {preview}")
    print()
