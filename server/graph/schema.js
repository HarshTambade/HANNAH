"use strict";

/**
 * The Device Intelligence Graph's vocabulary: what an entity can be and how
 * two entities may be related.
 *
 * Relationship types are versioned. Every edge records the version of its
 * type that was current when it was written, so a type whose meaning
 * changes (MONITORS v2 lets a robot or sensor watch a whole zone, not only a
 * machine) never silently reinterprets older edges. `changes` says what each
 * version changed. To change a type: bump `version`, add a `changes` entry,
 * keep the old endpoints readable.
 */

const ENTITY_TYPES = {
  user: "Person",
  organization: "Organization",
  workspace: "Workspace",
  robot: "Robot",
  machine: "Machine",
  iot_device: "IoT device",
  hub: "Device hub",
  sensor: "Sensor",
  actuator: "Actuator",
  motor_controller: "Motor controller",
  network: "Network",
  room: "Room",
  zone: "Zone",
  building: "Building",
  warehouse: "Warehouse",
  map: "Map",
  environment: "Environment",
  task: "Task",
  mission: "Mission",
  workflow: "Workflow",
  skill: "Skill",
  maintenance_record: "Maintenance record",
  hardware_component: "Hardware component",
};

const PLACES = ["room", "zone", "building", "warehouse", "environment"];
const EQUIPMENT = ["robot", "machine", "iot_device", "hub", "sensor", "actuator", "motor_controller", "hardware_component"];

const RELATION_TYPES = {
  HAS_SENSOR: { version: 1, from: ["robot", "machine", "iot_device", "hub"], to: ["sensor"], description: "Carries or contains this sensor." },
  HAS_MOTOR: { version: 1, from: ["robot", "machine"], to: ["motor_controller", "actuator"], description: "Is driven by this motor or motor controller." },
  HAS_ACTUATOR: { version: 1, from: ["robot", "machine", "iot_device"], to: ["actuator"], description: "Has this actuator." },
  HAS_COMPONENT: { version: 1, from: ["robot", "machine", "iot_device", "hub"], to: ["hardware_component", "motor_controller", "sensor", "actuator"], description: "Is built with this component." },
  MONITORS: {
    version: 2, from: ["robot", "sensor", "iot_device", "workflow"], to: ["machine", "iot_device", "robot", ...PLACES], description: "Watches this entity or place.",
    changes: [{ version: 1, note: "A robot, sensor or device monitors a machine or device." }, { version: 2, note: "May also monitor a place (room, zone, building, warehouse, environment), and a workflow may monitor." }],
  },
  OPERATES_IN: { version: 1, from: ["robot"], to: [...PLACES, "map"], description: "Works in this place." },
  LOCATED_IN: { version: 1, from: [...EQUIPMENT, ...PLACES], to: PLACES, description: "Is physically in this place." },
  PART_OF: { version: 1, from: [...PLACES, "network"], to: [...PLACES, "organization"], description: "Is part of a larger place." },
  CONTROLS: { version: 1, from: ["hub", "robot", "workflow", "user", "iot_device"], to: ["iot_device", "actuator", "machine", "motor_controller"], description: "Can change the state of this entity." },
  ASSIGNED_TO: { version: 1, from: ["mission", "task", "maintenance_record", "workflow"], to: ["robot", "user"], description: "Is assigned to this robot or person." },
  USES_MAP: { version: 1, from: ["robot", "mission"], to: ["map"], description: "Navigates with this map." },
  CONNECTED_TO: { version: 1, from: ["iot_device", "sensor", "actuator", "robot", "hub", "machine"], to: ["hub", "network"], description: "Reaches HANNAH through this hub or network." },
  HANDLES: { version: 1, from: ["workflow", "skill"], to: [...EQUIPMENT, ...PLACES], description: "Is the approved response for events from this entity." },
  RECORDED_FOR: { version: 1, from: ["maintenance_record"], to: EQUIPMENT, description: "Records maintenance on this equipment." },
  USES_SKILL: { version: 1, from: ["robot", "mission"], to: ["skill"], description: "Uses this skill." },
  MEMBER_OF: { version: 1, from: ["user", "workspace"], to: ["organization", "workspace"], description: "Belongs to this organization or workspace." },
  BELONGS_TO: { version: 1, from: [...EQUIPMENT, "map", "workflow", "mission", ...PLACES], to: ["workspace", "organization"], description: "Is owned by this workspace or organization." },
};

/** Why an edge of this type can't join these two entity types, or null when it can. */
function relationProblem(type, fromType, toType) {
  const rel = RELATION_TYPES[type];
  if (!rel) return `${type} is not a relationship type. Known types: ${Object.keys(RELATION_TYPES).join(", ")}.`;
  if (!rel.from.includes(fromType)) return `${type} can't start at a ${ENTITY_TYPES[fromType] || fromType}; it starts at ${rel.from.join(", ")}.`;
  if (!rel.to.includes(toType)) return `${type} can't end at a ${ENTITY_TYPES[toType] || toType}; it ends at ${rel.to.join(", ")}.`;
  return null;
}

function publicSchema() {
  return {
    entities: Object.entries(ENTITY_TYPES).map(([id, label]) => ({ id, label })),
    relations: Object.entries(RELATION_TYPES).map(([id, rel]) => ({ id, version: rel.version, from: rel.from, to: rel.to, description: rel.description, changes: rel.changes || [{ version: 1, note: "First version." }] })),
  };
}

module.exports = { ENTITY_TYPES, PLACES, RELATION_TYPES, publicSchema, relationProblem };
