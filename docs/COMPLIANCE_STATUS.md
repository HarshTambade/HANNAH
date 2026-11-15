# Shanaya Compliance Status

**Last reviewed:** 15 November 2026  
**Next compliance deadline:** 12 January 2027

## App Store age rating
- Declared rating: **12+** for the current build unless the operator changes it.
- The app does not offer romantic or sexual content, graphic violence, or unrestricted web browsing by default.
- If the operator enables adult-oriented prompts or content, update the rating and descriptor before release.

## Apple 2026-11-16 descriptor check
- Romantic or sexual content: **No** for the default build.
- If this changes, update the App Store Connect age rating and the in-app AgeGateGuard setting.

## Google Play
- Target audience: not directed to children under 13.
- Content rating: complete IARC questionnaire for the shipped build.
- Data Safety form: see `DATA_SAFETY_FORM.md`.

## Release checklist
- [ ] Confirm age rating matches shipped features.
- [ ] Confirm romantic/sexual content descriptor.
- [ ] Confirm `VITE_AGE_GATE_18_PLUS` matches the declared rating.
- [ ] Update privacy policy and terms if data flows changed.
- [ ] Update store metadata and screenshots.
- [ ] Record the compliance review date and owner.
