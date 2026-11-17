import Capacitor
import Contacts
import MessageUI
import UIKit

/// HANNAH Phone Bridge on iPhone: the phone's own Phone and Messages apps do
/// the cellular work, after the person confirms.
///
/// - dial opens a `tel:` URL. iOS shows its own confirmation before calling.
/// - composeSms presents Apple's message composer with the recipient and text
///   filled in; the person sends or cancels, and iOS reports which.
/// - findContacts searches Contacts (after the person allows it) and returns
///   only the matching names and numbers.
///
/// Every request is checked here again: the number's shape, no * or # codes,
/// no emergency numbers.
@objc(HannahPhonePlugin)
public class HannahPhonePlugin: CAPPlugin, CAPBridgedPlugin, MFMessageComposeViewControllerDelegate {
    public let identifier = "HannahPhonePlugin"
    public let jsName = "HannahPhone"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dial", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "composeSms", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "findContacts", returnType: CAPPluginReturnPromise),
    ]

    private static let emergency: Set<String> = ["000", "08", "100", "101", "102", "103", "108", "110", "112", "113", "115", "118", "119", "122", "15", "17", "18", "911", "999", "1122", "1091", "1098", "181"]
    private var smsCall: CAPPluginCall?

    /// nil if the number may be used, otherwise why not.
    static func refuse(_ number: String) -> String? {
        guard number.range(of: "^\\+?[0-9]{3,17}$", options: .regularExpression) != nil else { return "That isn't a phone number." }
        let digits = number.replacingOccurrences(of: "+", with: "")
        if emergency.contains(digits) { return "HANNAH doesn't call or text emergency numbers." }
        if digits.count <= 5, emergency.contains(where: { $0.count >= 3 && digits.hasSuffix($0) }) { return "HANNAH doesn't call or text emergency numbers." }
        return nil
    }

    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let canDial = URL(string: "tel:123").map { UIApplication.shared.canOpenURL($0) } ?? false
            let status = CNContactStore.authorizationStatus(for: .contacts)
            let permission: String
            switch status {
            case .authorized: permission = "granted"
            case .denied, .restricted: permission = "denied"
            default: permission = "prompt"
            }
            call.resolve(["platform": "ios", "canDial": canDial, "canSms": MFMessageComposeViewController.canSendText(), "contactsPermission": permission])
        }
    }

    @objc func dial(_ call: CAPPluginCall) {
        let number = call.getString("number") ?? ""
        if let refused = HannahPhonePlugin.refuse(number) { return call.reject(refused, "REFUSED") }
        guard let url = URL(string: "tel:\(number)") else { return call.reject("That isn't a phone number.", "REFUSED") }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve(["result": "opened"]) } else { call.reject("This device can't place calls.", "NO_APP") }
            }
        }
    }

    @objc func composeSms(_ call: CAPPluginCall) {
        let number = call.getString("number") ?? ""
        let body = call.getString("body") ?? ""
        if let refused = HannahPhonePlugin.refuse(number) { return call.reject(refused, "REFUSED") }
        guard !body.isEmpty, body.count <= 1000 else { return call.reject("The message must be 1 to 1000 characters.", "REFUSED") }
        DispatchQueue.main.async {
            guard MFMessageComposeViewController.canSendText() else { return call.reject("This device can't send text messages.", "NO_APP") }
            guard let presenter = self.bridge?.viewController else { return call.reject("HANNAH isn't on screen.", "UNAVAILABLE") }
            let composer = MFMessageComposeViewController()
            composer.recipients = [number]
            composer.body = body
            composer.messageComposeDelegate = self
            self.smsCall = call
            presenter.present(composer, animated: true) {
                self.notifyListeners("smsComposerPresented", data: [:])
            }
        }
    }

    public func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
        controller.dismiss(animated: true)
        guard let call = smsCall else { return }
        smsCall = nil
        switch result {
        case .sent: call.resolve(["result": "sent"])
        case .cancelled: call.resolve(["result": "cancelled"])
        default: call.resolve(["result": "failed"])
        }
    }

    @objc func findContacts(_ call: CAPPluginCall) {
        let query = (call.getString("query") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 2, query.count <= 80 else { return call.reject("Give at least two letters of the name.", "REFUSED") }
        let store = CNContactStore()
        store.requestAccess(for: .contacts) { granted, _ in
            guard granted else { return call.reject("Contacts access wasn't given, so HANNAH can't look up names on this phone.", "PERMISSION_DENIED") }
            let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactPhoneNumbersKey] as [CNKeyDescriptor]
            do {
                let contacts = try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: query), keysToFetch: keys)
                let matches: [[String: Any]] = contacts.prefix(10).compactMap { contact in
                    let numbers: [[String: Any]] = contact.phoneNumbers.prefix(6).map { entry in
                        ["label": entry.label.map { CNLabeledValue<NSString>.localizedString(forLabel: $0) } ?? NSNull(), "number": entry.value.stringValue]
                    }
                    let name = [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " ")
                    return numbers.isEmpty || name.isEmpty ? nil : ["name": name, "numbers": numbers]
                }
                call.resolve(["matches": matches])
            } catch {
                call.reject("Contacts couldn't be searched.", "FAILED")
            }
        }
    }
}

/// Capacitor's bridge, plus HANNAH's own native plugins.
class HannahBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HannahPhonePlugin())
    }
}
