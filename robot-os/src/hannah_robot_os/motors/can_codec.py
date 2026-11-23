from __future__ import annotations

CAN_MTU = 8
HEADER_LEN = 4  # channel, sequence, total frames, chunk length
CHUNK_LEN = CAN_MTU - HEADER_LEN


def encode_frames(payload: bytes, channel: int = 0, mtu: int = CAN_MTU) -> list[bytes]:
    """Split a packet into deterministic CAN frames with reassembly metadata."""
    size = max(HEADER_LEN + 1, int(mtu))
    chunk_len = size - HEADER_LEN
    chunks = [payload[i:i + chunk_len] for i in range(0, len(payload), chunk_len)] or [b""]
    if len(chunks) > 255:
        raise ValueError("packet too large for CAN frame sequence")
    frames = []
    for index, chunk in enumerate(chunks):
        frames.append(bytes([channel & 0xFF, index & 0xFF, len(chunks) & 0xFF, len(chunk) & 0xFF]) + chunk.ljust(chunk_len, b"\x00")[:chunk_len])
    return frames


class FrameReassembler:
    def __init__(self, channel: int = 0) -> None:
        self.channel = channel
        self._partial: dict[tuple[int, int], dict[int, bytes]] = {}

    def feed(self, frame: bytes) -> bytes | None:
        """Return the reassembled payload once all frames of a message arrive."""
        if len(frame) < HEADER_LEN:
            return None
        channel, seq, total, length = frame[0], frame[1], frame[2], frame[3]
        if channel != self.channel or total == 0 or seq >= total:
            return None
        key = (channel, total)
        parts = self._partial.setdefault(key, {})
        chunk = frame[HEADER_LEN:HEADER_LEN + min(length, max(0, len(frame) - HEADER_LEN))]
        parts[seq] = chunk[:length]
        if len(parts) < total:
            return None
        self._partial.pop(key, None)
        return b"".join(parts[i] for i in range(total))
