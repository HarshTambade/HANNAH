// HANNAH's macOS control helper.
//
// One request per process: `hannah-control <command>`, with a JSON object on
// stdin, answers one JSON object on stdout ({"ok": true, ...} or
// {"ok": false, "code": "...", "error": "..."}).
//
// It runs as a child of HANNAH's desktop app, so macOS attributes its
// Accessibility permission to HANNAH (System Settings → Privacy & Security →
// Accessibility). It never asks for anything itself except through macOS's own
// prompt (`request-access`). The rules — when HANNAH may act, what needs your
// approval — live in the app (plugins/desktop-tools/electron/dist/control.mjs);
// this helper only observes and acts as told, and refuses password fields.
//
// Semantic first: `observe` returns the frontmost window's accessibility tree
// (roles, labels, values, frames, actions) with a path for each element;
// `press`, `set-value`, `focus`, `select-text` act on an element by path and
// check that it's still the element that was observed. Coordinates (`click`,
// `scroll`, `drag`) are for when there's no accessible element.
import AppKit
import ApplicationServices
import Foundation

// MARK: - Output

func emit(_ object: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"code\":\"INTERNAL\",\"error\":\"Couldn't encode the answer.\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(object["ok"] as? Bool == true ? 0 : 1)
}
func fail(_ code: String, _ message: String) -> Never { emit(["ok": false, "code": code, "error": message]) }
func done(_ fields: [String: Any] = [:]) -> Never { var object = fields; object["ok"] = true; emit(object) }

// MARK: - Input

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail("USAGE", "Usage: hannah-control <command> (JSON options on stdin)") }
let command = arguments[1]
let input: [String: Any] = {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  if data.isEmpty { return [:] }
  guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { fail("BAD_INPUT", "The options aren't a JSON object.") }
  return object
}()
func number(_ key: String) -> Double? { (input[key] as? NSNumber)?.doubleValue }
func text(_ key: String) -> String? { input[key] as? String }
func integer(_ key: String, _ fallback: Int) -> Int { (input[key] as? NSNumber)?.intValue ?? fallback }

// MARK: - Accessibility helpers

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = attribute(element, name) else { return nil }
  if let text = value as? String { return text }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}
