# Shanaya Terms of Service

**Effective date:** 15 November 2026<br>
**Last updated:** 15 November 2026

These Terms of Service (“Terms”) govern your use of the Shanaya application, website, API, and related services (together, “Shanaya”, “the service”). Shanaya is operated by the Shanaya project operator (“we”, “us”, “our”). By downloading, accessing, or using Shanaya, you agree to these Terms and to the [Privacy Policy](./PRIVACY_POLICY.md). If you do not agree, do not use the service.

> **Publication note for the operator:** Replace the legal entity, contact addresses, governing-law jurisdiction, and effective date with the values that will appear on the public store listing before publishing. This document must be hosted at a public HTTPS URL and linked from the App Store and Google Play listings.

## 1. Eligibility

You must be at least 13 years old to use Shanaya. If you are between 13 and the age of majority in your jurisdiction, you may use Shanaya only with the involvement of a parent or guardian. If local law sets a higher minimum age for digital consent, that higher age applies. You may not use Shanaya if you have been previously banned from the service or if applicable law prohibits you from using it.

## 2. What Shanaya is

Shanaya is an AI companion and assistant with a 3D avatar, text and voice conversation, optional on-device inference, optional cloud inference, optional device tools, optional saved memories, and optional desktop computer use. Shanaya can generate text and take actions through tools only after the app’s confirmation flow.

Shanaya is **not** a human, a medical device, a therapist, a lawyer, a financial adviser, an emergency service, or a substitute for professional judgment. AI output can be wrong, incomplete, outdated, biased, or unsafe. Verify important information independently. In an emergency, contact local emergency services.

## 3. AI providers and your choices

Shanaya is a hybrid application. The inference mode you select determines where your data is processed:

| Mode | Where inference runs | What leaves your device |
| --- | --- | --- |
| WebLLM | In a compatible browser using WebGPU | Nothing is sent to Shanaya’s API or a cloud provider for inference, subject to browser/runtime behavior |
| On-device model | Downloaded llama.cpp model on iOS/Android | Nothing is sent to Shanaya’s API or a cloud provider for inference |
| Ollama | Your configured Ollama endpoint | The prompt and context go to that endpoint; a loopback endpoint stays on your machine |
| Cloud | Groq, OpenAI, Anthropic, or another configured provider through the Shanaya API | The prompt, relevant context, tool schemas, and tool results go to the selected provider |
| MobileClaw | Anthropic, from the native app | The prompt, relevant context, and relevant saved memories go to Anthropic |
| Desktop | Anthropic computer-use API | Task text, screenshots, and action context go to Anthropic |

When you select a cloud mode, you instruct us to transmit the request to the provider shown in the app. The provider’s terms and privacy policy apply in addition to these Terms. You are responsible for reviewing them and for deciding whether the selected mode is appropriate for your data. If you do not want data sent to a third party, use a local mode.

You are responsible for any API key or access token you enter. Do not share keys, paste them into public issues, or use a key you are not authorized to use. Visitor-supplied keys are held in page memory by the client and forwarded only to the applicable provider endpoint, but you should still treat them as sensitive credentials.

## 4. Free and Premium plans

Shanaya offers a Free plan and a Premium plan. The current product description is:

- **Free:** up to 25 successful assistant turns per local calendar day, using local inference modes (WebLLM, the downloaded on-device model, and Ollama). Failed turns do not consume a message.
- **Premium:** **US$9.99 per month**, unlimited messages, cloud providers, cloud-backed MobileClaw and desktop agents, and priority Groq routing, subject to provider availability.

Prices, features, and limits may change. We will give notice where required by law. Taxes may apply and will be shown at checkout. The current build contains a **placeholder checkout**; no payment is collected until the operator connects RevenueCat, Stripe, or the platform billing system and publishes the final price and terms. A local QA bypass (`VITE_SUBSCRIPTION_BYPASS`) is not a purchase and does not create a paid entitlement.

