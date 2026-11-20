"use strict";

/**
 * Static checks on a repository snapshot. Nothing is executed.
 *
 * Every finding names a file and a line and quotes that line, and says how it
 * is known:
 *
 *   certain    a fact about the text (a file that doesn't parse, an import of
 *              a file that isn't there, a conflict marker, a published advisory
 *              for the exact locked version)
 *   likely     true unless the project does something this check can't see
 *              (a bundler alias, a generated file, a monorepo hoist)
 *
 * What a model suspects after reading the code is a different thing and lives
 * in review.js: those findings are "suspected" until something reproduces them.
 *
 * Secrets are reported by kind and place. The value is never copied into a
 * finding.
 */
const acorn = require("acorn");
const posix = require("node:path").posix;
const { JS_LIKE, codeOnly, parseJson } = require("./indexer");

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const SECRET_PATTERNS = [
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/],
  ["Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/],
  ["hard-coded credential", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'`]([A-Za-z0-9+/_=-]{16,})["'`]/i],
];
const PLACEHOLDER = /(example|sample|dummy|placeholder|changeme|your[_-]|xxxx|test|fake|redacted|<[^>]+>|\*{4,}|0{8,}|1234)/i;
const FIXTURE_PATH = /(^|\/)(tests?|__tests__|spec|fixtures?|mocks?|examples?|docs?|e2e|redteam)\/|[._-](test|spec)\.[a-z]+$|\.md$|\.example$/i;

const finding = (rule, severity, confidence, path, line, title, detail, evidence, fix) => ({ rule, severity, confidence, source: "check", file: path, line, title, detail, evidence: String(evidence ?? "").trim().slice(0, 240), ...(fix ? { fix } : {}) });
const lineText = (text, line) => text.split("\n")[line - 1] || "";

/** Does a JavaScript file parse? Returns the error, or null. Files with JSX, Flow or TypeScript syntax aren't judged here. */
function jsSyntaxError(path, text) {
  if (!/\.(js|mjs|cjs)$/.test(path)) return null;
  if (/^\s*(?:\/\/\s*@flow|\/\*\s*@flow)/m.test(text.slice(0, 400))) return null;
  const options = { ecmaVersion: "latest", allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: false, locations: true };
  let first = null;
  for (const sourceType of path.endsWith(".cjs") ? ["script", "module"] : ["module", "script"]) {
    try { acorn.parse(text, { ...options, sourceType }); return null; } catch (error) { first ||= error; }
  }
  // JSX in a .js file is common in React projects; that isn't a syntax error for their build.
  if (/<[A-Za-z][\w.]*(\s[^<>]*)?\/?>/.test(codeOnly(text, "JavaScript")) && /\breact\b|jsx/i.test(text)) return null;
  return { line: first.loc?.line || 1, message: String(first.message).replace(/\s*\(\d+:\d+\)$/, "") };
}

function runChecks(snapshot, index, { only } = {}) {
  const findings = [];
  const wanted = (path) => !only || only.has(path);
  const add = (...args) => findings.push(finding(...args));

  for (const [path, file] of snapshot.files) {
    if (!wanted(path)) continue;
    const text = file.text;
    const record = index.files[path];
    const fixture = FIXTURE_PATH.test(path);

    // Merge conflict markers left in a file.
    const conflict = /^(<{7} |={7}$|>{7} )/m.exec(text);
    if (conflict && /^<{7} /m.test(text) && /^>{7} /m.test(text)) {
      const line = text.slice(0, text.search(/^<{7} /m)).split("\n").length;
      add("conflict-marker", "high", "certain", path, line, "Unresolved merge conflict", "The file still contains conflict markers from a merge, so it holds both versions of the code.", lineText(text, line), "Resolve the conflict and delete the <<<<<<<, ======= and >>>>>>> lines.");
    }

    // Files that don't parse.
    // A file with conflict markers doesn't parse either; the conflict is the thing to report.
    const syntax = conflict && /^<{7} /m.test(text) && /^>{7} /m.test(text) ? null : jsSyntaxError(path, text);
    if (syntax) add("syntax-error", "high", "certain", path, syntax.line, "JavaScript syntax error", `The file doesn't parse: ${syntax.message}. Anything that imports it fails at load time.`, lineText(text, syntax.line));
    if (/\.json$/.test(path) && !/(^|\/)(tsconfig|jsconfig)[\w.-]*\.json$|(^|\/)\.vscode\/|\.code-workspace$|(^|\/)\.eslintrc\.json$|devcontainer\.json$/.test(path) && text.trim() && parseJson(text) === null && text.trim() !== "null") {
      let line = 1;
      try { JSON.parse(text); } catch (error) { const at = Number(/position (\d+)/.exec(error.message)?.[1]); if (Number.isFinite(at)) line = text.slice(0, at).split("\n").length; }
      add("invalid-json", /(^|\/)package\.json$/.test(path) ? "high" : "medium", "certain", path, line, "Invalid JSON", "This file isn't valid JSON, so whatever reads it fails.", lineText(text, line));
    }

    // Secrets committed to the repository.
    if (text.length < 400_000 && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const row = lines[i];
        if (row.length > 2000) continue;
        for (const [kind, pattern] of SECRET_PATTERNS) {
          const match = pattern.exec(row);
          if (!match) continue;
          const value = match[1] || match[0];
          if (PLACEHOLDER.test(value) || PLACEHOLDER.test(row) && kind === "hard-coded credential" || /process\.env|os\.environ|getenv|\$\{/.test(row)) continue;
          if (kind === "hard-coded credential" && new Set(value).size < 8) continue;
          add("secret", fixture ? "low" : "critical", fixture ? "likely" : "certain", path, i + 1, `${kind[0].toUpperCase()}${kind.slice(1)} in the repository`, fixture ? "This looks like a credential in a test or example file. If it is real, it is exposed to everyone who can read the repository." : "A credential is committed in source. Anyone who can read the repository, or its history, has it.", row.replace(value, "‹redacted›"), "Revoke the credential, load it from the environment, and remove it from history.");
          break;
        }
      }
    }

    if (!record || !JS_LIKE.has(record.lang)) continue;

    // Imports that point at nothing, or at a name the target doesn't export.
    const dir = (() => { let at = posix.dirname(path); for (;;) { if (index.dependencyNames.has(at)) return at; if (at === "." || at === "/") return null; at = posix.dirname(at); } })();
    const declared = dir === null ? null : index.dependencyNames.get(dir);
    const rootDeclared = index.dependencyNames.get(".");
    for (const item of record.imports) {
      const source = lineText(text, item.line);
      if (item.missing && !item.alias && !/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|woff2?|ttf|mp3|mp4|glb|wasm|txt|md|graphql|gql)(\?.*)?$/.test(item.spec)) {
        add("missing-import", record.test ? "medium" : "high", snapshot.truncated ? "likely" : "certain", path, item.line, "Import of a file that doesn't exist", `“${item.spec}” resolves to no file in the repository. Loading this module fails.`, source, "Correct the path, or add the missing file.");
        continue;
      }
      if (item.file && !item.typeOnly && item.names?.length) {
        const target = index.files[item.file];
        const exported = target?.exports;
        if (exported && !exported.star && !exported.dynamic && JS_LIKE.has(target.lang) && !/\.(json|vue|svelte)$/.test(item.file)) {
          const known = new Set([...exported.names, ...target.symbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name)]);
          // A CommonJS file with no exports found is one this index couldn't read; say nothing.
          if (known.size) for (const name of item.names) if (!known.has(name) && name !== "default") add("missing-export", "high", "likely", path, item.line, `“${name}” isn't exported by ${item.file}`, `This file imports “${name}” from ${item.file}, which exports: ${[...known].slice(0, 12).join(", ")}${known.size > 12 ? ", …" : ""}. The imported value is undefined (CommonJS) or the import fails (ES modules).`, source, `Export “${name}” from ${item.file}, or import the name it has now.`);
        }
      }
      if (item.external && declared && !declared.has(item.external) && !(rootDeclared && rootDeclared.has(item.external)) && !item.typeOnly && !record.test && !/^(@types\/|\.)/.test(item.external) && !index.aliases.some((prefix) => item.spec.startsWith(prefix))) {
        add("undeclared-dependency", "medium", "likely", path, item.line, `“${item.external}” isn't in package.json`, `This file imports “${item.external}”, which ${dir === "." ? "package.json" : `${dir}/package.json`} doesn't list. It works only while another package happens to install it.`, source, `Add “${item.external}” to the dependencies.`);
      }
    }
  }

  // package.json scripts that run files that aren't there.
  for (const pack of index.packages) {
    if (pack.invalid || (only && !only.has(pack.path))) continue;
    const dir = posix.dirname(pack.path);
    const text = snapshot.files.get(pack.path)?.text || "";
    for (const [name, command] of Object.entries(pack.scripts || {})) {
      for (const match of command.matchAll(/\b(?:node|tsx|ts-node|bash|sh|python3?)\s+(?:--?[\w=-]+\s+)*((?:\.{1,2}\/)?[\w./-]+\.(?:[cm]?[jt]s|sh|py))\b/g)) {
        const target = posix.normalize(posix.join(dir, match[1]));
        if (target.startsWith("..") || snapshot.files.has(target) || snapshot.skipped.some((item) => item.path === target)) continue;
        if (/(^|\/)(dist|build|out|lib|\.next)\//.test(target)) continue;
        const line = text.split("\n").findIndex((row) => row.includes(`"${name}"`)) + 1 || 1;
        add("missing-script-file", "medium", snapshot.truncated ? "likely" : "certain", pack.path, line, `The “${name}” script runs a file that doesn't exist`, `“${command.slice(0, 160)}” refers to ${target}, which isn't in the repository.`, lineText(text, line));
      }
    }
  }
  // Real .env files in the repository.
  for (const path of index.env.committed) {
    if (only && !only.has(path)) continue;
    const text = snapshot.files.get(path)?.text || "";
    if (!/^\s*[A-Z][A-Z0-9_]*\s*=\s*\S+/m.test(text)) continue;
    add("env-file-committed", "high", "likely", path, 1, "An environment file is committed", "Files named .env usually hold real settings and secrets. This one is tracked by git, so its values are in the repository's history.", "(values not shown)", "Remove it from git, add it to .gitignore, and rotate anything it held.");
  }
  return sortFindings(findings);
}

