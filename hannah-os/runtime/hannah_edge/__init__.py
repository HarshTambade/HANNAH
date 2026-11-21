"""HANNAH Edge: the hub that runs next to your devices.

One process on a computer on the same network as the devices. It talks to them
in their own protocols (MQTT, Modbus TCP, HTTP), keeps their latest readings,
runs the simple rules a person set up, and carries out the few writes HANNAH's
server sends, each one signed, checked again here, and read back.

It opens the connection to HANNAH; nothing connects in. It keeps working, and
its rules keep running, while the internet is away.

Standard library only (Python 3.9+).
"""
__version__ = "0.1.0"
PROTOCOL = "hannah-hub/1"
