/**
 * Copy text, and say whether it worked.
 *
 * navigator.clipboard is missing on plain-http pages and some Android web
 * views, and it rejects when the browser denies permission; a bare
 * writeText() then threw an uncaught error and the button did nothing. This
 * falls back to a hidden selection with document.execCommand("copy"), and
 * resolves false (never throws) when neither works, so a button shows
 * "Copied" only when the text really is on the clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable: try the older way below.
  }
  try {
    if (typeof document === "undefined") return false;
    // Put focus back where it was (the copy button), so keyboard users keep their place.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.appendChild(area);
    area.focus();
    area.select();
    // iOS Safari doesn't select a readonly field with select() alone.
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy") && area.selectionEnd - area.selectionStart === text.length;
    area.remove();
    focused?.focus();
    return copied;
  } catch {
    return false;
  }
}
