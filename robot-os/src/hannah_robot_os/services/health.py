from __future__ import annotations

from dataclasses import dataclass, field

from ..common import AuditLog, ServiceState, now_ms


@dataclass
class ServiceStatus:
    name: str
    state: ServiceState = ServiceState.STOPPED
    last_ok_ms: int | None = None
    detail: str = ""


@dataclass
class ServiceHealthManager:
    audit: AuditLog
    required_services: list[str]
    stale_after_ms: int = 5000
    _services: dict[str, ServiceStatus] = field(default_factory=dict)

    def set_state(self, name: str, state: ServiceState, detail: str = "", now: int | None = None) -> ServiceStatus:
        now = now_ms() if now is None else now
        st = self._services.get(name) or ServiceStatus(name=name)
        st.state = state
        st.detail = detail
        if state in {ServiceState.READY, ServiceState.DEGRADED}:
            st.last_ok_ms = now
        self._services[name] = st
        self.audit.emit("service-health", "state_changed", service=name, state=state.value, detail=detail)
        return st

    def snapshot(self, now: int | None = None) -> dict:
        now = now_ms() if now is None else now
        services = []
        for name, st in sorted(self._services.items()):
            stale = st.last_ok_ms is None or (now - st.last_ok_ms > self.stale_after_ms)
            services.append({
                "name": name,
                "state": st.state.value,
                "last_ok_ms": st.last_ok_ms,
                "stale": stale,
                "detail": st.detail,
            })
        required_ready = []
        for name in self.required_services:
            st = self._services.get(name)
            ok = bool(st and st.state == ServiceState.READY and st.last_ok_ms and now - st.last_ok_ms <= self.stale_after_ms)
            required_ready.append({"name": name, "ok": ok})
        robot_ready = all(r["ok"] for r in required_ready) if required_ready else False
        return {"robot_ready": robot_ready, "required": required_ready, "services": services}