func bool(_ element: AXUIElement, _ name: String) -> Bool? { (attribute(element, name) as? NSNumber)?.boolValue }
func children(_ element: AXUIElement) -> [AXUIElement] { (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
  return list
}
func frame(_ element: AXUIElement) -> CGRect? {
  guard let positionValue = attribute(element, kAXPositionAttribute), let sizeValue = attribute(element, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard CFGetTypeID(positionValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
  AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
  AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
  return CGRect(origin: point, size: size)
}
func frameObject(_ rect: CGRect?) -> [String: Int]? {
  guard let rect = rect else { return nil }
  return ["x": Int(rect.origin.x.rounded()), "y": Int(rect.origin.y.rounded()), "width": Int(rect.size.width.rounded()), "height": Int(rect.size.height.rounded())]
}
func clip(_ value: String?, _ limit: Int) -> String? {
  guard let value = value?.replacingOccurrences(of: "\u{0}", with: "").trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
  return value.count > limit ? String(value.prefix(limit)) + "…" : value
}

let SECURE_ROLES: Set<String> = ["AXSecureTextField"]
func isSecure(_ element: AXUIElement) -> Bool {
  (string(element, kAXRoleAttribute).map { SECURE_ROLES.contains($0) } ?? false) || string(element, kAXSubroleAttribute) == "AXSecureTextField"
}
/** The element's label: what a person would call it. Never a password field's value. */
func label(_ element: AXUIElement) -> String? {
  for name in [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXHelpAttribute] {
    if let value = clip(string(element, name), 200) { return value }
  }
  if let titleElement = attribute(element, kAXTitleUIElementAttribute), CFGetTypeID(titleElement) == AXUIElementGetTypeID(), let value = clip(string(titleElement as! AXUIElement, kAXValueAttribute), 200) { return value }
  return nil
}

func requireTrusted() {
  if !AXIsProcessTrusted() { fail("ACCESSIBILITY_PERMISSION", "macOS hasn't given HANNAH Accessibility permission. Open System Settings → Privacy & Security → Accessibility and turn on HANNAH.") }
}

func runningApp(pid: pid_t) -> NSRunningApplication? { NSRunningApplication(processIdentifier: pid) }
func targetApp() -> NSRunningApplication {
  if let pid = number("pid") {
    guard let app = runningApp(pid: pid_t(pid)), !app.isTerminated else { fail("APP_GONE", "That app isn't running any more.") }
    return app
  }
  guard let app = NSWorkspace.shared.frontmostApplication else { fail("NO_APP", "No app is in front.") }
  return app
}
func appObject(_ app: NSRunningApplication) -> [String: Any] {
  ["name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier), "active": app.isActive, "hidden": app.isHidden]
}
func applicationElement(_ app: NSRunningApplication) -> AXUIElement {
  let element = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(element, 1.5)
  // Chromium and Electron apps (Chrome, VS Code …) build their accessibility tree only when asked.
  AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  return element
}
func windows(_ appElement: AXUIElement) -> [AXUIElement] { (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement]) ?? [] }
func focusedWindowIndex(_ appElement: AXUIElement, _ list: [AXUIElement]) -> Int? {
  for name in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
    if let value = attribute(appElement, name), CFGetTypeID(value) == AXUIElementGetTypeID() {
      let window = value as! AXUIElement
      if let index = list.firstIndex(where: { CFEqual($0, window) }) { return index }
    }
  }
  return list.isEmpty ? nil : 0
}
func windowObject(_ window: AXUIElement, index: Int) -> [String: Any] {
  var object: [String: Any] = ["index": index, "title": clip(string(window, kAXTitleAttribute), 300) ?? "", "role": string(window, kAXRoleAttribute) ?? "", "subrole": string(window, kAXSubroleAttribute) ?? ""]
  if let frame = frameObject(frame(window)) { object["frame"] = frame }
  object["minimized"] = bool(window, kAXMinimizedAttribute) ?? false
  object["main"] = bool(window, kAXMainAttribute) ?? false
  if let fullScreen = bool(window, "AXFullScreen") { object["fullScreen"] = fullScreen }
  return object
}

// FNV-1a, stable across runs (Swift's Hasher is seeded per process).
func fingerprint(_ parts: [String]) -> String {
  var hash: UInt64 = 0xcbf29ce484222325
  for part in parts { for byte in part.utf8 { hash ^= UInt64(byte); hash = hash &* 0x100000001b3 }; hash ^= 0x1f; hash = hash &* 0x100000001b3 }
  return String(hash, radix: 16)
}

let INPUT_ROLES: Set<String> = ["AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXSearchField", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider", "AXIncrementor", "AXDateField", "AXColorWell", "AXSwitch"]
let CONTAINER_ROLES: Set<String> = ["AXSheet", "AXDialog", "AXTable", "AXOutline", "AXList", "AXTabGroup", "AXMenu", "AXMenuBar", "AXToolbar", "AXWebArea", "AXScrollArea", "AXGroup", "AXSplitGroup", "AXBrowser"]
let ERROR_WORDS = try! NSRegularExpression(pattern: "\\b(error|errors|failed|failure|exception|fatal|cannot|can't|couldn't|unable|denied|invalid|not found|warning)\\b", options: [.caseInsensitive])

/** Walk one window's tree, keeping elements a person could see, read or use. */
func observeWindow(_ window: AXUIElement, windowIndex: Int, maxNodes: Int, maxDepth: Int) -> (nodes: [[String: Any]], text: String, parts: [String], dialogs: [String], errors: [String]) {
  var nodes: [[String: Any]] = []
  var parts: [String] = []
  var textLines: [String] = []
  var dialogs: [String] = []
  var errors: [String] = []
  var visited = 0
  var stack: [(AXUIElement, [Int], Int)] = [(window, [windowIndex], 0)]
  while let (element, path, depth) = stack.popLast() {
    visited += 1
    if visited > maxNodes * 6 || nodes.count >= maxNodes { break }
    let role = string(element, kAXRoleAttribute) ?? ""
    let subrole = string(element, kAXSubroleAttribute) ?? ""
    let secure = isSecure(element)
    let name = label(element)
    let value = secure ? nil : clip(string(element, kAXValueAttribute), role == "AXTextArea" || role == "AXStaticText" ? 600 : 200)
    let available = actions(element).filter { ["AXPress", "AXConfirm", "AXShowMenu", "AXPick", "AXIncrement", "AXDecrement", "AXRaise", "AXCancel", "AXOpen"].contains($0) }
    let rect = frame(element)
    let visible = rect.map { $0.width > 0 && $0.height > 0 } ?? false
    let interesting = depth > 0 && visible && (!available.isEmpty || INPUT_ROLES.contains(role) || name != nil || value != nil || ["AXSheet", "AXDialog", "AXTable", "AXHeading", "AXWebArea"].contains(role) || subrole == "AXDialog" || subrole == "AXSystemDialog")
    if interesting {
      var node: [String: Any] = ["path": path.map(String.init).joined(separator: "."), "role": role]
      if !subrole.isEmpty { node["subrole"] = subrole }
      if let name = name { node["label"] = name }
      if let value = value { node["value"] = value }
      if secure { node["secure"] = true }
      if !available.isEmpty { node["actions"] = available }
      if bool(element, kAXEnabledAttribute) == false { node["enabled"] = false }
      if bool(element, kAXFocusedAttribute) == true { node["focused"] = true }
      if let selected = bool(element, kAXSelectedAttribute), selected { node["selected"] = true }
      if let frame = frameObject(rect) { node["frame"] = frame }
      nodes.append(node)
      parts.append("\(node["path"]!)|\(role)|\(name ?? "")|\(value ?? "")|\(bool(element, kAXEnabledAttribute) ?? true)")
      if role == "AXSheet" || role == "AXDialog" || subrole == "AXDialog" || subrole == "AXSystemDialog" { dialogs.append(name ?? role) }
      for candidate in [name, value].compactMap({ $0 }) {
        if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" || role == "AXCell" { textLines.append(candidate) }
        let range = NSRange(candidate.startIndex..., in: candidate)
        if ERROR_WORDS.firstMatch(in: candidate, range: range) != nil && errors.count < 20 { errors.append(String(candidate.prefix(300))) }
      }
    }
    if depth < maxDepth && !secure {
      let kids = children(element)
      for (index, child) in kids.enumerated().reversed() { stack.append((child, path + [index], depth + 1)) }
    }
  }
  var joined = ""
  for line in textLines { if joined.count + line.count > 8000 { break }; joined += line + "\n" }
  return (nodes, joined, parts, dialogs, errors)
}

/** Find an element by the path `observe` gave it: window index, then child indexes. */
func resolve(_ appElement: AXUIElement, _ pathText: String) -> AXUIElement {
  let indexes = pathText.split(separator: ".").compactMap { Int($0) }
  guard let first = indexes.first, indexes.count >= 1 else { fail("BAD_INPUT", "An element path looks like 0.3.1.") }
  let list = windows(appElement)
  guard first >= 0 && first < list.count else { fail("CHANGED", "That window isn't there any more. Look at the screen again.") }
  var element = list[first]
  for index in indexes.dropFirst() {
    let kids = children(element)
    guard index >= 0 && index < kids.count else { fail("CHANGED", "The interface changed: that element isn't there any more. Look again before acting.") }
    element = kids[index]
  }
  return element
}
/** Stop if the element at the path isn't the one that was observed (role and label). */
func checkExpected(_ element: AXUIElement) {
  guard let expected = input["expect"] as? [String: Any] else { fail("BAD_INPUT", "Say which element you expect (role and label), so HANNAH doesn't act on the wrong one.") }
  let role = string(element, kAXRoleAttribute) ?? ""
  if let wanted = expected["role"] as? String, wanted != role { fail("CHANGED", "The interface changed: expected a \(wanted) but found a \(role.isEmpty ? "different element" : role). Look again before acting.") }
  let found = label(element) ?? ""
  if let wanted = expected["label"] as? String, !wanted.isEmpty, wanted != found { fail("CHANGED", "The interface changed: expected “\(wanted)” but found “\(found)”. Look again before acting.") }
  if bool(element, kAXEnabledAttribute) == false { fail("DISABLED", "That element is disabled right now.") }
}

// MARK: - Keyboard and mouse (CoreGraphics events, as a real device sends them)

let source = CGEventSource(stateID: .hidSystemState)
func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap) }
func pause(_ ms: UInt32) { usleep(ms * 1000) }
func point(_ key: String = "") -> CGPoint {
  guard let x = number(key.isEmpty ? "x" : "\(key)X"), let y = number(key.isEmpty ? "y" : "\(key)Y") else { fail("BAD_INPUT", "Give x and y in screen points.") }
  let bounds = NSScreen.screens.reduce(CGRect.null) { $0.union($1.frame) }
  guard bounds.isNull || (x >= Double(bounds.minX) - 1 && x <= Double(bounds.maxX) + 1) else { fail("OFF_SCREEN", "That point is off the screen.") }
  return CGPoint(x: x, y: y)
}

let KEY_CODES: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
  "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "forwarddelete": 117,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
func modifierFlags(_ names: [String]) -> CGEventFlags {
  var flags: CGEventFlags = []
  for name in names {
    switch name.lowercased() {
    case "cmd", "command", "meta": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default: fail("BAD_INPUT", "Unknown modifier “\(name)”. Use cmd, shift, option or control.")
    }
  }
  return flags
}

// MARK: - Commands

switch command {
case "status":
  done(["platform": "darwin", "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "frontmost": NSWorkspace.shared.frontmostApplication.map(appObject) as Any])

case "request-access":
  // macOS's own prompt; HANNAH can't grant itself anything.
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  done(["accessibility": AXIsProcessTrustedWithOptions(options)])

case "running":
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }.map(appObject)
  done(["apps": apps])

case "frontmost", "observe":
  requireTrusted()
  let app = targetApp()
  let appElement = applicationElement(app)
  let list = windows(appElement)
  let index = focusedWindowIndex(appElement, list)
  var result: [String: Any] = ["app": appObject(app), "windows": list.enumerated().map { windowObject($0.element, index: $0.offset) }]
  if let index = index { result["window"] = windowObject(list[index], index: index) }
  if let focused = attribute(appElement, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() {
    let element = focused as! AXUIElement
    var info: [String: Any] = ["role": string(element, kAXRoleAttribute) ?? ""]
    if let name = label(element) { info["label"] = name }
    if isSecure(element) { info["secure"] = true }
    result["focused"] = info
  }
  if command == "observe", let index = index {
    let observed = observeWindow(list[index], windowIndex: index, maxNodes: max(20, min(integer("maxNodes", 300), 800)), maxDepth: max(3, min(integer("maxDepth", 30), 60)))
    result["elements"] = observed.nodes
    result["text"] = observed.text
    result["dialogs"] = observed.dialogs
    result["errors"] = observed.errors
    result["fingerprint"] = fingerprint(observed.parts + [String(describing: result["window"])])
  }
  done(result)

case "press", "show-menu", "focus", "set-value", "select-text", "increment", "decrement":
  requireTrusted()
  let app = targetApp()
  let appElement = applicationElement(app)
  guard let pathText = text("path") else { fail("BAD_INPUT", "Give the element's path from the last observation.") }
  let element = resolve(appElement, pathText)
  checkExpected(element)
  let role = string(element, kAXRoleAttribute) ?? ""
  switch command {
  case "press":
    let available = actions(element)
    let action = available.contains("AXPress") ? "AXPress" : available.contains("AXConfirm") ? "AXConfirm" : available.contains("AXPick") ? "AXPick" : available.contains("AXOpen") ? "AXOpen" : nil
    guard let chosen = action else { fail("NO_ACTION", "That \(role) can't be pressed through accessibility; use a click at its position instead.") }
    let status = AXUIElementPerformAction(element, chosen as CFString)
    guard status == .success else { fail("ACTION_FAILED", "macOS refused to press it (AX error \(status.rawValue)).") }
    done(["action": chosen])
  case "show-menu":
    guard AXUIElementPerformAction(element, "AXShowMenu" as CFString) == .success else { fail("ACTION_FAILED", "That element has no context menu.") }
    done(["action": "AXShowMenu"])
  case "increment", "decrement":
    let action = command == "increment" ? "AXIncrement" : "AXDecrement"
    guard AXUIElementPerformAction(element, action as CFString) == .success else { fail("ACTION_FAILED", "That element can't be changed that way.") }
    done(["action": action])
  case "focus":
    guard AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { fail("ACTION_FAILED", "That element can't take focus.") }
    done(["focused": bool(element, kAXFocusedAttribute) ?? false])
  case "set-value":
    if isSecure(element) { fail("SECURE_FIELD", "HANNAH never types into password fields.") }
    guard let value = text("value") else { fail("BAD_INPUT", "Give the text to put in the field.") }
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { fail("NOT_SETTABLE", "That \(role) doesn't accept text through accessibility; focus it and type instead.") }
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success else { fail("ACTION_FAILED", "macOS refused to set the text.") }
    done(["value": clip(string(element, kAXValueAttribute), 400) ?? ""])
  default: // select-text
    if isSecure(element) { fail("SECURE_FIELD", "HANNAH never touches password fields.") }
    var range = CFRange(location: integer("location", 0), length: integer("length", 0))
    guard let value = AXValueCreate(.cfRange, &range), AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success else { fail("ACTION_FAILED", "That element's text can't be selected.") }
    done(["selected": clip(string(element, kAXSelectedTextAttribute), 400) ?? ""])
  }

case "click":
  requireTrusted()
  let at = point()
  let button = text("button") == "right" ? CGMouseButton.right : CGMouseButton.left
  let count = max(1, min(integer("count", 1), 3))
  let (down, up): (CGEventType, CGEventType) = button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
  post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: button))
  pause(40)
  for click in 1...count {
    let pressed = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: at, mouseButton: button)
    pressed?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
    post(pressed)
    let released = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: at, mouseButton: button)
    released?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
    post(released)
    pause(60)
  }
  done(["x": at.x, "y": at.y, "button": button == .right ? "right" : "left", "count": count])

