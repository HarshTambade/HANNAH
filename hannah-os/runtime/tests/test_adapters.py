"""UNIT and LOOPBACK tests: what every adapter declares, the shared value checks, the HTTP adapter against a local test server, and `doctor`."""
import json
import os
import stat
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from hannah_edge import adapters
from hannah_edge.__main__ import checks
from hannah_edge.adapters.base import ABOUT_FIELDS, AdapterError, check_value, decode, dig, fill
from hannah_edge.adapters.http_device import HttpDevice
from hannah_edge.protocol import write_private

PLUG = {
    "protocol": {"adapter": "http"},
    "points": [
        {"id": "power", "name": "Power", "kind": "actuator", "type": "boolean", "access": "read-write", "binding": {"state": {"path": "/status", "json": "relay.on"}, "command": {"method": "POST", "path": "/relay/{channel}", "body": {"turn": "{value}"}, "on": "on", "off": "off"}}},
        {"id": "watts", "name": "Power use", "kind": "sensor", "type": "number", "unit": "W", "range": [0, 4000], "access": "read", "binding": {"state": {"path": "/status", "json": "meter.watts"}}},
    ],
}


class Plug(BaseHTTPRequestHandler):
    state = {"on": False, "requests": [], "password": None, "mode": "ok"}

    def log_message(self, *_args):
        pass

    def _send(self, code, body, headers=None):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _handle(self):
        state = Plug.state
        state["requests"].append((self.command, self.path, self.headers.get("Authorization")))
        if state["password"] and self.headers.get("Authorization") != state["password"]:
            return self._send(401, {})
        if state["mode"] == "redirect":
            return self._send(302, {}, {"Location": "http://example.com/steal"})
        if state["mode"] == "html":
            return self._send(200, b"<html>login</html>")
        if state["mode"] == "huge":
            return self._send(200, b"[" + b"1," * 60_000 + b"1]")
        if self.path == "/status":
            return self._send(200, {"relay": {"on": state["on"]}, "meter": {"watts": 61.5 if state["on"] else 0}})
        if self.command == "POST" and self.path == "/relay/0":
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            state["on"] = body.get("turn") == "on"
            return self._send(200, {"ok": True})
        return self._send(404, {})

    do_GET = do_POST = _handle


class Declarations(unittest.TestCase):
    def test_every_adapter_says_what_it_is_and_how_far_it_was_tested(self):
        listed = adapters.about()
        self.assertEqual([item["name"] for item in listed], ["http", "modbus-tcp", "mqtt"])
        for item in listed:
            for field in ABOUT_FIELDS:
                self.assertTrue(isinstance(item.get(field), str) and len(item[field]) > 3, (item["name"], field))
            self.assertIn("Not against any physical device", item["tested"])

    def test_an_adapter_has_no_way_to_address_anything_but_a_listed_point(self):
        for adapter in adapters.ADAPTERS.values():
            public = {name for name in dir(adapter) if not name.startswith("_")}
            self.assertFalse(public & {"publish", "send", "raw", "write_register", "write_topic", "request", "call"}, adapter.NAME)

    def test_value_checks(self):
        level = {"id": "level", "name": "Level", "type": "number", "range": [0, 10], "step": 0.5, "unit": "V"}
        self.assertEqual(check_value(level, 2.5), 2.5)
        for value, reason in ((11, "out-of-range"), (-0.5, "out-of-range"), (2.3, "bad-step"), ("2", "bad-value"), (True, "bad-value"), (float("nan"), "bad-value"), (float("inf"), "bad-value")):
            with self.assertRaises(AdapterError) as raised:
                check_value(level, value)
            self.assertEqual(raised.exception.reason, reason, value)
        with self.assertRaises(AdapterError) as raised:
            check_value({"id": "x", "type": "number"}, 1)
        self.assertEqual(raised.exception.reason, "no-range")
        self.assertEqual(check_value({"id": "m", "type": "enum", "choices": ["eco", "boost"]}, "eco"), "eco")
        with self.assertRaises(AdapterError):
            check_value({"id": "m", "type": "enum", "choices": ["eco", "boost"]}, "turbo")
        with self.assertRaises(AdapterError):
            check_value({"id": "t", "type": "text"}, "anything")

    def test_decoding_rejects_what_does_not_fit_instead_of_coercing(self):
        number = {"type": "number"}
        self.assertEqual(decode(number, "21.5"), (True, 21.5))
        self.assertEqual(decode(number, 215, {"scale": 0.1}), (True, 21.5))
        self.assertEqual(decode(number, "hot"), (False, None))
        self.assertEqual(decode(number, True), (False, None))
        self.assertEqual(decode(number, "nan"), (False, None))
        switch = {"type": "boolean"}
        self.assertEqual(decode(switch, "ON", {"on": "ON", "off": "OFF"}), (True, True))
        self.assertEqual(decode(switch, "on", {"on": "ON", "off": "OFF"}), (False, None))
        self.assertEqual(decode(switch, "1"), (True, True))
        self.assertEqual(decode(switch, "maybe"), (False, None))
        self.assertEqual(decode({"type": "enum", "choices": ["eco"]}, "boost"), (False, None))
        self.assertEqual(dig({"a": [{"b": 3}]}, "a.0.b"), (True, 3))
        self.assertEqual(dig({"a": 1}, "a.b"), (False, None))
        self.assertEqual(fill("tele/{topic}/SENSOR", {"topic": "plug1"}), "tele/plug1/SENSOR")
        with self.assertRaises(AdapterError):
            fill("tele/{topic}/SENSOR", {})


