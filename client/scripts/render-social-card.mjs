#!/usr/bin/env node
/**
 * Renders scripts/social-card.html to public/social-card.png (1200×630), the
 * image link previews show. Run after changing the card:
 *
 *   node scripts/render-social-card.mjs
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = resolve(import.meta.dirname, "..");
const source = pathToFileURL(resolve(root, "scripts/social-card.html")).href;
const target = resolve(root, "public/social-card.png");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(source, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: target, type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log(`Wrote ${target}`);