function sortFindings(findings) {
  return findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);
}

// ---------- dependencies: published advisories for the exact locked versions ----------

/** Packages and versions from a lock file: [{ name, version, ecosystem, file, direct }]. */
function lockedPackages(snapshot, index) {
  const out = [];
  for (const [path, file] of snapshot.files) {
    if (/(^|\/)package-lock\.json$/.test(path)) {
      const data = parseJson(file.text);
      const direct = index.dependencyNames.get(posix.dirname(path)) || new Set();
      for (const [key, value] of Object.entries(data?.packages || {})) {
        if (!key || !value?.version || value.link) continue;
        const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
        out.push({ name, version: value.version, ecosystem: "npm", file: path, direct: direct.has(name) && !key.slice(0, key.lastIndexOf("node_modules/")).includes("node_modules/"), dev: Boolean(value.dev) });
      }
    } else if (/(^|\/)requirements[\w.-]*\.txt$/.test(path)) {
      for (const match of file.text.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*==\s*([0-9][\w.!+-]*)/gm)) out.push({ name: match[1], version: match[2], ecosystem: "PyPI", file: path, direct: true, dev: false });
    }
  }
  const seen = new Set();
  return out.filter((item) => { const key = `${item.ecosystem}:${item.name}@${item.version}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * Ask OSV (osv.dev, the open vulnerability database) about the exact versions
 * in the lock file. `request` is the server's outbound client. Returns
 * { findings, checked, note }: on a network failure, `note` says the check
 * didn't run, and nothing is reported as clean.
 */
async function vulnerabilityFindings(snapshot, index, { request, max = 600 } = {}) {
  const packages = lockedPackages(snapshot, index);
  if (!packages.length) return { findings: [], checked: 0, note: "No lock file with exact versions was found, so dependencies weren't checked against advisories." };
  if (!request) return { findings: [], checked: 0, note: "Dependencies weren't checked against advisories (no outbound client)." };
  const subset = [...packages.filter((item) => item.direct), ...packages.filter((item) => !item.direct)].slice(0, max);
  const hits = [];
  try {
    for (let offset = 0; offset < subset.length; offset += 200) {
      const batch = subset.slice(offset, offset + 200);
      const response = await request("https://api.osv.dev/v1/querybatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries: batch.map((item) => ({ package: { name: item.name, ecosystem: item.ecosystem }, version: item.version })) }), timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
      if (response.status >= 400) throw new Error(`OSV answered ${response.status}`);
      const data = JSON.parse(response.body.toString("utf8"));
      (data.results || []).forEach((result, at) => { for (const vuln of result.vulns || []) hits.push({ id: vuln.id, pack: batch[at] }); });
    }
  } catch {
    return { findings: [], checked: 0, note: "The advisory database (osv.dev) couldn't be reached, so dependencies were not checked. This is not a clean result." };
  }
  const details = new Map();
  for (const id of [...new Set(hits.map((hit) => hit.id))].slice(0, 40)) {
    try {
      const response = await request(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { timeoutMs: 12_000, maxBytes: 1024 * 1024 });
      if (response.status < 400) details.set(id, JSON.parse(response.body.toString("utf8")));
    } catch { /* the id alone is still reported */ }
  }
  const byPackage = new Map();
  for (const hit of hits) { const key = `${hit.pack.name}@${hit.pack.version}`; if (!byPackage.has(key)) byPackage.set(key, { pack: hit.pack, ids: [] }); byPackage.get(key).ids.push(hit.id); }
  const findings = [];
  for (const { pack, ids } of byPackage.values()) {
    const known = ids.map((id) => details.get(id)).filter(Boolean);
    const label = (vuln) => String(vuln?.database_specific?.severity || "").toLowerCase();
    const worst = known.map(label).sort((a, b) => (SEVERITY_ORDER[a === "moderate" ? "medium" : a] ?? 9) - (SEVERITY_ORDER[b === "moderate" ? "medium" : b] ?? 9))[0];
    const severity = worst === "critical" ? "critical" : worst === "high" ? "high" : worst === "low" ? "low" : "medium";
    const fixed = [...new Set(known.flatMap((vuln) => (vuln.affected || []).filter((item) => item.package?.name === pack.name).flatMap((item) => (item.ranges || []).flatMap((range) => (range.events || []).map((event) => event.fixed).filter(Boolean)))))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(-4);
    const text = snapshot.files.get(pack.file)?.text || "";
    const at = text.indexOf(`node_modules/${pack.name}"`);
    const line = at >= 0 ? text.slice(0, at).split("\n").length : 1;
    findings.push({
      ...finding("vulnerable-dependency", pack.dev ? (severity === "critical" ? "high" : severity === "high" ? "medium" : "low") : severity, "certain", pack.file, line,
        `${pack.name} ${pack.version} has ${ids.length} published advisor${ids.length === 1 ? "y" : "ies"}`,
        `${known[0]?.summary ? `${String(known[0].summary).slice(0, 220)}. ` : ""}${pack.direct ? "It is a direct dependency." : "It is installed as a dependency of another package."}${pack.dev ? " It is a development dependency, so it doesn't ship." : ""} Whether this project calls the affected code isn't something a version check can tell.`,
        `${pack.name}@${pack.version}`, fixed.length ? (fixed.length === 1 ? `Upgrade to ${fixed[0]} or later.` : `The advisories name these fixed versions: ${fixed.join(", ")}. Upgrading to ${fixed[fixed.length - 1]} or later clears all of them.`) : "Check the advisory for a fixed version."),
      advisories: ids.slice(0, 8), links: ids.slice(0, 4).map((id) => `https://osv.dev/vulnerability/${id}`),
    });
  }
  return { findings: sortFindings(findings), checked: subset.length, total: packages.length, note: subset.length < packages.length ? `${subset.length} of ${packages.length} locked packages were checked.` : undefined };
}