case "drag":
  requireTrusted()
  let from = point("from")
  let to = point("to")
  post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left))
  pause(40)
  post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
  let steps = 20
  for step in 1...steps {
    let t = CGFloat(step) / CGFloat(steps)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), mouseButton: .left))
    pause(15)
  }
  post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
  done(["from": ["x": from.x, "y": from.y], "to": ["x": to.x, "y": to.y]])

case "scroll":
  requireTrusted()
  if number("x") != nil { post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point(), mouseButton: .left)); pause(30) }
  let dy = Int32(max(-50, min(50, integer("dy", 0))))
  let dx = Int32(max(-50, min(50, integer("dx", 0))))
  post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
  done(["dx": dx, "dy": dy])

case "type":
  requireTrusted()
  if let app = NSWorkspace.shared.frontmostApplication {
    let appElement = applicationElement(app)
    if let focused = attribute(appElement, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(), isSecure(focused as! AXUIElement) { fail("SECURE_FIELD", "The focused field is a password field. HANNAH never types passwords.") }
  }
  guard let value = text("text"), !value.isEmpty else { fail("BAD_INPUT", "Give the text to type.") }
  let units = Array(value.utf16)
  var index = 0
  while index < units.count {
    let chunk = Array(units[index..<min(index + 16, units.count)])
    for keyDown in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: keyDown)
      chunk.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
      post(event)
    }
    pause(12)
    index += 16
  }
  done(["typed": value.count])

