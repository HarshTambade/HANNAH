"use strict";

/**
 * Word tokens for matching memories on the server: the same idea as the
 * client's MemoryModel (any script, lowercase, common words dropped, light
 * stemming), so "invoices" matches "invoice".
 */
const STOPWORDS = new Set("a an and are as at be but by for from has have i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who will with you your about after all also any can do does did had how just like more most not now only other out over same some such than too very".split(" "));

function stem(word) {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("es") && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  return word;
}

function tokens(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !STOPWORDS.has(word)).map(stem);
}

module.exports = { tokens };
