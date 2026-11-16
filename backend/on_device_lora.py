"""Prepare user-approved Shanaya examples for local LoRA fine-tuning.

The input is the JSONL export produced by the client. This script never reads
browser storage or server chat logs. GGUF files are inference artifacts: train
the original Hugging Face checkpoint, then convert/merge the adapter for the
target local runtime as a separate packaging step.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


MAX_EXAMPLES = 10_000
MAX_CONTENT_CHARS = 8_000


def _messages(row: dict[str, Any]) -> list[dict[str, str]] | None:
    messages = row.get("messages")
    if not isinstance(messages, list):
        return None
    clean: list[dict[str, str]] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"user", "assistant"}:
            continue
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        clean.append({"role": message["role"], "content": content.strip()[:MAX_CONTENT_CHARS]})
    if len(clean) < 2 or clean[0]["role"] != "user" or clean[-1]["role"] != "assistant":
        return None
    return clean


def prepare_jsonl(source: Path, destination: Path) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with source.open("r", encoding="utf-8") as input_file, destination.open("w", encoding="utf-8") as output_file:
        for line in input_file:
            if count >= MAX_EXAMPLES:
                break
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            messages = _messages(row)
            if messages is None:
                continue
            output_file.write(json.dumps({"messages": messages}, ensure_ascii=False) + "\n")
            count += 1
    return count


def train_adapter(dataset_path: Path, base_model: str, output_dir: Path, epochs: int) -> None:
    try:
        import torch
        from peft import LoraConfig, get_peft_model
        from transformers import AutoModelForCausalLM, AutoTokenizer, DataCollatorForSeq2Seq, Trainer, TrainingArguments
    except ImportError as exc:
        raise SystemExit("Training needs optional dependencies: pip install torch transformers peft") from exc

    tokenizer = AutoTokenizer.from_pretrained(base_model, local_files_only=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        local_files_only=True,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
    )
    model = get_peft_model(model, LoraConfig(
        r=8, lora_alpha=16, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
        target_modules=["q_proj", "v_proj"],
    ))

    class ChatDataset(torch.utils.data.Dataset):
        def __init__(self) -> None:
            self.rows: list[dict[str, list[int]]] = []
            with dataset_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    row = json.loads(line)
                    messages = _messages(row) if isinstance(row, dict) else None
                    if messages:
                        prompt_ids = tokenizer.apply_chat_template(messages[:-1], tokenize=True, add_generation_prompt=True)
                        input_ids = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False)
                        if len(input_ids) > 2048:
                            removed = len(input_ids) - 2048
                            input_ids = input_ids[removed:]
                            prompt_length = max(0, len(prompt_ids) - removed)
                        else:
                            prompt_length = len(prompt_ids)
                        if prompt_length >= len(input_ids):
                            continue
                        labels = [-100] * prompt_length + input_ids[prompt_length:]
                        self.rows.append({"input_ids": input_ids, "attention_mask": [1] * len(input_ids), "labels": labels})

        def __len__(self) -> int:
            return len(self.rows)

        def __getitem__(self, index: int) -> dict[str, Any]:
            return self.rows[index]

    dataset = ChatDataset()
    if not len(dataset):
        raise SystemExit("No valid examples found; nothing was trained.")
    output_dir.mkdir(parents=True, exist_ok=True)
    trainer = Trainer(
        model=model,
        args=TrainingArguments(
            output_dir=str(output_dir), num_train_epochs=epochs, per_device_train_batch_size=1,
            gradient_accumulation_steps=4, learning_rate=2e-4, logging_steps=5,
            save_strategy="epoch", report_to=[], remove_unused_columns=False,
        ),
        train_dataset=dataset,
        data_collator=DataCollatorForSeq2Seq(tokenizer=tokenizer, model=model, label_pad_token_id=-100),
    )
    trainer.train()
    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Client-exported approved examples JSONL")
    parser.add_argument("--output", type=Path, default=Path("./shanaya-lora-data.jsonl"), help="Validated training JSONL")
    parser.add_argument("--train", action="store_true", help="Run optional LoRA training after preparation")
    parser.add_argument("--base-model", help="Local Hugging Face checkpoint directory (not a GGUF file)")
    parser.add_argument("--adapter-output", type=Path, default=Path("./shanaya-lora-adapter"))
    parser.add_argument("--epochs", type=int, default=1)
    args = parser.parse_args()
    count = prepare_jsonl(args.input, args.output)
    print(f"Prepared {count} approved examples at {args.output}")
    if args.train:
        if not args.base_model:
            raise SystemExit("--base-model is required with --train; provide a local source checkpoint, not a GGUF.")
        train_adapter(args.output, args.base_model, args.adapter_output, max(1, min(args.epochs, 5)))
        print(f"Saved LoRA adapter to {args.adapter_output}")


if __name__ == "__main__":
    main()
