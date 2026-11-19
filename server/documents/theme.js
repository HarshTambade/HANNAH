"use strict";

/**
 * One design system for every document HANNAH makes, so a deck, its PDF and
 * its Word version look like the same piece of work. A theme is a name, or a
 * name plus the person's own accent colour and logo.
 */
const THEMES = {
  slate: { accent: "#1D4ED8", dark: "#0F172A", ink: "#1F2937", muted: "#64748B", soft: "#EFF6FF", line: "#E2E8F0", paper: "#FFFFFF" },
  ocean: { accent: "#0E7490", dark: "#083344", ink: "#1F2937", muted: "#5B7083", soft: "#ECFEFF", line: "#D5E3EA", paper: "#FFFFFF" },
  forest: { accent: "#15803D", dark: "#052E16", ink: "#1F2937", muted: "#5F6F65", soft: "#F0FDF4", line: "#DCE7DF", paper: "#FFFFFF" },
  plum: { accent: "#7E22CE", dark: "#2E1065", ink: "#1F2937", muted: "#6B647A", soft: "#FAF5FF", line: "#E6E0EE", paper: "#FFFFFF" },
  ember: { accent: "#C2410C", dark: "#431407", ink: "#1F2937", muted: "#7A675C", soft: "#FFF7ED", line: "#EADFD6", paper: "#FFFFFF" },
  graphite: { accent: "#334155", dark: "#111827", ink: "#1F2937", muted: "#6B7280", soft: "#F3F4F6", line: "#E5E7EB", paper: "#FFFFFF" },
};
// Series colours for charts: distinct in hue and in lightness, so they also read in greyscale.
const SERIES = ["#1D4ED8", "#F59E0B", "#0F766E", "#BE123C", "#7C3AED", "#65A30D", "#0891B2", "#9A3412"];
// Arial is on Windows, macOS and most Linux desktops; Calibri is missing wherever Office is not installed.
const FONT = { heading: "Arial", body: "Arial" };

const isHex = (value) => typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value.trim());

function themeFor(input) {
  const wanted = typeof input === "string" ? { name: input } : input && typeof input === "object" ? input : {};
  const name = THEMES[String(wanted.name || "").toLowerCase()] ? String(wanted.name).toLowerCase() : "slate";
  const theme = { name, ...THEMES[name], series: [...SERIES], font: FONT };
  if (isHex(wanted.accent)) {
    theme.accent = `#${wanted.accent.trim().replace("#", "").toUpperCase()}`;
    theme.series = [theme.accent, ...SERIES.filter((color) => color !== theme.accent)].slice(0, SERIES.length);
  }
  // A logo is only ever the person's own image, passed as PNG or JPEG data.
  if (typeof wanted.logo === "string" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(wanted.logo) && wanted.logo.length < 1_500_000) theme.logo = wanted.logo;
  return theme;
}

module.exports = { FONT, SERIES, THEMES, themeFor };
