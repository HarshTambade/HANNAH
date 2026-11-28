"""Motor controller drivers for real hardware protocols.

Every driver here implements MotorControllerAdapter (motors/base.py) and sits
behind MotorControllerManager, which keeps doing the ramping, limit checks and
watchdog. The drivers have been tested against byte vectors from the public
protocol documents and against fake transports only. None has been run on a
real motor controller.
"""
