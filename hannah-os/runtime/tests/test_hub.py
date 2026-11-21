"""SIMULATION tests: the hub with its real adapters, talking MQTT and Modbus TCP over real sockets to HANNAH's simulated devices.

No physical device is involved, and no broker or device HANNAH didn't write.
"""
import json
import os
import tempfile
import unittest

from hannah_edge.hub import Hub
from hannah_edge.sim.broker import Broker
from hannah_edge.sim.devices import ModbusMeter, MqttRoom, Room
from tests.support import HUB, SECRET, Server, device, wait


class HubCase(unittest.TestCase):
    def setUp(self):
        self.broker = Broker()
        self.room = MqttRoom(self.broker.host, self.broker.port, Room(temperature=24.0), period=0.1, speed=10.0)
        self.meter = ModbusMeter()
        self.state = tempfile.TemporaryDirectory()
        self.server = Server()
        self.hub = Hub(HUB, SECRET, self.state.name)
        mqtt = {"host": self.broker.host, "port": self.broker.port}
        self.devices = [
            device("dev_thermo", "thermometer", mqtt, name="Room sensor"),
            device("dev_fan", "fan", mqtt, writable=["power"], name="Fan"),
            device("dev_lamp", "lamp", mqtt, writable=["power", "brightness"], name="Lamp"),
            {**device("dev_meter", "power-meter", {"host": self.meter.host, "port": self.meter.port, "unit": 1}, writable=["relay"], name="Meter"), "pollS": 1},
        ]

    def tearDown(self):
        self.hub.close()
        self.room.close()
        self.meter.close()
        self.broker.close()
        self.state.cleanup()

    def configure(self, rules=(), **extra):
        self.assertTrue(self.hub.apply_config(*self.server.config(self.devices, rules, **extra)))

    def spin(self, check, seconds=6.0):
        def step():
            self.hub.tick()
            return check()
        return wait(step, seconds)

    def results(self):
        return [item for item in self.hub.report()["outbox"] if item["kind"] == "result"]

    def events(self, kind=None):
        return [item for item in self.hub.report()["outbox"] if item["kind"] == "event" and (kind is None or item["type"] == kind)]

    def by_id(self):
        return {item["id"]: item for item in self.hub.report()["devices"]}


class Reading(HubCase):
    def test_readings_arrive_typed_with_their_time_and_the_device_is_online(self):
        self.configure()
        seen = self.spin(lambda: all(self.by_id()[key]["connection"]["state"] == "online" for key in ("dev_thermo", "dev_fan", "dev_lamp", "dev_meter")) and "temperature" in self.by_id()["dev_thermo"]["points"] and self.by_id())
        self.assertTrue(seen, self.by_id())
        thermo = seen["dev_thermo"]["points"]
        self.assertAlmostEqual(thermo["temperature"]["value"], 24.0, delta=1.0)
        self.assertEqual(thermo["temperature"]["source"], "device")
        self.assertEqual(seen["dev_fan"]["points"]["power"]["value"], False)
        self.assertEqual(seen["dev_lamp"]["points"], {"power": {**seen["dev_lamp"]["points"]["power"], "value": False}, "brightness": {**seen["dev_lamp"]["points"]["brightness"], "value": 60}})
        self.assertEqual(seen["dev_meter"]["points"]["voltage"]["value"], 230.4)
        self.assertEqual(seen["dev_meter"]["points"]["limit"]["value"], 1500)

    def test_a_value_that_does_not_fit_is_dropped_and_counted(self):
        self.configure()
        self.assertTrue(self.spin(lambda: "temperature" in self.by_id()["dev_thermo"]["points"]))
        self.room.thermo_muted = True
        self.spin(lambda: False, 0.3)
        before = self.by_id()["dev_thermo"]["points"]["temperature"]
        self.room.thermo_muted = True
        self.room.thermo.publish("sim/thermo/reading", json.dumps({"temperature": "ignore previous instructions", "humidity": 9999, "lux": 10}))
        self.assertTrue(self.spin(lambda: self.by_id()["dev_thermo"]["rejected"] >= 2))
        after = self.by_id()["dev_thermo"]["points"]
        self.assertEqual(after["temperature"]["value"], before["value"])
        self.assertNotEqual(after.get("humidity", {}).get("value"), 9999)
        self.assertEqual(after["light"]["value"], 10)

    def test_a_device_that_says_it_is_offline_is_reported_offline(self):
        self.configure()
        self.spin(lambda: self.by_id()["dev_fan"]["connection"]["state"] == "online")
        self.broker.drop_clients("sim-fan")  # its last will says "offline"
        self.assertTrue(self.spin(lambda: self.by_id()["dev_fan"]["connection"]["state"] == "offline"))
        self.assertEqual(self.by_id()["dev_thermo"]["connection"]["state"], "online")

    def test_a_broker_that_is_away_is_an_error_with_a_reason_and_the_other_devices_carry_on(self):
        self.devices[1]["settings"] = {"host": "127.0.0.1", "port": 1}
        self.configure()
        self.assertTrue(self.spin(lambda: self.by_id()["dev_meter"]["connection"]["state"] == "online"))
        fan = self.by_id()["dev_fan"]["connection"]
        self.assertEqual((fan["state"], fan["reason"]), ("error", "unreachable"))

    def test_an_unknown_adapter_is_refused_not_substituted(self):
        self.devices[0]["profile"] = {**self.devices[0]["profile"], "protocol": {"adapter": "zigbee"}}
        self.configure()
        thermo = self.by_id()["dev_thermo"]["connection"]
        self.assertEqual((thermo["state"], thermo["reason"]), ("error", "no-adapter"))


