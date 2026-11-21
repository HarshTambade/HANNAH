"""UNIT and LOOPBACK tests: Modbus TCP frames and number formats, and the client against HANNAH's own test server.

Not a test against any real device or a vendor's simulator.
"""
import struct
import unittest

from hannah_edge import modbus
from hannah_edge.modbus import ModbusClient, ModbusError
from hannah_edge.sim.modbus_server import ModbusServer


class Frames(unittest.TestCase):
    def test_request_bytes_match_the_standard_example(self):
        # Read holding registers 108..110 (address 0x006B, 3 registers) from unit 17: PDU 03 00 6B 00 03.
        self.assertEqual(modbus.request(1, 17, 3, struct.pack(">HH", 0x006B, 3)), bytes.fromhex("000100000006" "11" "03" "006B0003"))

    def test_number_formats_round_trip_in_both_word_orders(self):
        cases = [("uint16", 65535), ("int16", -2), ("uint32", 4_000_000_000), ("int32", -123456), ("float32", 21.5)]
        for kind, value in cases:
            for order in ("big", "little"):
                self.assertEqual(modbus.number_of(modbus.words_of(value, kind, order), kind, order), value, (kind, order))
        self.assertEqual(modbus.words_of(0x12345678, "uint32", "big"), [0x1234, 0x5678])
        self.assertEqual(modbus.words_of(0x12345678, "uint32", "little"), [0x5678, 0x1234])
        self.assertEqual(modbus.words_of(21.5, "float32"), [0x41AC, 0x0000])
        with self.assertRaises(ModbusError):
            modbus.number_of([1], "float32")


class ClientAndServer(unittest.TestCase):
    def setUp(self):
        self.server = ModbusServer(unit=3)
        self.server.holding.update({0: 215, 1: 0x41AC, 2: 0, 10: 50})
        self.server.input.update({0: 2301})
        self.server.coils.update({0: False, 1: True})
        self.server.discrete.update({4: True})
        self.server.read_only_holding.add(0)
        self.client = ModbusClient(self.server.host, self.server.port, unit=3, timeout=1.5)
        self.client.connect()

    def tearDown(self):
        self.client.close()
        self.server.close()

    def test_reads_every_table(self):
        self.assertEqual(self.client.read("holding", 0, 3), [215, 0x41AC, 0])
        self.assertEqual(self.client.read("input", 0), [2301])
        self.assertEqual(self.client.read("coil", 0, 2), [False, True])
        self.assertEqual(self.client.read("discrete", 4), [True])
        self.assertEqual(modbus.number_of(self.client.read("holding", 1, 2), "float32"), 21.5)

    def test_writes_and_reads_back(self):
        self.client.write_coil(0, True)
        self.assertEqual(self.client.read("coil", 0), [True])
        self.client.write_registers(10, [65])
        self.assertEqual(self.client.read("holding", 10), [65])
        self.client.write_registers(1, modbus.words_of(19.25, "float32"))
        self.assertEqual(modbus.number_of(self.client.read("holding", 1, 2), "float32"), 19.25)

    def test_exceptions_are_named(self):
        with self.assertRaises(ModbusError) as raised:
            self.client.read("holding", 500)
        self.assertEqual((raised.exception.reason, raised.exception.code), ("exception", 2))
        self.assertIn("nothing at this address", str(raised.exception))
        with self.assertRaises(ModbusError) as raised:
            self.client.write_registers(0, [1])
        self.assertEqual(raised.exception.code, 3)
        # The connection is still usable after an exception answer.
        self.assertEqual(self.client.read("input", 0), [2301])

    def test_a_device_that_goes_away_is_reported_not_hung_on(self):
        self.server.close()
        with self.assertRaises(ModbusError) as raised:
            self.client.read("holding", 0)
        self.assertIn(raised.exception.reason, ("disconnected", "timeout"))
        self.assertFalse(self.client.connected)

    def test_refuses_an_address_outside_the_local_network(self):
        with self.assertRaises(ModbusError) as raised:
            ModbusClient("8.8.8.8", 502, timeout=0.5).connect()
        self.assertEqual(raised.exception.reason, "insecure")

    def test_wrong_unit_times_out(self):
        other = ModbusClient(self.server.host, self.server.port, unit=9, timeout=0.5)
        other.connect()
        with self.assertRaises(ModbusError) as raised:
            other.read("holding", 0)
        self.assertEqual(raised.exception.reason, "timeout")
        other.close()


if __name__ == "__main__":
    unittest.main()
