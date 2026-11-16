# Shanaya Store Submission Guide

## App Store Description

### Short (30 characters)
AI companion, locally

### Long
Shanaya is a multilingual AI companion with a living 3D avatar, voice chat, and optional on-device AI. Bring your own API key (BYOK) or run a local model for private conversations. Shanaya remembers context, supports tools, and adapts to your mood. Available on Web, iOS, Android, and Desktop.

## Privacy Policy Declaration

- **BYOK**: Users may connect their own Groq/OpenAI-compatible API keys. Keys are stored locally on the device and never uploaded to Shanaya servers.
- **Local LLM**: Optional on-device models run entirely on the user's hardware. No prompts leave the device in local mode.
- **Zero server-side retention**: Chat logs are not stored on Shanaya servers. The optional backend relays requests and does not persist conversation content.
- **Crash reporting**: Sentry is used with PII scrubbing enabled; no chat messages or API keys are included.
- **Analytics**: Privacy-first analytics (PostHog/Umami) tracks only allow-listed activation events.

## Google Play Data Safety Form

- Data collected: App activity (in-app interactions), Device or other IDs (anonymous analytics ID, if analytics enabled).
- Data shared: None with third parties except crash reporting (Sentry) and optional analytics providers.
- Data handling: Encrypted in transit (HTTPS). Users can request deletion via feedback channel.
- No data sold.

## iOS Info.plist Privacy Snippets

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Shanaya uses the microphone for voice chat with your AI companion.</string>

<key>NSSpeechRecognitionUsageDescription</key>
<string>Shanaya uses speech recognition to transcribe your voice messages.</string>

<key>NSCameraUsageDescription</key>
<string>Shanaya uses the camera only if you enable visual features in a future update.</string>

<key>NSPhotoLibraryUsageDescription</key>
<string>Shanaya may access photos only when you choose to share an image.</string>
```

## Release Assets Checklist

- [ ] App icons (1024x1024, adaptive)
- [ ] Screenshots (phone, tablet, desktop)
- [ ] Feature graphic (Google Play)
- [ ] Privacy policy URL
- [ ] Support URL
```