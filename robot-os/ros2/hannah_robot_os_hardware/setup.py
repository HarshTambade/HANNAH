from setuptools import setup

package_name = "hannah_robot_os_hardware"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="HANNAH",
    maintainer_email="dev@hannah.local",
    description="HANNAH Robot OS ros2_control hardware interface skeleton",
    license="Apache-2.0",
)