/** Direct npm dependencies behind their registry's latest version. `request` reaches the registry. */
async function outdatedDependencies(snapshot, index, { request, max = 40 } = {}) {
  if (!request) return { outdated: [], checked: 0, note: "Versions weren't compared with the registry (no outbound client)." };
  const direct = lockedPackages(snapshot, index).filter((item) => item.ecosystem === "npm" && item.direct).slice(0, max);
  const outdated = [];
  let checked = 0;
  const major = (version) => Number(String(version).split(".")[0]) || 0;
  await Promise.all(direct.map(async (item) => {
    try {
      const response = await request(`https://registry.npmjs.org/${item.name.replace("/", "%2f")}/latest`, { timeoutMs: 10_000, maxBytes: 512 * 1024, headers: { Accept: "application/json" } });
      if (response.status >= 400) return;
      const latest = JSON.parse(response.body.toString("utf8")).version;
      checked += 1;
      if (latest && latest !== item.version && !/-/.test(latest)) outdated.push({ name: item.name, current: item.version, latest, majorsBehind: Math.max(0, major(latest) - major(item.version)), dev: item.dev });
    } catch { /* not counted as checked */ }
  }));
  outdated.sort((a, b) => b.majorsBehind - a.majorsBehind || a.name.localeCompare(b.name));
  return { outdated, checked, note: checked < direct.length ? `${checked} of ${direct.length} direct dependencies could be compared.` : undefined };
}

module.exports = { FIXTURE_PATH, SEVERITY_ORDER, jsSyntaxError, lockedPackages, outdatedDependencies, runChecks, sortFindings, vulnerabilityFindings };