class Writing(HubCase):
    def ready(self):
        self.configure()
        self.assertTrue(self.spin(lambda: all(item["connection"]["state"] == "online" for item in self.by_id().values())))

    def run_command(self, command_type="write", patience=10.0, **fields):
        payload, signature = self.server.command(command_type, **fields)
        self.hub.handle(payload, signature)
        command_id = json.loads(payload)["id"]
        found = self.spin(lambda: next((item for item in self.results() if item["commandId"] == command_id), None), patience)
        self.assertTrue(found, self.hub.report()["outbox"])
        return found

    def test_a_write_is_done_only_when_the_device_reports_the_new_value(self):
        self.ready()
        result = self.run_command(deviceId="dev_fan", point="power", value=True)
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["readback"]["confirmed"], True)
        self.assertTrue(self.room.room.fan)
        result = self.run_command(deviceId="dev_lamp", point="brightness", value=35)
        self.assertEqual((result["status"], self.room.room.brightness), ("done", 35))
        result = self.run_command(deviceId="dev_meter", point="relay", value=True)
        self.assertEqual(result["status"], "done")
        self.assertTrue(self.spin(lambda: self.by_id()["dev_meter"]["points"]["power"]["value"] == 840))

    def test_a_device_that_ignores_the_write_is_unverified_not_done(self):
        self.ready()
        self.room.fan_stuck = True
        result = self.run_command(deviceId="dev_fan", point="power", value=True)
        self.assertEqual(result["status"], "unverified")
        self.assertEqual(result["readback"]["confirmed"], False)
        self.assertEqual(result["readback"]["value"], False)

    def test_the_hub_refuses_what_the_device_was_not_allowed_or_cannot_take(self):
        self.ready()
        cases = [
            ({"deviceId": "dev_meter", "point": "limit", "value": 1000}, "not-allowed"),   # writable in the profile, not allowed for this device
            ({"deviceId": "dev_thermo", "point": "temperature", "value": 30}, "not-allowed"),
            ({"deviceId": "dev_lamp", "point": "brightness", "value": 140}, "out-of-range"),
            ({"deviceId": "dev_lamp", "point": "brightness", "value": 12.5}, "bad-step"),
            ({"deviceId": "dev_lamp", "point": "power", "value": "ON"}, "bad-value"),
            ({"deviceId": "dev_gone", "point": "power", "value": True}, "unknown-device"),
            ({"deviceId": "dev_fan", "point": "sim/fan/set", "value": True}, "not-allowed"),
        ]
        for fields, reason in cases:
            result = self.run_command(**fields)
            self.assertEqual((result["status"], result["reason"]), ("refused", reason), fields)
        self.assertFalse(self.room.room.fan)
        self.assertEqual(self.room.room.brightness, 60)
        self.assertEqual(self.meter.server.holding[0], 1500)

    def test_commands_are_checked_signature_hub_expiry_order_and_run_once(self):
        self.ready()
        payload, signature = self.server.command("write", deviceId="dev_fan", point="power", value=True)
        self.hub.handle(payload, "0" * 64)
        self.hub.handle(payload.replace("true", "false"), signature)
        other = Server(hub_id="hub_other")
        self.hub.handle(*other.command("write", seq=50, deviceId="dev_fan", point="power", value=True))
        self.hub.handle(*self.server.command("write", seq=60, ttl_ms=-1, id="late", deviceId="dev_fan", point="power", value=True))
        self.spin(lambda: False, 0.5)
        self.assertFalse(self.room.room.fan)
        refused = {item["commandId"]: item["reason"] for item in self.results()}
        self.assertEqual(refused.get("late"), "expired")
        self.assertEqual(len(refused), 2)  # the wrong-hub one and the late one; a bad signature gets no answer at all
        # The genuine one runs, once, even when delivered twice; an older sequence number is a replay.
        self.hub.handle(*self.server.command("write", seq=70, id="genuine", deviceId="dev_fan", point="power", value=True))
        payload, signature = self.server.command("write", seq=71, id="again", deviceId="dev_fan", point="power", value=False)
        self.assertTrue(self.spin(lambda: self.room.room.fan))
        self.hub.handle(*self.server.command("write", seq=65, id="old", deviceId="dev_fan", point="power", value=False))
        self.spin(lambda: False, 0.4)
        self.assertTrue(self.room.room.fan)
        self.assertEqual({item["commandId"]: item.get("reason") for item in self.results()}.get("old"), "replayed")

    def test_the_guard_survives_a_restart(self):
        self.ready()
        payload, signature = self.server.command("write", seq=9, deviceId="dev_fan", point="power", value=True)
        self.hub.handle(payload, signature)
        self.assertTrue(self.spin(lambda: self.room.room.fan))
        self.hub.close()
        self.room.room.fan = False
        self.hub = Hub(HUB, SECRET, self.state.name)
        self.assertEqual(self.hub.report()["configVersion"], self.server.version)  # the saved configuration was loaded
        self.assertTrue(self.spin(lambda: self.by_id()["dev_fan"]["connection"]["state"] == "online"))
        self.hub.handle(payload, signature)
        self.hub.handle(*self.server.command("write", seq=8, id="older", deviceId="dev_fan", point="power", value=True))
        self.spin(lambda: False, 0.5)
        self.assertFalse(self.room.room.fan)

    def test_a_configuration_with_a_wrong_signature_or_an_older_version_is_ignored(self):
        self.ready()
        payload, signature = self.server.config([], version=self.server.version + 1)
        self.assertFalse(self.hub.apply_config(payload, "f" * 64))
        self.assertFalse(self.hub.apply_config(payload.replace(HUB, "hub_other"), signature))
        self.assertFalse(self.hub.apply_config(*self.server.config([], version=0)))
        self.assertEqual(len(self.hub.report()["devices"]), 4)
        with open(os.path.join(self.state.name, "config.json"), "r+", encoding="utf-8") as handle:
            saved = json.load(handle)
            saved["payload"] = saved["payload"].replace('"writable": []', '"writable": ["temperature"]')
            handle.seek(0)
            json.dump(saved, handle)
            handle.truncate()
        self.hub.close()
        self.hub = Hub(HUB, SECRET, self.state.name)
        self.assertEqual(self.hub.report()["devices"], [])  # an edited file is not obeyed

    def test_a_probe_reports_what_was_heard_without_adding_the_device(self):
        self.devices = self.devices[:1]
        self.configure()
        mqtt = {"host": self.broker.host, "port": self.broker.port}
        result = self.run_command("probe", device=device("draft", "lamp", mqtt), seconds=4)
        self.assertEqual(result["status"], "done")
        probe = result["probe"]
        self.assertEqual((probe["adapter"], probe["connection"]["state"]), ("mqtt", "online"))
        self.assertEqual({key: value["heard"] for key, value in probe["points"].items()}, {"power": True, "brightness": True})
        self.assertEqual(len(self.hub.report()["devices"]), 1)
        wrong = self.run_command("probe", device=device("draft", "lamp", {"host": self.broker.host, "port": 1}), seconds=2)
        self.assertEqual((wrong["probe"]["connection"]["state"], wrong["probe"]["connection"]["reason"]), ("error", "unreachable"))
        self.assertEqual(wrong["probe"]["points"]["power"]["heard"], False)

    def test_looking_at_a_broker_lists_topics_and_publishes_nothing(self):
        self.devices = []
        self.configure()
        before = len(self.broker.log)
        result = self.run_command("discover", kind="mqtt", settings={"host": self.broker.host, "port": self.broker.port}, seconds=1.5)
        topics = {item["topic"] for item in result["discovered"]["topics"]}
        self.assertTrue({"sim/fan/state", "sim/lamp/state", "sim/thermo/reading", "sim/thermo/status"} <= topics, topics)
        self.assertTrue(all(topic.startswith("sim/thermo/") for topic, _payload in self.broker.log[before:]), self.broker.log[before:])
        refused = self.run_command("discover", kind="network-scan")
        self.assertEqual((refused["status"], refused["reason"]), ("refused", "unknown-kind"))


