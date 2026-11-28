"""CRC-16 variants used by the motor protocols."""
from __future__ import annotations


def _table(poly: int) -> list[int]:
    table = []
    for byte in range(256):
        crc = byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ poly) if crc & 0x8000 else (crc << 1)
        table.append(crc & 0xFFFF)
    return table


_DXL_TABLE = _table(0x8005)
_XMODEM_TABLE = _table(0x1021)


def _crc(table: list[int], data: bytes, crc: int = 0) -> int:
    for byte in data:
        crc = ((crc << 8) ^ table[((crc >> 8) ^ byte) & 0xFF]) & 0xFFFF
    return crc


def crc16_dynamixel(data: bytes) -> int:
    """Robotis e-Manual, Protocol 2.0, section 2.7 "CRC" and the linked "CRC
    Calculation" page: polynomial 0x8005, initial value 0, MSB first, no final
    XOR, over the header through the last parameter."""
    return _crc(_DXL_TABLE, data)


def crc16_xmodem(data: bytes) -> int:
    """CRC-16/XMODEM (polynomial 0x1021, initial value 0): crc16() in the VESC
    firmware's crc.c, which comm/packet.c runs over the payload only."""
    return _crc(_XMODEM_TABLE, data)
