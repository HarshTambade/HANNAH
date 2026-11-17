/**
 * What HANNAH's memories are and how the relevant ones are chosen (brief §7).
 *
 * Pure functions, no storage, so the rules are easy to test:
 * - Categories, so you can see and switch off whole kinds of memory.
 * - Provenance: where each memory came from.
 * - Sensitivity: health, money, beliefs and contact details are marked
 *   sensitive and only go to on-device or Private-mode models.
 * - Secrets are refused outright: passwords, PINs, API keys, tokens, card and
 *   ID numbers are never stored as memories.
 * - Retrieval ranks memories by how well they match what you're asking (with
 *   rarer words counting more), so a reply gets the few that matter instead of
 *   the newest dozen.
 * - A new memory that says nearly the same as an old one replaces it.
 */

export type MemoryCategory = "preference" | "personal" | "people" | "project" | "routine" | "other";
export type MemorySourceKind = "you" | "chat" | "assistant" | "automation" | "insight" | "import" | "legacy";
export type MemorySource = { kind: MemorySourceKind; detail?: string };
export type Sensitivity = "normal" | "sensitive";

export const MEMORY_CATEGORIES: MemoryCategory[] = ["preference", "personal", "people", "project", "routine", "other"];
export const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: "Preferences",
  personal: "About you",
  people: "People",
  project: "Work and projects",
  routine: "Routines",
  other: "Other",
};
export const SOURCE_LABELS: Record<MemorySourceKind, string> = {
  you: "Added by you",
  chat: "“Remember this” in chat",
  assistant: "Saved by HANNAH when you asked, after your approval",
  automation: "Saved by an automation, after your approval",
  insight: "An insight HANNAH drew from your conversations",
  import: "Imported from a backup",
  legacy: "Saved before sources were recorded",
};

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:gsk|sk|rk|pk)_[A-Za-z0-9_-]{16,}/, "an API key"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/, "an API key"],
  [/\bAIza[0-9A-Za-z_-]{20,}/, "an API key"],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "an access token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "an access token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "a cloud access key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a sign-in token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, "an access token"],
  // "password is …", "PIN: …". Not "pin code" (a postal code) or "password manager".
  [/(?:\b(?:password|passcode|passwd|pwd|otp|cvv|cvc|security code|one[- ]time code|pin(?!\s*code))\b|पासवर्ड)\s*(?:is|=|:|-|was|hai)\s*\S{3,}/i, "a password or PIN"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "an ID number"],
  [/(?<![\d][\s-]?)\b\d{4}\s\d{4}\s\d{4}\b(?![\s-]?\d)/, "an ID number"],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/, "an ID number"],
];

function luhn(digits: string) {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** What kind of secret the text holds, or "" if none. Memories never store secrets. */
export function secretIn(text: string): string {
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "a card number";
  }
  for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(text)) return label;
  // A long run of mixed letters and digits with no spaces looks like a key or token.
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    if (/[0-9]/.test(match[0]) && /[A-Za-z]/.test(match[0]) && !/^[a-z-]+$/i.test(match[0])) return "a key or token";
  }
  return "";
}

const SENSITIVE = /\b(?:diagnos\w*|illness|disease|medication|medicine|prescri\w+|therap\w+|depress\w*|anxiety|adhd|autis\w*|pregnan\w*|hiv|diabet\w*|cancer|surgery|disorder|mental health|salary|income|debt|loan|bank account|net worth|credit score|tax(?:es)?|religio\w*|church|mosque|temple|caste|sexual\w*|gay|lesbian|bisexual|transgender|politic\w*|vote[sd]?|arrest\w*|criminal|lawsuit|court case|my address|i live at|phone number|my number is|email is)\b/i;
const CONTACT = /\b[\w.+-]+@[\w-]+\.[\w.]+\b|\+?\d[\d\s-]{8,}\d/;

/** Sensitive memories only go to on-device or self-hosted models. */
export function sensitivityOf(text: string): Sensitivity {
  return SENSITIVE.test(text) || CONTACT.test(text) ? "sensitive" : "normal";
}

