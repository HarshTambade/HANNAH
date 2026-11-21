"""UNIT and LOOPBACK tests: the MQTT codec, and the client against HANNAH's own test broker over real sockets.

This is not a test against Mosquitto or any device. See test_interop in the
server suite for the client against an independent broker.
"""
import threading
import time
import unittest

from hannah_edge import wire_mqtt as wire
from hannah_edge.mqtt import MqttClient, MqttError
from hannah_edge.sim.broker import Broker


def wait(check, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if check():
            return True
        time.sleep(0.02)
    return False


class Codec(unittest.TestCase):
    def test_known_bytes(self):
        # Worked examples from the standard's own layout.
        self.assertEqual(wire.pingreq(), b"\xc0\x00")
        self.assertEqual(wire.disconnect(), b"\xe0\x00")
        self.assertEqual(wire.publish("a/b", b"hi"), b"\x30\x07\x00\x03a/bhi")
        self.assertEqual(wire.publish("a/b", b"hi", qos=1, packet_id=10, retain=True), b"\x33\x09\x00\x03a/b\x00\x0ahi")
        self.assertEqual(wire.subscribe(1, [("a/#", 1)]), b"\x82\x08\x00\x01\x00\x03a/#\x01")
        self.assertEqual(wire.connect("c", keepalive=60), b"\x10\x0d\x00\x04MQTT\x04\x02\x00\x3c\x00\x01c")

    def test_remaining_length_boundaries(self):
        for size in (0, 127, 128, 16383, 16384, 2097151, 2097152):
            packet = wire.publish("t", b"x" * size)
            reader = wire.Reader()
            (kind, flags, body), = reader.feed(packet)
            self.assertEqual(kind, wire.PUBLISH)
            self.assertEqual(len(wire.parse_publish(flags, body)["payload"]), size)

    def test_packets_split_across_reads(self):
        stream = wire.publish("room/temp", b"21.5") + wire.pingresp() + wire.publish("x", b"y", qos=1, packet_id=7)
        reader, seen = wire.Reader(), []
        for index in range(len(stream)):
            seen += reader.feed(stream[index:index + 1])
        self.assertEqual([item[0] for item in seen], [wire.PUBLISH, wire.PINGRESP, wire.PUBLISH])
        self.assertEqual(wire.parse_publish(seen[2][1], seen[2][2])["packetId"], 7)

    def test_connect_round_trip(self):
        packet = wire.connect("hub-1", 30, "asha", "s3cret", will={"topic": "hub/state", "payload": "gone", "retain": True})
        (kind, _flags, body), = wire.Reader().feed(packet)
        hello = wire.parse_connect(body)
        self.assertEqual((kind, hello["clientId"], hello["username"], hello["password"], hello["keepalive"]), (wire.CONNECT, "hub-1", "asha", "s3cret", 30))
        self.assertEqual(hello["will"], {"topic": "hub/state", "payload": b"gone", "qos": 0, "retain": True})

    def test_refuses_what_it_cannot_do(self):
        with self.assertRaises(wire.WireError):
            wire.publish("a/+", b"x")
        with self.assertRaises(wire.WireError):
            wire.publish("a", b"x", qos=2)
        with self.assertRaises(wire.WireError):
            wire.connect("c", password="p")
        with self.assertRaises(wire.WireError):
            wire.Reader().feed(b"\x30\xff\xff\xff\xff\x01")
        with self.assertRaises(wire.WireError):
            wire.parse_publish(0, b"\x00\x09ab")

    def test_topic_matching(self):
        yes = [("a/b", "a/b"), ("a/+", "a/b"), ("a/#", "a/b/c"), ("a/#", "a"), ("#", "a/b"), ("+/+", "a/b"), ("a/+/c", "a/b/c"), ("$SYS/#", "$SYS/x")]
        no = [("a/b", "a/c"), ("a/+", "a/b/c"), ("a/+", "a"), ("#", "$SYS/x"), ("+/x", "$SYS/x"), ("a/b/c", "a/b")]
        for pattern, topic in yes:
            self.assertTrue(wire.matches(pattern, topic), (pattern, topic))
        for pattern, topic in no:
            self.assertFalse(wire.matches(pattern, topic), (pattern, topic))
        self.assertFalse(wire.valid_filter("a/#/b"))
        self.assertFalse(wire.valid_filter("a/b+"))
        self.assertTrue(wire.valid_filter("+/a/#"))


class ClientAndBroker(unittest.TestCase):
    def setUp(self):
        self.broker = Broker()
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.close()
        self.broker.close()

    def client(self, name, **extra):
        made = MqttClient(self.broker.host, self.broker.port, client_id=name, timeout=2.0, **extra)
        self.clients.append(made)
        return made

    def test_publish_subscribe_retained_and_qos1(self):
        got = []
        listener = self.client("listener", on_message=lambda topic, payload, retained: got.append((topic, payload, retained)))
        speaker = self.client("speaker")
        speaker.connect()
        speaker.publish("room/lamp/state", "ON", qos=1, retain=True)
        listener.connect()
        listener.subscribe(["room/+/state", "room/temp"])
        self.assertTrue(wait(lambda: got == [("room/lamp/state", b"ON", True)]), got)
        speaker.publish("room/temp", b"21.5")
        speaker.publish("elsewhere/temp", b"3")
        self.assertTrue(wait(lambda: len(got) == 2), got)
        self.assertEqual(got[1], ("room/temp", b"21.5", False))

    def test_wrong_password_is_named(self):
        self.broker._users = {"asha": "right"}
        with self.assertRaises(MqttError) as raised:
            self.client("x", username="asha", password="wrong").connect()
        self.assertEqual(raised.exception.reason, "auth")
        self.assertIn("wrong user name or password", str(raised.exception))
        self.client("y", username="asha", password="right").connect()

    def test_unreachable_and_not_mqtt(self):
        with self.assertRaises(MqttError) as raised:
            MqttClient("127.0.0.1", 1, timeout=1.0).connect()
        self.assertEqual(raised.exception.reason, "unreachable")
        import socket
        silent = socket.socket()
        silent.bind(("127.0.0.1", 0))
        silent.listen(1)
        try:
            with self.assertRaises(MqttError) as raised:
                MqttClient("127.0.0.1", silent.getsockname()[1], timeout=0.6).connect()
            self.assertEqual(raised.exception.reason, "no-connack")
        finally:
            silent.close()

    def test_a_plain_connection_to_a_public_address_is_refused_before_any_packet(self):
        with self.assertRaises(MqttError) as raised:
            MqttClient("8.8.8.8", 1883, timeout=0.5).connect()
        self.assertEqual(raised.exception.reason, "insecure")

    def test_dropped_connection_is_noticed(self):
        dropped = threading.Event()
        device = self.client("dev-1", on_disconnect=dropped.set)
        device.connect()
        self.broker.drop_clients("dev-1")
        self.assertTrue(dropped.wait(3.0))
        self.assertFalse(device.connected)
        with self.assertRaises(MqttError):
            device.publish("a", "b")

    def test_the_test_broker_sends_a_last_will_only_after_an_unclean_end(self):
        import socket
        got = []
        watcher = self.client("watcher", on_message=lambda topic, payload, retained: got.append((topic, payload)))
        watcher.connect()
        watcher.subscribe(["dev/+/status"])
        for name, clean in (("polite", True), ("rude", False)):
            raw = socket.create_connection((self.broker.host, self.broker.port))
            raw.sendall(wire.connect(name, will={"topic": f"dev/{name}/status", "payload": "offline"}))
            raw.recv(16)
            if clean:
                raw.sendall(wire.disconnect())
            raw.close()
        self.assertTrue(wait(lambda: got == [("dev/rude/status", b"offline")]), got)
        time.sleep(0.2)
        self.assertEqual(got, [("dev/rude/status", b"offline")])

    def test_keepalive_pings_keep_a_quiet_connection_open(self):
        quiet = self.client("quiet", keepalive=1)
        quiet.connect()
        time.sleep(1.6)
        self.assertTrue(quiet.connected)
        quiet.publish("still/here", "yes", qos=1)


if __name__ == "__main__":
    unittest.main()
