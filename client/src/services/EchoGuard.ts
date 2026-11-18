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

/** How long after HANNAH stops her last words may still be coming out of the speaker (Bluetooth adds up to a second or so). */
const TAIL_WINDOW_MS = 4_000;
const STOP_WORDS = new Set("the a an and or but to of in on at for with is are was were be been it its this that these those i you he she we they me my your our their him her them do does did so if as by from not no yes ok okay just".split(" "));

/**
 * The microphone reopened while the end of the reply was still playing and
 * caught a few of its last words ("you today"). Too short for isEchoOf, so:
 * a run of words that appears, in order, among the last dozen words she said.
 */
export function isTailEcho(heard: string, spoken: string) {
  const heardWords = words(heard);
  if (!heardWords.length || heardWords.length > 6) return false;
  const tail = words(spoken).slice(-12);
  for (let start = 0; start + heardWords.length <= tail.length; start += 1) {
    if (heardWords.every((word, index) => tail[start + index] === word)) return true;
  }
  return false;
}

/**
 * Recognition of her voice from a speaker garbles word order and small words.
 * When most of what was heard is her reply's meaningful words (4 or more),
 * it's her, not the person.
 */
export function isContentEcho(heard: string, spoken: string) {
  const content = (list: string[]) => list.filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  const heardContent = content(words(heard));
  if (heardContent.length < 4) return false;
  const spokenSet = new Set(content(words(spoken)));
  const matching = heardContent.filter((word) => spokenSet.has(word)).length;
  return matching / heardContent.length >= 0.8;
}

export type SpokenReply = { text: string; endedAt: number };

/** Echo only counts while HANNAH is speaking or shortly after she stops. */
export function isRecentEcho(heard: string, reply: SpokenReply | null, now = Date.now()) {
  if (!reply) return false;
  const since = now - reply.endedAt;
  if (since > ECHO_WINDOW_MS) return false;
  if (isEchoOf(heard, reply.text) || isContentEcho(heard, reply.text)) return true;
  return since <= TAIL_WINDOW_MS && isTailEcho(heard, reply.text);
}
