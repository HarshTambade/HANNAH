"""Real resource measurements for the Edge Resource Manager.

Every value here is read from the operating system or a vendor tool at the
moment of sampling: /proc, /sys (thermal zones, power_supply, net),
os.statvfs, os.getloadavg, nvidia-smi or tegrastats when they are installed,
and psutil when it is importable and /proc is not there. Nothing is estimated
or filled in. A value the device can't provide is reported as

    {"available": False, "reason": "not measurable on this device: ..."}

so the server and the dashboard can say so instead of showing a number.

The probe takes a filesystem root so tests can point it at a fixture tree,
and a command runner so tests can stand in for nvidia-smi and tegrastats.
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

SCHEMA = "hannah.edge-resources.v1"
NOT_MEASURABLE = "not measurable on this device"

Runner = Callable[[list[str], float], str]


def measured(value: Any, unit: str, source: str, **extra: Any) -> dict[str, Any]:
    return {"available": True, "value": value, "unit": unit, "source": source, **extra}


def unavailable(reason: str) -> dict[str, Any]:
    return {"available": False, "reason": f"{NOT_MEASURABLE}: {reason}"}


def is_measured(metric: Any) -> bool:
    return isinstance(metric, dict) and metric.get("available") is True


def value_of(metric: Any) -> Any:
    return metric.get("value") if is_measured(metric) else None


def run_command(cmd: list[str], timeout: float) -> str:
    """Run a read-only vendor tool and return its standard output."""
    done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=True)
    return done.stdout


def first_line(cmd: list[str], timeout: float) -> str:
    """Read one line from a streaming tool (tegrastats prints until stopped)."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        deadline = time.monotonic() + timeout
        line = ""
        while time.monotonic() < deadline and proc.stdout is not None:
            line = proc.stdout.readline()
            if line.strip():
                return line
        return line
    finally:
        proc.kill()
        proc.wait(timeout=2)


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None


def _int(text: str | None) -> int | None:
    try:
        return int(str(text).strip())
    except (TypeError, ValueError):
        return None


def _float(text: Any) -> float | None:
    try:
        number = float(str(text).strip())
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _round(value: float, digits: int = 1) -> float:
    return round(float(value), digits)


@dataclass
class InferenceLatencyTracker:
    """Latency of local inference calls, recorded by whatever runs them (the AI runtime)."""

    window: int = 200
    _samples: list[float] = field(default_factory=list)

    def record(self, latency_ms: float) -> None:
        number = _float(latency_ms)
        if number is None or number < 0:
            return
        self._samples.append(number)
        self._samples = self._samples[-self.window:]

    def summary(self) -> dict[str, Any]:
        if not self._samples:
            return {"latency_ms_p50": unavailable("no local inference has run since this service started"), "samples": 0}
        ordered = sorted(self._samples)

        def pct(q: float) -> float:
            return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]

        source = "recorded by the onboard AI runtime"
        return {
            "latency_ms_p50": measured(_round(pct(0.5)), "ms", source),
            "latency_ms_p95": measured(_round(pct(0.95)), "ms", source),
            "samples": len(ordered),
        }


