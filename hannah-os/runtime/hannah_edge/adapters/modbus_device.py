"""A device that speaks Modbus TCP on the local network. It is polled; it never speaks first."""
from __future__ import annotations

from .. import modbus
from ..modbus import ModbusClient, ModbusError
from .base import AdapterError, DeviceAdapter

RETRY_S = (2, 5, 15, 30)


class ModbusDevice(DeviceAdapter):
    NAME = "modbus-tcp"
    ABOUT = {
        "protocol": "Modbus TCP", "version": "Application Protocol V1.1b3",
        "authentication": "None: the protocol has none",
        "encryption": "None: the protocol has none. Local network addresses only, with no way to allow another",
        "reads": "The coils, inputs and registers a profile lists, as bool, 16- or 32-bit integers or 32-bit floats, in either word order, with a scale",
        "writes": "One listed coil or holding register (two for a 32-bit value); never an address the profile doesn't name",
        "rateLimit": "Polled no faster than once a second; one request at a time",
        "errors": "Exception answers are named; a silent or closed device is reported and retried with a growing pause",
        "permissions": "network-local",
        "security": "A device on this protocol can be written to by anything on its network. HANNAH's checks do not change that",
        "diagnostics": "Reachability, the last exception, time since each point was read",
        "tested": "Against HANNAH's own test server. Not against any physical device or vendor simulator",
        "notSupported": "Modbus RTU (serial), function codes other than 1-6 and 16, 64-bit values, strings",
    }

    def __init__(self, device: dict, clock=None, client_id: str = ""):
        super().__init__(device, **({"clock": clock} if clock else {}))
        self._client = None
        self._attempts = 0
        self._next_try = 0.0
        self._next_poll = 0.0
        self._poll_s = max(1.0, float(device.get("pollS") or self.settings.get("pollS") or 5))

    def start(self) -> None:
        self._connect()
        self.poll()

    def _connect(self) -> None:
        self._set_state("connecting")
        client = ModbusClient(str(self.settings.get("host", "")), int(self.settings.get("port") or 502), int(self.settings.get("unit") or 1), timeout=2.5)
        try:
            client.connect()
        except ModbusError as error:
            self._fail(error)
            return
        self._client = client
        self._attempts = 0

    def _fail(self, error: ModbusError) -> None:
        if self._client:
            self._client.close()
        self._client = None
        self._attempts += 1
        self._next_try = self.clock() + RETRY_S[min(self._attempts, len(RETRY_S)) - 1]
        self._set_state("error", error.reason, str(error))

    def _read_point(self, point: dict) -> None:
        binding = (point.get("binding") or {}).get("register")
        if not binding:
            return
        kind = binding.get("type") or ("bool" if binding["table"] in ("coil", "discrete") else "uint16")
        raw = self._client.read(binding["table"], int(binding["address"]), modbus.TYPES[kind])
        value = raw[0] if kind == "bool" else modbus.number_of(raw, kind, binding.get("wordOrder", "big"))
        self._record(point["id"], value, binding)

    def poll(self) -> None:
        now = self.clock()
        if not self._client:
            if now < self._next_try:
                return
            self._connect()
            if not self._client:
                return
        if now < self._next_poll:
            return
        self._next_poll = now + self._poll_s
        problems = []
        for point in self.points.values():
            try:
                self._read_point(point)
            except ModbusError as error:
                if error.reason == "exception":
                    problems.append(f"{point.get('name') or point['id']}: {error}")
                    continue
                self._fail(error)
                return
        if problems and not self._readings:
            self._set_state("error", "exception", " ".join(problems)[:300])
        elif problems:
            self._set_state("online", "partial", " ".join(problems)[:300])
        else:
            self._set_state("online")

    def has_feedback(self, point_id: str) -> bool:
        return bool((self.points.get(point_id, {}).get("binding") or {}).get("register"))

    def refresh(self, point_id: str) -> None:
        if self._client and point_id in self.points:
            try:
                self._read_point(self.points[point_id])
            except ModbusError:
                pass

    def write(self, point_id: str, value) -> None:
        point, value = self.point_for_write(point_id, value)
        binding = (point.get("binding") or {}).get("register")
        if not binding or binding.get("table") not in ("coil", "holding"):
            raise AdapterError(f"The profile has no writable register for {point.get('name') or point_id}.", "not-writable")
        if not self._client:
            raise AdapterError("The device isn't connected.", "offline")
        try:
            if binding["table"] == "coil":
                self._client.write_coil(int(binding["address"]), bool(value))
            else:
                kind = binding.get("type", "uint16")
                raw = (value - binding.get("offset", 0)) / (binding.get("scale", 1) or 1)
                self._client.write_registers(int(binding["address"]), modbus.words_of(raw if kind == "float32" else round(raw), kind, binding.get("wordOrder", "big")))
        except (ModbusError, OverflowError, ValueError) as error:
            reason = getattr(error, "reason", "bad-value")
            if isinstance(error, ModbusError) and reason != "exception":
                self._fail(error)
            raise AdapterError(str(error) if isinstance(error, ModbusError) else "The value doesn't fit the register.", reason) from None

    def stop(self) -> None:
        if self._client:
            self._client.close()
            self._client = None
        self._set_state("stopped")
