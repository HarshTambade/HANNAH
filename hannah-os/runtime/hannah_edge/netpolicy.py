"""Which addresses a hub may talk to without encryption.

Device protocols on a local network are often unencrypted (MQTT on 1883,
Modbus TCP always). That is acceptable only when the traffic stays on that
network. A plain connection to a public address is refused.
"""
from __future__ import annotations

import ipaddress
import socket


class PolicyError(Exception):
    pass


def is_local(host: str) -> bool:
    """True when every address the name resolves to is loopback, private or link-local."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        raise PolicyError(f"The address {host!r} can't be found on this network.") from None
    addresses = {info[4][0].split("%")[0] for info in infos}
    if not addresses:
        raise PolicyError(f"The address {host!r} can't be found on this network.")
    for text in addresses:
        address = ipaddress.ip_address(text)
        if not (address.is_loopback or address.is_private or address.is_link_local):
            return False
    return True


def require_local_or_tls(host: str, tls: bool, what: str) -> None:
    if not tls and not is_local(host):
        raise PolicyError(f"{what} to {host} would cross the internet unencrypted. Use TLS, or a device on this network.")
