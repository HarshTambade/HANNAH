import type { Connect, Plugin } from "vite";
import { CODE_WORKER_CSP } from "../src/services/codeSandbox";

/**
 * The code runner's workers (src/workers/jsRunner.worker.ts and
 * pyRunner.worker.ts) get their own strict Content-Security-Policy, so the
 * browser itself keeps code from the chat off the network. vercel.json sends
 * the same headers on the website; this does it for `vite` and `vite preview`
 * (and so for the end-to-end tests). The desktop and phone apps serve their
 * files without it and rely on the workers' own lockdown.
 */
export function workerPolicyFor(url: string | undefined): string | null {
  const path = (url ?? "").split("?")[0];
  if (/(^|\/)jsRunner\.worker(-[\w-]+)?\.(js|ts)$/.test(path)) return CODE_WORKER_CSP.javascript;
  if (/(^|\/)pyRunner\.worker(-[\w-]+)?\.(js|ts)$/.test(path)) return CODE_WORKER_CSP.python;
  return null;
}

const middleware: Connect.NextHandleFunction = (request, response, next) => {
  const policy = workerPolicyFor(request.url);
  if (policy) response.setHeader("Content-Security-Policy", policy);
  next();
};

export function codeRunnerHeadersPlugin(): Plugin {
  return {
    name: "hannah-code-runner-headers",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