**Billing.** When billing is connected, purchases made through the Apple App Store or Google Play are governed by that store’s payment terms. Subscriptions renew automatically unless cancelled at least 24 hours before the end of the current period (or the period stated by the store). Manage or cancel in your store account. Deleting the app does not cancel a subscription. Refunds are handled by the store under its policy, except where local law requires otherwise.

**Entitlements.** A client-side badge is not proof of purchase. Paid access must be validated by the billing provider and, where applicable, by the Shanaya API. We may revoke access obtained through fraud, chargebacks, tampering, or unauthorized key sharing.

## 5. Your content and permissions

You retain ownership of the text, files, images, voice, and other content you provide (“Your Content”). You grant us a limited, non-exclusive, worldwide license to host, process, transmit, and display Your Content solely to operate the features you request, including sending it to the inference provider you select. This license ends when the relevant processing ends, except for residual copies in backups, logs, or provider systems that are retained under the retention rules described in the Privacy Policy.

You represent that you have the rights and permissions needed to submit Your Content and to let Shanaya process it. Do not upload malware, stolen data, another person’s private information without permission, or content that violates law.

AI-generated output may be similar to output generated for others. We do not claim ownership of AI output and do not guarantee that it is unique, accurate, or free of third-party rights. You are responsible for how you use it.

## 6. Acceptable use

You may not use Shanaya to:

- generate, request, or distribute child sexual abuse material, non-consensual sexual content, or sexual content involving minors;
- threaten, harass, stalk, defame, or incite violence or hatred against a person or group;
- provide instructions for weapons, explosives, malware, credential theft, or other serious harm;
- infringe intellectual property, privacy, publicity, or other rights;
- impersonate a person or misrepresent an affiliation;
- distribute spam, scams, or deceptive content;
- bypass safety controls, rate limits, paywalls, authentication, or provider restrictions;
- probe, scan, or attack the service or another system;
- collect or disclose personal data without lawful authority;
- use the service in a way that violates applicable law or a provider’s acceptable-use policy.

We may investigate, remove content, limit features, or suspend access if we reasonably believe you have violated these Terms or created a security or legal risk. We may report suspected child sexual abuse material or other serious illegality to the appropriate authorities.

## 7. AI content reporting and moderation

The app includes a “Report” control on assistant messages. A report sends the message ID, a reason, the app version, the platform, the inference mode, and a timestamp to a metadata-only audit file. It does **not** send the reply text. Operators review reports for safety, quality, and provider issues. Reporting does not guarantee a particular outcome or a response to an individual report.

Do not use the report control to submit false reports, spam, or personal data. Abuse of the reporting system may result in restrictions.

## 8. Device tools, files, and desktop control

Some features can read or write files in Shanaya’s private app storage, control device features, launch apps, or control a desktop. These actions require confirmation through the app’s safety flow. You are responsible for reviewing each confirmation and for the consequences of approving an action.

Desktop computer use can take screenshots, move the pointer, click, type, and perform other actions. It may make mistakes, act on the wrong window, or expose information visible on your screen. Do not leave a computer-use session unattended. The operator may disable desktop control at any time.

## 9. Privacy

Our [Privacy Policy](./PRIVACY_POLICY.md) explains what we process, the third-party AI providers that may receive data, retention, and deletion. By using cloud modes, you consent to the transfers described there. If you do not consent, use a local mode.

## 10. Open-source software and third-party services

Shanaya includes open-source components, models, and SDKs, each governed by its own license. Third-party services, model weights, and app stores have their own terms. Nothing in these Terms overrides those licenses or terms. The repository’s LICENSE file governs the project’s source code.

## 11. Availability, changes, and beta features

Shanaya is provided on an “as available” basis. We may change, suspend, or discontinue features, providers, models, or plans. We do not guarantee uninterrupted availability, provider uptime, model availability, or that a particular feature will remain free. Features labeled beta, preview, or experimental may be unstable and may change without notice.

