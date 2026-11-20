"use strict";

/**
 * The repository index: what a codebase is made of and how its files relate,
 * built from a snapshot without running anything in it.
 *
 *   buildIndex(snapshot) → languages, frameworks, build tools, packages and
 *     their scripts, entry points, tests, CI workflows, environment variable
 *     names (never values), database schema hints, HTTP routes, and per file:
 *     symbols (name, kind, line, exported), imports (resolved to files where
 *     they are relative or aliased), exports, and who imports it.
 *   createSearch(index, snapshot) → find(query): the actual source lines that
 *     bear on a question (BM25 over 50-line chunks, with symbol and path
 *     matches weighted), each with its file and line range.
 *   contextFor(...) → those chunks plus each file's neighbours in the import
 *     graph, for a model that is about to reason about the code.
 *
 * Symbols are found lexically (comments and string contents are blanked
 * first, so a "function" inside a string isn't a symbol). That is a symbol
 * index, not a type checker: it doesn't know types, overloads or dynamic
 * dispatch, and says so where it matters (checks.js marks what it can't know).
 */
const posix = require("node:path").posix;

const LANGUAGES = {
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".swift": "Swift", ".dart": "Dart",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++", ".m": "Objective-C", ".scala": "Scala", ".sh": "Shell", ".bash": "Shell", ".sql": "SQL",
  ".vue": "Vue", ".svelte": "Svelte", ".html": "HTML", ".css": "CSS", ".scss": "CSS",
};
const JS_LIKE = new Set(["JavaScript", "TypeScript", "Vue", "Svelte"]);
const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".vue", ".svelte"];
const NODE_BUILTINS = new Set(["assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "sqlite", "stream", "string_decoder", "sys", "test", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"]);
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else", "do", "try", "with", "new", "typeof", "await", "super", "constructor", "import", "export", "throw", "case", "delete", "void", "yield"]);
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$/i;

const extOf = (path) => { const base = path.slice(path.lastIndexOf("/") + 1); const dot = base.lastIndexOf("."); return dot > 0 ? base.slice(dot).toLowerCase() : ""; };
const languageOf = (path) => LANGUAGES[extOf(path)] || null;
const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
/** JSON with comments and trailing commas (tsconfig). */
const parseJsonc = (text) => parseJson(String(text).replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string || "").replace(/,(\s*[}\]])/g, "$1"));

/**
 * The same text with comments and the insides of strings replaced by spaces.
 * Lines and columns stay where they were.
 */
