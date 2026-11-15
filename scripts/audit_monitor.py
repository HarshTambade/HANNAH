#!/usr/bin/env python3
"""Tail and summarize Shanaya's hash-chained agent audit log.

The audit log is written by `backend/audit_logger.py`. This monitor verifies the
SHA-256 chain and reports metadata-only daily totals:

    * total tool calls proposed
    * HITL approvals, user rejections, expirations, and cancellations
    * tool executions and execution errors
    * any hash-chain validation failures

Usage:
    python3 scripts/audit_monitor.py
    python3 scripts/audit_monitor.py --date 2026-11-15
    python3 scripts/audit_monitor.py --all --json
    python3 scripts/audit_monitor.py --follow --interval 2

Exit status is 1 when the hash chain is invalid and 0 otherwise. Missing logs
are treated as an empty audit trail so a fresh installation can run the monitor
safely from cron.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ZERO_HASH = "0" * 64
INTEGRITY_CODES = {
    "malformed_json",
    "missing_hash",
    "invalid_sequence",
    "broken_previous_hash",
    "hash_mismatch",
    "partial_record",
}
MAX_REPORTED_ISSUES = 20


def canonical_record(record: dict[str, Any]) -> bytes:
    """Match backend/audit_logger.py canonicalization exactly."""
    return json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def record_hash(record_without_hash: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_record(record_without_hash)).hexdigest()


def record_day(timestamp: Any) -> str:
    if not isinstance(timestamp, str) or not timestamp:
        return "unknown"
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return "unknown"
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).date().isoformat()


@dataclass
class ChainIssue:
    line: int
    code: str
    detail: str
    sequence: int | None = None
    timestamp: str | None = None

    @property
    def is_integrity_failure(self) -> bool:
        return self.code in INTEGRITY_CODES

    def to_dict(self) -> dict[str, Any]:
        return {
            "line": self.line,
            "code": self.code,
            "detail": self.detail,
            "sequence": self.sequence,
            "timestamp": self.timestamp,
            "severity": "integrity" if self.is_integrity_failure else "warning",
        }


@dataclass
class DaySummary:
    day: str
    records: int = 0
    tool_calls: int = 0
    approved: int = 0
    rejected: int = 0
    expired: int = 0
    cancelled: int = 0
    executions: int = 0
    execution_errors: int = 0
    chain_failures: int = 0
    tools: Counter[str] = field(default_factory=Counter)
    rejection_reasons: Counter[str] = field(default_factory=Counter)
    first_timestamp: str | None = None
    last_timestamp: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "date": self.day,
            "records": self.records,
            "toolCalls": self.tool_calls,
            "hitl": {
                "approved": self.approved,
                "rejected": self.rejected,
                "expired": self.expired,
                "cancelled": self.cancelled,
            },
            "executions": self.executions,
            "executionErrors": self.execution_errors,
            "chainFailures": self.chain_failures,
            "tools": dict(self.tools.most_common()),
            "rejectionReasons": dict(self.rejection_reasons.most_common()),
            "firstTimestamp": self.first_timestamp,
            "lastTimestamp": self.last_timestamp,
        }


@dataclass
class ScanResult:
    path: Path
    exists: bool
    summaries: dict[str, DaySummary] = field(default_factory=dict)
    issues: list[ChainIssue] = field(default_factory=list)
    records_verified: int = 0
    records_seen: int = 0

    @property
    def integrity_ok(self) -> bool:
        return not any(issue.is_integrity_failure for issue in self.issues)

    @property
    def integrity_failures(self) -> list[ChainIssue]:
        return [issue for issue in self.issues if issue.is_integrity_failure]

    def summary_for(self, day: str) -> DaySummary:
        return self.summaries.setdefault(day, DaySummary(day))

    def to_dict(self, days: Iterable[str] | None = None) -> dict[str, Any]:
        selected_days = list(days) if days is not None else sorted(self.summaries)
        return {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "log": str(self.path),
            "integrity": {
                "ok": self.integrity_ok,
                "recordsSeen": self.records_seen,
                "recordsVerified": self.records_verified,
                "failures": [issue.to_dict() for issue in self.integrity_failures[:MAX_REPORTED_ISSUES]],
                "warnings": [
                    issue.to_dict()
                    for issue in self.issues
                    if not issue.is_integrity_failure
                ][:MAX_REPORTED_ISSUES],
            },
            "days": [self.summary_for(day).to_dict() for day in selected_days],
        }


def _verify_one(
    record: dict[str, Any],
    expected_sequence: int,
    expected_previous: str,
    line_number: int,
) -> tuple[list[ChainIssue], int, str]:
    """Verify one record and return issues, next sequence, and next previous hash."""
    claimed_hash = record.get("hash")
    body = {key: value for key, value in record.items() if key != "hash"}
    timestamp = body.get("timestamp") if isinstance(body.get("timestamp"), str) else None
    sequence = body.get("sequence") if isinstance(body.get("sequence"), int) else None
    issues: list[ChainIssue] = []

    if not isinstance(claimed_hash, str) or not claimed_hash:
        issues.append(ChainIssue(line_number, "missing_hash", "Record has no string hash.", sequence, timestamp))
        claimed_hash = None

    actual_hash = record_hash(body)
    if sequence != expected_sequence:
        issues.append(
            ChainIssue(
                line_number,
                "invalid_sequence",
                f"Expected sequence {expected_sequence}, found {sequence if sequence is not None else 'invalid'}.",
                sequence,
                timestamp,
            )
        )
    if body.get("previous_hash") != expected_previous:
        issues.append(
            ChainIssue(
                line_number,
                "broken_previous_hash",
                "previous_hash does not match the preceding record.",
                sequence,
                timestamp,
            )
        )
    if claimed_hash is not None and not hmac.compare_digest(actual_hash, claimed_hash):
        issues.append(ChainIssue(line_number, "hash_mismatch", "Record hash does not match its contents.", sequence, timestamp))

    # Resynchronise at the claimed values so one damaged line does not produce a
    # cascade of false failures for every subsequent record.
    next_sequence = (sequence + 1) if sequence is not None else expected_sequence + 1
    next_previous = claimed_hash if claimed_hash is not None else actual_hash
    if not any(issue.code in {"invalid_sequence", "broken_previous_hash", "hash_mismatch", "missing_hash"} for issue in issues):
        next_sequence = expected_sequence + 1
        next_previous = actual_hash
    return issues, next_sequence, next_previous


def _tally(summary: DaySummary, record: dict[str, Any]) -> None:
    action = record.get("action")
    status = record.get("status") if isinstance(record.get("status"), str) else ""
    tool = record.get("tool") if isinstance(record.get("tool"), str) else None

    summary.records += 1
    if action == "tool_proposed":
        summary.tool_calls += 1
        if tool:
            summary.tools[tool] += 1
    elif action == "tool_approved":
        summary.approved += 1
    elif action == "tool_rejected":
        summary.rejection_reasons[status or "unknown"] += 1
        if status == "user_rejected":
            summary.rejected += 1
        else:
            # Invalid arguments, non-allowlisted tools, and missing approval
            # channels are automatic rejections, not user decisions.
            summary.cancelled += 1
    elif action == "tool_expired":
        summary.expired += 1
        summary.rejection_reasons[status or "expired"] += 1
    elif action == "tool_result":
        summary.executions += 1
        if status and status != "success":
            summary.execution_errors += 1


def scan_audit_log(path: str | Path) -> ScanResult:
    """Read the full log, verify its chain, and aggregate daily metadata."""
    resolved = Path(path).expanduser()
    if not resolved.is_absolute():
        resolved = Path.cwd() / resolved
    result = ScanResult(path=resolved, exists=resolved.is_file())
    if not result.exists:
        return result

    expected_sequence = 1
    expected_previous = ZERO_HASH
    try:
        stream = resolved.open("rb")
    except OSError:
        result.exists = False
        return result

    with stream:
        for line_number, raw_line in enumerate(stream, 1):
            result.records_seen += 1
            timestamp = None
            try:
                decoded = raw_line.decode("utf-8")
            except UnicodeDecodeError:
                result.issues.append(ChainIssue(line_number, "malformed_json", "Line is not valid UTF-8."))
                continue

            if not raw_line.endswith(b"\n"):
                result.issues.append(
                    ChainIssue(line_number, "partial_record", "Record is missing its terminating newline.")
                )
            if not decoded.strip():
                result.issues.append(ChainIssue(line_number, "malformed_json", "Blank audit record."))
                continue

            try:
                record = json.loads(decoded)
            except json.JSONDecodeError:
                result.issues.append(ChainIssue(line_number, "malformed_json", "Line is not valid JSON."))
                continue
            if not isinstance(record, dict):
                result.issues.append(ChainIssue(line_number, "malformed_json", "Audit record is not a JSON object."))
                continue

            timestamp = record.get("timestamp") if isinstance(record.get("timestamp"), str) else None
            day = record_day(timestamp)
            if day == "unknown":
                result.issues.append(
                    ChainIssue(line_number, "invalid_timestamp", "Record timestamp is missing or invalid.", record.get("sequence"), timestamp)
                )
            summary = result.summary_for(day)
            if timestamp:
                summary.first_timestamp = summary.first_timestamp or timestamp
                summary.last_timestamp = timestamp

            issues, expected_sequence, expected_previous = _verify_one(
                record, expected_sequence, expected_previous, line_number
            )
            for issue in issues:
                result.issues.append(issue)
                summary.chain_failures += 1
            if not issues:
                result.records_verified += 1
            _tally(summary, record)

    return result


def _fmt_count(value: int) -> str:
    return f"{value:,}"


def format_summary(result: ScanResult, selected_days: list[str], *, show_path: bool = True) -> str:
    lines: list[str] = []
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    header = "Shanaya agent audit summary"
    if len(selected_days) == 1:
        header += f" · {selected_days[0]}"
    lines.append(header)
    if show_path:
        lines.append(f"Log: {result.path} ({'found' if result.exists else 'not found'})")
    lines.append(f"Generated: {generated}")
    lines.append("")

    for day in selected_days:
        summary = result.summary_for(day)
        lines.append(f"[{day}]")
        lines.append(f"  Records:                 {_fmt_count(summary.records)}")
        lines.append(f"  Tool calls proposed:     {_fmt_count(summary.tool_calls)}")
        lines.append(f"  HITL approved:           {_fmt_count(summary.approved)}")
        lines.append(f"  HITL user rejected:      {_fmt_count(summary.rejected)}")
        if summary.cancelled:
            lines.append(f"  HITL cancelled/expired:  {_fmt_count(summary.cancelled + summary.expired)}")
        lines.append(
            f"  Tool executions:         {_fmt_count(summary.executions)}"
            f" (errors: {_fmt_count(summary.execution_errors)})"
        )
        if summary.tools:
            tools = ", ".join(f"{name}={count}" for name, count in summary.tools.most_common(12))
            lines.append(f"  Tools:                   {tools}")
        if summary.rejection_reasons:
            reasons = ", ".join(f"{name}={count}" for name, count in summary.rejection_reasons.most_common(8))
            lines.append(f"  Rejection reasons:       {reasons}")
        if summary.chain_failures:
            lines.append(f"  Chain failures:          {_fmt_count(summary.chain_failures)}")
        lines.append("")

    if result.integrity_ok:
        lines.append(f"Chain integrity: OK ({_fmt_count(result.records_verified)}/{_fmt_count(result.records_seen)} records verified)")
    else:
        failures = result.integrity_failures
        lines.append(f"Chain integrity: FAILED ({len(failures)} issue{'s' if len(failures) != 1 else ''})")
        for issue in failures[:MAX_REPORTED_ISSUES]:
            lines.append(f"  line {issue.line}: {issue.code} - {issue.detail}")
        if len(failures) > MAX_REPORTED_ISSUES:
            lines.append(f"  … {len(failures) - MAX_REPORTED_ISSUES} more issue(s) not shown")

    warnings = [issue for issue in result.issues if not issue.is_integrity_failure]
    if warnings:
        lines.append("")
        lines.append(f"Warnings: {len(warnings)}")
        for issue in warnings[:MAX_REPORTED_ISSUES]:
            lines.append(f"  line {issue.line}: {issue.code} - {issue.detail}")

    return "\n".join(lines)


def _selected_days(result: ScanResult, requested: str | None, all_days: bool) -> list[str]:
    if all_days:
        return sorted(result.summaries) or [requested or date.today().isoformat()]
    day = requested or date.today().isoformat()
    return [day]


def _print_report(result: ScanResult, selected_days: list[str], *, as_json: bool, compact: bool = False) -> None:
    if as_json:
        payload = result.to_dict(selected_days)
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":") if compact else None))
    else:
        print(format_summary(result, selected_days))


def _resolve_log_path(raw_path: str | None) -> Path:
    configured = raw_path or os.getenv("SHANAYA_AUDIT_LOG", "").strip() or "logs/shanaya_audit.jsonl"
    path = Path(configured).expanduser()
    return path if path.is_absolute() else Path.cwd() / path


def _run_follow(path: Path, args: argparse.Namespace, requested_day: str | None) -> int:
    last_signature: tuple[int, int, int] | None = None
    last_result: ScanResult | None = None
    first_pass = True
    print(f"Following {path} (Ctrl+C to stop)…", file=sys.stderr)
    try:
        while True:
            try:
                stat = path.stat()
                signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
            except OSError:
                signature = None
            if first_pass or signature != last_signature:
                result = scan_audit_log(path)
                days = _selected_days(result, requested_day, args.all)
                _print_report(result, days, as_json=args.json, compact=args.json)
                last_result = result
                last_signature = signature
                first_pass = False
            time.sleep(max(0.2, args.interval))
    except KeyboardInterrupt:
        if last_result is not None:
            days = _selected_days(last_result, requested_day, args.all)
            _print_report(last_result, days, as_json=args.json, compact=args.json)
        return 0 if last_result is None or last_result.integrity_ok else 1


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify and summarize Shanaya's hash-chained agent audit log.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 scripts/audit_monitor.py\n"
            "  python3 scripts/audit_monitor.py --all --json\n"
            "  python3 scripts/audit_monitor.py --follow --interval 2\n"
            "  SHANAYA_AUDIT_LOG=/var/lib/shanaya/audit.jsonl python3 scripts/audit_monitor.py --date 2026-11-15"
        ),
    )
    parser.add_argument("--log", help="Path to shanaya_audit.jsonl (default: $SHANAYA_AUDIT_LOG or logs/shanaya_audit.jsonl).")
    parser.add_argument("--date", help="UTC day to summarize, YYYY-MM-DD (default: today).")
    parser.add_argument("--all", action="store_true", help="Summarize every day present in the log.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--follow", action="store_true", help="Tail the log and refresh the summary when it changes.")
    parser.add_argument("--interval", type=float, default=2.0, help="Polling interval in seconds for --follow (default: 2).")
    args = parser.parse_args(argv)
    if args.interval < 0.2:
        parser.error("--interval must be at least 0.2 seconds.")
    if args.date:
        try:
            date.fromisoformat(args.date)
        except ValueError:
            parser.error("--date must use YYYY-MM-DD.")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    path = _resolve_log_path(args.log)
    if args.follow:
        return _run_follow(path, args, args.date)

    result = scan_audit_log(path)
    days = _selected_days(result, args.date, args.all)
    if not result.exists:
        print(f"Audit log not found: {path}", file=sys.stderr)
    _print_report(result, days, as_json=args.json)
    return 0 if result.integrity_ok else 1


if __name__ == "__main__":
    sys.exit(main())
