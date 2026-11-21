"""MQTT 3.1.1 packets: bytes in, bytes out, nothing else.

Covers what a device hub needs: CONNECT/CONNACK, PUBLISH at QoS 0 and 1 with
PUBACK, SUBSCRIBE/SUBACK, UNSUBSCRIBE/UNSUBACK, PINGREQ/PINGRESP, DISCONNECT.
QoS 2 is not implemented; a QoS 2 packet is reported as an error, not guessed at.

The standard: MQTT Version 3.1.1, OASIS, 2014.
"""
from __future__ import annotations

import struct

CONNECT, CONNACK, PUBLISH, PUBACK, SUBSCRIBE, SUBACK, UNSUBSCRIBE, UNSUBACK, PINGREQ, PINGRESP, DISCONNECT = 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14
CONNACK_REASONS = {
    1: "the broker doesn't accept this protocol version", 2: "the broker refused the client id", 3: "the broker is unavailable",
    4: "wrong user name or password", 5: "not authorised",
}
MAX_PACKET = 268_435_455


class WireError(Exception):
    pass


def _text(value: str) -> bytes:
    raw = value.encode("utf-8")
    if len(raw) > 65535:
        raise WireError("a string is too long for MQTT")
    return struct.pack(">H", len(raw)) + raw


def _length(size: int) -> bytes:
    if size > MAX_PACKET:
        raise WireError("the packet is too large for MQTT")
    out = bytearray()
    while True:
        digit, size = size % 128, size // 128
        out.append(digit | (0x80 if size else 0))
        if not size:
            return bytes(out)


def _packet(kind: int, flags: int, body: bytes) -> bytes:
    return bytes(((kind << 4) | flags,)) + _length(len(body)) + body


def connect(client_id: str, keepalive: int = 60, username: str | None = None, password: str | None = None, will: dict | None = None, clean: bool = True) -> bytes:
    flags = 0x02 if clean else 0
    payload = _text(client_id)
    if will:
        flags |= 0x04 | ((will.get("qos", 0) & 3) << 3) | (0x20 if will.get("retain") else 0)
        message = will.get("payload", b"")
        message = message.encode("utf-8") if isinstance(message, str) else bytes(message)
        payload += _text(will["topic"]) + struct.pack(">H", len(message)) + message
    if username is not None:
        flags |= 0x80
        payload += _text(username)
    if password is not None:
        if username is None:
            raise WireError("MQTT 3.1.1 allows a password only with a user name")
        flags |= 0x40
        payload += _text(password)
    return _packet(CONNECT, 0, _text("MQTT") + bytes((4, flags)) + struct.pack(">H", keepalive) + payload)


def connack(code: int = 0, session_present: bool = False) -> bytes:
    return _packet(CONNACK, 0, bytes((1 if session_present else 0, code)))


def publish(topic: str, payload: bytes, qos: int = 0, retain: bool = False, packet_id: int = 0, dup: bool = False) -> bytes:
    if qos not in (0, 1):
        raise WireError("only QoS 0 and 1 are supported")
    if not topic or "+" in topic or "#" in topic:
        raise WireError("a message can't be published to a wildcard or empty topic")
    body = _text(topic) + (struct.pack(">H", packet_id) if qos else b"") + payload
    return _packet(PUBLISH, (0x08 if dup else 0) | (qos << 1) | (1 if retain else 0), body)


def puback(packet_id: int) -> bytes:
    return _packet(PUBACK, 0, struct.pack(">H", packet_id))


def subscribe(packet_id: int, filters: list) -> bytes:
    body = struct.pack(">H", packet_id) + b"".join(_text(topic) + bytes((qos,)) for topic, qos in filters)
    return _packet(SUBSCRIBE, 0x02, body)


def suback(packet_id: int, codes: list) -> bytes:
    return _packet(SUBACK, 0, struct.pack(">H", packet_id) + bytes(codes))


def unsubscribe(packet_id: int, filters: list) -> bytes:
    return _packet(UNSUBSCRIBE, 0x02, struct.pack(">H", packet_id) + b"".join(_text(topic) for topic in filters))


def unsuback(packet_id: int) -> bytes:
    return _packet(UNSUBACK, 0, struct.pack(">H", packet_id))


def pingreq() -> bytes:
    return _packet(PINGREQ, 0, b"")


def pingresp() -> bytes:
    return _packet(PINGRESP, 0, b"")


def disconnect() -> bytes:
    return _packet(DISCONNECT, 0, b"")


