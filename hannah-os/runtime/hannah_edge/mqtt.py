"""An MQTT 3.1.1 client, enough for a device hub: connect (optionally with TLS
and a user name), subscribe, receive, publish at QoS 0 or 1, keep the
connection alive, and say plainly why a connection failed.

One reader thread per client. It does not reconnect by itself: whoever owns it
decides when to try again, so a broker that is away isn't hammered.
"""
from __future__ import annotations

import socket
import ssl
import threading
import time

from . import wire_mqtt as wire
from .netpolicy import PolicyError, require_local_or_tls


class MqttError(Exception):
    def __init__(self, message: str, reason: str = "error"):
        super().__init__(message)
        self.reason = reason


class MqttClient:
    def __init__(self, host: str, port: int = 1883, client_id: str = "hannah-hub", username: str | None = None, password: str | None = None,
                 tls: bool = False, ca_file: str | None = None, keepalive: int = 30, timeout: float = 5.0, on_message=None, on_disconnect=None, will: dict | None = None):
        self.host, self.port, self.client_id = host, int(port), client_id
        self._username, self._password = username or None, password or None
        self.tls, self._ca_file = bool(tls), ca_file
        self.keepalive, self.timeout = int(keepalive), float(timeout)
        self.on_message, self.on_disconnect = on_message, on_disconnect
        self._will = will
        self._socket = None
        self._lock = threading.Lock()
        self._waiting: dict = {}
        self._next_id = 0
        self._thread = None
        self._connected = False
        self._closing = False
        self._last_sent = 0.0
        self._connack = threading.Event()
        self._connack_code = None

    @property
    def connected(self) -> bool:
        return self._connected

    def connect(self) -> None:
        try:
            require_local_or_tls(self.host, self.tls, "An MQTT connection")
        except PolicyError as error:
            raise MqttError(str(error), "insecure") from None
        try:
            raw = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except socket.timeout:
            raise MqttError(f"No answer from {self.host}:{self.port}.", "timeout") from None
        except OSError as error:
            raise MqttError(f"Can't reach a broker at {self.host}:{self.port} ({type(error).__name__}).", "unreachable") from None
        if self.tls:
            try:
                context = ssl.create_default_context(cafile=self._ca_file) if self._ca_file else ssl.create_default_context()
                raw = context.wrap_socket(raw, server_hostname=self.host)
            except (ssl.SSLError, OSError) as error:
                raw.close()
                raise MqttError(f"The broker's certificate wasn't accepted ({type(error).__name__}).", "tls") from None
        raw.settimeout(1.0)
        self._socket = raw
        self._closing = False
        self._connack.clear()
        self._thread = threading.Thread(target=self._read, name=f"mqtt-{self.client_id}", daemon=True)
        self._thread.start()
        self._send(wire.connect(self.client_id, self.keepalive, self._username, self._password, self._will))
        if not self._connack.wait(self.timeout):
            self.close()
            raise MqttError("The broker accepted the connection and then said nothing. Is this port MQTT?", "no-connack")
        if self._connack_code != 0:
            code = self._connack_code
            self.close()
            raise MqttError(f"The broker refused the connection: {wire.CONNACK_REASONS.get(code, f'code {code}')}.", "auth" if code in (4, 5) else "refused")
        self._connected = True

    def _send(self, data: bytes) -> None:
        with self._lock:
            if not self._socket:
                raise MqttError("Not connected to the broker.", "disconnected")
            try:
                self._socket.sendall(data)
                self._last_sent = time.monotonic()
            except OSError:
                raise MqttError("The connection to the broker dropped.", "disconnected") from None

    def _packet_id(self) -> int:
        self._next_id = self._next_id % 65535 + 1
        return self._next_id

    def _await(self, packet_id: int, send: bytes, what: str):
        event = threading.Event()
        self._waiting[packet_id] = [event, None]
        try:
            self._send(send)
            if not event.wait(self.timeout):
                raise MqttError(f"The broker didn't confirm {what}.", "timeout")
            return self._waiting[packet_id][1]
        finally:
            self._waiting.pop(packet_id, None)

    def subscribe(self, filters: list, qos: int = 0) -> None:
        for topic in filters:
            if not wire.valid_filter(topic):
                raise MqttError(f"{topic!r} isn't a valid topic filter.", "bad-topic")
        packet_id = self._packet_id()
        codes = self._await(packet_id, wire.subscribe(packet_id, [(topic, qos) for topic in filters]), "the subscription")
        refused = [topic for topic, code in zip(filters, codes or []) if code == 0x80]
        if refused:
            raise MqttError(f"The broker refused the subscription to {', '.join(refused)}.", "refused")

    def publish(self, topic: str, payload, qos: int = 0, retain: bool = False) -> None:
        data = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
        if qos == 0:
            self._send(wire.publish(topic, data, 0, retain))
            return
        packet_id = self._packet_id()
        self._await(packet_id, wire.publish(topic, data, 1, retain, packet_id), "the message")

    def _read(self) -> None:
        reader = wire.Reader()
        sock = self._socket
        while not self._closing:
            if self._connected and self.keepalive and time.monotonic() - self._last_sent > self.keepalive / 2:
                try:
                    self._send(wire.pingreq())
                except MqttError:
                    break
            try:
                data = sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data:
                break
            try:
                packets = reader.feed(data)
            except wire.WireError:
                break
            for kind, flags, body in packets:
                try:
                    self._handle(kind, flags, body)
                except (wire.WireError, MqttError):
                    pass
        was_connected = self._connected
        self._connected = False
        with self._lock:
            try:
                sock.close()
            except OSError:
                pass
            if self._socket is sock:
                self._socket = None
        for entry in list(self._waiting.values()):
            entry[0].set()
        if was_connected and not self._closing and self.on_disconnect:
            self.on_disconnect()

    def _handle(self, kind: int, flags: int, body: bytes) -> None:
        if kind == wire.CONNACK:
            self._connack_code = body[1] if len(body) >= 2 else 255
            self._connack.set()
        elif kind == wire.PUBLISH:
            message = wire.parse_publish(flags, body)
            if message["qos"] == 2:
                return  # not supported; never acknowledged, so the broker knows it wasn't taken
            if message["qos"] == 1:
                self._send(wire.puback(message["packetId"]))
            if self.on_message:
                self.on_message(message["topic"], message["payload"], message["retain"])
        elif kind in (wire.PUBACK, wire.UNSUBACK):
            entry = self._waiting.get(wire.packet_id_of(body))
            if entry:
                entry[1] = True
                entry[0].set()
        elif kind == wire.SUBACK:
            entry = self._waiting.get(wire.packet_id_of(body))
            if entry:
                entry[1] = list(body[2:])
                entry[0].set()

    def close(self) -> None:
        self._closing = True
        was = self._connected
        self._connected = False
        if was:
            try:
                self._send(wire.disconnect())
            except MqttError:
                pass
        with self._lock:
            if self._socket:
                for end in (lambda: self._socket.shutdown(socket.SHUT_RDWR), lambda: self._socket.close()):
                    try:
                        end()  # shutdown first, so the reader thread wakes now instead of at its next timeout
                    except OSError:
                        pass
                self._socket = None
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=2.0)
