/**
 * Appearance preferences kept on this device. Text size is also read by the
 * inline script in index.html, so it applies before the first paint.
 */
export type TextSize = "default" | "large" | "larger";
const TEXT_SIZE_KEY = "hannah.textSize";

export function readTextSize(): TextSize {
  try {
    const value = window.localStorage.getItem(TEXT_SIZE_KEY);
    return value === "large" || value === "larger" ? value : "default";
  } catch {
    return "default";
  }
}

export function applyTextSize(size: TextSize) {
  try {
    if (size === "default") window.localStorage.removeItem(TEXT_SIZE_KEY);
    else window.localStorage.setItem(TEXT_SIZE_KEY, size);
  } catch {
    // No storage: still apply for this session.
  }
  if (size === "default") document.documentElement.removeAttribute("data-text-size");
  else document.documentElement.setAttribute("data-text-size", size);
}