class Reader:
    """Feed it bytes as they arrive; it yields whole packets as (kind, flags, body)."""

    def __init__(self):
        self._buffer = bytearray()

    def feed(self, data: bytes) -> list:
        self._buffer += data
        out = []
        while True:
            if len(self._buffer) < 2:
                return out
            size, shift, index = 0, 0, 1
            while True:
                if index >= len(self._buffer):
                    return out
                digit = self._buffer[index]
                size |= (digit & 0x7F) << shift
                index += 1
                if not digit & 0x80:
                    break
                shift += 7
                if shift > 21:
                    raise WireError("malformed remaining length")
            if len(self._buffer) < index + size:
                return out
            first = self._buffer[0]
            out.append((first >> 4, first & 0x0F, bytes(self._buffer[index:index + size])))
            del self._buffer[:index + size]


def _take_text(body: bytes, at: int) -> tuple:
    if at + 2 > len(body):
        raise WireError("truncated packet")
    size = struct.unpack(">H", body[at:at + 2])[0]
    if at + 2 + size > len(body):
        raise WireError("truncated packet")
    try:
        return body[at + 2:at + 2 + size].decode("utf-8"), at + 2 + size
    except UnicodeDecodeError:
        raise WireError("a string isn't valid UTF-8") from None


def parse_connect(body: bytes) -> dict:
    name, at = _take_text(body, 0)
    if name != "MQTT" or at + 4 > len(body) or body[at] != 4:
        raise WireError("not an MQTT 3.1.1 CONNECT")
    flags = body[at + 1]
    keepalive = struct.unpack(">H", body[at + 2:at + 4])[0]
    client_id, at = _take_text(body, at + 4)
    out = {"clientId": client_id, "keepalive": keepalive, "clean": bool(flags & 0x02), "will": None, "username": None, "password": None}
    if flags & 0x04:
        topic, at = _take_text(body, at)
        size = struct.unpack(">H", body[at:at + 2])[0]
        out["will"] = {"topic": topic, "payload": body[at + 2:at + 2 + size], "qos": (flags >> 3) & 3, "retain": bool(flags & 0x20)}
        at += 2 + size
    if flags & 0x80:
        out["username"], at = _take_text(body, at)
    if flags & 0x40:
        out["password"], at = _take_text(body, at)
    return out


def parse_publish(flags: int, body: bytes) -> dict:
    qos = (flags >> 1) & 3
    if qos == 3:
        raise WireError("malformed QoS")
    topic, at = _take_text(body, 0)
    packet_id = 0
    if qos:
        if at + 2 > len(body):
            raise WireError("truncated packet")
        packet_id = struct.unpack(">H", body[at:at + 2])[0]
        at += 2
    return {"topic": topic, "payload": body[at:], "qos": qos, "retain": bool(flags & 1), "dup": bool(flags & 8), "packetId": packet_id}


def parse_subscribe(body: bytes) -> dict:
    packet_id = struct.unpack(">H", body[:2])[0]
    filters, at = [], 2
    while at < len(body):
        topic, at = _take_text(body, at)
        if at >= len(body):
            raise WireError("truncated packet")
        filters.append((topic, body[at] & 3))
        at += 1
    if not filters:
        raise WireError("a SUBSCRIBE needs at least one topic")
    return {"packetId": packet_id, "filters": filters}


def parse_unsubscribe(body: bytes) -> dict:
    packet_id = struct.unpack(">H", body[:2])[0]
    filters, at = [], 2
    while at < len(body):
        topic, at = _take_text(body, at)
        filters.append(topic)
    return {"packetId": packet_id, "filters": filters}


def packet_id_of(body: bytes) -> int:
    if len(body) < 2:
        raise WireError("truncated packet")
    return struct.unpack(">H", body[:2])[0]


def valid_filter(topic: str) -> bool:
    if not topic or "\x00" in topic:
        return False
    levels = topic.split("/")
    for index, level in enumerate(levels):
        if level == "#":
            if index != len(levels) - 1:
                return False
        elif "#" in level or ("+" in level and level != "+"):
            return False
    return True


def matches(topic_filter: str, topic: str) -> bool:
    """Does a subscription filter match a topic? `+` is one level, `#` the rest. Topics starting with `$` match only filters that start with it."""
    if topic.startswith("$") != topic_filter.startswith("$"):
        return False
    want, have = topic_filter.split("/"), topic.split("/")
    for index, level in enumerate(want):
        if level == "#":
            return True
        if index >= len(have):
            return False
        if level != "+" and level != have[index]:
            return False
    return len(want) == len(have)
