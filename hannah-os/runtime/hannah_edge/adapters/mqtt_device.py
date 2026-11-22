"""A device that speaks MQTT through a broker on the local network."""
from __future__ import annotations

import json

from ..mqtt import MqttClient, MqttError
from .base import AdapterError, DeviceAdapter, fill, parse_payload

RETRY_S = (2, 5, 15, 30)


class MqttDevice(DeviceAdapter):
    NAME = "mqtt"
    ABOUT = {
        "protocol": "MQTT", "version": "3.1.1",
        "authentication": "The broker's user name and password, when it has them",
        "encryption": "TLS when the broker offers it. Without TLS only to a broker on the local network",
        "reads": "The topics a profile lists, as text or one field of a JSON message",
        "writes": "A message to the command topic a profile lists for a writable point; never an arbitrary topic",
        "rateLimit": "One write per point per second",
        "errors": "Unreachable broker, refused sign-in, refused subscription and a dropped connection are each named; it reconnects with a growing pause",
        "permissions": "network-local",
        "security": "Device messages are data: a value that doesn't fit the point's type and range is dropped",
        "diagnostics": "Broker connection, the device's own availability message, time since each point was heard",
        "tested": "Against HANNAH's own test broker and against aedes, an independent broker. Not against any physical device",
        "notSupported": "QoS 2, MQTT 5 features, client certificates",
    }

    def __init__(self, device: dict, clock=None, client_id: str = "hannah-hub"):
        super().__init__(device, **({"clock": clock} if clock else {}))
        self._client = None
        self._client_id = client_id
        self._attempts = 0
        self._next_try = 0.0
        self._available = None
        self._routes: list = []
        availability = self.profile.get("availability")
        self._availability = {**availability, "topic": fill(availability["topic"], self.settings)} if availability else None
        for point in self.points.values():
            state = (point.get("binding") or {}).get("state")
            if state:
                self._routes.append((fill(state["topic"], self.settings), point["id"], state))

    def start(self) -> None:
        self._connect()

    def _connect(self) -> None:
        settings = self.settings
        self._set_state("connecting")
        client = MqttClient(str(settings.get("host", "")), int(settings.get("port") or (8883 if settings.get("tls") else 1883)), client_id=self._client_id,
                            username=settings.get("username") or None, password=settings.get("password") or None, tls=bool(settings.get("tls")), ca_file=settings.get("caFile") or None,
                            keepalive=30, timeout=4.0, on_message=self._message, on_disconnect=self._dropped)
        try:
            client.connect()
            topics = sorted({topic for topic, _point, _state in self._routes} | ({self._availability["topic"]} if self._availability else set()))
            if topics:
                client.subscribe(topics, qos=1)
        except MqttError as error:
            client.close()
            self._client = None
            self._attempts += 1
            self._next_try = self.clock() + RETRY_S[min(self._attempts, len(RETRY_S)) - 1]
            self._set_state("error", error.reason, str(error))
            return
        self._client = client
        self._attempts = 0
        self._update_state()

    def _dropped(self) -> None:
        self._client = None
        self._next_try = self.clock() + RETRY_S[0]
        self._set_state("error", "disconnected", "The connection to the broker dropped. Trying again.")

    def _update_state(self) -> None:
        if not self._client:
            return
        if self._available is False:
            self._set_state("offline", "device-offline", "The broker is reachable; the device says it is offline.")
        elif self._available or self._readings:
            self._set_state("online")
        else:
            self._set_state("no-data", "nothing-heard", "Connected to the broker. Nothing has been heard from the device yet.")

    def _message(self, topic: str, payload: bytes, _retained: bool) -> None:
        if self._availability and topic == self._availability["topic"]:
            text = payload.decode("utf-8", "replace").strip()
            self._available = True if text == str(self._availability.get("online")) else False if text == str(self._availability.get("offline")) else self._available
        for route, point_id, state in self._routes:
            if route == topic:
                ok, raw = parse_payload(payload, state.get("json"))
                if ok:
                    self._record(point_id, raw, state)
                else:
                    self.rejected += 1
        self._update_state()

    def poll(self) -> None:
        if not self._client and self.clock() >= self._next_try:
            self._connect()

    def has_feedback(self, point_id: str) -> bool:
        return bool((self.points.get(point_id, {}).get("binding") or {}).get("state"))

    def write(self, point_id: str, value) -> None:
        point, value = self.point_for_write(point_id, value)
        command = (point.get("binding") or {}).get("command")
        if not command:
            raise AdapterError(f"The profile has no command for {point.get('name') or point_id}.", "not-writable")
        if not self._client:
            raise AdapterError("The broker isn't connected.", "offline")
        if point["type"] == "boolean":
            text = str(command.get("on", "ON") if value else command.get("off", "OFF"))
        elif point["type"] == "enum":
            text = str((command.get("values") or {}).get(value, value))
        else:
            number = (value - command.get("offset", 0)) / (command.get("scale", 1) or 1)
            text = str(int(number)) if float(number).is_integer() else str(round(number, 6))
        if command.get("json"):
            text = json.dumps({command["json"]: json.loads(text) if point["type"] == "number" else text})
        try:
            self._client.publish(fill(command["topic"], self.settings), text, qos=1, retain=bool(command.get("retain")))
        except MqttError as error:
            raise AdapterError(str(error), error.reason) from None

    def stop(self) -> None:
        if self._client:
            self._client.on_disconnect = None
            self._client.close()
            self._client = None
        self._set_state("stopped")
