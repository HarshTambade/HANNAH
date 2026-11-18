import AppIntents
import Foundation

/// "Hey Siri, talk to HANNAH": iOS doesn't let apps listen for their own wake
/// word in the background, so the supported way to start HANNAH by voice is
/// Siri and the Shortcuts app. The intent opens HANNAH and leaves a note that
/// the web layer reads (through Capacitor Preferences, which keeps its values
/// in UserDefaults under "CapacitorStorage."); the app then opens the same
/// voice turn as tapping the microphone. Nothing listens while HANNAH is closed.
@available(iOS 16.0, *)
struct TalkToHannahIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to HANNAH"
    static var description = IntentDescription("Opens HANNAH ready to listen to you.")
    static var openAppWhenRun: Bool = true

    /// The key the app reads with Preferences.get({ key: "hannah.voiceLaunch" }).
    static let launchKey = "CapacitorStorage.hannah.voiceLaunch"

    @MainActor
    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(String(Int(Date().timeIntervalSince1970 * 1000)), forKey: TalkToHannahIntent.launchKey)
        return .result()
    }
}

@available(iOS 16.0, *)
struct HannahShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToHannahIntent(),
            phrases: ["Talk to \(.applicationName)", "Hey \(.applicationName)", "Ask \(.applicationName)", "Open \(.applicationName) voice"],
            shortTitle: "Talk to HANNAH",
            systemImageName: "waveform"
        )
    }
}
