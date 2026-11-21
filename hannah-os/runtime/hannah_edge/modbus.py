"""Modbus TCP: the client a hub needs, and the number formats devices use.

Function codes: 1 (coils), 2 (discrete inputs), 3 (holding registers),
4 (input registers), 5 (write one coil), 6 (write one register),
16 (write several registers). An exception answer becomes a ModbusError that
names it.

Modbus has no authentication and no encryption. The client refuses any address
that isn't on the local network; there is no switch to allow it.

The standard: Modbus Application Protocol V1.1b3 and Modbus Messaging on TCP/IP V1.0b.
"""
from __future__ import annotations

import socket
import struct
import threading

from .netpolicy import PolicyError, is_local

EXCEPTIONS = {1: "the device doesn't support this function", 2: "the device has nothing at this address", 3: "the device refused the value", 4: "the device reported a failure", 6: "the device is busy"}
TABLES = {"coil": 1, "discrete": 2, "holding": 3, "input": 4}
TYPES = {"bool": 1, "uint16": 1, "int16": 1, "uint32": 2, "int32": 2, "float32": 2}


class ModbusError(Exception):
    def __init__(self, message: str, reason: str = "error", code: int = 0):
        super().__init__(message)
        self.reason = reason
        self.code = code


def request(transaction: int, unit: int, function: int, data: bytes) -> bytes:
    return struct.pack(">HHHBB", transaction, 0, len(data) + 2, unit, function) + data


def words_of(value, kind: str, word_order: str = "big") -> list:
    """A number as 16-bit register values."""
    if kind == "uint16":
        packed = struct.pack(">H", int(value))
    elif kind == "int16":
        packed = struct.pack(">h", int(value))
    elif kind == "uint32":
        packed = struct.pack(">I", int(value))
    elif kind == "int32":
        packed = struct.pack(">i", int(value))
    elif kind == "float32":
        packed = struct.pack(">f", float(value))
    else:
        raise ModbusError(f"{kind!r} isn't a register type", "bad-type")
    words = list(struct.unpack(f">{len(packed) // 2}H", packed))
    return words if word_order == "big" else words[::-1]


def number_of(words: list, kind: str, word_order: str = "big"):
    """Register values as a number."""
    if len(words) != TYPES.get(kind, 0):
        raise ModbusError(f"{kind!r} needs {TYPES.get(kind, '?')} registers", "bad-type")
    ordered = words if word_order == "big" else words[::-1]
    packed = struct.pack(f">{len(ordered)}H", *ordered)
    code = {"uint16": ">H", "int16": ">h", "uint32": ">I", "int32": ">i", "float32": ">f"}[kind]
    return struct.unpack(code, packed)[0]


class ModbusClient:
    def __init__(self, host: str, port: int = 502, unit: int = 1, timeout: float = 3.0):
        self.host, self.port, self.unit, self.timeout = host, int(port), int(unit), float(timeout)
        self._socket = None
        self._lock = threading.Lock()
        self._transaction = 0

    def connect(self) -> None:
        try:
            local = is_local(self.host)
        except PolicyError as error:
            raise ModbusError(str(error), "unreachable") from None
        if not local:
            raise ModbusError(f"Modbus has no encryption or sign-in, so it must stay on the local network. {self.host} is not on it.", "insecure")
        try:
            self._socket = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except socket.timeout:
            raise ModbusError(f"No answer from {self.host}:{self.port}.", "timeout") from None
        except OSError as error:
            raise ModbusError(f"Can't reach a device at {self.host}:{self.port} ({type(error).__name__}).", "unreachable") from None

    @property
    def connected(self) -> bool:
        return self._socket is not None

    def close(self) -> None:
        with self._lock:
            if self._socket:
                try:
                    self._socket.close()
                except OSError:
                    pass
                self._socket = None

    def _exact(self, count: int) -> bytes:
        out = b""
        while len(out) < count:
            chunk = self._socket.recv(count - len(out))
            if not chunk:
                raise OSError("closed")
            out += chunk
        return out

    def _call(self, function: int, data: bytes) -> bytes:
        with self._lock:
            if not self._socket:
                raise ModbusError("Not connected to the device.", "disconnected")
            self._transaction = self._transaction % 65535 + 1
            try:
                self._socket.sendall(request(self._transaction, self.unit, function, data))
                transaction, protocol, length, _unit = struct.unpack(">HHHB", self._exact(7))
                if protocol != 0 or length < 2 or length > 254:
                    raise ModbusError("The answer wasn't Modbus TCP.", "protocol")
                body = self._exact(length - 1)
            except socket.timeout:
                self._drop()
                raise ModbusError("The device didn't answer in time.", "timeout") from None
            except OSError:
                self._drop()
                raise ModbusError("The connection to the device dropped.", "disconnected") from None
            if transaction != self._transaction:
                self._drop()
                raise ModbusError("The device answered a different request.", "protocol")
            if body[0] == function | 0x80:
                code = body[1] if len(body) > 1 else 0
                raise ModbusError(f"Modbus exception {code}: {EXCEPTIONS.get(code, 'unknown')}.", "exception", code)
            if body[0] != function:
                self._drop()
                raise ModbusError("The device answered a different function.", "protocol")
            return body[1:]

    def _drop(self) -> None:
        try:
            self._socket.close()
        except OSError:
            pass
        self._socket = None

    def read(self, table: str, address: int, count: int = 1) -> list:
        if table not in TABLES:
            raise ModbusError(f"{table!r} isn't a Modbus table", "bad-table")
        if not (0 <= address <= 65535) or not (1 <= count <= 125):
            raise ModbusError("address or count out of range", "bad-address")
        answer = self._call(TABLES[table], struct.pack(">HH", address, count))
        size, data = answer[0], answer[1:]
        if table in ("coil", "discrete"):
            if size != (count + 7) // 8 or len(data) != size:
                raise ModbusError("The answer had the wrong length.", "protocol")
            return [bool(data[index // 8] >> (index % 8) & 1) for index in range(count)]
        if size != count * 2 or len(data) != size:
            raise ModbusError("The answer had the wrong length.", "protocol")
        return list(struct.unpack(f">{count}H", data))

    def write_coil(self, address: int, on: bool) -> None:
        sent = struct.pack(">HH", address, 0xFF00 if on else 0)
        if self._call(5, sent) != sent:
            raise ModbusError("The device didn't echo the write.", "protocol")

    def write_registers(self, address: int, words: list) -> None:
        if len(words) == 1:
            sent = struct.pack(">HH", address, words[0])
            if self._call(6, sent) != sent:
                raise ModbusError("The device didn't echo the write.", "protocol")
            return
        answer = self._call(16, struct.pack(">HHB", address, len(words), len(words) * 2) + struct.pack(f">{len(words)}H", *words))
        if answer != struct.pack(">HH", address, len(words)):
            raise ModbusError("The device didn't confirm the write.", "protocol")
