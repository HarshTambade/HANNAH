from __future__ import annotations

import json
from pathlib import Path

from backend.on_device_lora import prepare_jsonl


def test_prepare_jsonl_keeps_only_valid_user_assistant_examples(tmp_path: Path) -> None:
    source = tmp_path / "approved.jsonl"
    target = tmp_path / "prepared" / "dataset.jsonl"
    rows = [
        {"messages": [{"role": "user", "content": "Help me plan."}, {"role": "assistant", "content": "Start with three steps."}]},
        {"messages": [{"role": "system", "content": "invalid"}, {"role": "assistant", "content": "skip"}]},
        {"not": "a chat example"},
    ]
    source.write_text("\n".join(json.dumps(row) for row in rows) + "\nnot-json\n", encoding="utf-8")

    count = prepare_jsonl(source, target)

    assert count == 1
    prepared = json.loads(target.read_text(encoding="utf-8").strip())
    assert prepared["messages"] == rows[0]["messages"]
