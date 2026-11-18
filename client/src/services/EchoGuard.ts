/**
 * Echo guard for hands-free voice: recognises when the microphone has picked
 * up HANNAH's own spoken reply (from the speaker) rather than the user, so it
 * isn't sent back to her as the next message.
 */

const ECHO_WINDOW_MS = 20_000;

function words(text: string) {
  return text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

function bigrams(list: string[]) {
  const pairs: string[] = [];
  for (let index = 0; index < list.length - 1; index += 1) pairs.push(`${list[index]} ${list[index + 1]}`);
  return pairs;
}

/**
 * True when most of what was heard is a stretch of what HANNAH just said.
 * Short phrases ("yes", "stop that") are never treated as echo, and a user
 * who quotes part of the reply inside their own sentence still gets through.
 */
export function isEchoOf(heard: string, spoken: string) {
  const heardWords = words(heard);
  if (heardWords.length < 3) return false;
  const spokenWords = words(spoken);
  if (spokenWords.length < 3) return false;
  const spokenPairs = new Set(bigrams(spokenWords));
  const heardPairs = bigrams(heardWords);
  const matching = heardPairs.filter((pair) => spokenPairs.has(pair)).length;
  return matching / heardPairs.length >= 0.6;
}

export type SpokenReply = { text: string; endedAt: number };

/** Echo only counts while HANNAH is speaking or shortly after she stops. */
export function isRecentEcho(heard: string, reply: SpokenReply | null, now = Date.now()) {
  if (!reply) return false;
  return now - reply.endedAt <= ECHO_WINDOW_MS && isEchoOf(heard, reply.text);
}