@dataclass
class ResourceProbe:
    root: str | Path = "/"
    storage_paths: list[str] = field(default_factory=lambda: ["/"])
    runner: Runner = run_command
    line_reader: Runner = first_line
    which: Callable[[str], str | None] = shutil.which
    psutil_module: Any = "auto"
    # Wait between two /proc/stat reads on the first sample (CPU use is a rate).
    cpu_interval_s: float = 0.2
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.time
    service_status: Callable[[], list[dict[str, Any]]] | None = None
    inference: InferenceLatencyTracker = field(default_factory=InferenceLatencyTracker)
    _prev_cpu: tuple[int, int] | None = None
    _prev_net: dict[str, tuple[int, int, float]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.root = Path(self.root)
        if self.psutil_module == "auto":
            try:
                import psutil  # type: ignore[import-not-found]

                self.psutil_module = psutil
            except ImportError:
                self.psutil_module = None

    # ------------------------------------------------------------ paths
    def _p(self, *parts: str) -> Path:
        return Path(self.root, *parts)

    @property
    def has_proc(self) -> bool:
        return self._p("proc", "meminfo").exists() or self._p("proc", "stat").exists()

    @property
    def _psutil(self) -> Any:
        # psutil is a fallback for systems without /proc (macOS, Windows), never a replacement for it.
        return None if self.has_proc else self.psutil_module

    # ------------------------------------------------------------ sample
    def sample(self) -> dict[str, Any]:
        at = int(self.clock() * 1000)
        return {
            "schema": SCHEMA,
            "measured_at_ms": at,
            "host": self.host(),
            "cpu": self.cpu(),
            "memory": self.memory(),
            "gpu": self.gpu(),
            "storage": self.storage(),
            "network": self.network(),
            "battery": self.battery(),
            "power": self.power(),
            "processes": self.processes(),
            "inference": self.inference.summary(),
        }

    def host(self) -> dict[str, Any]:
        return {
            "system": platform.system().lower() or "unknown",
            "machine": platform.machine() or "unknown",
            "proc_available": self.has_proc,
            "psutil": bool(self._psutil),
            "root": str(self.root),
        }

    # ------------------------------------------------------------ cpu
    def _cpu_times(self) -> tuple[int, int] | None:
        text = _read(self._p("proc", "stat"))
        if not text:
            return None
        for line in text.splitlines():
            if line.startswith("cpu "):
                parts = [int(x) for x in line.split()[1:] if x.isdigit()]
                if len(parts) < 4:
                    return None
                idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
                return sum(parts), idle
        return None

    def _cpu_utilization(self) -> dict[str, Any]:
        ps = self._psutil
        if ps is not None:
            return measured(_round(ps.cpu_percent(interval=self.cpu_interval_s or None)), "%", "psutil.cpu_percent")
        now = self._cpu_times()
        if now is None:
            return unavailable("/proc/stat is missing")
        prev = self._prev_cpu
        if prev is None and self.cpu_interval_s > 0:
            self.sleep(self.cpu_interval_s)
            prev, now = now, self._cpu_times()
            if now is None:
                return unavailable("/proc/stat could not be read twice")
        self._prev_cpu = now
        if prev is None:
            return unavailable("CPU use is a rate and needs a second sample")
        total, idle = now[0] - prev[0], now[1] - prev[1]
        if total <= 0:
            return unavailable("/proc/stat did not advance between samples")
        return measured(_round(100.0 * (total - idle) / total), "%", "/proc/stat")

    def _cores(self) -> dict[str, Any]:
        text = _read(self._p("proc", "cpuinfo"))
        if text:
            count = sum(1 for line in text.splitlines() if line.startswith("processor"))
            if count:
                return measured(count, "cores", "/proc/cpuinfo")
        if str(self.root) == "/" and os.cpu_count():
            return measured(os.cpu_count(), "cores", "os.cpu_count")
        return unavailable("/proc/cpuinfo is missing")

    def _load(self) -> dict[str, Any]:
        text = _read(self._p("proc", "loadavg"))
        if text:
            value = _float(text.split()[0])
            if value is not None:
                return measured(value, "load", "/proc/loadavg")
        if str(self.root) == "/" and hasattr(os, "getloadavg"):
            try:
                return measured(_round(os.getloadavg()[0], 2), "load", "os.getloadavg")
            except OSError:
                pass
        return unavailable("/proc/loadavg is missing")

    def thermal_zones(self) -> list[dict[str, Any]]:
        base = self._p("sys", "class", "thermal")
        zones = []
        if not base.exists():
            return zones
        for zone in sorted(base.glob("thermal_zone*")):
            milli = _int(_read(zone / "temp"))
            if milli is None:
                continue
            # Some drivers report an error sentinel; a reading below absolute zero or above 200 C isn't a temperature.
            celsius = milli / 1000.0 if abs(milli) > 200 else float(milli)
            if celsius < -273 or celsius > 200:
                continue
            zones.append({"zone": zone.name, "type": _read(zone / "type") or "unknown", "temperature_c": _round(celsius)})
        return zones

    def cpu(self) -> dict[str, Any]:
        zones = self.thermal_zones()
        cpuish = [z for z in zones if re.search(r"cpu|soc|x86_pkg|coretemp|package|tcpu|k10temp", z["type"], re.I)]
        if cpuish:
            hottest = max(cpuish, key=lambda z: z["temperature_c"])
            temperature = measured(hottest["temperature_c"], "C", f"/sys/class/thermal/{hottest['zone']} ({hottest['type']})")
        elif zones:
            hottest = max(zones, key=lambda z: z["temperature_c"])
            temperature = measured(hottest["temperature_c"], "C", f"/sys/class/thermal/{hottest['zone']} ({hottest['type']}); no zone is labelled CPU, so this is the hottest zone")
        else:
            ps = self._psutil
            reading = None
            if ps is not None and hasattr(ps, "sensors_temperatures"):
                try:
                    groups = ps.sensors_temperatures() or {}
                    values = [entry.current for entries in groups.values() for entry in entries if entry.current is not None]
                    reading = max(values) if values else None
                except (OSError, AttributeError):
                    reading = None
            temperature = measured(_round(reading), "C", "psutil.sensors_temperatures") if reading is not None else unavailable("no thermal zone under /sys/class/thermal")
        return {
            "utilization_pct": self._cpu_utilization(),
            "load_1m": self._load(),
            "cores": self._cores(),
            "temperature_c": temperature,
            "thermal_zones": zones,
        }

    # ------------------------------------------------------------ memory
    def memory(self) -> dict[str, Any]:
        text = _read(self._p("proc", "meminfo"))
        if text:
            info: dict[str, int] = {}
            for line in text.splitlines():
                match = re.match(r"^(\w+):\s+(\d+)\s*kB", line)
                if match:
                    info[match.group(1)] = int(match.group(2))
            total = info.get("MemTotal")
            available = info.get("MemAvailable")
            out: dict[str, Any] = {}
            out["total_mb"] = measured(_round(total / 1024), "MB", "/proc/meminfo MemTotal") if total else unavailable("/proc/meminfo has no MemTotal")
            if available is not None and total:
                out["available_mb"] = measured(_round(available / 1024), "MB", "/proc/meminfo MemAvailable")
                out["used_pct"] = measured(_round(100.0 * (total - available) / total), "%", "/proc/meminfo")
            else:
                out["available_mb"] = unavailable("/proc/meminfo has no MemAvailable (kernel older than 3.14)")
                out["used_pct"] = unavailable("/proc/meminfo has no MemAvailable")
            swap_total, swap_free = info.get("SwapTotal"), info.get("SwapFree")
            if swap_total:
                out["swap_used_pct"] = measured(_round(100.0 * (swap_total - (swap_free or 0)) / swap_total), "%", "/proc/meminfo")
            else:
                out["swap_used_pct"] = unavailable("no swap is configured")
            return out
        ps = self._psutil
        if ps is not None:
            vm = ps.virtual_memory()
            sw = ps.swap_memory()
            return {
                "total_mb": measured(_round(vm.total / 1048576), "MB", "psutil.virtual_memory"),
                "available_mb": measured(_round(vm.available / 1048576), "MB", "psutil.virtual_memory"),
                "used_pct": measured(_round(vm.percent), "%", "psutil.virtual_memory"),
                "swap_used_pct": measured(_round(sw.percent), "%", "psutil.swap_memory") if sw.total else unavailable("no swap is configured"),
            }
        reason = "/proc/meminfo is missing and psutil isn't installed"
        return {key: unavailable(reason) for key in ("total_mb", "available_mb", "used_pct", "swap_used_pct")}

    # ------------------------------------------------------------ gpu
    def gpu(self) -> dict[str, Any]:
        if self.which("nvidia-smi"):
            try:
                return self._nvidia(self.runner(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"], 5.0))
            except (OSError, subprocess.SubprocessError, ValueError) as error:
                return {"devices": [], "status": unavailable(f"nvidia-smi is installed but failed ({type(error).__name__})")}
        if self.which("tegrastats"):
            try:
                return self._tegra(self.line_reader(["tegrastats", "--interval", "1000"], 4.0))
            except (OSError, subprocess.SubprocessError, ValueError) as error:
                return {"devices": [], "status": unavailable(f"tegrastats is installed but failed ({type(error).__name__})")}
        load = _int(_read(self._p("sys", "devices", "gpu.0", "load")))
        if load is not None:
            # Jetson exposes GPU load in tenths of a percent here; its memory is the system RAM.
            return {"devices": [{"name": "Jetson integrated GPU", "utilization_pct": measured(_round(load / 10.0), "%", "/sys/devices/gpu.0/load"), "memory_total_mb": unavailable("integrated GPU shares system memory"), "memory_used_mb": unavailable("integrated GPU shares system memory"), "temperature_c": unavailable("read the GPU thermal zone"), "power_w": unavailable("no power rail reading"), "shared_memory": True}], "status": measured(1, "devices", "/sys/devices/gpu.0")}
        return {"devices": [], "status": unavailable("no supported GPU tool found (nvidia-smi or tegrastats)")}

    @staticmethod
    def _nvidia(output: str) -> dict[str, Any]:
        devices = []
        source = "nvidia-smi"

        def field_metric(text: str, unit: str) -> dict[str, Any]:
            number = _float(text)
            return measured(number, unit, source) if number is not None else unavailable(f"nvidia-smi reports {text.strip() or 'nothing'}")

        for line in output.strip().splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 6:
                continue
            devices.append({
                "name": parts[0],
                "utilization_pct": field_metric(parts[1], "%"),
                "memory_used_mb": field_metric(parts[2], "MB"),
                "memory_total_mb": field_metric(parts[3], "MB"),
                "temperature_c": field_metric(parts[4], "C"),
                "power_w": field_metric(parts[5], "W"),
                "shared_memory": False,
            })
        if not devices:
            raise ValueError("nvidia-smi printed no GPU")
        return {"devices": devices, "status": measured(len(devices), "devices", source)}

    @staticmethod
    def _tegra(line: str) -> dict[str, Any]:
        source = "tegrastats"
        ram = re.search(r"RAM (\d+)/(\d+)MB", line)
        gr3d = re.search(r"GR3D_FREQ (\d+)%", line)
        temp = re.search(r"GPU@(-?[\d.]+)C", line)
        power = re.search(r"(?:VDD_GPU_SOC|POM_5V_GPU|VDD_GPU) (\d+)mW", line)
        if not (ram or gr3d):
            raise ValueError("tegrastats line not recognised")
        device = {
            "name": "NVIDIA Jetson integrated GPU",
            "utilization_pct": measured(int(gr3d.group(1)), "%", source) if gr3d else unavailable("tegrastats has no GR3D_FREQ"),
            "memory_used_mb": measured(int(ram.group(1)), "MB", f"{source} (shared system RAM)") if ram else unavailable("tegrastats has no RAM figure"),
            "memory_total_mb": measured(int(ram.group(2)), "MB", f"{source} (shared system RAM)") if ram else unavailable("tegrastats has no RAM figure"),
            "temperature_c": measured(float(temp.group(1)), "C", source) if temp else unavailable("tegrastats has no GPU temperature"),
            "power_w": measured(_round(int(power.group(1)) / 1000.0, 2), "W", source) if power else unavailable("tegrastats has no GPU power rail"),
            "shared_memory": True,
        }
        return {"devices": [device], "status": measured(1, "devices", source)}

    # ------------------------------------------------------------ storage
    def storage(self) -> list[dict[str, Any]]:
        out = []
        for path in self.storage_paths:
            target = Path(self.root, str(path).lstrip("/")) if str(self.root) != "/" else Path(path)
            try:
                st = os.statvfs(target)
            except (OSError, AttributeError) as error:
                out.append({"path": str(path), "total_gb": unavailable(f"statvfs failed ({type(error).__name__})"), "free_gb": unavailable("statvfs failed"), "used_pct": unavailable("statvfs failed")})
                continue
            total = st.f_blocks * st.f_frsize
            free = st.f_bavail * st.f_frsize
            if total <= 0:
                out.append({"path": str(path), "total_gb": unavailable("filesystem reports no size"), "free_gb": unavailable("filesystem reports no size"), "used_pct": unavailable("filesystem reports no size")})
                continue
            used = total - st.f_bfree * st.f_frsize
            out.append({
                "path": str(path),
                "total_gb": measured(_round(total / 1e9, 2), "GB", "os.statvfs"),
                "free_gb": measured(_round(free / 1e9, 2), "GB", "os.statvfs"),
                "used_pct": measured(_round(100.0 * used / total), "%", "os.statvfs"),
            })
        return out

    # ------------------------------------------------------------ network
    def network(self) -> dict[str, Any]:
        text = _read(self._p("proc", "net", "dev"))
        now = self.clock()
        interfaces = []
        if text:
            for line in text.splitlines()[2:]:
                if ":" not in line:
                    continue
                name, rest = line.split(":", 1)
                name = name.strip()
                fields = rest.split()
                if len(fields) < 9 or name == "lo":
                    continue
                rx, tx = int(fields[0]), int(fields[8])
                sys_dir = self._p("sys", "class", "net", name)
                oper = _read(sys_dir / "operstate")
                speed = _int(_read(sys_dir / "speed"))
                entry: dict[str, Any] = {
                    "name": name,
                    "up": measured(oper == "up", "bool", f"/sys/class/net/{name}/operstate") if oper else unavailable(f"/sys/class/net/{name}/operstate is missing"),
                    "speed_mbps": measured(speed, "Mbit/s", f"/sys/class/net/{name}/speed") if speed is not None and speed > 0 else unavailable("the driver doesn't report a link speed"),
                    "rx_bytes": measured(rx, "bytes", "/proc/net/dev"),
                    "tx_bytes": measured(tx, "bytes", "/proc/net/dev"),
                }
                prev = self._prev_net.get(name)
                if prev and now > prev[2] and rx >= prev[0] and tx >= prev[1]:
                    span = now - prev[2]
                    entry["rx_bps"] = measured(_round((rx - prev[0]) * 8 / span), "bit/s", "/proc/net/dev")
                    entry["tx_bps"] = measured(_round((tx - prev[1]) * 8 / span), "bit/s", "/proc/net/dev")
                else:
                    entry["rx_bps"] = unavailable("throughput is a rate and needs a second sample")
                    entry["tx_bps"] = unavailable("throughput is a rate and needs a second sample")
                self._prev_net[name] = (rx, tx, now)
                interfaces.append(entry)
            ups = [i["up"]["value"] for i in interfaces if is_measured(i["up"])]
            online = measured(any(ups), "bool", "a non-loopback interface is up") if ups else unavailable("no interface reports its link state")
            return {"interfaces": interfaces, "link_up": online}
        ps = self._psutil
        if ps is not None:
            stats = ps.net_if_stats()
            for name, stat in sorted(stats.items()):
                if name.startswith("lo"):
                    continue
                interfaces.append({"name": name, "up": measured(bool(stat.isup), "bool", "psutil.net_if_stats"), "speed_mbps": measured(stat.speed, "Mbit/s", "psutil.net_if_stats") if stat.speed else unavailable("the driver doesn't report a link speed")})
            ups = [i["up"]["value"] for i in interfaces]
            return {"interfaces": interfaces, "link_up": measured(any(ups), "bool", "psutil.net_if_stats") if ups else unavailable("no network interface")}
        return {"interfaces": [], "link_up": unavailable("/proc/net/dev is missing and psutil isn't installed")}

    # ------------------------------------------------------------ battery and power
    def _supplies(self) -> list[tuple[str, Path, str]]:
        base = self._p("sys", "class", "power_supply")
        if not base.exists():
            return []
        return [(entry.name, entry, (_read(entry / "type") or "").lower()) for entry in sorted(base.iterdir())]

    def battery(self) -> dict[str, Any]:
        for name, path, kind in self._supplies():
            if kind != "battery":
                continue
            src = f"/sys/class/power_supply/{name}"
            capacity = _int(_read(path / "capacity"))
            status = _read(path / "status")
            voltage = _int(_read(path / "voltage_now"))
            current = _int(_read(path / "current_now"))
            power = _int(_read(path / "power_now"))
            if power is None and voltage is not None and current is not None:
                power_metric = measured(_round(voltage * current / 1e12, 2), "W", f"{src} voltage_now x current_now")
            else:
                power_metric = measured(_round(power / 1e6, 2), "W", f"{src}/power_now") if power is not None else unavailable(f"{src} reports no power or current")
            return {
                "name": name,
                "percent": measured(capacity, "%", f"{src}/capacity") if capacity is not None else unavailable(f"{src} reports no capacity"),
                "status": measured(status.lower(), "state", f"{src}/status") if status else unavailable(f"{src} reports no status"),
                "voltage_v": measured(_round(voltage / 1e6, 3), "V", f"{src}/voltage_now") if voltage is not None else unavailable(f"{src} reports no voltage"),
                "current_a": measured(_round(current / 1e6, 3), "A", f"{src}/current_now") if current is not None else unavailable(f"{src} reports no current"),
                "power_w": power_metric,
            }
        ps = self._psutil
        if ps is not None and hasattr(ps, "sensors_battery"):
            batt = ps.sensors_battery()
            if batt is not None:
                return {"name": "battery", "percent": measured(_round(batt.percent), "%", "psutil.sensors_battery"), "status": measured("charging" if batt.power_plugged else "discharging", "state", "psutil.sensors_battery"), "voltage_v": unavailable("psutil doesn't report voltage"), "current_a": unavailable("psutil doesn't report current"), "power_w": unavailable("psutil doesn't report power")}
        reason = "no battery under /sys/class/power_supply" if self._p("sys", "class", "power_supply").exists() else "/sys/class/power_supply is missing"
        return {"name": None, "percent": unavailable(reason), "status": unavailable(reason), "voltage_v": unavailable(reason), "current_a": unavailable(reason), "power_w": unavailable(reason)}

    def power(self) -> dict[str, Any]:
        mains = [(name, path) for name, path, kind in self._supplies() if kind in {"mains", "usb", "usb_pd", "usb_c"}]
        if mains:
            states = [(_int(_read(path / "online")), name) for name, path in mains]
            known = [state for state, _ in states if state is not None]
            if known:
                return {"external_power": measured(any(s == 1 for s in known), "bool", "/sys/class/power_supply/" + ",".join(n for _, n in states) + "/online")}
        ps = self._psutil
        if ps is not None and hasattr(ps, "sensors_battery"):
            batt = ps.sensors_battery()
            if batt is not None and batt.power_plugged is not None:
                return {"external_power": measured(bool(batt.power_plugged), "bool", "psutil.sensors_battery")}
        return {"external_power": unavailable("no mains or USB supply under /sys/class/power_supply")}

    # ------------------------------------------------------------ processes
    def processes(self) -> dict[str, Any]:
        proc = self._p("proc")
        count: dict[str, Any]
        if self.has_proc:
            count = measured(sum(1 for entry in proc.iterdir() if entry.name.isdigit()), "processes", "/proc")
        elif self._psutil is not None:
            count = measured(len(self._psutil.pids()), "processes", "psutil.pids")
        else:
            count = unavailable("/proc is missing and psutil isn't installed")
        services = self.service_status() if self.service_status else []
        return {"count": count, "services": services}