case "key":
  requireTrusted()
  guard let name = text("key")?.lowercased(), let code = KEY_CODES[name] else { fail("BAD_INPUT", "Unknown key. Use a letter, digit, or return, tab, space, delete, escape, arrows, home, end, page up/down, f1–f12.") }
  let flags = modifierFlags((input["modifiers"] as? [String]) ?? [])
  for keyDown in [true, false] {
    let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: keyDown)
    event?.flags = flags
    post(event)
    pause(20)
  }
  done(["key": name, "modifiers": (input["modifiers"] as? [String]) ?? []])

case "activate":
  let app = targetApp()
  if #available(macOS 14.0, *) { _ = app.activate() } else { _ = app.activate(options: [.activateIgnoringOtherApps]) }
  pause(250)
  done(["app": appObject(app), "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier])

case "quit":
  let app = targetApp()
  guard app.terminate() else { fail("ACTION_FAILED", "\(app.localizedName ?? "The app") didn't accept the request to quit.") }
  done(["app": appObject(app)])

case "window":
  requireTrusted()
  let app = targetApp()
  let appElement = applicationElement(app)
  let list = windows(appElement)
  let index = integer("index", focusedWindowIndex(appElement, list) ?? 0)
  guard index >= 0 && index < list.count else { fail("CHANGED", "That window isn't there any more.") }
  let window = list[index]
  if let expectedTitle = text("expectTitle"), expectedTitle != (string(window, kAXTitleAttribute) ?? "") { fail("CHANGED", "That window's title changed. Look again before acting.") }
  switch text("action") ?? "" {
  case "raise":
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    if #available(macOS 14.0, *) { _ = app.activate() } else { _ = app.activate(options: [.activateIgnoringOtherApps]) }
  case "minimize": AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
  case "restore": AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
  case "fullscreen": AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, (input["on"] as? Bool ?? true) ? kCFBooleanTrue : kCFBooleanFalse)
  case "close":
    guard let button = attribute(window, kAXCloseButtonAttribute), CFGetTypeID(button) == AXUIElementGetTypeID(), AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success else { fail("ACTION_FAILED", "That window has no close button HANNAH can press.") }
  case "move", "resize":
    if let x = number("x"), let y = number("y") {
      var origin = CGPoint(x: x, y: y)
      if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value) }
    }
    if let width = number("width"), let height = number("height") {
      var size = CGSize(width: max(100, width), height: max(80, height))
      if let value = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value) }
    }
  default: fail("BAD_INPUT", "A window action is raise, minimize, restore, fullscreen, close, move or resize.")
  }
  pause(300)
  let after = windows(appElement)
  done(["windows": after.enumerated().map { windowObject($0.element, index: $0.offset) }])

default:
  fail("USAGE", "Unknown command “\(command)”.")
}
