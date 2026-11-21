"""A small Modbus TCP server for tests and simulation. Not a product, and not a model of any product.

Only addresses that were defined exist; anything else answers with exception 2,
as a real device does. `on_write` lets a simulated device react to a write.
"""
from __future__ import annotations

import socket
import struct
import threading


class ModbusServer:
    def __init__(self, host: str = "127.0.0.1", port: int = 0, unit: int = 1):
        self.unit = unit
        self.coils: dict = {}
        self.discrete: dict = {}
        self.holding: dict = {}
        self.input: dict = {}
        self.read_only_holding: set = set()
        self.on_write = None
        self.requests = 0
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind((host, port))
        self._server.listen(8)
        self.host, self.port = self._server.getsockname()[:2]
        self._running = True
        self._connections: list = []
        threading.Thread(target=self._accept, name="sim-modbus", daemon=True).start()

    def _accept(self) -> None:
        while self._running:
            try:
                connection, _ = self._server.accept()
            except OSError:
                return
            self._connections.append(connection)
            threading.Thread(target=self._serve, args=(connection,), daemon=True).start()

    def _serve(self, connection) -> None:
        try:
            while self._running:
                header = self._exact(connection, 7)
                transaction, protocol, length, unit = struct.unpack(">HHHB", header)
                body = self._exact(connection, length - 1)
                if protocol != 0 or unit != self.unit:
                    continue  # another unit: a real gateway stays silent
                self.requests += 1
                answer = self._answer(body[0], body[1:])
                connection.sendall(struct.pack(">HHHB", transaction, 0, len(answer) + 1, unit) + answer)
        except (OSError, struct.error, IndexError):
            pass
        finally:
            try:
                connection.close()
            except OSError:
                pass

    @staticmethod
    def _exact(connection, count: int) -> bytes:
        out = b""
        while len(out) < count:
            chunk = connection.recv(count - len(out))
            if not chunk:
                raise OSError("closed")
            out += chunk
        return out

    def _answer(self, function: int, data: bytes) -> bytes:
        error = lambda code: bytes((function | 0x80, code))
        table = {1: self.coils, 2: self.discrete, 3: self.holding, 4: self.input}.get(function)
        if table is not None:
            address, count = struct.unpack(">HH", data[:4])
            if any(address + index not in table for index in range(count)):
                return error(2)
            values = [table[address + index] for index in range(count)]
            if function in (1, 2):
                packed = bytearray((count + 7) // 8)
                for index, value in enumerate(values):
                    if value:
                        packed[index // 8] |= 1 << (index % 8)
                return bytes((function, len(packed))) + bytes(packed)
            return bytes((function, count * 2)) + struct.pack(f">{count}H", *values)
        if function == 5:
            address, value = struct.unpack(">HH", data[:4])
            if address not in self.coils:
                return error(2)
            if value not in (0xFF00, 0):
                return error(3)
            self.coils[address] = value == 0xFF00
            if self.on_write:
                self.on_write("coil", address, self.coils[address])
            return bytes((5,)) + data[:4]
        if function in (6, 16):
            if function == 6:
                address, value = struct.unpack(">HH", data[:4])
                words = [value]
            else:
                address, count, _size = struct.unpack(">HHB", data[:5])
                words = list(struct.unpack(f">{count}H", data[5:5 + count * 2]))
            if any(address + index not in self.holding for index in range(len(words))):
                return error(2)
            if any(address + index in self.read_only_holding for index in range(len(words))):
                return error(3)
            for index, word in enumerate(words):
                self.holding[address + index] = word
            if self.on_write:
                self.on_write("holding", address, words)
            return bytes((function,)) + (data[:4] if function == 6 else struct.pack(">HH", address, len(words)))
        return error(1)

    def close(self) -> None:
        self._running = False
        try:
            self._server.close()
        except OSError:
            pass
        for connection in self._connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
