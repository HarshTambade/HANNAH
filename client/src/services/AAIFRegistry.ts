import { AAIFService, type AAIFDocument } from "./AAIFService";

export type AAIFVersionEntry = {
  documentId: string;
  version: number;
  createdAt: string;
  changes: string[]; // human-readable diff summary
};

const DOC_KEY = "shanaya.aaif.docs.v1";
const VERSION_KEY = "shanaya.aaif.versions.v1";

function readDocuments(): AAIFDocument[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DOC_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeDocuments(docs: AAIFDocument[]) {
  try {
    window.localStorage.setItem(DOC_KEY, JSON.stringify(docs.slice(-500)));
  } catch {
    // Best effort.
  }
}

function readVersions(): AAIFVersionEntry[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VERSION_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeVersions(versions: AAIFVersionEntry[]) {
  try {
    window.localStorage.setItem(VERSION_KEY, JSON.stringify(versions.slice(-1000)));
  } catch {
    // Best effort.
  }
}

export const AAIFRegistry = {
  register(doc: AAIFDocument, changes: string[] = ["initial version"]): AAIFDocument {
    const { valid, errors } = AAIFService.validate(doc);
    if (!valid) throw new Error(`Invalid AAIF document: ${errors.join(", ")}`);

    const now = new Date().toISOString();
    doc.updatedAt = now;

    const existing = readDocuments().find((d) => d.id === doc.id);
    if (existing) {
      // create new version entry
      const versions = readVersions();
      const latest = versions.filter((v) => v.documentId === doc.id).sort((a, b) => b.version - a.version)[0];
      const nextVersion = (latest?.version ?? 0) + 1;
      versions.push({ documentId: doc.id, version: nextVersion, createdAt: now, changes });
      writeVersions(versions);

      // replace existing document
      const docs = readDocuments().map((d) => (d.id === doc.id ? doc : d));
      writeDocuments(docs);
    } else {
      doc.createdAt = now;
      const versions = readVersions();
      versions.push({ documentId: doc.id, version: 1, createdAt: now, changes });
      writeVersions(versions);
      const docs = readDocuments();
      docs.push(doc);
      writeDocuments(docs);
    }

    return doc;
  },

  get(documentId: string): AAIFDocument | null {
    return readDocuments().find((d) => d.id === documentId) ?? null;
  },

  list(): AAIFDocument[] {
    return readDocuments();
  },

  versions(documentId: string): AAIFVersionEntry[] {
    return readVersions().filter((v) => v.documentId === documentId).sort((a, b) => b.version - a.version);
  },

  diff(documentId: string, v1: number, v2: number): { added: string[]; removed: string[]; changed: string[] } {
    const docs = readDocuments();
    const doc = docs.find((d) => d.id === documentId);
    if (!doc) return { added: [], removed: [], changed: [] };

    // Return a semantic diff based on current doc vs version metadata
    const versions = this.versions(documentId);
    const entry1 = versions.find((v) => v.version === v1);
    const entry2 = versions.find((v) => v.version === v2);

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    if (entry1 && entry2) {
      entry2.changes.forEach((c) => {
        if (!entry1.changes.includes(c)) added.push(c);
      });
      entry1.changes.forEach((c) => {
        if (!entry2.changes.includes(c)) removed.push(c);
      });
    }

    return { added, removed, changed };
  },

  remove(documentId: string) {
    const docs = readDocuments().filter((d) => d.id !== documentId);
    writeDocuments(docs);
    const versions = readVersions().filter((v) => v.documentId !== documentId);
    writeVersions(versions);
  },
};