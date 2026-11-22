"""One-request discovery worker. Input and output are bounded JSON over stdio."""
from __future__ import annotations

import json
import os
import sys

from .discovery import DiscoveryError, discover

MAX_REQUEST_BYTES = 64 * 1024


def main() -> int:
    raw = sys.stdin.read(MAX_REQUEST_BYTES + 1)
    if len(raw.encode("utf-8")) > MAX_REQUEST_BYTES:
        answer = {"ok": False, "error": {"reason": "request-too-large", "message": "The discovery request is too large."}}
    else:
        try:
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise DiscoveryError("A discovery request must be an object.", "bad-request")
            answer = {"ok": True, "result": discover(request)}
        except DiscoveryError as error:
            answer = {"ok": False, "error": {"reason": error.reason, "message": str(error)}}
        except Exception as error:
            answer = {"ok": False, "error": {"reason": "discovery-error", "message": "Discovery failed (" + type(error).__name__ + ")."}}
    answer["pid"] = os.getpid()
    sys.stdout.write(json.dumps(answer, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
