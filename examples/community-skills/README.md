# Example community skills

These are signed HANNAH community-skill manifests you can install from the
Marketplace → Community skills screen.

1. Open HANNAH, go to **Marketplace → Agents and skills**.
2. Paste one of these files (or open it with **Open file**).
3. Click **Check manifest**, then **Install skill**, and turn it on.

Each manifest is signed with Ed25519. Because the signing key is not in
`shared/trusted-publishers.json`, HANNAH shows it as **signed by an unknown key**
with a fingerprint; confirm the fingerprint with the publisher before trusting it.

Regenerate or re-sign with:

```sh
node server/scripts/sign-skill.js verify examples/community-skills/action-items.signed.json
```