const CATEGORY_RULES: Array<[MemoryCategory, RegExp]> = [
  ["preference", /\b(?:prefer\w*|i (?:really )?(?:like|love|hate|dislike|enjoy|can't stand)|favou?rite|don't like|do not like|rather|please (?:always|never|don't)|call me|i want you to|keep (?:it|answers|replies|responses)|answer in|reply in|speak in|pasand)\b/i],
  ["people", /\b(?:my (?:wife|husband|partner|girlfriend|boyfriend|mom|mum|mother|dad|father|parents?|son|daughter|kids?|children|brother|sister|friend|boss|manager|colleague|coworker|team ?mate|cousin|uncle|aunt|grand\w+)|'s birthday)\b/i],
  ["routine", /\b(?:every (?:day|morning|evening|night|week|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|usually|daily|weekly|routine|habit|each (?:morning|evening)|on weekdays|on weekends)\b/i],
  ["project", /\b(?:project|repo|repository|codebase|deadline|client|sprint|launch|release|working on|building|my (?:app|startup|company|job|work|team|thesis|course))\b/i],
  ["personal", /\b(?:i am|i'm|my name|i live|i work|i was born|my birthday|years old|allergic|i study|i speak|my (?:city|home|hometown|pet|dog|cat))\b/i],
];

/** A first guess at the category; you can change it. */
export function categoryOf(text: string): MemoryCategory {
  for (const [category, pattern] of CATEGORY_RULES) if (pattern.test(text)) return category;
  return "other";
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "for", "with", "about", "from", "by", "as", "is", "are", "was", "were", "be", "been",
  "am", "do", "does", "did", "have", "has", "had", "i", "me", "my", "mine", "you", "your", "we", "our", "it", "its", "this", "that", "these", "those", "what",
  "which", "who", "whom", "when", "where", "why", "how", "can", "could", "would", "should", "will", "shall", "may", "might", "must", "not", "no", "yes", "so",
  "too", "very", "just", "please", "tell", "know", "remember", "some", "any", "all", "there", "here", "then", "than", "also", "up", "out", "into", "over",
  "hai", "hain", "ka", "ki", "ke", "ko", "se", "mein", "main", "mera", "meri", "mere", "kya", "aur", "bhi", "toh", "ho", "tha", "thi", "nahi", "na", "ye", "yeh", "wo", "woh",
]);

function stem(word: string) {
  if (word.length > 5 && word.endsWith("ing")) {
    const base = word.slice(0, -3);
    // running → run, planning → plan
    return /([bdgmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Words that carry meaning, lowercased and roughly stemmed. Works for any script. */
export function tokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !STOPWORDS.has(word)).map(stem);
}

/** How much two memories say the same thing (0 to 1). */
export function similarity(a: string, b: string) {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size || !right.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export const DUPLICATE_THRESHOLD = 0.8;

export type RankableMemory = {
  id: string;
  content: string;
  layer: string;
  weight: number;
  decay: number;
  updatedAt: string;
  category: MemoryCategory;
  sensitivity: Sensitivity;
};
export type RankOptions = {
  limit?: number;
  /** Preferences shape every reply, so a few are always included. */
  preferences?: number;
  allowSensitive?: boolean;
  categories?: Partial<Record<MemoryCategory, boolean>>;
  now?: number;
};
export type Ranked<T> = { memory: T; score: number; why: "match" | "preference" };

/**
 * The memories worth sending with this message, best first. Session notes,
 * switched-off categories and (unless allowed) sensitive memories are left out.
 */
export function rankMemories<T extends RankableMemory>(memories: T[], query: string, options: RankOptions = {}): { picked: Ranked<T>[]; hiddenSensitive: number } {
  const limit = options.limit ?? 8;
  const preferenceSlots = options.preferences ?? 3;
  const now = options.now ?? Date.now();
  let hiddenSensitive = 0;
  const usable = memories.filter((memory) => {
    if (memory.layer === "session" || !memory.content.trim() || options.categories?.[memory.category] === false) return false;
    if (memory.sensitivity === "sensitive" && !options.allowSensitive) {
      hiddenSensitive += 1;
      return false;
    }
    return true;
  });
  const docs = usable.map((memory) => ({ memory, words: tokens(memory.content) }));
  const frequency = new Map<string, number>();
  for (const doc of docs) for (const word of new Set(doc.words)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const queryWords = [...new Set(tokens(query))];
  const ageDays = (memory: T) => Math.max(0, (now - (Date.parse(memory.updatedAt) || now)) / 86_400_000);
  const strength = (memory: T) => Math.max(0.2, (Number(memory.weight) || 1) * (1 - Math.min(0.9, Number(memory.decay) || 0)));

  const scored: Ranked<T>[] = [];
  for (const doc of docs) {
    if (!queryWords.length || !doc.words.length) continue;
    let match = 0;
    for (const word of queryWords) {
      const hit = doc.words.some((candidate) => candidate === word || (word.length >= 4 && candidate.length >= 4 && (candidate.startsWith(word) || word.startsWith(candidate))));
      if (hit) match += Math.log(1 + docs.length / (frequency.get(word) ?? 1));
    }
    if (match <= 0) continue;
    const score = (match / Math.sqrt(doc.words.length)) * (1 + 0.1 * Math.log(1 + strength(doc.memory))) * (1 + 0.2 / (1 + ageDays(doc.memory) / 30));
    scored.push({ memory: doc.memory, score, why: "match" });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, limit);
  const chosen = new Set(picked.map((item) => item.memory.id));
  const preferences = docs
    .map((doc) => doc.memory)
    .filter((memory) => memory.category === "preference" && !chosen.has(memory.id))
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .slice(0, Math.max(0, Math.min(preferenceSlots, limit + preferenceSlots - picked.length)));
  for (const memory of preferences) picked.push({ memory, score: 0, why: "preference" });
  return { picked, hiddenSensitive };
}
