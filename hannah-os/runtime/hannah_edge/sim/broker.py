"""A small MQTT 3.1.1 broker for tests and simulation. Not for real use.

It routes QoS 0 and 1 messages (delivered at QoS 0 or 1 as subscribed), keeps
retained messages, checks a user name and password when given one, and sends a
client's last-will message when its connection ends without a DISCONNECT.
No persistence, no QoS 2, no TLS.
"""
from __future__ import annotations

import socket
import threading

from .. import wire_mqtt as wire


class Broker:
    def __init__(self, host: str = "127.0.0.1", port: int = 0, users: dict | None = None):
        self._users = users
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind((host, port))
        self._server.listen(32)
        self.host, self.port = self._server.getsockname()[:2]
        self._lock = threading.RLock()
        self._clients: dict = {}
        self._retained: dict = {}
        self._running = True
        self.log: list = []
        threading.Thread(target=self._accept, name="sim-broker", daemon=True).start()

    def _accept(self) -> None:
        while self._running:
            try:
                connection, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(connection,), daemon=True).start()

    def _serve(self, connection) -> None:
        reader = wire.Reader()
        session = {"socket": connection, "filters": {}, "will": None, "id": None, "lock": threading.Lock()}
        clean = False
        try:
            while self._running:
                data = connection.recv(65536)
                if not data:
                    break
                for kind, flags, body in reader.feed(data):
                    if session["id"] is None:
                        if kind != wire.CONNECT:
                            return
                        hello = wire.parse_connect(body)
                        if self._users is not None and self._users.get(hello["username"] or "") != (hello["password"] or ""):
                            connection.sendall(wire.connack(4))
                            return
                        session["id"], session["will"] = hello["clientId"] or f"anon-{id(session)}", hello["will"]
                        with self._lock:
                            old = self._clients.pop(session["id"], None)
                            self._clients[session["id"]] = session
                        if old:
                            try:
                                old["socket"].close()
                            except OSError:
                                pass
                        connection.sendall(wire.connack(0))
                    elif kind == wire.PUBLISH:
                        message = wire.parse_publish(flags, body)
                        if message["qos"] == 1:
                            self._write(session, wire.puback(message["packetId"]))
                        self.route(message["topic"], message["payload"], message["retain"])
                    elif kind == wire.SUBSCRIBE:
                        request = wire.parse_subscribe(body)
                        codes = []
                        for topic, qos in request["filters"]:
                            if wire.valid_filter(topic):
                                session["filters"][topic] = min(qos, 1)
                                codes.append(min(qos, 1))
                            else:
                                codes.append(0x80)
                        self._write(session, wire.suback(request["packetId"], codes))
                        with self._lock:
                            retained = list(self._retained.items())
                        for topic, payload in retained:
                            if any(wire.matches(pattern, topic) for pattern, _ in request["filters"]):
                                self._write(session, wire.publish(topic, payload, 0, True))
                    elif kind == wire.UNSUBSCRIBE:
                        request = wire.parse_unsubscribe(body)
                        for topic in request["filters"]:
                            session["filters"].pop(topic, None)
                        self._write(session, wire.unsuback(request["packetId"]))
                    elif kind == wire.PINGREQ:
                        self._write(session, wire.pingresp())
                    elif kind == wire.DISCONNECT:
                        clean = True
                        return
        except (OSError, wire.WireError):
            pass
        finally:
            try:
                connection.close()
            except OSError:
                pass
            with self._lock:
                if session["id"] and self._clients.get(session["id"]) is session:
                    del self._clients[session["id"]]
            if session["will"] and not clean and self._running:
                self.route(session["will"]["topic"], session["will"]["payload"], session["will"]["retain"])

    def _write(self, session: dict, data: bytes) -> None:
        with session["lock"]:
            try:
                session["socket"].sendall(data)
            except OSError:
                pass

    def route(self, topic: str, payload: bytes, retain: bool = False) -> None:
        """Deliver a message to every matching subscriber (and keep it, when retained)."""
        with self._lock:
            if retain:
                if payload:
                    self._retained[topic] = payload
                else:
                    self._retained.pop(topic, None)
            self.log.append((topic, payload))
            del self.log[:-500]
            sessions = list(self._clients.values())
        for session in sessions:
            if any(wire.matches(pattern, topic) for pattern in list(session["filters"])):
                self._write(session, wire.publish(topic, payload, 0, False))

    def drop_clients(self, prefix: str = "") -> None:
        """Cut connections without a goodbye, as a network failure would."""
        with self._lock:
            sessions = [session for key, session in self._clients.items() if key.startswith(prefix)]
        for session in sessions:
            try:
                session["socket"].shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self) -> None:
        self._running = False
        try:
            self._server.close()
        except OSError:
            pass
        self.drop_clients()
