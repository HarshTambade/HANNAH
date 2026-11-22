"""Simulated devices that speak real protocols over real sockets.

A room with a thermometer, a fan and a dimmable lamp, each an MQTT client of
its own; and a power meter with a relay on Modbus TCP. The room has a little
physics so that switching the fan changes what the thermometer reports.

SIMULATION. These are not models of any product.
"""
from __future__ import annotations

import json
import queue
import threading
import time

from ..mqtt import MqttClient
from .modbus_server import ModbusServer


class Room:
    """Temperature drifts towards `outside` plus what the heat source adds; a running fan pulls it down."""

    def __init__(self, temperature: float = 24.0, outside: float = 24.0, heat: float = 0.0):
        self.temperature, self.outside, self.heat = temperature, outside, heat
        self.fan = False
        self.lamp = False
        self.brightness = 60
        self.daylight = 300.0

    def step(self, seconds: float) -> None:
        target = self.outside + self.heat - (6.0 if self.fan else 0.0)
        self.temperature += (target - self.temperature) * min(1.0, seconds / 20.0)

    @property
    def lux(self) -> float:
        return round(self.daylight + (self.brightness * 4.0 if self.lamp else 0.0), 1)


class MqttRoom:
    """The room's devices on an MQTT broker. Topics: sim/thermo/*, sim/fan/*, sim/lamp/*."""

    def __init__(self, host: str, port: int, room: Room | None = None, period: float = 1.0, speed: float = 1.0, username: str | None = None, password: str | None = None):
        self.room = room or Room()
        self.period, self.speed = period, speed
        self._running = True
        connect = lambda name, on_message=None, will=None: MqttClient(host, port, client_id=name, username=username, password=password, on_message=on_message, will=will, timeout=3.0)
        self.thermo = connect("sim-thermo", will={"topic": "sim/thermo/status", "payload": "offline", "retain": True})
        self.fan = connect("sim-fan", self._fan_command, {"topic": "sim/fan/status", "payload": "offline", "retain": True})
        self.lamp = connect("sim-lamp", self._lamp_command, {"topic": "sim/lamp/status", "payload": "offline", "retain": True})
        for client, name in ((self.thermo, "thermo"), (self.fan, "fan"), (self.lamp, "lamp")):
            client.connect()
            client.publish(f"sim/{name}/status", "online", qos=1, retain=True)
        self.fan.subscribe(["sim/fan/set"])
        self.lamp.subscribe(["sim/lamp/set", "sim/lamp/brightness/set"])
        # Message callbacks run on each MQTT socket reader. Publishing QoS 1
        # from there would wait for a PUBACK that the same reader must consume.
        # Keep device replies on a separate worker so the reader can keep ACKing.
        self._outgoing: queue.Queue = queue.Queue()
        self._publisher = threading.Thread(target=self._publish_loop, name="sim-mqtt-publisher", daemon=True)
        self._publisher.start()
        self._publish_fan()
        self._publish_lamp()
        self.thermo_muted = False
        self.fan_stuck = False
        threading.Thread(target=self._loop, name="sim-room", daemon=True).start()

    def _fan_command(self, _topic: str, payload: bytes, _retained: bool) -> None:
        text = payload.decode("utf-8", "replace").strip()
        if text in ("ON", "OFF") and not self.fan_stuck:
            self.room.fan = text == "ON"
            self._outgoing.put((self.fan, "sim/fan/state", text))

    def _lamp_command(self, topic: str, payload: bytes, _retained: bool) -> None:
        text = payload.decode("utf-8", "replace").strip()
        if topic.endswith("brightness/set"):
            if text.isdigit() and 0 <= int(text) <= 100:
                self.room.brightness = int(text)
                reply = json.dumps({"state": "ON" if self.room.lamp else "OFF", "brightness": self.room.brightness})
                self._outgoing.put((self.lamp, "sim/lamp/state", reply))
        elif text in ("ON", "OFF"):
            self.room.lamp = text == "ON"
            reply = json.dumps({"state": "ON" if self.room.lamp else "OFF", "brightness": self.room.brightness})
            self._outgoing.put((self.lamp, "sim/lamp/state", reply))

    def _publish_loop(self) -> None:
        while self._running:
            message = self._outgoing.get()
            if message is None:
                return
            client, topic, payload = message
            try:
                client.publish(topic, payload, qos=1, retain=True)
            except Exception:
                # The simulation should keep accepting commands after a dropped
                # broker connection; the test owner observes the missing state.
                continue

    def _publish_fan(self) -> None:
        self.fan.publish("sim/fan/state", "ON" if self.room.fan else "OFF", qos=1, retain=True)

    def _publish_lamp(self) -> None:
        self.lamp.publish("sim/lamp/state", json.dumps({"state": "ON" if self.room.lamp else "OFF", "brightness": self.room.brightness}), qos=1, retain=True)

    def _loop(self) -> None:
        while self._running:
            self.room.step(self.period * self.speed)
            if not self.thermo_muted and self.thermo.connected:
                try:
                    self.thermo.publish("sim/thermo/reading", json.dumps({"temperature": round(self.room.temperature, 2), "humidity": 48.0, "lux": self.room.lux}))
                except Exception:
                    pass
            time.sleep(self.period)

    def close(self) -> None:
        self._running = False
        self._outgoing.put(None)
        self._publisher.join(timeout=2.0)
        for client in (self.thermo, self.fan, self.lamp):
            client.close()


class ModbusMeter:
    """A power meter with a load relay. Input 0: volts x10. Input 1-2: watts (uint32). Holding 0: limit in watts. Coil 0: relay."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0, unit: int = 1):
        self.server = ModbusServer(host, port, unit)
        self.server.input.update({0: 2304, 1: 0, 2: 0})
        self.server.holding.update({0: 1500})
        self.server.coils.update({0: False})
        self.server.on_write = self._wrote
        self.load_watts = 840
        self.host, self.port = self.server.host, self.server.port

    def _wrote(self, table: str, address: int, value) -> None:
        if table == "coil" and address == 0:
            watts = self.load_watts if value else 0
            self.server.input[1], self.server.input[2] = watts >> 16, watts & 0xFFFF

    def close(self) -> None:
        self.server.close()
