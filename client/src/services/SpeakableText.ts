/**
 * Turning a chat reply into something to say out loud.
 *
 * - speakableText drops what shouldn't be read aloud: Markdown symbols, code
 *   blocks (said as "There's code in the chat"), bare links (said as "link"),
 *   table pipes and emoji-only lines. The words themselves are kept.
 * - chunkForSpeech splits it into sentence-sized pieces. Every engine has a
 *   limit: Chrome's speech synthesis stops partway through a long utterance
 *   (and then never reports that it ended), Android's TextToSpeech refuses
 *   more than 4,000 characters, and the server voices cut long text. Speaking
 *   piece by piece reads the whole reply.
 */

export function speakableText(markdown: string): string {
  return String(markdown ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " There's code in the chat. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\[(\d+|[A-Za-z][^\]]{0,40}§\d+)\]/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.!?])\s*\.(\s|$)/g, "$1$2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Sentence-sized pieces of at most `max` characters, split at sentence ends, then commas, then spaces. */
export function chunkForSpeech(text: string, max = 200): string[] {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?।]+(?:[.!?।]+["'”’)]*|$)\s*/g) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  const push = (piece: string) => {
    const value = piece.trim();
    if (value) chunks.push(value);
  };
  const split = (piece: string) => {
    // A sentence longer than the limit: break at commas, then at spaces.
    let rest = piece.trim();
    while (rest.length > max) {
      const window = rest.slice(0, max);
      let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
      if (cut < max * 0.4) cut = window.lastIndexOf(" ");
      if (cut < max * 0.4) cut = max;
      push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1).trim();
    }
    return rest;
  };
  for (const sentence of sentences) {
    if ((current + sentence).length <= max) {
      current += sentence;
      continue;
    }
    push(current);
    current = sentence.length > max ? split(sentence) : sentence;
  }
  push(current);
  return chunks;
}
