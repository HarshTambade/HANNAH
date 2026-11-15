import { GuardianAgent } from "./GuardianAgent";

export type SpecialistListing = {
  id: string;
  author: string;
  name: string;
  description: string;
  prompt: string;
  modelTier: string;
  toolSubset: string[];
  priceUsd: number;
  status: "pending" | "published" | "quarantined" | "retired";
  createdAt: string;
  updatedAt: string;
  downloads: number;
};

const KEY = "shanaya.marketplace.v1";

function readListings(): SpecialistListing[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeListings(listings: SpecialistListing[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(listings.slice(0, 1000)));
  } catch {
    // Best effort.
  }
}

export const SpecialistMarketplace = {
  listings: readListings(),
  async publish(listing: Omit<SpecialistListing, "id" | "status" | "createdAt" | "updatedAt" | "downloads">) {
    const safety = GuardianAgent.evaluate({
      tool: "specialist_publish",
      args: { prompt: listing.prompt, name: listing.name },
    });
    if (!safety.allowed) {
      throw new Error(`Marketplace listing blocked by guardian: ${safety.reason}`);
    }
    const now = new Date().toISOString();
    const entry: SpecialistListing = {
      ...listing,
      id: crypto.randomUUID(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      downloads: 0,
    };
    const all = readListings();
    all.push(entry);
    writeListings(all);
    this.listings = all;
    return entry;
  },
  review(id: string, approved: boolean, reason?: string) {
    const all = readListings();
    const index = all.findIndex((l) => l.id === id);
    if (index < 0) throw new Error("Listing not found.");
    all[index].status = approved ? "published" : "quarantined";
    all[index].updatedAt = new Date().toISOString();
    if (reason) all[index].description += ` [Review: ${reason}]`;
    writeListings(all);
    this.listings = all;
    return all[index];
  },
  list() {
    return readListings().filter((l) => l.status === "published");
  },
  get(id: string) {
    return readListings().find((l) => l.id === id);
  },
  retire(id: string) {
    const all = readListings();
    const index = all.findIndex((l) => l.id === id);
    if (index < 0) throw new Error("Listing not found.");
    all[index].status = "retired";
    all[index].updatedAt = new Date().toISOString();
    writeListings(all);
    this.listings = all;
  },
  recordDownload(id: string) {
    const all = readListings();
    const entry = all.find((l) => l.id === id);
    if (entry) {
      entry.downloads += 1;
      writeListings(all);
    }
  },
};