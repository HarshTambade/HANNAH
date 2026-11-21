# Home world

An example robot package: a simulation environment. It is data, not code.

Sign it with your own key before verifying it:

```bash
node server/scripts/robot-package.js keygen my-key
node server/scripts/robot-package.js sign robotics/sdk/examples/home-world my-key.private.pem
node server/scripts/robot-package.js verify robotics/sdk/examples/home-world my-key.public.pem "me"
```
