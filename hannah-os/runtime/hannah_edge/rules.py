"""Rules a hub runs by itself: "when the temperature is above 28, turn the fan on".

No model is involved, here or anywhere near here. A rule is a comparison on a
reading and a short list of writes. It is evaluated every tick from the hub's
own readings, so it keeps working while the internet is away, and it acts on
the change, not on every tick:

  - the condition has to hold for `forS` seconds before `then` runs;
  - when it stops holding (past the hysteresis, for numbers) `otherwise` runs;
  - a reading older than `staleAfterS`, or from a device that isn't online, is
    not acted on: the rule waits and says why;
  - at most `maxPerHour` firings an hour; one over that is recorded, not run.

Every write a rule makes goes through the same checks as a write from the
server: the point must be on the device's allow-list and the value in range.
"""
from __future__ import annotations

OPS = {
    ">": lambda a, b: a > b, ">=": lambda a, b: a >= b, "<": lambda a, b: a < b, "<=": lambda a, b: a <= b,
    "==": lambda a, b: a == b, "!=": lambda a, b: a != b,
}
DEFAULTS = {"forS": 0, "staleAfterS": 120, "maxPerHour": 30, "hysteresis": 0}


def _holds(condition: dict, value, was_true: bool) -> bool:
    op, target = condition["op"], condition["value"]
    if isinstance(value, bool) or isinstance(target, bool) or not isinstance(value, (int, float)) or not isinstance(target, (int, float)):
        return OPS[op](value, target)
    gap = float(condition.get("hysteresis") or 0)
    if was_true and gap:
        # Once true, stay true until the reading has come back past the margin.
        if op in (">", ">="):
            return value > target - gap
        if op in ("<", "<="):
            return value < target + gap
    return OPS[op](value, target)


class RuleEngine:
    def __init__(self, read, write, online, clock):
        """read(device, point) -> reading or None; write(device, point, value) -> (ok, message); online(device) -> bool."""
        self._read, self._write, self._online, self._clock = read, write, online, clock
        self._rules: list = []
        self._state: dict = {}
        self.suspended = False

    def load(self, rules: list, suspended: bool = False) -> None:
        self._rules = [rule for rule in rules if rule.get("enabled", True)]
        keep = {rule["id"] for rule in self._rules}
        self._state = {key: value for key, value in self._state.items() if key in keep}
        self.suspended = bool(suspended)

    def report(self) -> list:
        return [{"id": rule["id"], **{key: value for key, value in self._state.get(rule["id"], {}).items() if key in ("status", "detail", "lastFiredAt", "fires", "lastError", "active")}} for rule in self._rules]

    def tick(self) -> list:
        """Evaluate every rule once. Returns the events worth telling the server."""
        events = []
        now = self._clock()
        for rule in self._rules:
            state = self._state.setdefault(rule["id"], {"active": None, "since": None, "status": "waiting", "detail": "", "fires": 0, "recent": [], "lastFiredAt": None, "lastError": None})
            if self.suspended:
                self._status(state, "suspended", "Automations are paused for this account.", events, rule)
                continue
            conditions = rule["when"].get("all") or [rule["when"]]
            verdict, why = True, ""
            for condition in conditions:
                reading = self._read(condition["device"], condition["point"])
                limit = float(rule.get("staleAfterS", DEFAULTS["staleAfterS"]))
                if not self._online(condition["device"]):
                    verdict, why = None, "The device isn't online."
                    break
                if reading is None:
                    verdict, why = None, "No reading yet."
                    break
                if now - reading["at"] / 1000.0 > limit:
                    verdict, why = None, f"The last reading is older than {int(limit)} seconds."
                    break
                if not _holds(condition, reading["value"], bool(state["active"])):
                    verdict = False
            if verdict is None:
                state["since"] = None
                self._status(state, "waiting", why, events, rule)
                continue
            if verdict:
                state["since"] = state["since"] if state["since"] is not None else now
                if state["active"] is not True and now - state["since"] >= float(rule.get("forS", 0)):
                    self._fire(rule, state, "then", now, events)
                elif state["active"] is True:
                    self._status(state, "active", "", events, rule)
                else:
                    self._status(state, "pending", "The condition holds; waiting for it to last.", events, rule)
            else:
                state["since"] = None
                if state["active"] is True:
                    self._fire(rule, state, "otherwise", now, events)
                else:
                    state["active"] = False
                    self._status(state, "watching", "", events, rule)
        return events

    def _status(self, state: dict, status: str, detail: str, events: list, rule: dict) -> None:
        if state["status"] != status and status in ("waiting", "suspended"):
            events.append({"type": f"rule-{status}", "severity": "info" if status == "suspended" else "warning", "ruleId": rule["id"], "message": f"“{rule.get('name', rule['id'])}” is not running: {detail}"})
        state["status"], state["detail"] = status, detail

    def _fire(self, rule: dict, state: dict, branch: str, now: float, events: list) -> None:
        state["active"] = branch == "then"
        actions = rule.get(branch) or []
        state["status"], state["detail"] = ("active" if branch == "then" else "watching"), ""
        if not actions:
            return
        state["recent"] = [at for at in state["recent"] if now - at < 3600]
        if len(state["recent"]) >= int(rule.get("maxPerHour", DEFAULTS["maxPerHour"])):
            state["lastError"] = "Fired too often this hour; this change was not acted on."
            events.append({"type": "rule-limited", "severity": "warning", "ruleId": rule["id"], "message": f"“{rule.get('name', rule['id'])}” reached its limit of {rule.get('maxPerHour', DEFAULTS['maxPerHour'])} an hour. It did not act this time."})
            return
        state["recent"].append(now)
        problems, done = [], []
        for action in actions:
            ok, message = self._write(action["device"], action["point"], action["value"])
            (done if ok else problems).append(message)
        state["fires"] += 1
        state["lastFiredAt"] = int(now * 1000)
        state["lastError"] = " ".join(problems) or None
        events.append({
            "type": "rule-fired" if not problems else "rule-failed", "severity": "info" if not problems else "error", "ruleId": rule["id"], "branch": branch,
            "message": f"“{rule.get('name', rule['id'])}” {'ran' if branch == 'then' else 'ended'}: {' '.join(done + problems)}".strip(),
        })