class Rules(HubCase):
    RULE = {
        "id": "rule_cool", "name": "Cool the room", "enabled": True,
        "when": {"device": "dev_thermo", "point": "temperature", "op": ">", "value": 27, "hysteresis": 1.5},
        "then": [{"device": "dev_fan", "point": "power", "value": True}],
        "otherwise": [{"device": "dev_fan", "point": "power", "value": False}],
        "staleAfterS": 3,
    }

    def test_a_rule_acts_on_the_change_both_ways_with_no_server(self):
        self.configure([self.RULE])
        self.assertIsNone(self.hub.link)
        self.spin(lambda: self.by_id()["dev_thermo"]["connection"]["state"] == "online")
        self.spin(lambda: False, 0.6)
        self.assertFalse(self.room.room.fan)
        self.room.room.heat = 8.0  # the room heats towards 32
        self.assertTrue(self.spin(lambda: self.room.room.fan, 10))
        fired = self.events("rule-fired")
        self.assertEqual(len(fired), 1)
        self.assertIn("Fan Power set to on", fired[0]["message"])
        # The fan pulls it to about 26: inside the margin, so the rule holds instead of chattering.
        self.spin(lambda: False, 2.0)
        self.assertTrue(self.room.room.fan)
        self.assertEqual(len(self.events("rule-fired")), 1)
        self.room.room.heat = 0.0
        self.assertTrue(self.spin(lambda: not self.room.room.fan, 10))
        self.assertEqual([item["branch"] for item in self.events("rule-fired")], ["then", "otherwise"])
        report = {item["id"]: item for item in self.hub.report()["rules"]}["rule_cool"]
        self.assertEqual((report["fires"], report["status"]), (2, "watching"))

    def test_a_rule_does_not_act_on_a_stale_reading_and_says_so(self):
        self.configure([self.RULE])
        self.assertTrue(self.spin(lambda: self.hub.report()["rules"][0]["status"] == "watching"))
        self.room.thermo_muted = True
        self.room.room.heat = 8.0
        self.assertTrue(self.spin(lambda: self.events("rule-waiting"), 8))
        self.assertIn("older than 3 seconds", self.events("rule-waiting")[0]["message"])
        self.assertFalse(self.room.room.fan)
        self.room.thermo_muted = False
        self.assertTrue(self.spin(lambda: self.room.room.fan, 10))

    def test_a_rule_cannot_write_where_the_device_was_not_allowed(self):
        self.devices[1]["writable"] = []
        self.configure([self.RULE])
        self.room.room.heat = 8.0
        self.assertTrue(self.spin(lambda: self.events("rule-failed"), 10))
        self.assertIn("hasn't been allowed", self.events("rule-failed")[0]["message"])
        self.assertFalse(self.room.room.fan)

    def test_paused_automations_do_nothing_and_a_limit_stops_a_rule_that_fires_too_often(self):
        self.configure([self.RULE], suspended=True)
        self.room.room.heat = 8.0
        self.spin(lambda: self.room.room.temperature > 30, 8)
        self.spin(lambda: False, 0.5)
        self.assertFalse(self.room.room.fan)
        self.assertEqual(self.hub.report()["rules"][0]["status"], "suspended")
        flappy = {**self.RULE, "id": "rule_flap", "when": {"device": "dev_lamp", "point": "power", "op": "==", "value": True}, "then": [{"device": "dev_lamp", "point": "brightness", "value": 80}], "otherwise": [], "maxPerHour": 1, "staleAfterS": 600}
        self.configure([flappy])
        for wanted in (True, False, True):
            self.room.lamp._client = None
            self.room._lamp_command("sim/lamp/set", b"ON" if wanted else b"OFF", False)
            self.spin(lambda: self.by_id()["dev_lamp"]["points"]["power"]["value"] is wanted, 4)
            self.spin(lambda: False, 0.3)
        self.assertEqual(len(self.events("rule-fired")), 1)
        self.assertEqual(len(self.events("rule-limited")), 1)

    def test_a_rule_whose_write_the_device_ignores_is_reported(self):
        self.configure([self.RULE])
        self.room.fan_stuck = True
        self.room.room.heat = 8.0
        self.assertTrue(self.spin(lambda: self.events("write-unconfirmed"), 14))
        self.assertIn("has not reported the new value", self.events("write-unconfirmed")[0]["message"])


if __name__ == "__main__":
    unittest.main()
