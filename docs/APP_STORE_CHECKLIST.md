# App Store Submission Checklist

## Apple App Store

### Privacy Nutrition Label (App Store Connect)
- **Data Collection**: None for conversation data (local-first). Optional Sentry error tracking (metadata only).
- **Data Types**: 
  - Device ID: Not collected
  - Usage Data: Not collected
  - Diagnostics: Yes (Sentry, scrubbed of PII)
- **Data Not Linked to User**: All diagnostics are anonymous
- **Data Not Used for Tracking**: No tracking or advertising

### AI Data-Sharing Consent (Apple Guideline 5.1.2(i))
- Users must explicitly consent to sending data to third-party AI providers (Groq, Anthropic, OpenAI, etc.)
- Consent flow implemented in Onboarding.tsx: privacy step requires explicit opt-in
- Consent recorded with timestamp in `shanaya.ageConsent.v1` localStorage key
- Users can revoke consent at any time via Settings

### Required Disclosures
- [ ] Privacy Policy URL in App Store Connect
- [ ] Terms of Service URL
- [ ] AI companion disclaimer in app description
- [ ] Age rating (18+ for AI companion content)

## Google Play Store

### Data Safety Form
- **Data Collection**: No conversation data collected by Shanaya
- **Data Shared**: None (user configures their own providers)
- **Data Processing**: All processing is client-side or via user-configured providers
- **Security**: Data encrypted in transit (HTTPS) and at rest (local storage)

### Data Types Declared
| Data Type | Collected? | Shared? | Optional? |
|-----------|-----------|---------|-----------|
| Location | No | No | N/A |
| Personal info | No | No | N/A |
| Financial info | No | No | N/A |
| Health & fitness | No | No | N/A |
| Messages | No | No | N/A |
| Photos & videos | No | No | N/A |
| Audio files | No | No | N/A |
| Files & docs | No | No | N/A |
| Calendar | No | No | N/A |
| Contacts | No | No | N/A |
| App activity | No | No | N/A |
| Web browsing | No | No | N/A |
| App info & performance | Yes (Sentry) | No | Yes |
| Device or other IDs | No | No | N/A |

### Required Disclosures
- [ ] Privacy Policy URL in Google Play Console
- [ ] Data Safety form completed
- [ ] Content rating (Mature 17+ for AI companion)
- [ ] Target audience declaration
- [ ] AI data-sharing consent flow documented

## Compliance Checklist

- [ ] Privacy Policy published and linked
- [ ] Terms of Service published and linked
- [ ] Age gating implemented (18+)
- [ ] Consent flows documented
- [ ] Data retention policy documented
- [ ] Third-party provider terms reviewed
- [ ] Audit logging implemented and tested
- [ ] HITL approval flow functional
- [ ] Kill switch functional
- [ ] Export compliance report functional