If a provider fails, the app may fall back to another configured model or to local inference. Fallback behavior can change which provider receives your request; the app shows the active mode, and you should check it before sending sensitive information.

## 12. Disclaimers

TO THE MAXIMUM EXTENT PERMITTED BY LAW, SHANAYA IS PROVIDED “AS IS” AND “AS AVAILABLE” WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, AND QUIET ENJOYMENT. WE DO NOT WARRANT THAT OUTPUT WILL BE ACCURATE, SAFE, COMPLETE, OR SUITABLE FOR YOUR PURPOSE, OR THAT THE SERVICE WILL BE UNINTERRUPTED OR ERROR-FREE.

Nothing in these Terms excludes a warranty or right that cannot be excluded under applicable law, including consumer rights in the European Economic Area, the United Kingdom, India, Australia, or another jurisdiction.

## 13. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST DATA, LOSS OF GOODWILL, BUSINESS INTERRUPTION, OR DAMAGE CAUSED BY AI OUTPUT, DEVICE ACTIONS, DESKTOP CONTROL, OR A THIRD-PARTY PROVIDER.

OUR TOTAL LIABILITY FOR ALL CLAIMS RELATING TO THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US FOR THE SERVICE IN THE 12 MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM, OR (B) US$50. THESE LIMITS DO NOT APPLY TO FRAUD, WILLFUL MISCONDUCT, DEATH OR PERSONAL INJURY CAUSED BY NEGLIGENCE, OR ANY LIABILITY THAT CANNOT BE LIMITED BY LAW.

## 14. Indemnity

To the extent permitted by law, you will indemnify and hold harmless the operator and its contributors from claims, damages, liabilities, and reasonable costs arising from Your Content, your violation of these Terms, your misuse of the service, or your violation of another person’s rights. This does not apply to claims caused solely by our own negligence or willful misconduct.

## 15. Termination

You may stop using Shanaya at any time. We may suspend or terminate access if you materially breach these Terms, create a security or legal risk, or if we discontinue the service. Sections that by their nature should survive termination — including ownership, disclaimers, limitation of liability, indemnity, and governing law — will survive.

## 16. Apple and Google terms

If you downloaded the app from the Apple App Store, you acknowledge that these Terms are between you and the operator, not Apple. Apple is not responsible for the app or its content, maintenance, support, or warranty. Apple has no obligation to provide maintenance or support. In the event of a failure of the app to conform to an applicable warranty, you may notify Apple, and Apple may refund the purchase price, if any; to the maximum extent permitted by law, Apple has no other warranty obligation. Apple is a third-party beneficiary of these Terms and may enforce them against you. You must comply with the App Store terms and Apple’s usage rules.

If you downloaded the app from Google Play, you acknowledge that Google is not a party to these Terms and has no responsibility for the app. Google Play’s terms and refund policy apply to the purchase.

## 17. Governing law and disputes

These Terms are governed by the laws of **[OPERATOR JURISDICTION]**, without regard to conflict-of-law rules. Before filing a claim, contact **legal@shanaya.app** and give us 30 days to try to resolve the dispute. Nothing in this section prevents you from bringing a claim in a court that has mandatory jurisdiction over you or from exercising a non-waivable consumer right.

If you are a consumer in the European Economic Area, the United Kingdom, or another jurisdiction with mandatory consumer-protection rules, you may also use your local courts and consumer-protection authorities.

## 18. Changes to these Terms

We may update these Terms when the service, providers, or law change. We will update the effective date and provide notice of material changes where required. If you do not agree to the updated Terms, stop using the service. Continued use after the effective date means you accept the updated Terms.

## 19. Contact

- Legal: **legal@shanaya.app**
- Support: **support@shanaya.app**
- Privacy: **privacy@shanaya.app**
- Security: **security@shanaya.app**
