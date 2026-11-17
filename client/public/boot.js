// Runs before the first paint (loaded from index.html).
// 1. The desktop and mobile apps get the "native-app" class, which shows the boot splash.
// 2. The chosen text size (Settings → Appearance) is applied so nothing jumps.
(function () {
  var protocol = location.protocol, origin = location.origin;
  if (protocol === "capacitor:" || protocol === "capacitor-electron:" || origin === "https://localhost") document.documentElement.classList.add("native-app");
  try {
    var size = window.localStorage.getItem("hannah.textSize");
    if (size === "large" || size === "larger") document.documentElement.setAttribute("data-text-size", size);
  } catch (error) {}
})();
