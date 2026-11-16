export type EntityType = "person" | "place" | "project" | "event" | "organization" | "topic";

export type Entity = {
  id: string;
  type: EntityType;
  name: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type Relationship = {
  id: string;
  sourceId: string;
  targetId: string;
  type: string; // e.g., "works_on", "met_at", "located_in", "part_of"
  properties: Record<string, unknown>;
  confidence: number; // 0..1
  createdAt: string;
};

export type GraphQueryResult = {
  entities: Entity[];
  relationships: Relationship[];
  query: string;
  path: string[];
};

const ENTITIES_KEY = "hannah.pkg.entities.v1";
const RELATIONSHIPS_KEY = "hannah.pkg.relationships.v1";

function readEntities(): Entity[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ENTITIES_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntities(entities: Entity[]) {
  try {
    window.localStorage.setItem(ENTITIES_KEY, JSON.stringify(entities.slice(0, 1000)));
  } catch {
    // Best effort.
  }
}

function readRelationships(): Relationship[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RELATIONSHIPS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRelationships(relationships: Relationship[]) {
  try {
    window.localStorage.setItem(RELATIONSHIPS_KEY, JSON.stringify(relationships.slice(0, 2000)));
  } catch {
    // Best effort.
  }
}

export const PersonalKnowledgeGraph = {
  addEntity(type: EntityType, name: string, properties: Record<string, unknown> = {}): Entity {
    const now = new Date().toISOString();
    const entity: Entity = {
      id: crypto.randomUUID(),
      type,
      name,
      properties,
      createdAt: now,
      updatedAt: now,
    };
    const entities = readEntities();
    // Check for duplicate by name+type
    const existing = entities.find((e) => e.name.toLowerCase() === name.toLowerCase() && e.type === type);
    if (existing) {
      existing.properties = { ...existing.properties, ...properties };
      existing.updatedAt = now;
      writeEntities(entities);
      return existing;
    }
    entities.push(entity);
    writeEntities(entities);
    return entity;
  },

  getEntities(type?: EntityType): Entity[] {
    const entities = readEntities();
    return type ? entities.filter((e) => e.type === type) : entities;
  },

  getEntity(id: string): Entity | undefined {
    return readEntities().find((e) => e.id === id);
  },

  removeEntity(id: string) {
    const entities = readEntities().filter((e) => e.id !== id);
    writeEntities(entities);
    // Also remove relationships involving this entity
    const relationships = readRelationships().filter((r) => r.sourceId !== id && r.targetId !== id);
    writeRelationships(relationships);
  },

  addRelationship(sourceId: string, targetId: string, type: string, properties: Record<string, unknown> = {}, confidence = 0.8): Relationship {
    const now = new Date().toISOString();
    const rel: Relationship = {
      id: crypto.randomUUID(),
      sourceId,
      targetId,
      type,
      properties,
      confidence,
      createdAt: now,
    };
    const relationships = readRelationships();
    relationships.push(rel);
    writeRelationships(relationships);
    return rel;
  },

  getRelationships(entityId?: string): Relationship[] {
    const relationships = readRelationships();
    if (!entityId) return relationships;
    return relationships.filter((r) => r.sourceId === entityId || r.targetId === entityId);
  },

  query(question: string): GraphQueryResult {
    const entities = readEntities();
    const relationships = readRelationships();
    const lower = question.toLowerCase();

    // Extract keywords from the question
    const words = lower.split(/\s+/).filter((w) => w.length > 2);
    const matchedEntities = entities.filter((e) =>
      words.some((w) => e.name.toLowerCase().includes(w) || e.type.includes(w)),
    );

    const matchedRelationships = relationships.filter((r) => {
      const source = entities.find((e) => e.id === r.sourceId);
      const target = entities.find((e) => e.id === r.targetId);
      return (
        matchedEntities.includes(source!) ||
        matchedEntities.includes(target!) ||
        words.some((w) => r.type.toLowerCase().includes(w))
      );
    });

    const path = matchedEntities.map((e) => e.name);

    return {
      entities: matchedEntities,
      relationships: matchedRelationships,
      query: question,
      path,
    };
  },

  // Extract entities from text (simple NLP)
  extractEntities(text: string): Entity[] {
    const entities: Entity[] = [];
    // Simple heuristic: capitalize words that might be names
    const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
    let match;
    while ((match = namePattern.exec(text)) !== null) {
      const name = match[1];
      if (name.length > 2 && !["The", "HANNAH", "I", "A", "An", "He", "She", "It"].includes(name)) {
        const entity = this.addEntity("person", name);
        entities.push(entity);
      }
    }
    return entities;
  },
};