function codeOnly(text, language) {
  const out = text.split("");
  const blank = (from, to) => { for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " "; };
  const hash = language === "Python" || language === "Ruby" || language === "Shell";
  const slash = !hash || language === "PHP";
  let i = 0;
  const length = text.length;
  while (i < length) {
    const char = text[i];
    const next = text[i + 1];
    if (slash && char === "/" && next === "/") { const end = text.indexOf("\n", i); const stop = end < 0 ? length : end; blank(i, stop); i = stop; continue; }
    if (slash && char === "/" && next === "*") { const end = text.indexOf("*/", i + 2); const stop = end < 0 ? length : end + 2; blank(i, stop); i = stop; continue; }
    if (hash && char === "#") { const end = text.indexOf("\n", i); const stop = end < 0 ? length : end; blank(i, stop); i = stop; continue; }
    if (language === "Python" && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const quote = text.slice(i, i + 3);
      const end = text.indexOf(quote, i + 3);
      const stop = end < 0 ? length : end + 3;
      blank(i + 3, Math.max(i + 3, stop - 3));
      i = stop;
      continue;
    }
    if (char === '"' || char === "'" || (char === "`" && JS_LIKE.has(language))) {
      let j = i + 1;
      while (j < length && text[j] !== char) {
        if (text[j] === "\\") j += 1;
        else if (text[j] === "\n" && char !== "`") break;
        j += 1;
      }
      blank(i + 1, Math.min(j, length));
      i = Math.min(j + 1, length);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

const lineAt = (text, index) => { let line = 1; for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1; return line; };

function jsImports(text, code) {
  const imports = [];
  const live = (index) => code[index] !== " " || /\S/.test(code.slice(index, index + 6));
  const names = (clause) => {
    const out = { names: [], default: null, namespace: null };
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) out.names = braces[1].split(",").map((item) => item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim()).filter((item) => /^[\w$]+$/.test(item));
    const rest = clause.replace(/\{[^}]*\}/, "").replace(/^type\s+/, "");
    const star = /\*\s+as\s+([\w$]+)/.exec(rest);
    if (star) out.namespace = star[1];
    const first = rest.replace(/\*\s+as\s+[\w$]+/, "").split(",")[0].trim();
    if (/^[\w$]+$/.test(first)) out.default = first;
    return out;
  };
  for (const match of text.matchAll(/(^|[\n;])\s*import\s+([^'";]+?)\s+from\s+['"]([^'"\n]+)['"]/g)) {
    const at = match.index + match[0].indexOf("import");
    if (live(at)) imports.push({ spec: match[3], line: lineAt(text, at), typeOnly: /^type\s/.test(match[2]), ...names(match[2]) });
  }
  for (const match of text.matchAll(/(^|[\n;])\s*import\s+['"]([^'"\n]+)['"]/g)) {
    const at = match.index + match[0].indexOf("import");
    if (live(at)) imports.push({ spec: match[2], line: lineAt(text, at), names: [], default: null, namespace: null, sideEffect: true });
  }
  for (const match of text.matchAll(/(^|[\n;])\s*export\s+(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g)) {
    const at = match.index + match[0].indexOf("export");
    if (live(at)) imports.push({ spec: match[3], line: lineAt(text, at), reexport: true, ...(match[2].startsWith("*") ? { names: [], default: null, namespace: "*" } : names(match[2])) });
  }
  for (const match of text.matchAll(/(?:(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*)?(?:await\s+)?\b(require|import)\(\s*['"]([^'"\n]+)['"]\s*\)/g)) {
    const at = match.index + match[0].lastIndexOf(match[2]);
    if (!live(at)) continue;
    const bound = match[1] || "";
    imports.push({ spec: match[3], line: lineAt(text, at), dynamic: match[2] === "import", names: bound.startsWith("{") ? bound.slice(1, -1).split(",").map((item) => item.trim().split(":")[0].trim()).filter((item) => /^[\w$]+$/.test(item)) : [], default: bound && !bound.startsWith("{") ? bound : null, namespace: null, commonjs: match[2] === "require" });
  }
  return imports;
}

function jsSymbols(code) {
  const symbols = [];
  const exported = { names: new Set(), star: false, dynamic: false, default: false };
  const lines = code.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const add = (name, kind, isExported) => { symbols.push({ name, kind, line: index + 1, exported: Boolean(isExported) }); if (isExported) exported.names.add(name); };
    let match;
    if ((match = /^(\s*)(export\s+)?(default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/.exec(line))) { add(match[4], "function", match[2]); if (match[3]) exported.default = true; continue; }
    if ((match = /^(\s*)(export\s+)?(default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) { add(match[4], "class", match[2]); if (match[3]) exported.default = true; continue; }
    if ((match = /^(\s*)(export\s+)?(?:declare\s+)?(interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/.exec(line))) { add(match[4], match[3] === "enum" ? "enum" : "type", match[2]); continue; }
    if ((match = /^(\s*)(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/.exec(line))) {
      const isFunction = /^(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>|\($|<[^>]+>\s*\()/.test(match[4]);
      if (isFunction) add(match[3], "function", match[2]);
      else if (match[2] || match[1] === "") add(match[3], "variable", match[2]);
      continue;
    }
    if (/^\s*export\s+default\b/.test(line)) { exported.default = true; continue; }
    if ((match = /^\s*export\s+\{([^}]*)\}\s*(?:;|$)/.exec(line))) { for (const item of match[1].split(",")) { const name = item.trim().split(/\s+as\s+/).pop().trim(); if (/^[\w$]+$/.test(name)) exported.names.add(name); } continue; }
    if (/^\s*export\s+\*\s+from\b/.test(line)) { exported.star = true; continue; }
    if ((match = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/.exec(line))) { exported.names.add(match[1]); continue; }
    if ((match = /^(\s+)(?:(?:static|async|public|private|protected|readonly|override|get|set)\s+)*\*?([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/.exec(line)) && !KEYWORDS.has(match[2])) { symbols.push({ name: match[2], kind: "method", line: index + 1, exported: false }); continue; }
  }
  const whole = /module\.exports\s*=\s*([^;\n]*)/.exec(code);
  if (whole) {
    const object = /module\.exports\s*=\s*\{([^}]*)\}/.exec(code);
    if (object && !/\.\.\./.test(object[1])) for (const item of object[1].split(",")) { const name = item.trim().split(":")[0].trim(); if (/^[\w$]+$/.test(name)) exported.names.add(name); }
    else if (object) exported.dynamic = true;
    else if (/^[\w$]+\s*$/.test(whole[1])) { exported.default = true; exported.dynamic = true; } else exported.dynamic = true;
  }
  for (const symbol of symbols) if (exported.names.has(symbol.name)) symbol.exported = true;
  return { symbols, exported: { names: [...exported.names], star: exported.star, dynamic: exported.dynamic, default: exported.default } };
}

function otherSymbols(code, language) {
  const symbols = [];
  const imports = [];
  const lines = code.split("\n");
  const push = (name, kind, index, isExported = false) => symbols.push({ name, kind, line: index + 1, exported: isExported });
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match;
    if (language === "Python") {
      if ((match = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(line))) push(match[2], match[1] ? "method" : "function", index, !match[1] && !match[2].startsWith("_"));
      else if ((match = /^(\s*)class\s+(\w+)/.exec(line))) push(match[2], "class", index, !match[1]);
      else if ((match = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(line))) imports.push({ spec: match[1], line: index + 1, names: match[2].replace(/[()]/g, "").split(",").map((item) => item.trim().split(/\s+as\s+/)[0]).filter((item) => /^\w+$/.test(item)), default: null, namespace: null });
      else if ((match = /^\s*import\s+([\w., ]+)$/.exec(line))) for (const item of match[1].split(",")) imports.push({ spec: item.trim().split(/\s+as\s+/)[0], line: index + 1, names: [], default: null, namespace: null });
    } else if (language === "Go") {
      if ((match = /^func\s+(?:\([^)]*\)\s*)?(\w+)/.exec(line))) push(match[1], "function", index, /^[A-Z]/.test(match[1]));
      else if ((match = /^type\s+(\w+)\s+(struct|interface)/.exec(line))) push(match[1], "type", index, /^[A-Z]/.test(match[1]));
    } else if (language === "Rust") {
      if ((match = /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/.exec(line))) push(match[2], "function", index, Boolean(match[1]));
      else if ((match = /^\s*(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod)\s+(\w+)/.exec(line))) push(match[3], "type", index, Boolean(match[1]));
    } else {
      if ((match = /\b(class|interface|enum|struct|trait|object|module|protocol|extension)\s+([A-Za-z_]\w*)/.exec(line))) push(match[2], "class", index, /\b(public|export|open)\b/.test(line));
      else if ((match = /\b(fun|func|def|function|sub)\s+([A-Za-z_]\w*)\s*[(<]/.exec(line))) push(match[2], "function", index, /\b(public|export|open)\b/.test(line));
    }
  }
  return { symbols, imports };
}

/** Where a JavaScript or TypeScript import points, among the snapshot's files. */
function createResolver(files) {
  const aliases = [];
  for (const config of [...files.keys()].filter((name) => /(^|\/)(tsconfig|jsconfig)(\.[\w-]+)?\.json$/.test(name))) {
    const data = parseJsonc(files.get(config).text);
    const paths = data?.compilerOptions?.paths;
    const base = posix.join(posix.dirname(config), data?.compilerOptions?.baseUrl || ".");
    if (paths && typeof paths === "object") {
      for (const [pattern, targets] of Object.entries(paths)) {
        const target = Array.isArray(targets) ? targets[0] : null;
        if (typeof target !== "string") continue;
        aliases.push({ root: posix.dirname(config), prefix: pattern.replace(/\*$/, ""), target: posix.join(base, target.replace(/\*$/, "")), exact: !pattern.endsWith("*") });
      }
    }
  }
  const tryFile = (candidate) => {
    const clean = posix.normalize(candidate).replace(/^\.\//, "");
    if (files.has(clean) && extOf(clean)) return clean;
    for (const ext of JS_EXTS) if (files.has(clean + ext)) return clean + ext;
    // TypeScript sources are imported with the extension they compile to.
    const swapped = clean.replace(/\.(m|c)?js$/, (_all, kind) => `.${kind || ""}ts`);
    if (swapped !== clean && files.has(swapped)) return swapped;
    if (clean.endsWith(".js") && files.has(clean.replace(/\.js$/, ".tsx"))) return clean.replace(/\.js$/, ".tsx");
    if (clean.endsWith(".jsx") && files.has(clean.replace(/\.jsx$/, ".tsx"))) return clean.replace(/\.jsx$/, ".tsx");
    for (const ext of JS_EXTS) if (files.has(`${clean}/index${ext}`)) return `${clean}/index${ext}`;
    if (files.has(clean)) return clean;
    return null;
  };
  return {
    aliases,
    /** → { file } when it resolves in the repository, { external: "pkg" } for a package, { missing: true } when it should be a file and isn't. */
    resolve(from, spec) {
      if (spec.startsWith(".")) { const file = tryFile(posix.join(posix.dirname(from), spec.replace(/\?.*$/, ""))); return file ? { file } : { missing: true }; }
      if (spec.startsWith("/")) return { unknown: true };
      for (const alias of aliases) {
        if (!(from === alias.root || alias.root === "." || from.startsWith(`${alias.root}/`))) continue;
        if (alias.exact ? spec === alias.prefix : spec.startsWith(alias.prefix)) {
          const file = tryFile(alias.exact ? alias.target : alias.target + spec.slice(alias.prefix.length));
          return file ? { file } : { missing: true, alias: true };
        }
      }
      if (/^(node|bun|deno|npm|jsr):/.test(spec)) return spec.startsWith("npm:") ? { external: spec.slice(4).replace(/@[^/]*$/, "") } : { builtin: true };
      if (/^[@~#]\//.test(spec) || spec === "@" || spec.startsWith("virtual:") || spec.startsWith("$")) return { unknown: true };
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (NODE_BUILTINS.has(name)) return { builtin: true };
      return { external: name };
    },
  };
}

const FRAMEWORK_DEPS = [
  ["react", "React"], ["next", "Next.js"], ["vue", "Vue"], ["nuxt", "Nuxt"], ["svelte", "Svelte"], ["@angular/core", "Angular"], ["express", "Express"], ["fastify", "Fastify"], ["koa", "Koa"], ["@nestjs/core", "NestJS"], ["hono", "Hono"],
  ["vite", "Vite"], ["webpack", "webpack"], ["electron", "Electron"], ["@capacitor/core", "Capacitor"], ["react-native", "React Native"], ["expo", "Expo"], ["tailwindcss", "Tailwind CSS"],
  ["prisma", "Prisma"], ["@prisma/client", "Prisma"], ["drizzle-orm", "Drizzle"], ["sequelize", "Sequelize"], ["typeorm", "TypeORM"], ["mongoose", "Mongoose"], ["pg", "PostgreSQL client"], ["mysql2", "MySQL client"], ["better-sqlite3", "SQLite"], ["mongodb", "MongoDB client"], ["redis", "Redis client"],
  ["jest", "Jest"], ["vitest", "Vitest"], ["mocha", "Mocha"], ["@playwright/test", "Playwright"], ["cypress", "Cypress"], ["eslint", "ESLint"], ["typescript", "TypeScript compiler"],
  ["passport", "Passport"], ["next-auth", "NextAuth"], ["jsonwebtoken", "JWT"], ["stripe", "Stripe"], ["graphql", "GraphQL"], ["socket.io", "Socket.IO"], ["three", "Three.js"],
];
const PY_FRAMEWORKS = [["django", "Django"], ["flask", "Flask"], ["fastapi", "FastAPI"], ["sqlalchemy", "SQLAlchemy"], ["pytest", "pytest"], ["celery", "Celery"], ["pydantic", "Pydantic"], ["torch", "PyTorch"], ["pandas", "pandas"]];

function buildIndex(snapshot) {
  const files = snapshot.files;
  const resolver = createResolver(files);
  const perFile = {};
  const languages = new Map();
  let totalLines = 0;
  for (const [path, file] of files) {
    const language = languageOf(path);
    const lines = file.text ? file.text.split("\n").length : 0;
    totalLines += lines;
    if (language) { const entry = languages.get(language) || { name: language, files: 0, lines: 0 }; entry.files += 1; entry.lines += lines; languages.set(language, entry); }
    const record = { lang: language, lines, symbols: [], imports: [], exports: null, importedBy: [], test: TEST_FILE.test(path) };
    if (language && file.text.length <= 400_000) {
      const code = codeOnly(file.text, language);
      if (JS_LIKE.has(language)) {
        const { symbols, exported } = jsSymbols(code);
        record.symbols = symbols.slice(0, 400);
        record.exports = exported;
        record.imports = jsImports(file.text, code).map((item) => ({ ...item, ...resolver.resolve(path, item.spec) }));
      } else {
        const { symbols, imports } = otherSymbols(code, language);
        record.symbols = symbols.slice(0, 400);
        record.imports = imports;
      }
    }
    perFile[path] = record;
  }
  for (const [path, record] of Object.entries(perFile)) for (const item of record.imports) if (item.file && perFile[item.file] && !perFile[item.file].importedBy.includes(path)) perFile[item.file].importedBy.push(path);

  // Packages, scripts, frameworks.
  const packages = [];
  const frameworks = new Set();
  const buildSystems = new Set();
  const dependencyNames = new Map();
  for (const [path, file] of files) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base === "package.json") {
      const data = parseJson(file.text);
      if (!data) { packages.push({ path, invalid: true }); continue; }
      const all = { ...data.dependencies, ...data.devDependencies, ...data.peerDependencies, ...data.optionalDependencies };
      dependencyNames.set(posix.dirname(path), new Set(Object.keys(all)));
      for (const [dep, label] of FRAMEWORK_DEPS) if (all[dep]) frameworks.add(label);
      packages.push({ path, name: data.name || "", version: data.version || "", private: Boolean(data.private), type: data.type || "commonjs", main: data.main || data.module || "", bin: data.bin ? (typeof data.bin === "string" ? [data.bin] : Object.values(data.bin)) : [], scripts: data.scripts && typeof data.scripts === "object" ? Object.fromEntries(Object.entries(data.scripts).slice(0, 60).map(([key, value]) => [key, String(value).slice(0, 300)])) : {}, dependencies: Object.keys(data.dependencies || {}).length, devDependencies: Object.keys(data.devDependencies || {}).length, workspaces: Array.isArray(data.workspaces) ? data.workspaces : data.workspaces?.packages || [], engines: data.engines || null });
      buildSystems.add("npm scripts");
    } else if (base === "requirements.txt" || base === "pyproject.toml" || base === "Pipfile") {
      buildSystems.add(base === "pyproject.toml" ? "pyproject" : base === "Pipfile" ? "Pipenv" : "pip");
      const lower = file.text.toLowerCase();
      for (const [dep, label] of PY_FRAMEWORKS) if (new RegExp(`(^|[\\s"'\\[,])${dep}([\\s"'=<>~!\\],]|$)`, "m").test(lower)) frameworks.add(label);
    } else if (base === "go.mod") { buildSystems.add("Go modules"); if (/gin-gonic\/gin/.test(file.text)) frameworks.add("Gin"); }
    else if (base === "Cargo.toml") { buildSystems.add("Cargo"); for (const [dep, label] of [["actix-web", "Actix"], ["axum", "Axum"], ["tokio", "Tokio"], ["tauri", "Tauri"]]) if (new RegExp(`^${dep}\\s*=`, "m").test(file.text)) frameworks.add(label); }
    else if (base === "pom.xml") { buildSystems.add("Maven"); if (/spring-boot/.test(file.text)) frameworks.add("Spring Boot"); }
    else if (/^build\.gradle(\.kts)?$/.test(base)) { buildSystems.add("Gradle"); if (/spring-boot/.test(file.text)) frameworks.add("Spring Boot"); if (/com\.android\./.test(file.text)) frameworks.add("Android"); }
    else if (base === "Gemfile") { buildSystems.add("Bundler"); if (/['"]rails['"]/.test(file.text)) frameworks.add("Rails"); }
    else if (base === "composer.json") { buildSystems.add("Composer"); if (/laravel\/framework/.test(file.text)) frameworks.add("Laravel"); }
    else if (base === "Makefile") buildSystems.add("Make");
    else if (/^Dockerfile/.test(base) || /^docker-compose.*\.ya?ml$/.test(base)) buildSystems.add("Docker");
    else if (base === "pubspec.yaml") { buildSystems.add("pub"); if (/flutter:/.test(file.text)) frameworks.add("Flutter"); }
  }
  const lockfiles = [...files.keys()].filter((name) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(name));
  const packageManager = lockfiles.some((name) => name.endsWith("pnpm-lock.yaml")) ? "pnpm" : lockfiles.some((name) => name.endsWith("yarn.lock")) ? "yarn" : packages.length ? "npm" : null;

  // Entry points.
  const entryPoints = new Set();
  for (const pack of packages) {
    const dir = posix.dirname(pack.path);
    for (const target of [pack.main, ...(pack.bin || [])].filter(Boolean)) { const resolved = resolver.resolve(`${dir}/package.json`, `./${String(target).replace(/^\.\//, "")}`); if (resolved.file) entryPoints.add(resolved.file); }
    for (const script of ["start", "dev", "serve"]) { const found = /\b(?:node|tsx|ts-node|nodemon|bun)\s+(?:--[\w=-]+\s+)*([\w./-]+\.(?:[cm]?[jt]s))/.exec(pack.scripts?.[script] || ""); if (found) { const file = posix.normalize(posix.join(dir, found[1])); if (files.has(file)) entryPoints.add(file); } }
  }
  for (const path of files.keys()) if (/(^|\/)(src\/)?(main|index|app|server)\.(m?[jt]sx?|py|go|rs)$/.test(path) && path.split("/").length <= 3 || /(^|\/)(manage\.py|wsgi\.py|asgi\.py|main\.go|src\/main\.rs|cmd\/[^/]+\/main\.go)$/.test(path)) entryPoints.add(path);

  // Tests and CI.
  const testFiles = Object.entries(perFile).filter(([, record]) => record.test && record.lang).map(([path]) => path);
  const testCommands = [];
  for (const pack of packages) for (const name of ["test", "lint", "typecheck", "type-check", "check", "build"]) if (pack.scripts?.[name]) testCommands.push({ dir: posix.dirname(pack.path), script: name, command: `${packageManager || "npm"} run ${name}`, runs: pack.scripts[name] });
  if ([...files.keys()].some((name) => /(^|\/)(pytest\.ini|conftest\.py)$/.test(name)) || frameworks.has("pytest")) testCommands.push({ dir: ".", script: "pytest", command: "python -m pytest -q", runs: "pytest" });
  if (buildSystems.has("Go modules")) testCommands.push({ dir: ".", script: "go test", command: "go test ./...", runs: "go test" });
  if (buildSystems.has("Cargo")) testCommands.push({ dir: ".", script: "cargo test", command: "cargo test", runs: "cargo test" });
  const ci = [];
  for (const [path, file] of files) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) && !/^(\.gitlab-ci\.yml|bitbucket-pipelines\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile)$/.test(path)) continue;
    const name = /^name:\s*["']?([^"'\n]+)/m.exec(file.text)?.[1]?.trim() || path;
    const triggers = /^on:\s*(.*)$/m.exec(file.text)?.[1]?.trim() || "";
    const runs = [...file.text.matchAll(/^\s*-?\s*run:\s*(?:[|>][+-]?\s*\n((?:\s{6,}.*\n?)+)|(.+))$/gm)].map((match) => String(match[2] || match[1] || "").trim().split("\n")[0].trim()).filter(Boolean).slice(0, 40);
    ci.push({ file: path, name, triggers: triggers.slice(0, 120), jobs: [...file.text.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((match) => match[1]).filter((job) => !["push", "pull_request", "workflow_dispatch", "schedule"].includes(job)).slice(0, 30), runs });
  }

  // Environment (names only), database, routes.
  const envFiles = [...files.keys()].filter((name) => /(^|\/)\.env(\.[\w.-]+)?$/.test(name));
  const envNames = new Set();
  for (const name of envFiles.filter((item) => /example|sample|template/.test(item))) for (const match of files.get(name).text.matchAll(/^\s*([A-Z][A-Z0-9_]{2,})\s*=/gm)) envNames.add(match[1]);
  const tables = new Set();
  const migrations = [];
  const routes = [];
  for (const [path, file] of files) {
    const record = perFile[path];
    if (!record.lang && !/\.(sql|prisma)$/.test(path)) continue;
    const text = file.text;
    if (text.length > 400_000) continue;
    if (JS_LIKE.has(record.lang) || record.lang === "Python") for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})|process\.env\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]|os\.environ(?:\.get)?[[(]\s*["']([A-Z][A-Z0-9_]{2,})["']|os\.getenv\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) envNames.add(match[1] || match[2] || match[3] || match[4]);
    if (/CREATE\s+TABLE/i.test(text)) for (const match of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_][\w.]*)/gi)) tables.add(match[1]);
    if (path.endsWith(".prisma")) for (const match of text.matchAll(/^model\s+(\w+)/gm)) tables.add(match[1]);
    if (/(^|\/)(migrations?|migrate|alembic\/versions|db\/migrate)\//.test(path) || /migrations?\.[cm]?[jt]s$/.test(path)) migrations.push(path);
    if (JS_LIKE.has(record.lang) && routes.length < 400) for (const match of text.matchAll(/\b(app|router|server|api|route)\.(get|post|put|patch|delete|all|use)\(\s*["'`]([^"'`\n]{1,160})["'`]/g)) { if (match[2] === "use" && !match[3].startsWith("/")) continue; routes.push({ method: match[2].toUpperCase(), path: match[3], file: path, line: lineAt(text, match.index) }); }
    if (record.lang === "Python" && routes.length < 400) for (const match of text.matchAll(/@(?:\w+)\.(get|post|put|patch|delete|route)\(\s*["']([^"'\n]{1,160})["']/g)) routes.push({ method: match[1] === "route" ? "ANY" : match[1].toUpperCase(), path: match[2], file: path, line: lineAt(text, match.index) });
  }
  const dbEngines = ["PostgreSQL client", "MySQL client", "SQLite", "MongoDB client", "Redis client", "Prisma", "Drizzle", "Sequelize", "TypeORM", "Mongoose", "SQLAlchemy"].filter((name) => frameworks.has(name));
  const hubs = Object.entries(perFile).filter(([, record]) => record.importedBy.length >= 3).sort((a, b) => b[1].importedBy.length - a[1].importedBy.length).slice(0, 25).map(([path, record]) => ({ path, importedBy: record.importedBy.length }));
  const languageList = [...languages.values()].sort((a, b) => b.lines - a.lines);
  const codeLines = languageList.reduce((sum, item) => sum + item.lines, 0) || 1;

  return {
    stats: { files: files.size, lines: totalLines, bytes: snapshot.bytes || 0, skipped: snapshot.skipped.length, truncated: Boolean(snapshot.truncated), symbols: Object.values(perFile).reduce((sum, record) => sum + record.symbols.length, 0) },
    languages: languageList.map((item) => ({ ...item, share: Math.round((item.lines / codeLines) * 100) })),
    frameworks: [...frameworks].sort(), buildSystems: [...buildSystems].sort(), packageManager,
    packages, dependencyNames, entryPoints: [...entryPoints].slice(0, 30), hubs,
    tests: { files: testFiles.length, commands: testCommands, examples: testFiles.slice(0, 12) },
    ci, env: { files: envFiles, names: [...envNames].sort().slice(0, 200), committed: envFiles.filter((name) => !/example|sample|template|\.dist$/.test(name)) },
    database: { engines: dbEngines, migrations: migrations.slice(0, 60), tables: [...tables].slice(0, 150) },
    routes: routes.slice(0, 400), files: perFile, aliases: resolver.aliases.map((alias) => alias.prefix),
  };
}

/** What is remembered about a repository between sessions: its shape, never its code. */
function overviewOf(index) {
  return {
    stats: index.stats, languages: index.languages.slice(0, 8), frameworks: index.frameworks, buildSystems: index.buildSystems, packageManager: index.packageManager,
    packages: index.packages.slice(0, 20).map((pack) => ({ path: pack.path, name: pack.name, scripts: Object.keys(pack.scripts || {}).slice(0, 20), dependencies: pack.dependencies, devDependencies: pack.devDependencies, invalid: pack.invalid || undefined })),
    entryPoints: index.entryPoints.slice(0, 15), hubs: index.hubs.slice(0, 12),
    tests: { files: index.tests.files, commands: index.tests.commands.map(({ dir, script, command }) => ({ dir, script, command })) },
    ci: index.ci.map(({ file, name, jobs }) => ({ file, name, jobs })), env: { names: index.env.names.slice(0, 80), committed: index.env.committed },
    database: index.database, routes: index.routes.length,
  };
}

// ---------- search ----------

const tokens = (text) => {
  const out = [];
  for (const word of String(text).split(/[^A-Za-z0-9_$]+/)) {
    if (word.length < 2 || word.length > 60) continue;
    const lower = word.toLowerCase();
    out.push(lower);
    const parts = word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_$]+/g, " ").toLowerCase().split(/\s+/).filter((part) => part.length > 1);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
};
const STOP = new Set(["the", "is", "in", "to", "of", "and", "or", "for", "why", "my", "this", "that", "with", "it", "on", "be", "are", "was", "an", "fix", "bug", "issue", "error", "code", "file", "does", "not", "when", "how", "what", "all", "find", "from", "please", "make", "can", "you"]);
const CHUNK = 50;
const OVERLAP = 10;

function createSearch(index, snapshot) {
  const chunks = [];
  const frequency = new Map();
  for (const [path, file] of snapshot.files) {
    const record = index.files[path];
    if (!record?.lang && !/\.(json|ya?ml|toml|md|sql|prisma|env\.example)$/.test(path)) continue;
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path) || file.text.length > 400_000) continue;
    const lines = file.text.split("\n");
    for (let start = 0; start < lines.length; start += CHUNK - OVERLAP) {
      const text = lines.slice(start, start + CHUNK).join("\n");
      if (!text.trim()) continue;
      const counts = new Map();
      for (const token of tokens(text)) counts.set(token, (counts.get(token) || 0) + 1);
      // The path and the symbols defined here count for more than a mention.
      for (const token of tokens(path)) counts.set(token, (counts.get(token) || 0) + 2);
      for (const symbol of record?.symbols || []) if (symbol.line > start && symbol.line <= start + CHUNK) for (const token of tokens(symbol.name)) counts.set(token, (counts.get(token) || 0) + 3);
      let length = 0;
      for (const [token, count] of counts) { length += count; frequency.set(token, (frequency.get(token) || 0) + 1); }
      chunks.push({ path, start: start + 1, end: Math.min(lines.length, start + CHUNK), counts, length, test: Boolean(record?.test) });
      if (start + CHUNK >= lines.length) break;
    }
  }
  const average = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / (chunks.length || 1);
  const total = chunks.length || 1;
  return {
    chunks: chunks.length,
    find(query, { limit = 12, includeTests = true, paths } = {}) {
      const terms = [...new Set(tokens(query).filter((token) => !STOP.has(token)))];
      if (!terms.length) return [];
      const scored = [];
      for (const chunk of chunks) {
        if (!includeTests && chunk.test) continue;
        if (paths && !paths.some((prefix) => chunk.path.startsWith(prefix))) continue;
        let score = 0;
        for (const term of terms) {
          const count = chunk.counts.get(term);
          if (!count) continue;
          const idf = Math.log(1 + (total - (frequency.get(term) || 0) + 0.5) / ((frequency.get(term) || 0) + 0.5));
          score += idf * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * (chunk.length / average)));
        }
        if (score > 0) scored.push({ path: chunk.path, start: chunk.start, end: chunk.end, score: chunk.test ? score * 0.8 : score });
      }
      scored.sort((a, b) => b.score - a.score);
      // Overlapping chunks of one file say the same thing twice.
      const kept = [];
      for (const item of scored) {
        if (kept.some((other) => other.path === item.path && item.start <= other.end && item.end >= other.start)) continue;
        kept.push(item);
        if (kept.length >= limit) break;
      }
      return kept;
    },
  };
}

/** Lines start..end of a file, each prefixed with its number, as a model should read source. */
function numbered(text, start = 1, end = Infinity) {
  const lines = text.split("\n");
  const last = Math.min(lines.length, end);
  const width = String(last).length;
  const out = [];
  for (let line = Math.max(1, start); line <= last; line += 1) out.push(`${String(line).padStart(width)}| ${lines[line - 1]}`);
  return out.join("\n");
}

/** Where a name is defined, and where else it appears. */
function findSymbol(index, snapshot, name, { limit = 40 } = {}) {
  const definitions = [];
  for (const [path, record] of Object.entries(index.files)) for (const symbol of record.symbols) if (symbol.name === name) definitions.push({ path, line: symbol.line, kind: symbol.kind, exported: symbol.exported });
  const references = [];
  const pattern = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`);
  outer: for (const [path, file] of snapshot.files) {
    if (!index.files[path]?.lang || !file.text.includes(name)) continue;
    const lines = file.text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!pattern.test(lines[i])) continue;
      if (definitions.some((item) => item.path === path && item.line === i + 1)) continue;
      references.push({ path, line: i + 1, text: lines[i].trim().slice(0, 200) });
      if (references.length >= limit) break outer;
    }
  }
  return { name, definitions, references };
}

/**
 * The source a model needs for a question: the best-matching chunks (whole
 * small files rather than fragments), and for each file what it imports from
 * the repository and who imports it.
 */
function contextFor(index, snapshot, search, query, { maxChars = 36_000, limit = 10, focus = [] } = {}) {
  const hits = search.find(query, { limit: limit * 2 });
  const order = [...new Set([...focus.filter((path) => snapshot.files.has(path)), ...hits.map((hit) => hit.path)])];
  const pieces = [];
  let used = 0;
  for (const path of order) {
    const file = snapshot.files.get(path);
    const fileHits = hits.filter((hit) => hit.path === path);
    const whole = file.text.length <= 9_000 || (focus.includes(path) && file.text.length <= 24_000);
    const ranges = whole ? [{ start: 1, end: file.text.split("\n").length }] : (fileHits.length ? fileHits : [{ start: 1, end: 80 }]).slice(0, 3).map((hit) => ({ start: Math.max(1, hit.start - 5), end: hit.end + 5 }));
    for (const range of ranges) {
      const text = numbered(file.text, range.start, range.end);
      if (used + text.length > maxChars) continue;
      used += text.length;
      pieces.push({ path, startLine: range.start, endLine: Math.min(range.end, file.text.split("\n").length), whole, text });
    }
    if (pieces.length >= limit + focus.length) break;
  }
  const files = [...new Set(pieces.map((piece) => piece.path))];
  const related = {};
  for (const path of files) {
    const record = index.files[path];
    if (!record) continue;
    related[path] = { imports: [...new Set(record.imports.map((item) => item.file).filter(Boolean))].slice(0, 12), importedBy: record.importedBy.slice(0, 12), exports: record.exports?.names?.slice(0, 30) || record.symbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name).slice(0, 30) };
  }
  return { pieces, files, related };
}

module.exports = { JS_LIKE, NODE_BUILTINS, TEST_FILE, buildIndex, codeOnly, contextFor, createResolver, createSearch, extOf, findSymbol, languageOf, lineAt, numbered, overviewOf, parseJson, parseJsonc, tokens };