class HttpPlug(unittest.TestCase):
    def setUp(self):
        Plug.state = {"on": False, "requests": [], "password": None, "mode": "ok"}
        self.server = HTTPServer(("127.0.0.1", 0), Plug)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def device(self, **settings):
        return HttpDevice({"id": "d1", "profile": PLUG, "settings": {"url": self.url, "channel": 0, **settings}, "pollS": 1})

    def test_reads_writes_and_reads_back(self):
        plug = self.device()
        plug.start()
        self.assertEqual(plug.connection()["state"], "online")
        self.assertEqual({key: value["value"] for key, value in plug.readings().items()}, {"power": False, "watts": 0})
        plug.write("power", True)
        plug.refresh("power")
        self.assertIs(plug.reading("power")["value"], True)
        self.assertIn(("POST", "/relay/0", None), Plug.state["requests"])
        with self.assertRaises(AdapterError) as raised:
            plug.write("watts", 5)
        self.assertEqual(raised.exception.reason, "not-writable")

    def test_sign_in_and_its_refusal(self):
        Plug.state["password"] = "Basic YXNoYTpvcGVu"  # asha:open
        wrong = self.device(username="asha", password="shut")
        wrong.start()
        self.assertEqual((wrong.connection()["state"], wrong.connection()["reason"]), ("error", "auth"))
        right = self.device(username="asha", password="open")
        right.start()
        self.assertEqual(right.connection()["state"], "online")

    def test_a_device_cannot_send_the_hub_elsewhere_or_flood_it(self):
        for mode, reason in (("redirect", "http-error"), ("html", "not-json"), ("huge", "too-large")):
            Plug.state["mode"] = mode
            plug = self.device()
            plug.start()
            self.assertEqual((plug.connection()["state"], plug.connection()["reason"]), ("error", reason), mode)
        self.assertTrue(all(path in ("/status",) for _method, path, _auth in Plug.state["requests"]))

    def test_refuses_plain_http_to_a_public_address_and_reports_a_device_that_is_away(self):
        public = HttpDevice({"id": "d", "profile": PLUG, "settings": {"url": "http://8.8.8.8", "channel": 0}})
        public.start()
        self.assertEqual(public.connection()["reason"], "insecure")
        away = HttpDevice({"id": "d", "profile": PLUG, "settings": {"url": "http://127.0.0.1:1", "channel": 0}})
        away.start()
        self.assertEqual(away.connection()["reason"], "unreachable")


class Doctor(unittest.TestCase):
    def test_reports_a_readable_key_file_and_an_unencrypted_server(self):
        with tempfile.TemporaryDirectory() as folder:
            os.chmod(folder, 0o700)
            self.assertEqual({name: result for name, result, _detail in checks(folder)}["identity"], "WARN")
            write_private(os.path.join(folder, "identity.json"), json.dumps({"hubId": "hub_1", "secret": "x", "server": "http://127.0.0.1:3000"}))
            found = {name: result for name, result, _detail in checks(folder)}
            self.assertEqual((found["identity"], found["server-address"], found["state-folder"]), ("PASS", "WARN", "PASS"))
            os.chmod(os.path.join(folder, "identity.json"), 0o644)
            os.chmod(folder, 0o755)
            found = {name: result for name, result, _detail in checks(folder)}
            self.assertEqual((found["identity"], found["state-folder"]), ("FAIL", "FAIL"))
            self.assertEqual(stat.S_IMODE(os.stat(folder).st_mode), 0o755, "doctor changes nothing")
        self.assertEqual({name: result for name, result, _detail in checks("/nonexistent/hannah-hub")}["state-folder"], "WARN")


if __name__ == "__main__":
    unittest.main()
