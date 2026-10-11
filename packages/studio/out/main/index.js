"use strict";
const editorApi = require("@agile-sofl/editor-api");
const node_fs = require("node:fs");
const node_path = require("node:path");
const parser = require("@agile-sofl/parser");
const electron = require("electron");
const promises = require("node:fs/promises");
const gui = require("@agile-sofl/gui");
const node_crypto = require("node:crypto");
const node_url = require("node:url");
const initSqlJs = require("sql.js");
const node_module = require("node:module");
const node_child_process = require("node:child_process");
const node_util = require("node:util");
const WRITE_FIELDS = ["toText", "fsf", "pre", "post", "newText", "text"];
function repairAsflSurface(input) {
  const parts = splitProtected(input);
  const notes = [];
  let unresolved = null;
  const text = parts.map((part) => {
    if (!part.code) return part.text;
    const repaired = repairCode(part.text);
    notes.push(...repaired.notes);
    if (repaired.unresolved) unresolved = repaired.unresolved;
    return repaired.text;
  }).join("");
  return { text, notes: [...new Set(notes)], unresolved };
}
function normalizeHybridPatch(patch) {
  const notes = [];
  const unresolved = [];
  const operations = (patch.operations ?? []).map((op) => {
    const next = { ...op };
    for (const field of WRITE_FIELDS) {
      const value = next[field];
      if (typeof value !== "string" || !value) continue;
      const repaired = repairAsflSurface(value);
      next[field] = repaired.text;
      notes.push(...repaired.notes);
      if (repaired.unresolved) unresolved.push(`${field}: ${repaired.unresolved}`);
    }
    return next;
  });
  const unique = [...new Set(notes)];
  const explanation = unique.length ? [patch.explanation, `Auto-repaired illegal ASFL: ${unique.join("; ")}.`].filter((part) => part && String(part).trim()).join("\n") : patch.explanation;
  return {
    patch: { ...patch, operations, explanation },
    notes: unique,
    unresolved: unresolved.length ? unresolved.join("; ") : null
  };
}
function repairCode(code) {
  const notes = [];
  let text = code;
  if (text.includes("!=")) {
    text = text.replace(/!=/g, "<>");
    notes.push("rewrote != to <>");
  }
  if (text.includes("'")) {
    const stripped = text.replace(/'/g, "");
    if (stripped !== text) {
      text = stripped;
      notes.push("dropped VDM post-state prime (')");
    }
  }
  let guard = 0;
  let carets = 0;
  while (text.includes("^") && guard++ < 40) {
    const hat = text.indexOf("^");
    const left = readPrimaryBackward(text, hat - 1);
    const right = readPrimaryForward(text, hat + 1);
    if (!left || !right) {
      return {
        text,
        notes,
        unresolved: "could not rewrite ^; use conc(seq, elem)"
      };
    }
    const ltxt = text.slice(left.start, left.end).trim();
    const rtxt = text.slice(right.start, right.end).trim();
    text = `${text.slice(0, left.start)}conc(${ltxt}, ${rtxt})${text.slice(right.end)}`;
    carets += 1;
  }
  if (text.includes("^")) {
    return { text, notes, unresolved: "could not rewrite ^; use conc(seq, elem)" };
  }
  if (carets) notes.push("rewrote ^ to conc(seq, elem)");
  return { text, notes, unresolved: null };
}
function splitProtected(input) {
  const parts = [];
  let i = 0;
  let buf = "";
  const flush = (code, text) => {
    if (buf) {
      parts.push({ text: buf, code: true });
      buf = "";
    }
    if (text) parts.push({ text, code: false });
  };
  while (i < input.length) {
    if (input.startsWith("//", i) || input.startsWith("--", i)) {
      const nl = input.indexOf("\n", i);
      const end = nl < 0 ? input.length : nl;
      flush(false, input.slice(i, end));
      i = end;
      continue;
    }
    if (input.startsWith("/*", i)) {
      const end = input.indexOf("*/", i + 2);
      const to = end < 0 ? input.length : end + 2;
      flush(false, input.slice(i, to));
      i = to;
      continue;
    }
    if (input[i] === '"') {
      let j = i + 1;
      while (j < input.length) {
        if (input[j] === "\\") {
          j += 2;
          continue;
        }
        if (input[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      flush(false, input.slice(i, j));
      i = j;
      continue;
    }
    if (input[i] === "'" && charLiteralLength(input, i) > 0) {
      const len = charLiteralLength(input, i);
      flush(false, input.slice(i, i + len));
      i += len;
      continue;
    }
    buf += input[i];
    i += 1;
  }
  if (buf) parts.push({ text: buf, code: true });
  return parts;
}
function charLiteralLength(input, i) {
  if (input[i] !== "'") return 0;
  if (input[i + 1] === "\\" && input[i + 2] && input[i + 3] === "'") return 4;
  if (input[i + 1] && input[i + 1] !== "'" && input[i + 1] !== "\\" && input[i + 2] === "'") return 3;
  return 0;
}
function matchForward(s, open) {
  const closer = s[open] === "(" ? ")" : s[open] === "[" ? "]" : s[open] === "{" ? "}" : "";
  if (!closer) return -1;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === s[open]) depth += 1;
    else if (s[i] === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function matchBack(s, close) {
  const opener = s[close] === ")" ? "(" : s[close] === "]" ? "[" : s[close] === "}" ? "{" : "";
  if (!opener) return -1;
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (s[i] === s[close]) depth += 1;
    else if (s[i] === opener) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function readPrimaryBackward(s, from) {
  let i = from;
  while (i >= 0 && /\s/.test(s[i])) i -= 1;
  if (i < 0) return null;
  const end = i + 1;
  const c = s[i];
  if (c === ")" || c === "]" || c === "}") {
    const open = matchBack(s, i);
    if (open < 0) return null;
    let start = open;
    if (c === ")") {
      let j = open - 1;
      while (j >= 0 && /\s/.test(s[j])) j -= 1;
      const idEnd = j;
      while (j >= 0 && /[A-Za-z0-9_\u0080-\uFFFF]/.test(s[j])) j -= 1;
      if (idEnd >= 0 && j < idEnd && /[A-Za-z_\u0080-\uFFFF]/.test(s[j + 1])) start = j + 1;
    }
    return { start, end };
  }
  if (/[A-Za-z0-9_\u0080-\uFFFF.]/.test(c)) {
    while (i >= 0 && /[A-Za-z0-9_\u0080-\uFFFF.]/.test(s[i])) i -= 1;
    return { start: i + 1, end };
  }
  return null;
}
function readPrimaryForward(s, from) {
  let i = from;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  if (i >= s.length) return null;
  const start = i;
  const c = s[i];
  if (c === "(" || c === "[" || c === "{") {
    const close = matchForward(s, i);
    if (close < 0) return null;
    return { start, end: close + 1 };
  }
  if (/[A-Za-z_\u0080-\uFFFF]/.test(c)) {
    i += 1;
    while (i < s.length && /[A-Za-z0-9_\u0080-\uFFFF]/.test(s[i])) i += 1;
    let j = i;
    while (j < s.length && /\s/.test(s[j])) j += 1;
    if (s[j] === "(") {
      const close = matchForward(s, j);
      if (close >= 0) return { start, end: close + 1 };
    }
    return { start, end: i };
  }
  if (/[0-9]/.test(c)) {
    i += 1;
    while (i < s.length && /[0-9.]/.test(s[i])) i += 1;
    return { start, end: i };
  }
  return null;
}
function getExperimentConfig(projectRoot, env = process.env) {
  let file = {};
  if (projectRoot) {
    const p = node_path.join(projectRoot, ".agile-sofl", "experiment.json");
    try {
      if (node_fs.existsSync(p)) file = JSON.parse(node_fs.readFileSync(p, "utf-8"));
    } catch {
    }
  }
  const condition = String(env.AGILE_SOFL_CONDITION || file.condition || "T").trim().toUpperCase() || "T";
  const participantId = String(env.AGILE_SOFL_PARTICIPANT || file.participantId || "anonymous").trim();
  const telemetry = env.AGILE_SOFL_TELEMETRY !== void 0 ? env.AGILE_SOFL_TELEMETRY !== "0" : file.telemetry !== false;
  const logPrompts = env.AGILE_SOFL_LOG_PROMPTS !== void 0 ? env.AGILE_SOFL_LOG_PROMPTS === "1" : file.logPrompts === true;
  return { condition, participantId, semanticChecks: condition.toUpperCase() !== "B2", telemetry, logPrompts };
}
const isL1Code = (code) => /^ASFL_FSF_1\d\d$/.test(code);
const isL2Code = (code) => /^ASFL_FSF_2\d\d$/.test(code);
const count = (ds) => ({
  error: ds.filter((d) => d.severity === "error").length,
  warning: ds.filter((d) => d.severity === "warning").length
});
async function semanticDiagnostics(asfl, cfg) {
  if (!cfg.semanticChecks || !asfl.trim()) return [];
  const r = parser.check(asfl, { fsfL1: false });
  if (!r.ast) return [];
  return [...parser.checkFsfL1(r.ast).diagnostics, ...(await parser.checkFsfL2(r.ast)).diagnostics];
}
async function diagnosticCounts(asfl, cfg) {
  const r = parser.check(asfl, { fsfL1: false });
  const parser$1 = count(r.diagnostics.filter((d) => !isL1Code(d.code) && !isL2Code(d.code)));
  if (!cfg.semanticChecks || !r.ast) {
    return { parser: parser$1, l1: { error: 0, warning: 0, enabled: cfg.semanticChecks, ran: false }, l2: { error: 0, warning: 0, enabled: cfg.semanticChecks, ran: false } };
  }
  const l1 = count(parser.checkFsfL1(r.ast).diagnostics);
  const l2 = count((await parser.checkFsfL2(r.ast)).diagnostics);
  return { parser: parser$1, l1: { ...l1, enabled: true, ran: true }, l2: { ...l2, enabled: true, ran: true } };
}
function telemetryPath(projectRoot) {
  return node_path.join(projectRoot, ".agile-sofl", "llm-calls.jsonl");
}
const SECRET_KEYS = /^(api[-_]?key|authorization|token|secret|password)$/i;
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(x);
    return o;
  }
  if (typeof v === "string") return v.replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/g, "[redacted]");
  return v;
}
function logTelemetry(projectRoot, cfg, sessionId, ev) {
  if (!projectRoot || !cfg.telemetry) return;
  const rec = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    sessionId,
    participantId: cfg.participantId,
    condition: cfg.condition,
    ...ev
  };
  if (!cfg.logPrompts) delete rec.prompt;
  try {
    node_fs.mkdirSync(node_path.join(projectRoot, ".agile-sofl"), { recursive: true });
    node_fs.appendFileSync(telemetryPath(projectRoot), JSON.stringify(scrub(rec)) + "\n", "utf-8");
  } catch {
  }
}
const KNOWN_CONDITIONS = ["T", "B2"];
function conditionNotice(cfg) {
  const mode = cfg.semanticChecks ? "full tool: agent + parser + L1 + L2" : "agent + parser feedback only; L1/L2 disabled";
  let msg = `[agile-sofl experiment] active condition=${cfg.condition} (${mode}), participant=${cfg.participantId}`;
  if (cfg.condition === "B0" || cfg.condition === "B1") msg += ` — WARNING: ${cfg.condition} is an external baseline not implemented in the studio; running as T`;
  else if (!KNOWN_CONDITIONS.includes(cfg.condition)) msg += ` — WARNING: unknown condition label; running as T`;
  return msg;
}
const announced = /* @__PURE__ */ new Set();
function announceCondition(projectRoot, sessionId, cfg = getExperimentConfig(projectRoot)) {
  const msg = conditionNotice(cfg);
  const key = `${projectRoot ?? ""}\0${sessionId}`;
  if (announced.has(key)) return msg;
  announced.add(key);
  console.warn(msg);
  logTelemetry(projectRoot, cfg, sessionId, { event: "session_start", semanticChecks: cfg.semanticChecks, warning: msg });
  return msg;
}
let cached = {};
let loaded = false;
function statePath() {
  return node_path.join(electron.app.getPath("userData"), "dialog-state.json");
}
async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await promises.readFile(statePath(), "utf8");
    cached = JSON.parse(raw);
  } catch {
    cached = {};
  }
}
async function getLastDialogDir() {
  await ensureLoaded();
  return cached.lastDir;
}
async function rememberDialogPath(filePath) {
  await ensureLoaded();
  cached.lastDir = node_path.dirname(filePath);
  try {
    await promises.writeFile(statePath(), JSON.stringify(cached), "utf8");
  } catch {
  }
}
function moduleArtifactDir(filePath) {
  return node_path.join(node_path.dirname(filePath), ".agile-sofl", "modules", node_path.basename(filePath, node_path.extname(filePath)));
}
function writeModuleArtifacts(filePath, content) {
  if (node_path.extname(filePath).toLowerCase() !== ".asfl") return { written: [], skipped: "not an .asfl file" };
  let ast;
  try {
    ast = parser.parse(content).ast;
  } catch (e) {
    return { written: [], skipped: `parse failed: ${String(e)}` };
  }
  if (!ast || ast.type !== "program" || ast.modules.length === 0) return { written: [], skipped: "no parsable modules" };
  const dir = moduleArtifactDir(filePath);
  node_fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const keep = /* @__PURE__ */ new Set();
  for (const a of parser.moduleArtifacts(ast, content)) {
    const safe = a.moduleName.replace(/[^A-Za-z0-9_.-]/g, "_");
    const txt = node_path.join(dir, `${safe}.asfl`);
    const xml = node_path.join(dir, `${safe}.xml`);
    node_fs.writeFileSync(txt, a.text, "utf-8");
    node_fs.writeFileSync(xml, a.xml, "utf-8");
    written.push(txt, xml);
    keep.add(`${safe}.asfl`).add(`${safe}.xml`);
  }
  for (const f of node_fs.readdirSync(dir)) if (/\.(asfl|xml)$/.test(f) && !keep.has(f)) node_fs.unlinkSync(node_path.join(dir, f));
  return { written };
}
function registerFileHandlers(getWindow2) {
  electron.ipcMain.handle("studio:file-read", async (_event, filePath) => {
    const content = await promises.readFile(filePath, "utf-8");
    return { filePath, content, title: node_path.basename(filePath) };
  });
  electron.ipcMain.handle("studio:file-write", async (_event, filePath, content) => {
    await promises.writeFile(filePath, content, "utf-8");
    let dualSave;
    try {
      dualSave = writeModuleArtifacts(filePath, content);
    } catch (e) {
      dualSave = { written: [], skipped: String(e) };
    }
    return { filePath, title: node_path.basename(filePath), dualSave };
  });
  electron.ipcMain.handle("studio:file-open-dialog", async (_event, kind) => {
    const win = getWindow2();
    const lastDir = await getLastDialogDir();
    const filters = kind === "aspec" ? [{ name: "Informal Spec", extensions: ["aspec"] }] : kind === "asfl" ? [{ name: "Hybrid Spec", extensions: ["asfl"] }] : [
      { name: "Agile-SOFL Specs", extensions: ["asfl", "aspec"] },
      { name: "Hybrid (.asfl)", extensions: ["asfl"] },
      { name: "Informal (.aspec)", extensions: ["aspec"] }
    ];
    const result = await electron.dialog.showOpenDialog(win ?? void 0, {
      filters,
      properties: ["openFile"],
      defaultPath: lastDir
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    await rememberDialogPath(filePath);
    const content = await promises.readFile(filePath, "utf-8");
    return { filePath, content, title: node_path.basename(filePath) };
  });
  electron.ipcMain.handle(
    "studio:file-save-dialog",
    async (_event, defaultName, kind = "asfl") => {
      const win = getWindow2();
      const lastDir = await getLastDialogDir();
      const ext = kind === "aspec" ? "aspec" : "asfl";
      const defaultPath = defaultName ?? `untitled.${ext}`;
      const result = await electron.dialog.showSaveDialog(win ?? void 0, {
        filters: [{ name: kind === "aspec" ? "Informal Spec" : "Hybrid Spec", extensions: [ext] }],
        defaultPath: lastDir ? joinLastDir(lastDir, defaultPath) : defaultPath
      });
      if (result.canceled || !result.filePath) return null;
      await rememberDialogPath(result.filePath);
      return result.filePath;
    }
  );
  electron.ipcMain.handle("studio:open-project-folder", async () => {
    const win = getWindow2();
    const lastDir = await getLastDialogDir();
    const result = await electron.dialog.showOpenDialog(win ?? void 0, {
      properties: ["openDirectory"],
      defaultPath: lastDir
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const root = result.filePaths[0];
    await rememberDialogPath(root);
    return root;
  });
  electron.ipcMain.handle("studio:reveal-in-folder", (_event, filePath) => {
    electron.shell.showItemInFolder(filePath);
  });
}
function joinLastDir(dir, name) {
  return node_path.join(dir, name);
}
function registerWindowHandlers(getWindow2) {
  electron.ipcMain.handle("studio:window-minimize", () => {
    getWindow2()?.minimize();
  });
  electron.ipcMain.handle("studio:window-maximize", () => {
    const win = getWindow2();
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    }
    win.maximize();
    return true;
  });
  electron.ipcMain.handle("studio:window-close", () => {
    getWindow2()?.close();
  });
  electron.ipcMain.handle("studio:window-is-maximized", () => {
    return getWindow2()?.isMaximized() ?? false;
  });
  electron.ipcMain.handle("studio:app-get-locale", () => {
    return electron.app.getLocale();
  });
  electron.ipcMain.handle("studio:app-get-platform", () => {
    return process.platform;
  });
}
function resolveParseBridgePath() {
  const fromOut = node_path.join(electron.app.getAppPath(), "out/dist/parse-bridge.cjs");
  if (node_fs.existsSync(fromOut)) return fromOut;
  return node_path.join(electron.app.getAppPath(), "dist/parse-bridge.cjs");
}
function registerParseHandlers() {
  const { registerParseHandlers: registerBundled } = require(resolveParseBridgePath());
  registerBundled();
}
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}
function applyEnvFile(filePath) {
  if (!node_fs.existsSync(filePath)) return;
  const parsed = parseEnv(node_fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}
function loadStudioEnv() {
  const files = [
    node_path.join(process.cwd(), ".env"),
    node_path.join(electron.app.getAppPath(), ".env"),
    node_path.join(electron.app.getAppPath(), "../.env"),
    node_path.join(electron.app.getAppPath(), "../../.env")
  ];
  try {
    files.unshift(node_path.join(electron.app.getAppPath(), "packages/studio/.env"));
  } catch {
  }
  for (const file of files) applyEnvFile(file);
}
function getEnvLlmFallback() {
  loadStudioEnv();
  return {
    apiKey: process.env.ECNU_API_KEY?.trim() || "",
    baseUrl: (process.env.ECNU_API_BASE_URL || "https://chat.ecnu.edu.cn/open/api/v1").replace(/\/$/, ""),
    model: process.env.ECNU_MODEL || "ecnu-max"
  };
}
function newProfileId() {
  return `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function normalizeBaseUrl(url) {
  return url.trim().replace(/\/+$/, "");
}
function maskApiKey(key) {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}
function toPublicProfile(profile, activeId) {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKeyMasked: maskApiKey(profile.apiKey),
    hasKey: Boolean(profile.apiKey.trim()),
    active: profile.id === activeId
  };
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function parseProfile(raw, fallbackId) {
  const object = asRecord(raw);
  if (!object) return null;
  const baseUrl = typeof object.baseUrl === "string" ? normalizeBaseUrl(object.baseUrl) : "";
  const apiKey = typeof object.apiKey === "string" ? object.apiKey : "";
  const model = typeof object.model === "string" ? object.model.trim() : "";
  const nameRaw = typeof object.name === "string" ? object.name.trim() : "";
  if (!baseUrl && !model && !apiKey && !nameRaw) return null;
  const id = typeof object.id === "string" && object.id.trim() ? object.id.trim() : fallbackId;
  return {
    id,
    name: nameRaw || model || "LLM",
    baseUrl,
    apiKey,
    model
  };
}
function parseLlmImport(raw) {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Empty JSON");
    value = JSON.parse(trimmed);
  }
  if (Array.isArray(value)) {
    const profiles = value.map((item) => parseProfile(item, newProfileId())).filter((item) => Boolean(item)).map((item) => ({ ...item, id: newProfileId() }));
    if (!profiles.length) throw new Error("No LLM profiles in JSON array");
    return { mode: "append", profiles };
  }
  const object = asRecord(value);
  if (object && Array.isArray(object.profiles)) {
    const profiles = object.profiles.map((item, index) => parseProfile(item, `llm-import-${index}`)).filter((item) => Boolean(item));
    if (!profiles.length) throw new Error("No LLM profiles in dump");
    const seen = /* @__PURE__ */ new Set();
    for (const profile of profiles) {
      if (seen.has(profile.id)) profile.id = newProfileId();
      seen.add(profile.id);
    }
    const activeId = typeof object.activeId === "string" || object.activeId === null ? object.activeId : void 0;
    return { mode: "replace", profiles, activeId };
  }
  const one = parseProfile(value, newProfileId());
  if (one) return { mode: "append", profiles: [{ ...one, id: newProfileId() }] };
  throw new Error("Invalid LLM profile JSON");
}
function dumpLlmProfiles(store) {
  return JSON.stringify({ activeId: store.activeId, profiles: store.profiles }, null, 2);
}
function resolveActiveProfile(store) {
  if (store.activeId) {
    const active = store.profiles.find((p) => p.id === store.activeId);
    if (active) return active;
  }
  return store.profiles.find((p) => p.apiKey.trim()) ?? store.profiles[0] ?? null;
}
const TEST_TIMEOUT_MS = 15e3;
function storePath() {
  return node_path.join(electron.app.getPath("userData"), "llm-profiles.json");
}
function envFallback() {
  const env = getEnvLlmFallback();
  return {
    id: "env-default",
    name: "ChatECNU",
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    model: env.model
  };
}
function emptyStore() {
  return { activeId: null, profiles: [] };
}
function readStore() {
  const file = storePath();
  if (!node_fs.existsSync(file)) {
    const seeded = envFallback();
    if (!seeded.apiKey && !seeded.baseUrl) return emptyStore();
    const next = { activeId: seeded.apiKey ? seeded.id : null, profiles: [seeded] };
    writeStore(next);
    return next;
  }
  try {
    const parsed = JSON.parse(node_fs.readFileSync(file, "utf8"));
    if (!parsed || !Array.isArray(parsed.profiles)) return emptyStore();
    return {
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
      profiles: parsed.profiles.filter((p) => p && typeof p.id === "string")
    };
  } catch {
    return emptyStore();
  }
}
function writeStore(store) {
  const file = storePath();
  node_fs.mkdirSync(node_path.dirname(file), { recursive: true });
  node_fs.writeFileSync(file, dumpLlmProfiles(store), "utf8");
}
function listLlmProfiles() {
  const store = readStore();
  return {
    activeId: store.activeId,
    profiles: store.profiles.map((p) => toPublicProfile(p, store.activeId))
  };
}
function getActiveLlmConfig() {
  const active = resolveActiveProfile(readStore());
  if (!active?.apiKey.trim()) return null;
  return {
    apiKey: active.apiKey.trim(),
    baseUrl: normalizeBaseUrl(active.baseUrl) || envFallback().baseUrl,
    model: active.model.trim() || "ecnu-max"
  };
}
function getEcnuConfig() {
  return getActiveLlmConfig() ?? getEnvLlmFallback();
}
function saveLlmProfile(draft) {
  const store = readStore();
  const existing = draft.id ? store.profiles.find((p) => p.id === draft.id) : void 0;
  const id = existing?.id ?? newProfileId();
  const next = {
    id,
    name: (draft.name ?? existing?.name ?? "").trim() || (draft.model ?? existing?.model ?? "LLM"),
    baseUrl: normalizeBaseUrl(draft.baseUrl ?? existing?.baseUrl ?? ""),
    apiKey: draft.apiKey != null && draft.apiKey !== "" ? draft.apiKey : existing?.apiKey ?? "",
    model: (draft.model ?? existing?.model ?? "").trim()
  };
  if (existing) {
    store.profiles = store.profiles.map((p) => p.id === id ? next : p);
  } else {
    store.profiles = [...store.profiles, next];
  }
  if (draft.activate || !store.activeId) store.activeId = id;
  writeStore(store);
  return { ...listLlmProfiles(), savedId: id };
}
function deleteLlmProfile(id) {
  const store = readStore();
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.activeId === id) store.activeId = store.profiles[0]?.id ?? null;
  writeStore(store);
  return listLlmProfiles();
}
function setActiveLlmProfile(id) {
  const store = readStore();
  if (!store.profiles.some((p) => p.id === id)) throw new Error("Unknown LLM profile");
  store.activeId = id;
  writeStore(store);
  return listLlmProfiles();
}
function exportLlmProfiles() {
  return dumpLlmProfiles(readStore());
}
function importLlmProfiles(raw) {
  const parsed = parseLlmImport(raw);
  const store = readStore();
  if (parsed.mode === "replace") {
    store.profiles = parsed.profiles;
    store.activeId = parsed.activeId && parsed.profiles.some((p) => p.id === parsed.activeId) ? parsed.activeId : parsed.profiles[0]?.id ?? null;
  } else {
    store.profiles = [...store.profiles, ...parsed.profiles];
    if (!store.activeId && parsed.profiles[0]) store.activeId = parsed.profiles[0].id;
  }
  writeStore(store);
  return listLlmProfiles();
}
function resolveTestConfig(request) {
  const store = readStore();
  const existing = request.profileId ? store.profiles.find((p) => p.id === request.profileId) : void 0;
  const apiKey = request.draft?.apiKey && request.draft.apiKey.trim() ? request.draft.apiKey.trim() : existing?.apiKey.trim() ?? "";
  const baseUrl = normalizeBaseUrl(request.draft?.baseUrl || existing?.baseUrl || "");
  const model = (request.draft?.model || existing?.model || "").trim();
  return { apiKey, baseUrl, model };
}
async function pingModels(cfg) {
  const started = Date.now();
  const res = await fetch(`${cfg.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
  });
  const ms = Date.now() - started;
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, message: `HTTP ${res.status}`, ms, detail: text.slice(0, 240) };
  }
  let count2;
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json.data)) count2 = json.data.length;
  } catch {
  }
  return {
    ok: true,
    message: count2 != null ? `OK · ${count2} models` : `OK · HTTP ${res.status}`,
    ms
  };
}
async function pingChat(cfg) {
  const started = Date.now();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: "Reply with the single word pong." }],
      max_tokens: 8,
      temperature: 0,
      stream: false,
      thinking: { type: "disabled" }
    }),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
  });
  const ms = Date.now() - started;
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, message: `HTTP ${res.status}`, ms, detail: text.slice(0, 240) };
  }
  let snippet = text.slice(0, 160);
  try {
    const json = JSON.parse(text);
    snippet = json.choices?.[0]?.message?.content?.trim() || snippet;
  } catch {
  }
  return { ok: true, message: `OK · ${ms}ms`, ms, detail: snippet };
}
async function testLlmProfile(request) {
  const cfg = resolveTestConfig(request);
  if (!cfg.baseUrl) return { ok: false, message: "Missing base URL", ms: 0 };
  if (!cfg.apiKey) return { ok: false, message: "Missing API key", ms: 0 };
  if (request.kind === "params" && !cfg.model) return { ok: false, message: "Missing model name", ms: 0 };
  try {
    if (request.kind === "params") return await pingChat(cfg);
    try {
      const models = await pingModels(cfg);
      if (models.ok) return models;
      if (models.message.includes("HTTP 404") || models.message.includes("HTTP 405")) {
        if (!cfg.model) return models;
        return await pingChat(cfg);
      }
      return models;
    } catch {
      if (!cfg.model) throw new Error("Connectivity test failed");
      return await pingChat(cfg);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, ms: 0 };
  }
}
class ChatAbortedError extends Error {
  constructor(message = "Stopped by user.") {
    super(message);
    this.name = "ChatAbortedError";
  }
}
function isChatAborted(error) {
  return error instanceof ChatAbortedError || error instanceof Error && error.name === "ChatAbortedError";
}
function combineAbortSignals(signals) {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
const CHAT_TIMEOUT_MS = 9e4;
async function postChat(body, userSignal) {
  const cfg = getEcnuConfig();
  if (!cfg.apiKey) {
    throw new Error("No LLM API key. Add a profile in Settings, or set ECNU_API_KEY in packages/studio/.env.");
  }
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  const signal = userSignal ? combineAbortSignals([timeout, userSignal]) : timeout;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({ model: cfg.model, ...body }),
    signal
  }).catch((e) => {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      if (userSignal?.aborted) throw new ChatAbortedError();
      throw new Error("ChatECNU timed out after 90s. Send again to continue.");
    }
    throw e;
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ChatECNU ${res.status}: ${text.slice(0, 400)}`);
  }
  return res;
}
function reasoningEffortFor(thinking) {
  return thinking === false ? "off" : "low";
}
function buildStreamBody(options) {
  const body = {
    messages: options.messages,
    temperature: options.temperature ?? 0.35,
    stream: true,
    thinking: { type: options.thinking === false ? "disabled" : "enabled" }
  };
  const effort = reasoningEffortFor(options.thinking);
  if (effort !== "off") body.reasoning_effort = effort;
  if (options.tools?.length) body.tools = options.tools;
  body.stream_options = { include_usage: true };
  return body;
}
async function chatEcnuStream(options) {
  const body = buildStreamBody(options);
  const res = await postChat(body, options.signal);
  if (!res.body) throw new Error("ChatECNU stream has no body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  const tools = [];
  let finishReason = "stop";
  let usage = { promptTokens: null, completionTokens: null };
  let model;
  const flushLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed.usage) usage = { promptTokens: parsed.usage.prompt_tokens ?? null, completionTokens: parsed.usage.completion_tokens ?? null };
    if (parsed.model) model = parsed.model;
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    const reasonChunk = delta.reasoning_content ?? delta.reasoning ?? "";
    const contentChunk = delta.content ?? "";
    if (reasonChunk) {
      reasoning += reasonChunk;
      options.onDelta?.({ reasoning });
    }
    if (contentChunk) {
      content += contentChunk;
      options.onDelta?.({ content });
    }
    let toolsChanged = false;
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? tools.length;
      const current = tools[index] ?? { id: "", name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      tools[index] = current;
      toolsChanged = true;
    }
    if (toolsChanged) {
      options.onDelta?.({
        toolCalls: tools.flatMap(
          (t, index) => t ? [
            {
              index,
              id: t.id,
              name: t.name,
              arguments: t.arguments
            }
          ] : []
        )
      });
    }
  };
  while (true) {
    if (options.signal?.aborted) {
      await reader.cancel().catch(() => void 0);
      throw new ChatAbortedError();
    }
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (options.signal?.aborted || e instanceof Error && e.name === "AbortError") {
        throw new ChatAbortedError();
      }
      throw e;
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) flushLine(line);
  }
  if (buffer.trim()) flushLine(buffer);
  return {
    content,
    reasoning,
    toolCalls: tools.filter((t) => t.name).map((t) => ({
      id: t.id || `call-${t.name}`,
      type: "function",
      function: { name: t.name, arguments: t.arguments || "{}" }
    })),
    finishReason,
    usage,
    model: model ?? getEcnuConfig().model
  };
}
function hasEcnuKey() {
  return Boolean(getEcnuConfig().apiKey);
}
const AGENT_SKILLS = [
  {
    id: "requirement-discovery",
    name: "Requirement Discovery",
    prompt: "Discover Functions, Data Resources, and Constraints from the user's natural language. Do not dump a full specification. Summarize candidates, then ask clarifying questions, then propose structured propose_changes patches. After each applied write, read_specification and continue until the inventory is complete, then summarize. If CRUD cannot express a fix, read view=source and propose_source_edit. The full journey is Informal → Hybrid+GUI → dual-line refinement until the refinement digest is unambiguous. If Hybrid already exists with remaining gaps, after Informal work call read_refinement_state and invite the next refinement slice — do not stop as if the specification were finished."
  },
  {
    id: "requirement-clarification",
    name: "Requirement Clarification",
    prompt: "Find vague, missing, or ambiguous information. Ask focused questions (options + optional custom input). Do not invent details the user did not confirm."
  },
  {
    id: "function-decomposition",
    name: "Function Decomposition",
    prompt: "Decompose a selected function into sub-steps. Propose child function nodes, not free-form markdown."
  },
  {
    id: "data-modeling",
    name: "Data Modeling",
    prompt: "Identify data resources and fields. Propose data-resource / data-field nodes with clear titles and short descriptions."
  },
  {
    id: "constraint-discovery",
    name: "Constraint Discovery",
    prompt: "Turn business rules into Constraint nodes with precise natural-language statements (limits, locking, non-negativity, uniqueness)."
  },
  {
    id: "specification-review",
    name: "Specification Review",
    prompt: "Review Completeness, Precision, Consistency, and Traceability. Call review_specification and list concrete issues tied to node ids when possible."
  },
  {
    id: "hybrid-generation",
    name: "Hybrid Generation",
    prompt: `Turn Informal Specification into Hybrid (.asfl) incrementally via CRUD tools. NEVER dump a full SOFL file or use replace-document.
Agile-SOFL architecture:
- Exactly one top-level SYSTEM_ module named after the whole system (e.g. SYSTEM_FoodDelivery). It is the system module; other modules are children (module Auth / FoodDelivery;).
- Add SYSTEM_ first (it is inserted at the file start). Then add semantic modules with parentId=mod:SYSTEM_…. A GUI_ module is a child, not the system module.
- Process signatures default to () when ports are unknown. Never invent dummy (x: nat) ok: nat. Write real inputs/outputs when they exist. There is no implication operator; write not A or B.
Pipeline — keep going after each applied patch until every enabled stage is done, then summarize:
1. Read Informal and Hybrid inventories. If Hybrid already exists and strategy is ask, call ask_clarification (merge vs rebuild).
2. Module architecture: add the SYSTEM_ module, then each semantic module (and a GUI module) with propose_hybrid_changes op=add kind=module. Do not paste module source.
3. Per module: add types/variables from Data Resources (kind=type|var, parentId=mod:…).
4. Per module: add process signatures from Functions (kind=process).
5. Per process: replace-process-body or add scenarios. Write the FSF (FSF : T1 && D1 || T2 && D2 || … || others && Dn); Ti/Di may be structured natural language at this stage. Enumerations use {<Tag>}.
6. Add invariants (kind=inv) from Constraints. Do NOT dump GUI widgets into Hybrid CRUD.
7. For UI, call read_gui_specification then propose_gui_changes. Each screen is its own HTML page (data-screen) with data-nav to sibling screens so the prototype can click-switch. Build a high-fidelity HTML prototype (shell, sidebar, hero, cards, forms, lists, empty states) — not a page of three buttons. Use whitelist tags plus any as-* class. Bind with data-process / data-bind / data-nav. Prefer replace-screen-html with the full inner layout of that one screen. Hybrid gui blocks stay as slim screen→process traces.
After every applied write, call read_hybrid_specification / read_gui_specification and fix gaps until inventories are correct.
8. Three-line refinement is a later stage, not automatic. After enabled Hybrid/GUI stages finish, call read_refinement_state. If unambiguous=false, ask_clarification with 2–4 next slices (empty module, stub process, FormalizePredicate, data retrieve, operational grain). Do not refine the entire tree in one go. Do not claim the specification has no ambiguity while empty modules, stubs, processAmbiguity, dataAmbiguity, or grainAmbiguity remain. Grain questions may only use variations already listed in the digest.
Last message = summary of completed generation stages plus remaining refinement gaps.
If CRUD fails, the file is empty/out of sync, diagnostics list syntax errors, or leftover unparsed text appears, call read_hybrid_specification with view=source then propose_source_edit (unique replace/append/replace-document). Do not retry the same failing CRUD. Prefer CRUD; source edit is last resort.
Infer unstated GUI/navigation only when the parameter allows it; otherwise ask. Prefer small patches citing inventory ids.`
  },
  {
    id: "hybrid-refinement",
    name: "Hybrid Refinement",
    prompt: `You are refining an existing Hybrid (.asfl) specification along three lines: process atomicity, data refinement, and operational grain. Do not dump a full file. Formal pre/post does not make a process one operation.
Completeness is not "whatever happens to be written". A module that is only a name (no types/vars/processes/cdfd) is an empty shell — a gap. A process that is only a name (no pre/post/fsf/decom) is a stub — also a gap.
Guide the user one slice at a time. Do not silently refine every node.
Pipeline:
1. read_refinement_state (tree or summary) plus Informal/Hybrid inventories. Identify the named module/process/data item from the user message, or ask_clarification if several slices are open.
2. Prefer propose_refinement_step: FormalizePredicate, DecomposeProcess, SetCdfd, DeclareAtomic, IntroduceRetrieve, DischargeDataObligation, DefineType, ClassifyGrain, ResolveVariation.
   Grain: read the digest. ask_clarification only about variations already extracted (and name-claim). Then ClassifyGrain (grainClass=operation|abstract) or ResolveVariation (variationId, disposition=scenario|child|waived, toText=child process name, note required when waived). Do not invent a CRUD catalog. Do not clear grainAmbiguity by rewriting pre/post; that counter drops only after those steps or DecomposeProcess. DeclareAtomic requires operational grain to be closed.
3. Use propose_hybrid_changes for new types/vars/processes/scenarios when the shell is empty. Never treat missing members as done.
4. If CRUD/refinement-step cannot express the fix, read_hybrid_specification view=source then propose_source_edit (replace/append). Informal atoms still need a FormalizePredicate step afterwards or ambiguity will not drop.
5. CDFD is optional on old files; write one only when the user asks to draft/complete a diagram or a process must appear on the current module graph.
6. After each applied write, read_refinement_state. Stay on the chosen slice until that local gap shrinks. Then if more gaps remain, ask_clarification for the next slice — do not claim an unambiguous spec while the digest says unambiguous=false.
Last message = what ambiguity dropped (process vs data vs grain) and what remains.`
  }
];
function skillById(id) {
  return AGENT_SKILLS.find((s) => s.id === id) ?? AGENT_SKILLS[0];
}
const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description: "Ask the user a structured clarification question. The UI renders options plus a custom text field. The tool result has selected (clicked options) and custom (text the user typed). A non-empty custom answer is required context for both single-choice and multi-choice, even when selected is also set. Never ignore custom. Use this instead of listing questions only in prose when a decision is needed.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, label: { type: "string" } },
              required: ["id", "label"]
            }
          },
          allowCustom: { type: "boolean" },
          multiSelect: { type: "boolean" }
        },
        required: ["question"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_changes",
      description: "Propose a structured Informal Specification patch against the CURRENT Informal inventory ids. Never write raw markdown. Never use this for Hybrid/.asfl. Prefer update/remove on existing ids. After Apply (or auto-write), continue: read_specification, fix gaps, then summarize.",
      parameters: {
        type: "object",
        properties: {
          explanation: { type: "string" },
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["add", "update", "remove", "move"] },
                target: {
                  type: "string",
                  description: "add only: functions | data-resources | constraints, or a parent node id (for nested fields)."
                },
                id: {
                  type: "string",
                  description: "update / remove / move: existing node id from the inventory (or unique title)."
                },
                parentId: { type: "string" },
                afterId: { type: "string" },
                title: { type: "string", description: "update: new title" },
                description: { type: "string", description: "update: new body text" },
                node: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["function", "data-resource", "data-field", "constraint", "text"]
                    },
                    title: { type: "string" },
                    description: { type: "string" }
                  }
                }
              },
              required: ["op"]
            }
          }
        },
        required: ["operations"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_specification",
      description: "Return the current Informal Specification. Default view=inventory (node ids/titles). Pass view=source for numbered markdown text before propose_source_edit. Does not return Hybrid/.asfl.",
      parameters: {
        type: "object",
        properties: {
          view: {
            type: "string",
            enum: ["inventory", "source"],
            description: "inventory (default) or numbered source text"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "review_specification",
      description: "Record a structured review of the current informal specification.",
      parameters: {
        type: "object",
        properties: {
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dimension: {
                  type: "string",
                  enum: ["completeness", "precision", "consistency", "traceability"]
                },
                message: { type: "string" },
                nodeId: { type: "string" }
              },
              required: ["dimension", "message"]
            }
          }
        },
        required: ["issues"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_hybrid_specification",
      description: "Return the current Hybrid Specification. Default view=inventory (mod:/proc:/scn:/type:/var:/inv:/gui:) plus per-module syntax/parse diagnostics when present. Pass view=source for numbered .asfl text before propose_source_edit. Always inspect diagnostics and fix remaining errors.",
      parameters: {
        type: "object",
        properties: {
          view: {
            type: "string",
            enum: ["inventory", "source"],
            description: "inventory (default) or numbered source text"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_refinement_state",
      description: "Return the current dual-line refinement digest (Liu SOFL process atomicity + data discharge): overall harmonic completeness, empty-shell modules, stub processes, informal atoms, open scenarios, data obligations, and a process/data tree. Call this after Hybrid writes. view=summary (default), tree, or log. Missing members are gaps, not completeness.",
      parameters: {
        type: "object",
        properties: {
          view: {
            type: "string",
            enum: ["summary", "tree", "log"],
            description: "summary (counters + next slices), tree (modules/processes/gates/data), or audit log"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_hybrid_changes",
      description: "Propose an incremental Hybrid/.asfl CRUD patch against inventory ids (mod:, proc:Module.Name). Prefer this over source edits. SYSTEM_ is the unique top-level system module (named after the whole system) and is inserted first; other modules use parentId=mod:SYSTEM_…. Default process signature is (). Never emit raw SOFL or replace-document here. Use add/update/remove/replace-process-body. Write process logic as FSF via replace-process-body.fsf: FSF : T1 && D1 || T2 && D2 || … || others && Dn. There is no implication operator; write not A or B.",
      parameters: {
        type: "object",
        properties: {
          explanation: { type: "string" },
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: {
                  type: "string",
                  enum: ["add", "update", "remove", "replace-process-body"]
                },
                kind: {
                  type: "string",
                  enum: [
                    "module",
                    "process",
                    "function",
                    "type",
                    "var",
                    "const",
                    "inv",
                    "scenario",
                    "gui-screen"
                  ]
                },
                id: { type: "string", description: "update/remove/replace-process-body: inventory id" },
                parentId: { type: "string", description: "add: parent mod: or proc: id" },
                name: { type: "string" },
                text: { type: "string" },
                fsf: { type: "string", description: 'replace-process-body: final-grammar FSF "FSF : T1 && D1 || T2 && D2 || … || others && Dn"' },
                pre: { type: "string" },
                post: { type: "string" },
                signature: { type: "string" },
                comment: { type: "string" },
                scenarios: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      guard: { type: "string" },
                      test: { type: "string" },
                      def: { type: "string" },
                      definingCondition: { type: "string" },
                      kind: { type: "string", enum: ["normal", "exceptional"] }
                    }
                  }
                }
              },
              required: ["op"]
            }
          }
        },
        required: ["operations"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_gui_specification",
      description: "Read the current GUI HTML specification. view=inventory lists screens plus a DOM outline of layout/widgets/bindings; view=source returns numbered .gui.html. Use whitelist tags and as-* classes. Design complete product screens, not a few isolated buttons.",
      parameters: {
        type: "object",
        properties: {
          view: {
            type: "string",
            enum: ["inventory", "source"],
            description: "inventory (default) or numbered HTML source"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_gui_changes",
      description: "Propose a structured GUI HTML patch. Prefer replace-screen-html with a complete inner layout (navbar/sidebar/hero/cards/forms/tables), not a single button. Ops: add-screen (optional html), remove-screen, add-widget, replace-html, replace-screen-html, insert-html, patch-node, remove-node. Whitelist HTML5 tags; any as-* class is allowed. Bind with data-process / data-bind / data-nav. Never emit <script>, style=, href, or src.",
      parameters: {
        type: "object",
        properties: {
          explanation: { type: "string" },
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: {
                  type: "string",
                  enum: [
                    "add-screen",
                    "remove-screen",
                    "add-widget",
                    "replace-html",
                    "replace-screen-html",
                    "insert-html",
                    "patch-node",
                    "remove-node"
                  ]
                },
                id: { type: "string" },
                name: { type: "string" },
                screenId: { type: "string" },
                kind: { type: "string" },
                label: { type: "string" },
                process: { type: "string" },
                nav: { type: "string" },
                html: { type: "string" },
                text: { type: "string" }
              },
              required: ["op"]
            }
          }
        },
        required: ["operations"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_refinement_step",
      description: "Submit an auditable Hybrid refinement step. Informal atoms may only become formal via FormalizePredicate. Operational grain closes only via ClassifyGrain, ResolveVariation, or DecomposeProcess — rewriting pre/post does not reduce grainAmbiguity. DecomposeProcess creates a child module and an empty CDFD. SetCdfd writes or replaces one module cdfd block (toText). Missing cdfd on an existing module is not an error — do not invent a CDFD unless the user asks to draw or refine the data-flow diagram.",
      parameters: {
        type: "object",
        properties: {
          explanation: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "FormalizePredicate",
              "DecomposeProcess",
              "BalanceFlows",
              "DefineType",
              "BindConstraint",
              "DeclareAtomic",
              "Extend",
              "IntroduceRetrieve",
              "DischargeDataObligation",
              "SetCdfd",
              "ClassifyGrain",
              "ResolveVariation"
            ]
          },
          grainClass: { type: "string", enum: ["operation", "abstract"], description: "ClassifyGrain: operation is one trigger; abstract is still a concern" },
          variationId: { type: "string", description: "ResolveVariation: id from the grain digest, or name-claim" },
          disposition: { type: "string", enum: ["scenario", "child", "waived"], description: "ResolveVariation. child requires toText = child process name. waived requires note." },
          moduleName: { type: "string" },
          processName: { type: "string" },
          typeName: { type: "string" },
          clause: { type: "string", enum: ["pre", "post", "fsf"] },
          fromText: { type: "string" },
          toText: { type: "string" },
          childModuleName: { type: "string" },
          representationType: { type: "string" },
          retrieveFunction: { type: "string" },
          retrieveBody: { type: "string" },
          note: { type: "string" }
        },
        required: ["kind"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_source_edit",
      description: "Last-resort source-level edit of Informal markdown or Hybrid .asfl. Prefer propose_changes / propose_hybrid_changes. Use this only when CRUD failed, leftover unparsed text remains, inventory is empty/out of sync, or you must fix text the structured tools cannot express. Read view=source first. Ops: replace (unique oldText → newText; all:true to replace every match), append, replace-document.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["informal", "hybrid"],
            description: "Which open specification file to edit"
          },
          explanation: { type: "string" },
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["replace", "append", "replace-document"] },
                oldText: { type: "string", description: "replace: unique snippet from the current source" },
                newText: { type: "string" },
                text: { type: "string", description: "append or replace-document body" },
                all: { type: "boolean", description: "replace: replace every match of oldText" }
              },
              required: ["op"]
            }
          }
        },
        required: ["operations"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "review_hybrid",
      description: "Record a structured review of the current Hybrid specification.",
      parameters: {
        type: "object",
        properties: {
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dimension: {
                  type: "string",
                  enum: ["completeness", "precision", "consistency", "traceability"]
                },
                message: { type: "string" },
                nodeId: { type: "string" }
              },
              required: ["dimension", "message"]
            }
          }
        },
        required: ["issues"]
      }
    }
  }
];
function defaultAgentPermissions() {
  return {
    informal: { read: true, write: true },
    hybrid: { read: true, write: true }
  };
}
function normalizePermissions(raw) {
  const base = defaultAgentPermissions();
  const informal = { ...base.informal, ...raw?.informal };
  const hybrid = { ...base.hybrid, ...raw?.hybrid };
  if (informal.write) informal.read = true;
  if (hybrid.write) hybrid.read = true;
  if (!informal.read) informal.write = false;
  if (!hybrid.read) hybrid.write = false;
  return { informal, hybrid };
}
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clone$1(value) {
  return JSON.parse(JSON.stringify(value));
}
function toolIdsFor(message) {
  const ids = /* @__PURE__ */ new Set();
  for (const call of message.toolCalls ?? []) ids.add(call.id);
  if (message.clarification?.pendingToolCallId) ids.add(message.clarification.pendingToolCallId);
  return ids;
}
function pendingToolCallIdOf(message) {
  if (!message.pending) return void 0;
  return message.clarification?.pendingToolCallId ?? message.toolCalls?.[0]?.id;
}
function lastPendingToolCallId(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = pendingToolCallIdOf(messages[i]);
    if (id) return id;
  }
  return void 0;
}
function endIndexThrough(messages, idx, mode) {
  if (mode === "reset") return idx;
  const toolIds = toolIdsFor(messages[idx]);
  let end = idx;
  let i = idx + 1;
  while (i < messages.length && messages[i].role === "tool" && toolIds.has(messages[i].id)) {
    end = i;
    i += 1;
  }
  return end;
}
function sliceSessionMessages(messages, throughMessageId, mode, exclusive) {
  const idx = messages.findIndex((m) => m.id === throughMessageId);
  if (idx < 0) return null;
  if (exclusive) {
    const sliced2 = clone$1(messages.slice(0, idx));
    return { messages: sliced2, pendingToolCallId: lastPendingToolCallId(sliced2) };
  }
  const sliced = clone$1(messages.slice(0, endIndexThrough(messages, idx, mode) + 1));
  if (mode === "reset") {
    const msg = sliced[Math.min(idx, sliced.length - 1)];
    msg.pending = true;
    msg.resolution = void 0;
    if (msg.clarification) {
      msg.clarification = { ...msg.clarification, answer: void 0 };
    }
    return {
      messages: sliced,
      pendingToolCallId: msg.clarification?.pendingToolCallId ?? msg.toolCalls?.[0]?.id
    };
  }
  return { messages: sliced, pendingToolCallId: lastPendingToolCallId(sliced) };
}
function applySessionSlice(session, throughMessageId, mode, exclusive) {
  const sliced = sliceSessionMessages(session.messages, throughMessageId, mode, exclusive);
  if (!sliced) return null;
  return {
    ...session,
    messages: sliced.messages,
    context: { ...session.context, pendingToolCallId: sliced.pendingToolCallId }
  };
}
function forkSessionRecord(session, throughMessageId, options) {
  const sliced = applySessionSlice(session, throughMessageId, options?.mode ?? "keep");
  if (!sliced) return null;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const copy = clone$1(sliced);
  copy.id = newId("ses");
  copy.title = options?.title?.trim() || `${session.title}`;
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.pinned = false;
  copy.archived = false;
  return copy;
}
const INDEX_NAME = "_index.json";
function sessionsDir(projectRoot) {
  return node_path.join(projectRoot, ".agile-sofl", "agent", "sessions");
}
function indexPath(projectRoot) {
  return node_path.join(sessionsDir(projectRoot), INDEX_NAME);
}
function ensureDir(dir) {
  node_fs.mkdirSync(dir, { recursive: true });
}
function yieldTick() {
  return new Promise((resolve) => setImmediate(resolve));
}
function sessionFiles(dir) {
  return node_fs.readdirSync(dir).filter((file) => file.endsWith(".json") && file !== INDEX_NAME);
}
function readIndex(projectRoot) {
  const file = indexPath(projectRoot);
  if (!node_fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(node_fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry) => entry && typeof entry.id === "string");
  } catch {
    return null;
  }
}
function writeIndex(projectRoot, entries) {
  ensureDir(sessionsDir(projectRoot));
  node_fs.writeFileSync(indexPath(projectRoot), JSON.stringify(entries), "utf8");
}
function entryFromSession(session) {
  return {
    id: session.id,
    moduleId: session.moduleId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    pinned: session.pinned,
    archived: session.archived,
    skillId: session.context.skillId,
    permissions: session.context.permissions
  };
}
function covers(entries, files, extraId) {
  const ids = new Set(entries.map((entry) => entry.id));
  if (extraId) ids.add(extraId);
  if (ids.size !== files.length) return false;
  return files.every((file) => ids.has(file.slice(0, -5)));
}
function compareSessions(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  if (Boolean(a.archived) !== Boolean(b.archived)) return a.archived ? 1 : -1;
  return b.updatedAt.localeCompare(a.updatedAt);
}
function toListSession(entry) {
  return {
    id: entry.id,
    moduleId: entry.moduleId,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    pinned: entry.pinned,
    archived: entry.archived,
    messages: [],
    context: {
      skillId: entry.skillId,
      permissions: entry.permissions
    }
  };
}
function upsertIndex(projectRoot, session) {
  const dir = sessionsDir(projectRoot);
  if (!node_fs.existsSync(dir)) return;
  const files = sessionFiles(dir);
  const current = readIndex(projectRoot);
  if (!current || !covers(current, files, session.id)) return;
  writeIndex(projectRoot, [...current.filter((entry) => entry.id !== session.id), entryFromSession(session)]);
}
function sessionForRenderer(session) {
  if (!session.messages.some((message) => message.role === "tool" && message.content)) return session;
  return {
    ...session,
    messages: session.messages.map(
      (message) => message.role === "tool" ? { id: message.id, role: "tool", content: "", timestamp: message.timestamp } : message
    )
  };
}
async function listSessions(projectRoot) {
  const dir = sessionsDir(projectRoot);
  if (!node_fs.existsSync(dir)) return [];
  const files = sessionFiles(dir);
  const indexed = readIndex(projectRoot);
  if (indexed && covers(indexed, files)) {
    return indexed.map(toListSession).sort(compareSessions);
  }
  const loaded2 = [];
  for (const file of files) {
    try {
      loaded2.push(JSON.parse(node_fs.readFileSync(node_path.join(dir, file), "utf8")));
    } catch {
    }
    await yieldTick();
  }
  writeIndex(projectRoot, loaded2.map(entryFromSession));
  return loaded2.map((session) => toListSession(entryFromSession(session))).sort(compareSessions);
}
function loadSession(projectRoot, id) {
  const file = node_path.join(sessionsDir(projectRoot), `${id}.json`);
  if (!node_fs.existsSync(file)) return null;
  try {
    return JSON.parse(node_fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function saveSession$1(projectRoot, session) {
  const dir = sessionsDir(projectRoot);
  ensureDir(dir);
  session.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  node_fs.writeFileSync(node_path.join(dir, `${session.id}.json`), JSON.stringify(session), "utf8");
  upsertIndex(projectRoot, session);
}
function deleteSession(projectRoot, id) {
  const file = node_path.join(sessionsDir(projectRoot), `${id}.json`);
  if (!node_fs.existsSync(file)) return false;
  node_fs.unlinkSync(file);
  const entries = readIndex(projectRoot);
  if (entries) writeIndex(projectRoot, entries.filter((entry) => entry.id !== id));
  return true;
}
function createSession(projectRoot, moduleId, title, options) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const session = {
    id: newId("ses"),
    moduleId,
    title: title || "Requirement Analysis",
    createdAt: now,
    updatedAt: now,
    messages: [],
    context: {
      skillId: options?.skillId || "requirement-discovery",
      permissions: normalizePermissions(options?.permissions),
      promptExtras: options?.promptExtras
    }
  };
  saveSession$1(projectRoot, session);
  return session;
}
function renameSession(projectRoot, id, title) {
  const session = loadSession(projectRoot, id);
  if (!session) return null;
  session.title = title.trim() || session.title;
  saveSession$1(projectRoot, session);
  return session;
}
function duplicateSession(projectRoot, id) {
  const session = loadSession(projectRoot, id);
  if (!session) return null;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const copy = {
    ...session,
    id: newId("ses"),
    title: `${session.title} copy`,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false
  };
  saveSession$1(projectRoot, copy);
  return copy;
}
function forkSession(projectRoot, id, throughMessageId, options) {
  const session = loadSession(projectRoot, id);
  if (!session) return null;
  const copy = forkSessionRecord(session, throughMessageId, options);
  if (!copy) return null;
  saveSession$1(projectRoot, copy);
  return copy;
}
function rewindSession(projectRoot, id, throughMessageId, options) {
  const session = loadSession(projectRoot, id);
  if (!session) return null;
  const next = applySessionSlice(session, throughMessageId, options?.mode ?? "reset", options?.exclusive);
  if (!next) return null;
  saveSession$1(projectRoot, next);
  return next;
}
function setSessionFlag(projectRoot, id, flag, value) {
  const session = loadSession(projectRoot, id);
  if (!session) return null;
  session[flag] = value;
  saveSession$1(projectRoot, session);
  return session;
}
const DiagnosticCodes = {
  INFORMAL_UNKNOWN_SECTION: "ASPEC_MD_001",
  INFORMAL_ORPHAN_HEADING: "ASPEC_MD_002"
};
function createDiagnostic(code, message, severity, path) {
  return { code, message, severity, path };
}
function extractInformalFrontmatter(source) {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("---")) {
    return { meta: {}, body: source, hadFrontmatter: false };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0)
    return { meta: {}, body: source, hadFrontmatter: false };
  const raw = trimmed.slice(4, end).trim();
  const body = trimmed.slice(end + 4).replace(/^(?:\r?\n)+/, "");
  const fields = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0)
      continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (key)
      fields[key] = value;
  }
  const version = fields.version != null ? Number(fields.version) : void 0;
  const meta = {
    id: fields.id,
    moduleId: fields.moduleId,
    version: version != null && Number.isFinite(version) ? version : void 0,
    title: fields.title,
    author: fields.author,
    hybridTarget: fields.hybridTarget,
    guiTarget: fields.guiTarget
  };
  return { meta, body, hadFrontmatter: true };
}
function stripInformalIdComments(markdown) {
  const next = markdown.replace(/[ \t]*<!--\s*@id:[^>]*-->/gi, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return next ? `${next}
` : "";
}
const PREFIX = {
  function: "fn",
  "data-resource": "dr",
  "data-field": "df",
  constraint: "c",
  text: "tx",
  functions: "sec-fn",
  "data-resources": "sec-dr",
  constraints: "sec-c"
};
function slugify(title) {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "node";
}
function createNodeId(type, title, used) {
  const prefix = PREFIX[type] ?? "n";
  const base = `${prefix}-${slugify(title)}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}-${i}`))
    i += 1;
  const id = `${base}-${i}`;
  used.add(id);
  return id;
}
function treeToSpec(tree) {
  const sections = tree.sections.map((section) => ({
    id: section.id,
    type: section.type,
    title: section.title,
    children: section.children.map((child) => treeNodeToFlat(child, void 0))
  }));
  relink(sections);
  return {
    id: tree.id,
    moduleId: tree.moduleId,
    version: tree.version,
    metadata: tree.metadata,
    sections
  };
}
function treeNodeToFlat(node, parentId) {
  const children = node.children.map((c) => treeNodeToFlat(c, node.id));
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    description: node.description,
    parentId,
    children: children.map((c) => c.id),
    metadata: {
      ...node.metadata,
      nested: children
    }
  };
}
function relink(sections) {
  for (const section of sections) {
    const walk = (nodes, parentId) => {
      for (const node of nodes) {
        node.parentId = parentId;
        const nested = node.metadata?.nested ?? [];
        node.children = nested.map((c) => c.id);
        walk(nested, node.id);
      }
    };
    walk(section.children, void 0);
  }
}
const DEFAULT_INFORMAL_SECTIONS = [
  {
    id: "functions",
    title: "Functions",
    type: "functions",
    required: true,
    allowChildren: true,
    order: 1,
    childType: "function",
    grandchildType: "function"
  },
  {
    id: "data-resources",
    title: "Data Resources",
    type: "data-resources",
    required: true,
    allowChildren: true,
    order: 2,
    childType: "data-resource",
    grandchildType: "data-field"
  },
  {
    id: "constraints",
    title: "Constraints",
    type: "constraints",
    required: true,
    allowChildren: true,
    order: 3,
    childType: "constraint"
  }
];
const TITLE_ALIASES = {
  functions: "functions",
  function: "functions",
  fn: "functions",
  功能: "functions",
  "data resources": "data-resources",
  "data-resources": "data-resources",
  dataresources: "data-resources",
  data: "data-resources",
  数据: "data-resources",
  "数据资源": "data-resources",
  constraints: "constraints",
  constraint: "constraints",
  约束: "constraints"
};
function sectionTypeFromTitle(title) {
  const cleaned = title.replace(/^#+\s*/, "").trim().toLowerCase();
  return TITLE_ALIASES[cleaned] ?? TITLE_ALIASES[cleaned.replace(/_/g, "-")] ?? null;
}
function sectionDef(type) {
  return DEFAULT_INFORMAL_SECTIONS.find((s) => s.id === type);
}
function nodeTypeForLevel(section, headingLevel) {
  const def = sectionDef(section);
  if (headingLevel <= 2)
    return def.childType;
  return def.grandchildType ?? def.childType;
}
const ID_COMMENT = /<!--\s*@id:([^>]+?)\s*-->/i;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
function splitBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let current = null;
  const bodyLines = [];
  const flush = () => {
    if (!current)
      return;
    const taken = consumeIdFromBody(bodyLines.join("\n"), current.id);
    current.id = taken.id;
    current.body = taken.body;
    blocks.push(current);
    bodyLines.length = 0;
  };
  for (const line of lines) {
    const match = line.match(HEADING);
    if (match) {
      flush();
      const rawTitle = match[2] ?? "";
      const idMatch = rawTitle.match(ID_COMMENT);
      const title = rawTitle.replace(ID_COMMENT, "").trim();
      current = {
        level: match[1].length,
        title,
        id: idMatch?.[1]?.trim(),
        body: ""
      };
      continue;
    }
    if (current)
      bodyLines.push(line);
  }
  flush();
  return blocks;
}
function consumeIdFromBody(body, existingId) {
  const lines = body.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === "")
    start += 1;
  const match = lines[start]?.trim().match(/^<!--\s*@id:([^>]+?)\s*-->$/);
  if (!match)
    return { id: existingId, body: body.trim() };
  const rest = [...lines.slice(0, start), ...lines.slice(start + 1)].join("\n").trim();
  return { id: existingId || match[1]?.trim(), body: rest };
}
function parseInformalSpec(markdown, options) {
  const diagnostics = [];
  const extracted = extractInformalFrontmatter(markdown);
  const body = extracted.body;
  const meta = { ...extracted.meta, ...options?.meta };
  const blocks = splitBlocks(body);
  const used = /* @__PURE__ */ new Set();
  const sections = DEFAULT_INFORMAL_SECTIONS.map((def) => ({
    id: def.id === "functions" ? "sec-fn" : def.id === "data-resources" ? "sec-dr" : "sec-c",
    type: def.id,
    title: def.title,
    children: []
  }));
  const sectionByType = new Map(sections.map((s) => [s.type, s]));
  let activeType = null;
  const stack = [];
  for (const block of blocks) {
    if (block.level === 1) {
      const type2 = sectionTypeFromTitle(block.title);
      if (!type2) {
        diagnostics.push(createDiagnostic(DiagnosticCodes.INFORMAL_UNKNOWN_SECTION, `Top-level heading "# ${block.title}" is not allowed. Use Functions, Data Resources, or Constraints.`, "error", block.title));
        activeType = null;
        stack.length = 0;
        continue;
      }
      activeType = type2;
      stack.length = 0;
      const section = sectionByType.get(type2);
      if (section && block.id)
        section.id = block.id;
      continue;
    }
    if (!activeType) {
      diagnostics.push(createDiagnostic(DiagnosticCodes.INFORMAL_ORPHAN_HEADING, `Heading "${block.title}" appears before a valid top-level section.`, "warning", block.title));
      continue;
    }
    const type = nodeTypeForLevel(activeType, block.level);
    const id = block.id && !used.has(block.id) ? block.id : createNodeId(type, block.title, used);
    used.add(id);
    const node = {
      id,
      type,
      title: block.title,
      description: block.body || void 0,
      children: []
    };
    while (stack.length && stack[stack.length - 1].level >= block.level)
      stack.pop();
    if (stack.length === 0) {
      sectionByType.get(activeType).children.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
      node.parentId = stack[stack.length - 1].node.id;
    }
    stack.push({ level: block.level, node });
  }
  const tree = {
    id: meta.id || "spec-local",
    moduleId: meta.moduleId || "project",
    version: meta.version && Number.isFinite(meta.version) ? meta.version : 1,
    metadata: {
      title: meta.title,
      author: meta.author,
      hybridTarget: meta.hybridTarget,
      guiTarget: meta.guiTarget,
      sourceFormat: "markdown"
    },
    sections
  };
  const specification = treeToSpec(tree);
  for (const def of DEFAULT_INFORMAL_SECTIONS) {
    if (def.required && !specification.sections.some((s) => s.type === def.id)) {
      specification.sections.push({
        id: sectionDef(def.id).id,
        type: def.id,
        title: def.title,
        children: []
      });
    }
  }
  specification.sections.sort((a, b) => sectionDef(a.type).order - sectionDef(b.type).order);
  return {
    specification,
    diagnostics,
    format: "markdown",
    displaySource: stripInformalIdComments(body)
  };
}
function nestedOf(node) {
  return node.metadata?.nested ?? [];
}
function clip(text, n) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= n)
    return compact;
  return `${compact.slice(0, Math.max(0, n - 1))}…`;
}
function formatInformalInventory(spec, maxChars = 12e3) {
  if (!spec)
    return "(empty informal specification)";
  const lines = [];
  for (const section of spec.sections) {
    lines.push(`## ${section.title} [${section.type}]`);
    const walk = (nodes, depth) => {
      if (!nodes.length && depth === 0) {
        lines.push("- (empty)");
        return;
      }
      for (const node of nodes) {
        const desc = node.description?.trim() ? ` — ${clip(node.description, 240)}` : "";
        lines.push(`${"  ".repeat(depth)}- ${node.id} (${node.type}) ${node.title}${desc}`);
        walk(nestedOf(node), depth + 1);
      }
    };
    walk(section.children, 0);
    lines.push("");
  }
  const text = lines.join("\n").trim();
  if (text.length <= maxChars)
    return text;
  return `${text.slice(0, maxChars)}
…(truncated)`;
}
function informalInventoryFromMarkdown(markdown, maxChars = 12e3) {
  const { specification } = parseInformalSpec(markdown);
  return formatInformalInventory(specification, maxChars);
}
function readStructured(result) {
  try {
    const parsed = JSON.parse(result);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (typeof parsed.action === "string") return null;
    const hasSelected = Array.isArray(parsed.selected);
    const hasCustom = typeof parsed.custom === "string";
    if (!hasSelected && !hasCustom) return null;
    const selected = hasSelected ? parsed.selected.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
    const custom = hasCustom ? parsed.custom.trim() : "";
    return { selected, custom };
  } catch {
    return null;
  }
}
function formatClarificationToolContent(result, options) {
  const structured = readStructured(result);
  let selected;
  let custom;
  if (structured) {
    selected = options?.multiSelect ? structured.selected : structured.selected.slice(0, 1);
    custom = structured.custom;
  } else {
    const labels = new Set(options?.labels ?? []);
    const parts = result.split(";").map((part) => part.trim()).filter(Boolean);
    selected = parts.filter((part) => labels.has(part));
    const customParts = parts.filter((part) => !labels.has(part));
    if (!options?.multiSelect && selected.length > 1) selected = selected.slice(0, 1);
    custom = selected.length === 0 ? result.trim() : customParts.join("; ");
  }
  const answer = [...selected, custom].filter(Boolean).join("; ");
  const next = custom ? "custom is text the user typed. You MUST use it even when this question was single-choice (multiSelect false) and even when selected is also non-empty. A clicked option does not replace or cancel custom. Then continue the task." : "Use the selected answer and continue the task. If more work remains, propose the next change or ask_clarification. When the task is done, write a short summary.";
  return {
    display: answer || result.trim(),
    toolContent: JSON.stringify({
      type: "clarification_answer",
      selected,
      custom,
      answer: answer || result.trim(),
      next
    })
  };
}
function clarificationContinuationText(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.type !== "clarification_answer") return null;
    const custom = typeof parsed.custom === "string" ? parsed.custom.trim() : "";
    const selected = Array.isArray(parsed.selected) ? parsed.selected.filter((item) => typeof item === "string" && item.trim().length > 0).join("; ") : "";
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    if (custom) {
      return `The user answered a clarification. Selected options: ${selected || "(none)"}. Custom answer, which you MUST follow even if the question was single-choice and even if a selected option is also present: ${custom}. Do not ignore this custom answer. Continue the task with propose_* or another ask_clarification as needed, then summarize when done.`;
    }
    return `The user answered a clarification: ${answer || selected || "(empty)"}. Continue the task. Prefer propose_changes / propose_hybrid_changes. When the task is done, write a short summary and stop.`;
  } catch {
    return null;
  }
}
function numberedSource(text, maxChars = 16e3) {
  if (!text.trim()) return "(empty file)";
  const body = text.split("\n").map((line, i) => `${String(i + 1).padStart(4, " ")}| ${line}`).join("\n");
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}
…(truncated)`;
}
function informalGrainNotes(projectRoot) {
  if (!projectRoot) return [];
  let names = [];
  try {
    names = node_fs.readdirSync(projectRoot).filter((name) => name.endsWith(".aspec"));
  } catch {
    return [];
  }
  const notes = [];
  for (const name of names) {
    try {
      notes.push(...parser.authorNotesFromInformalMarkdown(node_fs.readFileSync(node_path.join(projectRoot, name), "utf-8")));
    } catch {
    }
  }
  return notes;
}
function refinementLogPath(projectRoot) {
  return node_path.join(projectRoot, ".agile-sofl", "refinement-log.jsonl");
}
function readRefinementLog(projectRoot) {
  const file = refinementLogPath(projectRoot);
  if (!node_fs.existsSync(file)) return [];
  try {
    return editorApi.parseRefinementLog(node_fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}
function projectRefinementState(projectRoot, source) {
  return editorApi.buildRefinementState(source, readRefinementLog(projectRoot), informalGrainNotes(projectRoot));
}
function patchFingerprint(patch) {
  return JSON.stringify({
    target: patch.target ?? "",
    mode: patch.mode ?? "crud",
    operations: patch.operations ?? []
  });
}
function validateAgentPatch(target, patch, options) {
  if (!Array.isArray(patch.operations) || patch.operations.length === 0) {
    return { ok: false, message: "Patch has no operations." };
  }
  const mode = options?.mode ?? patch.mode ?? "crud";
  if (mode === "source") {
    for (const op of patch.operations) {
      const kind = String(op.op || "");
      if (kind === "replace-document") {
        if (typeof op.text !== "string" && typeof op.asflText !== "string") {
          return { ok: false, message: "replace-document requires text." };
        }
        continue;
      }
      if (kind === "append") {
        if (typeof op.text !== "string" || !String(op.text).length) {
          return { ok: false, message: "append requires text." };
        }
        continue;
      }
      if (kind === "replace") {
        if (!String(op.oldText ?? op.from ?? "").length) {
          return { ok: false, message: "replace requires oldText (a unique snippet from the current source)." };
        }
        continue;
      }
      return {
        ok: false,
        message: `Unknown source op "${kind}". Use replace, append, or replace-document.`
      };
    }
    return { ok: true, message: "ok" };
  }
  if (target === "gui") {
    const allowed = /* @__PURE__ */ new Set([
      "add",
      "add-screen",
      "remove",
      "remove-screen",
      "add-widget",
      "replace-html",
      "replace-screen-html",
      "insert-html",
      "patch-node",
      "remove-node"
    ]);
    for (const op of patch.operations) {
      const kind = String(op.op || "");
      if (!allowed.has(kind)) {
        return {
          ok: false,
          message: `Unknown GUI op "${kind}". Use add-screen, add-widget, replace-html, replace-screen-html, insert-html.`
        };
      }
    }
    return { ok: true, message: "ok" };
  }
  for (const op of patch.operations) {
    const kind = String(op.op || "");
    if (kind === "refine-step") {
      const stepKind = String(op.kind || "");
      if (!stepKind) return { ok: false, message: "refine-step requires kind." };
      if (stepKind === "FormalizePredicate") {
        if (!String(op.fromText ?? "").trim() || op.toText == null || !String(op.toText).trim()) {
          return {
            ok: false,
            message: "FormalizePredicate requires fromText (the current informal sentence) and toText (legal ASFL)."
          };
        }
      }
      if (stepKind === "ClassifyGrain") {
        const grain = String(op.grainClass ?? "");
        if (!String(op.moduleName ?? "").trim() || !String(op.processName ?? "").trim() || grain !== "operation" && grain !== "abstract") {
          return {
            ok: false,
            message: "ClassifyGrain requires moduleName, processName, and grainClass operation|abstract."
          };
        }
      }
      continue;
    }
    if (kind === "replace-document" || typeof op.asflText === "string") {
      return {
        ok: false,
        message: "replace-document / asflText is not allowed on CRUD. Use add/update/remove, or call propose_source_edit for a source-level fix."
      };
    }
    const blobs = [op.text, op.fsf, op.pre, op.post, op.comment, op.signature];
    for (const blob of blobs) {
      if (typeof blob !== "string") continue;
      if (/\b(?:module|system)\b[\s\S]{6,}end_module\b/i.test(blob) || /\bend_module\b/i.test(blob)) {
        return {
          ok: false,
          message: "Do not put whole modules or end_module in CRUD fields. Add each entity as a separate operation, or call propose_source_edit if you must edit the .asfl text."
        };
      }
    }
  }
  if (target === "hybrid") {
    for (const op of patch.operations) {
      const kind = String(op.op || "");
      if (kind === "add") {
        if (!op.kind) return { ok: false, message: "Hybrid add requires kind (module, type, var, inv, process, …)." };
        if (op.kind !== "inv" && !String(op.name ?? "").trim()) {
          return { ok: false, message: "Hybrid add requires name." };
        }
      }
      if ((kind === "update" || kind === "remove" || kind === "replace-process-body") && !String(op.id ?? "").trim()) {
        return { ok: false, message: `${kind} requires an inventory id.` };
      }
    }
  }
  return { ok: true, message: "ok" };
}
function consecutiveWriteFailures(toolContents) {
  let n = 0;
  for (let i = toolContents.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(toolContents[i] || "{}");
      if (parsed.action === "error" || parsed.ok === false) n += 1;
      else break;
    } catch {
      break;
    }
  }
  return n;
}
function crudBlockedByFailures(lastFailed, incoming) {
  if (incoming.mode === "source") return null;
  if (!lastFailed) return null;
  if (lastFailed.fingerprint === incoming.fingerprint) {
    return "This patch already failed. Do not retry it unchanged. Read the error, rewrite the fragment (legal ASFL, a unique fromText) or propose_source_edit, then continue.";
  }
  return null;
}
function nextFailedWrite(lastFailed, incoming) {
  const count2 = lastFailed ? lastFailed.count + 1 : 1;
  return {
    fingerprint: incoming.fingerprint,
    error: incoming.error,
    count: count2,
    mode: incoming.mode
  };
}
function continuationUserText(lastToolContent, failures = 0) {
  const clarification = clarificationContinuationText(lastToolContent || "");
  if (clarification) return clarification;
  let action;
  let error;
  let instruction;
  try {
    const parsed = JSON.parse(lastToolContent || "{}");
    action = parsed.action;
    error = parsed.error;
    if (parsed.type === "user_instruction") instruction = parsed.text || "";
  } catch {
  }
  if (instruction != null) {
    return `The user wrote this while a proposed change was still unconfirmed: ${instruction}. That change was neither applied nor rejected. Interpret their meaning and act now: re-propose the same change if they want it, propose a revision if they want something different, or leave it if they declined. Then continue the task. Do not stop and do not wait.`;
  }
  const sourceHint = "If CRUD cannot express the fix, call read_* with view=source, then propose_source_edit (replace/append/replace-document). That is allowed.";
  if (action === "applied") {
    if (error) {
      return `The patch was applied, but some operations failed: ${error}. Immediately call read_specification and/or read_hybrid_specification, fix remaining work with CRUD or ${sourceHint}`;
    }
    return "The patch was applied. Immediately call read_specification and/or read_hybrid_specification and read_refinement_state (if Hybrid changed). Compare with the plan, and either propose the next incremental CRUD/refinement step or write a final summary. If the refinement digest is not unambiguous, invite the next slice with ask_clarification. Do not wait for a new user message.";
  }
  if (action === "error" || failures >= 2) {
    return `The write failed: ${error || "unknown error"}. This is a tool result, not a stopped session. Do not retry the same patch unchanged. Rewrite it (legal ASFL, unique fromText) and re-propose, or call read_specification and/or read_hybrid_specification with view=source, then propose_source_edit to unstick (replace a unique snippet, append, or replace-document). Then verify. Do not stop with an empty message.`;
  }
  if (action === "rejected") {
    return "The user rejected that patch. Adjust: ask_clarification if needed, propose a smaller CRUD patch, or use propose_source_edit if the file itself is stuck. Do not stop with an empty message.";
  }
  return "Continue now. Prefer propose_changes / propose_hybrid_changes. If those fail, read source and propose_source_edit. After writes, read the spec to verify. When the task is done, write a short summary and stop. Do not reply with an empty message.";
}
function appliedToolResult(extra) {
  const notes = [
    extra?.repair ? `Auto-repair kept the write legal: ${extra.repair}.` : "",
    extra?.userNote ? `The user also said: ${extra.userNote}. Follow that after verifying.` : ""
  ].filter(Boolean);
  const next = extra?.error ? `Some operations failed: ${extra.error}. Read the inventory (and view=source if needed). Follow up with a corrected CRUD or propose_source_edit. Do not stop.` : "Call read_specification and/or read_hybrid_specification and read_refinement_state (if Hybrid changed) to verify. If syntax errors remain, fix them before the next step. If more work remains, propose the next CRUD or propose_refinement_step (or propose_source_edit if CRUD cannot express it). If Hybrid still has dual-line gaps, ask_clarification for the next slice. If the task is complete, write a short summary and stop.";
  return JSON.stringify({
    action: "applied",
    ok: !extra?.error,
    error: extra?.error,
    repair: extra?.repair,
    userNote: extra?.userNote,
    next: [next, ...notes].join(" ")
  });
}
function userInstructionToolResult(text) {
  return JSON.stringify({
    type: "user_instruction",
    applied: false,
    rejected: false,
    text,
    next: "The user wrote this while your proposed change was still unconfirmed. It was neither applied nor rejected. Interpret their meaning: re-propose the same change if they want it, propose a revision if they want something else, or drop it if they declined. Then continue the task. Do not stop."
  });
}
function rejectedToolResult() {
  return JSON.stringify({
    action: "rejected",
    ok: false,
    next: "Revise the plan. Ask if needed, propose a smaller CRUD patch, or propose_source_edit if the file is stuck."
  });
}
function assistantTurnIsComplete(content, toolCallCount) {
  return content.trim().length > 0;
}
function failedToolResult(error, userNote) {
  return JSON.stringify({
    action: "error",
    ok: false,
    error,
    userNote: userNote || void 0,
    next: [
      "Tool failed. Do not retry the identical patch. Read the error, rewrite the fragment, and re-propose. If CRUD cannot express the fix, read inventory and view=source, then propose_source_edit. Do not stop the task.",
      userNote ? `The user also said: ${userNote}` : ""
    ].filter(Boolean).join(" ")
  });
}
const MAX_HISTORY = 20;
function permissionsOf(session, ctx) {
  return normalizePermissions(ctx.permissions ?? session.context.permissions);
}
function toolsFor(permissions) {
  return AGENT_TOOLS.filter((tool) => {
    const name = tool.function.name;
    if (name === "ask_clarification") return true;
    if (name === "read_specification" || name === "review_specification") return permissions.informal.read;
    if (name === "propose_changes") return permissions.informal.write;
    if (name === "read_hybrid_specification" || name === "review_hybrid" || name === "read_refinement_state")
      return permissions.hybrid.read;
    if (name === "propose_hybrid_changes" || name === "propose_refinement_step") return permissions.hybrid.write;
    if (name === "read_gui_specification") return permissions.hybrid.read || permissions.informal.read;
    if (name === "propose_gui_changes") return permissions.hybrid.write || permissions.informal.write;
    if (name === "propose_source_edit") return permissions.informal.write || permissions.hybrid.write;
    return true;
  });
}
function compactSpec(markdown) {
  return informalInventoryFromMarkdown(markdown, 12e3);
}
function compactHybrid(asfl) {
  if (!asfl?.trim()) return "(empty hybrid specification)";
  return editorApi.formatHybridInventory(asfl, 12e3);
}
function compactRefinement(ctx) {
  return compactRefinementView(ctx, "summary");
}
function compactRefinementView(ctx, view) {
  if (!ctx.hybridAsfl?.trim()) return "(no hybrid specification yet — generate Hybrid before dual-line refinement)";
  try {
    const state = projectRefinementState(ctx.projectRoot ?? "", ctx.hybridAsfl);
    return editorApi.formatRefinementDigest(state, view, view === "tree" ? 16e3 : 12e3);
  } catch {
    return "(refinement digest unavailable)";
  }
}
function hybridDiagnosticsPayload(asfl) {
  const items = editorApi.collectHybridAgentDiagnostics(asfl ?? "");
  return {
    count: items.length,
    errors: items.filter((d) => d.severity === "error").length,
    items
  };
}
async function hybridDiagnosticsWithSemantic(asfl, cfg) {
  const base = hybridDiagnosticsPayload(asfl);
  let semantic = [];
  try {
    semantic = await semanticDiagnostics(asfl ?? "", cfg);
  } catch {
  }
  const items = [
    ...base.items,
    ...semantic.map((d) => ({
      severity: d.severity,
      code: d.code,
      source: /^ASFL_FSF_1/.test(d.code) ? "L1" : "L2",
      line: d.span.line,
      column: d.span.column,
      message: d.message
    }))
  ];
  return {
    count: items.length,
    errors: items.filter((d) => d.severity === "error").length,
    items,
    semanticChecks: cfg.semanticChecks
  };
}
function numberedHybridSource(asfl) {
  const source = numberedSource(asfl ?? "");
  const report = editorApi.formatHybridDiagnostics(asfl ?? "");
  if (report === "(no hybrid diagnostics)") return source;
  return `${source}

${report}`;
}
function systemPrompt(ctx, permissions) {
  const skill = skillById(ctx.skillId);
  const toolLines = [
    "- ask_clarification: when you need a decision (options the user can click, plus their own typed answer)"
  ];
  if (permissions.informal.read) {
    toolLines.push("- read_specification: Informal inventory (default) or numbered source (view=source)");
    toolLines.push("- review_specification: Informal quality review");
  }
  if (permissions.informal.write) {
    toolLines.push("- propose_changes: Informal add/update/remove/move (preferred)");
  }
  if (permissions.hybrid.read) {
    toolLines.push("- read_hybrid_specification: Hybrid inventory (default; includes per-module syntax/parse diagnostics) or numbered .asfl (view=source)");
    toolLines.push("- read_refinement_state: dual-line refinement tree/summary/log (empty modules and stub processes are gaps)");
    toolLines.push("- review_hybrid: Hybrid quality review");
  }
  if (permissions.hybrid.read || permissions.informal.read) {
    toolLines.push("- read_gui_specification: GUI HTML inventory or numbered .gui.html (view=source)");
  }
  if (permissions.hybrid.write) {
    toolLines.push("- propose_hybrid_changes: incremental Hybrid CRUD (preferred)");
    toolLines.push(
      "- propose_refinement_step: FormalizePredicate / DecomposeProcess / SetCdfd / DeclareAtomic / IntroduceRetrieve / DischargeDataObligation / ClassifyGrain / ResolveVariation. A module without cdfd is valid; do not treat ASFL_CDFD_001 as a syntax error. Grain ambiguity does not drop if you only rewrite pre/post."
    );
  }
  if (permissions.hybrid.write || permissions.informal.write) {
    toolLines.push("- propose_gui_changes: GUI HTML structure patches — full-screen prototypes with as-* layout, not a few buttons");
  }
  if (permissions.informal.write || permissions.hybrid.write) {
    toolLines.push(
      "- propose_source_edit: last-resort Informal/Hybrid source edit (replace/append/replace-document) when CRUD cannot unstick"
    );
  }
  const informalGuide = permissions.informal.write ? `For propose_changes, operate on the CURRENT Informal inventory (ids like fn-login, dr-account, c-unique):
- add: target = functions | data-resources | constraints (or a parent node id). node.type = function | data-resource | data-field | constraint. Include title and description.
- update: id = existing node id (or unique title). Set title and/or description.
- remove: id = existing node id.
- move: id + parentId + optional afterId.
Prefer update/remove on existing nodes over adding a second copy of the same idea.
Do not invent YAML frontmatter or document-level metadata.` : "You do not have Informal write permission. Do not call propose_changes.";
  const hybridGuide = permissions.hybrid.write ? `For propose_hybrid_changes, operate on Hybrid inventory ids with CRUD only:
- add: kind (module|type|var|const|inv|process|function|scenario|gui-screen) + parentId (mod:Module or proc:Module.Name) + name. Bare ids like proc:Login or Chinese titles are resolved when possible, but prefer inventory ids. Types/vars/invs use text. Processes use signature + FSF (final grammar): FSF : T1 && D1 || T2 && D2 || … || others && Dn (Ti = test condition over inputs and ~x initial values, never outputs; Di = defining condition that constrains outputs / written ext vars). Inside Ti/Di use and, or, not; && and || only separate scenarios. If ports are unknown, signature is () — do not invent dummy (x: nat) ok: nat.
- update / remove: id of existing entity (mod:, proc:, type:, var:, inv:, scn:, gui:). Removing a parent module rewrites child headers (drops / Parent).
- replace-process-body: id of proc:, set fsf to the full FSF text "FSF : T1 && D1 || T2 && D2 || … || others && Dn" (structured natural language is allowed inside Ti/Di). Use pre/post only for legacy documents that already use them.
FORBIDDEN: replace-document, asflText, dumping several modules as one string, "-- comments" as source.
Add SYSTEM_ first, then one semantic module at a time with parentId pointing at the system module, then its types/vars/invs/processes as separate operations. Prefer updating an existing id over adding a duplicate.
Never put end_module, a whole module, or a process block inside type/var/inv/pre/post text — that wipes the document.
After a write is applied, call read_hybrid_specification and keep patching until the inventory matches the plan and Diagnostics lists no syntax errors. A module with processes and no cdfd is backward compatible — do not add a cdfd just to clear a warning.
Formalize informal FSF atoms only via propose_refinement_step kind=FormalizePredicate.
Decompose a process with kind=DecomposeProcess (child module, empty cdfd, matching ports, decom set to that module).
Write or replace a module CDFD with kind=SetCdfd: moduleName plus toText, either a full "cdfd ... end_cdfd" block or the inner lines. One cdfd per module. Syntax:
  port in <name> / port out <name>
  store <var>
  node <process>
  cond <name>
  flow <from> -> <to>
  flow <cond> | <predicate> -> <target>
  flow <cond> | others -> <target>
node names are processes in that module; store names are vars; ports match the parent process inputs and outputs when this module is a decom target. Do not store coordinates. Type keywords (time, nat, string, bool, …) are legal parameter and variable names.` : "You do not have Hybrid write permission. Do not call propose_hybrid_changes.";
  const guiGuide = permissions.hybrid.write || permissions.informal.write ? `For propose_gui_changes, design a high-fidelity product prototype the user can walk through:
- Each screen should look like a finished app surface: shell/sidebar or navbar, hero or toolbar, cards/lists/tables/forms, badges, empty states, primary+secondary actions.
- Each screen is a separate HTML page. Clicking data-nav must switch screens; the screen list follows. Do not put the whole app into one un-navigable view.
- Prefer replace-screen-html (or add-screen with html) with the FULL inner markup of that screen. All children are kept; do not flatten a layout down to the first widget.
- Tags: common HTML5 (header/main/aside/nav/table/form/img/a/…). Classes: any as-* token (as-shell, as-hero, as-card, as-grid-3, as-btn-primary, …). Bind with data-process / data-bind / data-nav.
- Do not ship a page that is only two or three unlabeled buttons. Navigation must be visible in the layout, not implied.
- Never emit <script>, style=, href, or src.` : "You do not have GUI write permission. Do not call propose_gui_changes.";
  const sourceGuide = permissions.informal.write || permissions.hybrid.write ? `propose_source_edit is an escape hatch, not the default:
- Prefer propose_changes / propose_hybrid_changes / propose_gui_changes / propose_refinement_step for almost every write.
- Use source edit after CRUD fails, when leftover unparsed text remains, when inventory is empty/out of sync with the file, when Diagnostics lists syntax/parse errors CRUD cannot fix, or when you must fix text CRUD cannot express.
- First call read_* with view=source (or read_refinement_state then source). Then replace a UNIQUE oldText snippet, append, or replace-document.
- Informal atoms that you rewrite via source edit still need propose_refinement_step kind=FormalizePredicate or process ambiguity will not drop.
- Do not retry the same failing CRUD patch. After two CRUD failures you MUST switch to propose_source_edit.` : "You do not have write permission for source edits.";
  const refinementGuide = permissions.hybrid.read ? `Dual-line refinement (guide the user; do not auto-refine the whole tree):
- Journey: Informal → Hybrid+GUI → process atomicity + data discharge + operational grain until the refinement digest reports unambiguous=true.
- Operational grain: a leaf is not atomic just because pre/post are formal. If the digest lists variations or a name-claim, ask_clarification about those extracted items only, then ClassifyGrain or ResolveVariation. Do not invent operations, and do not clear grainAmbiguity by rewriting pre/post.
- Predicate text must lex as ASFL. There is no VDM post-state prime and no ^. The final value is the bare name (~x is the initial value). Sequence append is conc(seq, elem). != is <>. Studio rewrites a trailing prime and a clear ^ before the write is kept, and it refuses a write that would add syntax errors. If a tool result says the write was not kept or a patch already failed, rewrite that fragment and re-propose. Do not retry the identical text and do not stop.
- Empty name-only modules and stub (name-only) processes are gaps. Hybrid generation does not finish the specification.
- After Hybrid/GUI work for this turn is done, if unambiguous=false, ask_clarification with 2–4 next slices from the digest. Wait for the user unless they already named a slice.
- Prefer propose_refinement_step, then propose_hybrid_changes. Fallback: propose_source_edit on Hybrid.
- After Hybrid writes, call read_refinement_state as well as read_hybrid_specification.
- Do not claim "no ambiguity" while processAmbiguity, dataAmbiguity, empty modules, or stubs remain.` : "Refinement digest: (hybrid read permission off)";
  const informalBlock = permissions.informal.read ? `Current Informal Specification inventory:
${compactSpec(ctx.informalMarkdown)}` : "Informal Specification: (read permission off)";
  const hybridBlock = permissions.hybrid.read ? `Current Hybrid Specification inventory:
${compactHybrid(ctx.hybridAsfl)}` : "Hybrid Specification: (read permission off)";
  const guiBlock = permissions.hybrid.read || permissions.informal.read ? `Current GUI HTML inventory:
${ctx.guiHtml?.trim() ? gui.formatGuiInventory(ctx.guiHtml, 8e3) : "(empty GUI specification)"}` : "GUI Specification: (read permission off)";
  const refinementBlock = permissions.hybrid.read ? `Current dual-line refinement digest:
${compactRefinement(ctx)}` : "Refinement tree: (hybrid read permission off)";
  return `You are the Agile-SOFL Specification Agent inside Studio.
You help users build Informal Specification and/or Hybrid Specification (.asfl).
Markdown and SOFL text are views. You MUST NOT output a full document to apply.
You MUST use tools:
${toolLines.join("\n")}

Agile-SOFL conventions:
- There is exactly one system module. Name it SYSTEM_<SystemName> after the whole product (e.g. SYSTEM_FoodDelivery). It is the root; every other module is a child: module Auth / FoodDelivery;
- SYSTEM_ is listed first in the .asfl file. Do not treat GUI_App or a feature module as the system module.
- Processes without known ports use signature (). Inventing (x: nat) ok: nat is wrong.
- There is no implication operator: write not A or B instead. Process logic is written as FSF: FSF : T1 && D1 || T2 && D2 || … || others && Dn.
- GUI is a walkable high-fidelity prototype, not a wireframe of a few buttons.

Never claim you already modified the file. Writes go through propose_* tools. User Apply/Reject (or auto-write) is only a tool result — you MUST continue the same task.
A tool result with type user_instruction is the user's own words while a change card was still open. That change was neither applied nor rejected. Interpret the words yourself: re-propose the same change if they want it, propose a revision if they want something else, or drop it if they declined. Then continue the task. Do not stop.
Clarification tool results include "selected" (clicked options) and "custom" (text the user typed). If custom is non-empty, you MUST use it. Single-choice (multiSelect false) does not discard custom, and a clicked option does not override it. When both are present, follow both.
After any applied write, call read_specification and/or read_hybrid_specification (and read_refinement_state when Hybrid changed), verify inventory, Hybrid Diagnostics, and dual-line gaps, and propose another patch if anything is missing, wrong, or still has syntax errors. Repeat until the current task slice is done.
When the whole task is done, your LAST message is a short summary of what was completed. Do not wait for the user to say "continue". If Hybrid exists and the digest is not unambiguous, that summary must invite the next refinement slice (ask_clarification) unless the user already declined further refinement.
Prefer structured CRUD. Do not dump raw Markdown or raw SOFL through propose_changes / propose_hybrid_changes. If those tools fail or cannot express the fix, read view=source and use propose_source_edit.

You are scoped to ONE project. Read/write only this project's Informal, Hybrid, and GUI files. Do not copy modules or text from any other Studio project.

${informalGuide}

${hybridGuide}

${guiGuide}

${refinementGuide}

${sourceGuide}

Active skill: ${skill.name}
${skill.prompt}

Current project: ${ctx.projectName ?? "unknown"}
Project folder: ${ctx.projectRoot ?? "(unknown)"}
Current module: ${ctx.moduleId ?? "project"}
Selected node: ${ctx.selectedNodeSummary || ctx.selectedNodeId || "(none — stay focused on selection when present)"}
Session permissions: Informal r=${permissions.informal.read} w=${permissions.informal.write}; Hybrid r=${permissions.hybrid.read} w=${permissions.hybrid.write}

${ctx.promptExtras ? `${ctx.promptExtras}
` : ""}
${informalBlock}

${hybridBlock}

${guiBlock}

${refinementBlock}
`;
}
function toApiMessages(session, ctx, permissions, options) {
  const msgs = [{ role: "system", content: systemPrompt(ctx, permissions) }];
  const toolResults = /* @__PURE__ */ new Map();
  for (const m of session.messages) {
    if (m.role === "tool") toolResults.set(m.id, m);
  }
  const body = [];
  for (const m of session.messages) {
    if (m.role === "system" || m.role === "tool") continue;
    if (m.role === "user") {
      body.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role !== "assistant") continue;
    const toolCalls = m.toolCalls ?? [];
    if (toolCalls.length) {
      const results = toolCalls.map((call) => toolResults.get(call.id));
      if (results.some((result) => !result)) continue;
      const assistant = {
        role: "assistant",
        content: m.content || null,
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments }
        })),
        reasoning_content: m.thinking ?? ""
      };
      body.push(assistant);
      for (const call of toolCalls) {
        body.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolResults.get(call.id).content
        });
      }
      continue;
    }
    if (m.content.trim() || m.thinking?.trim()) {
      body.push({ role: "assistant", content: m.content });
    }
  }
  const startIndexes = /* @__PURE__ */ new Set();
  for (let i = 0; i < body.length; i++) {
    const msg = body[i];
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      startIndexes.add(i);
      let j = i + 1;
      while (j < body.length && body[j]?.role === "tool") {
        startIndexes.add(j);
        j += 1;
      }
    }
  }
  for (let i = Math.max(0, body.length - MAX_HISTORY); i < body.length; i++) startIndexes.add(i);
  const trimmed = body.filter((_, i) => startIndexes.has(i));
  msgs.push(...trimmed);
  if (options?.continuation) {
    const lastTool = [...session.messages].reverse().find((m) => m.role === "tool");
    const toolContents = session.messages.filter((m) => m.role === "tool").map((m) => m.content);
    const failures = Math.max(
      consecutiveWriteFailures(toolContents),
      session.context.lastFailedWrite?.count ?? 0
    );
    msgs.push({
      role: "user",
      content: continuationUserText(lastTool?.content, failures)
    });
  }
  return msgs;
}
function parseArgs(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function settleFinishedToolCalls(session) {
  for (const msg of session.messages) {
    if (msg.role !== "assistant" || msg.streaming) continue;
    for (const call of msg.toolCalls ?? []) {
      if (call.status === "streaming" || call.status === "running" || !call.status) {
        call.status = "done";
      }
    }
  }
}
function saveSession(projectRoot, session) {
  settleFinishedToolCalls(session);
  saveSession$1(projectRoot, session);
}
function emit(sink, event) {
  if (event.kind === "session") settleFinishedToolCalls(event.session);
  sink?.(event);
}
const TOOL_DELTA_THROTTLE_MS = 50;
const TEXT_DELTA_THROTTLE_MS = 80;
function yieldToUi() {
  return new Promise((resolve) => setImmediate(resolve));
}
function emitToolCall(sink, live, index, status) {
  const call = live.toolCalls?.[index];
  if (!call) return;
  const args = status === "streaming" && call.arguments.length > 12e3 ? call.arguments.slice(0, 4e3) : call.arguments;
  emit(sink, {
    kind: "tool_call",
    messageId: live.id,
    index,
    id: call.id,
    name: call.name,
    arguments: args,
    status
  });
}
function markCallStatus(live, id, status, sink) {
  const index = live.toolCalls?.findIndex((c) => c.id === id) ?? -1;
  if (index < 0 || !live.toolCalls) return;
  live.toolCalls[index].status = status;
  emit(sink, { kind: "tool_status", messageId: live.id, index, id, status });
}
function markRemainingToolCalls(live, status, sink) {
  for (const call of live.toolCalls ?? []) {
    if (call.status === "done" || call.status === "error") continue;
    markCallStatus(live, call.id, status, sink);
  }
}
function attachStreamDeltas(live, sink) {
  let lastToolEmitAt = 0;
  let toolsPending = false;
  let textTimer = null;
  let lastTextEmitAt = 0;
  let lastSentContent = "";
  let lastSentThinking = "";
  const seenNames = /* @__PURE__ */ new Set();
  const emitSnapshot = () => {
    toolsPending = false;
    lastToolEmitAt = Date.now();
    for (let i = 0; i < (live.toolCalls?.length ?? 0); i++) {
      emitToolCall(sink, live, i, live.toolCalls[i].status ?? "streaming");
    }
  };
  const flushText = () => {
    if (textTimer) {
      clearTimeout(textTimer);
      textTimer = null;
    }
    lastTextEmitAt = Date.now();
    const thinking = live.thinking ?? "";
    if (thinking !== lastSentThinking) {
      lastSentThinking = thinking;
      if (thinking) emit(sink, { kind: "reasoning", messageId: live.id, text: thinking });
    }
    if (live.content !== lastSentContent) {
      lastSentContent = live.content;
      if (live.content) emit(sink, { kind: "content", messageId: live.id, text: live.content });
    }
  };
  const scheduleText = () => {
    const now = Date.now();
    if (now - lastTextEmitAt >= TEXT_DELTA_THROTTLE_MS) {
      flushText();
      return;
    }
    if (textTimer) return;
    textTimer = setTimeout(() => {
      textTimer = null;
      flushText();
    }, TEXT_DELTA_THROTTLE_MS - (now - lastTextEmitAt));
  };
  return {
    onDelta(delta) {
      if (delta.reasoning != null || delta.content != null) {
        if (delta.reasoning != null) live.thinking = delta.reasoning;
        if (delta.content != null) live.content = delta.content;
        scheduleText();
      }
      if (!delta.toolCalls) return;
      live.toolCalls = delta.toolCalls.map((c, i) => ({
        id: c.id || live.toolCalls?.[i]?.id || `pending-${i}`,
        name: c.name,
        arguments: c.arguments,
        status: "streaming"
      }));
      const nameAppeared = (live.toolCalls ?? []).some((c, i) => {
        if (!c.name) return false;
        const key = `${i}:${c.name}`;
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });
      const heavy = (live.toolCalls ?? []).some((c) => c.arguments.length > 8e3);
      const wait = heavy ? 200 : TOOL_DELTA_THROTTLE_MS;
      const now = Date.now();
      if (nameAppeared || now - lastToolEmitAt >= wait) {
        emitSnapshot();
        return;
      }
      toolsPending = true;
    },
    flush() {
      flushText();
      if (toolsPending || live.toolCalls?.length) emitSnapshot();
    }
  };
}
const AGENT_THINKING = false;
function retryReasonOf(e) {
  const msg = e instanceof Error ? e.message : String(e);
  const status = /\b(4\d\d|5\d\d)\b/.exec(msg)?.[1];
  return (status ? `HTTP ${status}: ` : "") + msg.replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/g, "[redacted]").slice(0, 120);
}
async function loggedStream(projectRoot, sessionId, options, meta = { attempt: 1 }) {
  const callMeta = { reasoning: reasoningEffortFor(options.thinking), attempt: meta.attempt, ...meta.retryReason ? { retryReason: meta.retryReason } : {} };
  const cfg = getExperimentConfig(projectRoot);
  announceCondition(projectRoot, sessionId, cfg);
  const t0 = Date.now();
  const promptChars = JSON.stringify(options.messages).length;
  try {
    const c = await chatEcnuStream(options);
    logTelemetry(projectRoot, cfg, sessionId, {
      event: "llm_call",
      model: c.model ?? getEcnuConfig().model,
      promptTokens: c.usage?.promptTokens ?? null,
      completionTokens: c.usage?.completionTokens ?? null,
      latencyMs: Date.now() - t0,
      ok: true,
      ...callMeta,
      finishReason: c.finishReason,
      toolCalls: c.toolCalls.map((t) => t.function.name),
      promptChars,
      prompt: cfg.logPrompts ? options.messages : void 0
    });
    return c;
  } catch (e) {
    logTelemetry(projectRoot, cfg, sessionId, {
      event: "llm_call",
      model: getEcnuConfig().model,
      promptTokens: null,
      completionTokens: null,
      latencyMs: Date.now() - t0,
      ok: false,
      ...callMeta,
      promptChars,
      error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)
    });
    throw e;
  }
}
async function runAgentTurn(session, projectRoot, ctx, userText, sink, signal) {
  if (userText?.trim()) {
    session.messages.push({
      id: newId("msg"),
      role: "user",
      content: userText.trim(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      skillId: ctx.skillId
    });
    if (session.title === "Requirement Analysis" && session.messages.filter((m) => m.role === "user").length === 1) {
      session.title = userText.trim().slice(0, 42);
    }
    saveSession(projectRoot, session);
    emit(sink, { kind: "session", session });
  }
  session.context.skillId = ctx.skillId || session.context.skillId || "requirement-discovery";
  session.context.selectedNodeId = ctx.selectedNodeId;
  const permissions = permissionsOf(session, ctx);
  session.context.permissions = permissions;
  if (ctx.promptExtras) session.context.promptExtras = ctx.promptExtras;
  else ctx.promptExtras = session.context.promptExtras;
  ctx.permissions = permissions;
  const continuation = !userText?.trim();
  let needsContinuationNudge = continuation;
  const stopIfAborted = () => {
    if (!signal?.aborted) return false;
    const live = [...session.messages].reverse().find((m) => m.role === "assistant" && m.streaming);
    if (live) {
      live.streaming = false;
      markRemainingToolCalls(live, "error", sink);
      if (!live.content.trim()) live.content = "已停止 / Stopped.";
    } else {
      session.messages.push({
        id: newId("msg"),
        role: "assistant",
        content: "已停止 / Stopped.",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        skillId: ctx.skillId
      });
    }
    saveSession(projectRoot, session);
    emit(sink, { kind: "session", session });
    return true;
  };
  for (let step = 0; step < 14; step++) {
    if (stopIfAborted()) return session;
    const assistantId = newId("msg");
    const live = {
      id: assistantId,
      role: "assistant",
      content: "",
      thinking: "",
      streaming: true,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      skillId: ctx.skillId
    };
    session.messages.push(live);
    emit(sink, { kind: "session", session });
    const history = { ...session, messages: session.messages.filter((m) => m.id !== assistantId) };
    const request = {
      messages: toApiMessages(history, ctx, permissions, { continuation: needsContinuationNudge }),
      tools: toolsFor(permissions),
      temperature: 0.35
    };
    const streamDeltas = attachStreamDeltas(live, sink);
    let completion;
    try {
      completion = await loggedStream(projectRoot, session.id, {
        ...request,
        thinking: AGENT_THINKING,
        signal,
        onDelta: streamDeltas.onDelta
      });
    } catch (first) {
      streamDeltas.flush();
      if (isChatAborted(first) || signal?.aborted) {
        live.streaming = false;
        markRemainingToolCalls(live, "error", sink);
        if (!live.content.trim()) live.content = "已停止 / Stopped.";
        saveSession(projectRoot, session);
        emit(sink, { kind: "session", session });
        return session;
      }
      try {
        completion = await loggedStream(projectRoot, session.id, {
          ...request,
          thinking: false,
          signal,
          onDelta: streamDeltas.onDelta
        }, { attempt: 2, retryReason: retryReasonOf(first) });
      } catch (err) {
        streamDeltas.flush();
        live.streaming = false;
        markRemainingToolCalls(live, "error", sink);
        if (isChatAborted(err) || signal?.aborted) {
          if (!live.content.trim()) live.content = "已停止 / Stopped.";
          saveSession(projectRoot, session);
          emit(sink, { kind: "session", session });
          return session;
        }
        live.content = err instanceof Error ? err.message : String(err);
        saveSession(projectRoot, session);
        emit(sink, { kind: "session", session });
        if (continuation) {
          session.messages = session.messages.filter((m) => m.id !== assistantId);
          continue;
        }
        throw err;
      }
    }
    streamDeltas.flush();
    await yieldToUi();
    live.streaming = false;
    live.content = completion.content.trim();
    live.thinking = completion.reasoning.trim() || live.thinking;
    if (completion.toolCalls.length) {
      live.toolCalls = completion.toolCalls.map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
        status: "running"
      }));
      live.toolCalls.forEach((call, index) => {
        emit(sink, {
          kind: "tool_call",
          messageId: assistantId,
          index,
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: "running"
        });
      });
    } else {
      live.toolCalls = void 0;
    }
    if (completion.toolCalls.length) {
      for (const call of completion.toolCalls) {
        await yieldToUi();
        const args = parseArgs(call.function.arguments || "{}");
        if (call.function.name === "ask_clarification") {
          const options = Array.isArray(args.options) ? args.options.filter((o) => o.label).map((o, i) => ({ id: o.id || `opt-${i}`, label: String(o.label) })) : void 0;
          live.content = String(args.question || live.content || "");
          live.clarification = {
            id: newId("q"),
            question: String(args.question || "Please clarify."),
            options,
            allowCustom: args.allowCustom !== false,
            multiSelect: Boolean(args.multiSelect),
            pendingToolCallId: call.id
          };
          live.pending = true;
          session.context.pendingToolCallId = call.id;
          completeSiblingToolCalls(session, completion.toolCalls, call.id);
          markCallStatus(live, call.id, "done", sink);
          markRemainingToolCalls(live, "done", sink);
          saveSession(projectRoot, session);
          emit(sink, { kind: "session", session });
          return session;
        }
        if (call.function.name === "propose_changes" || call.function.name === "propose_hybrid_changes" || call.function.name === "propose_refinement_step" || call.function.name === "propose_gui_changes" || call.function.name === "propose_source_edit") {
          const mode = call.function.name === "propose_source_edit" ? "source" : "crud";
          let target;
          if (call.function.name === "propose_hybrid_changes" || call.function.name === "propose_refinement_step")
            target = "hybrid";
          else if (call.function.name === "propose_changes") target = "informal";
          else if (call.function.name === "propose_gui_changes") target = "gui";
          else {
            const raw = typeof args.target === "string" ? args.target : "";
            if (raw === "hybrid" || raw === "informal") {
              target = raw;
            } else if (permissions.hybrid.write && !permissions.informal.write) {
              target = "hybrid";
            } else if (permissions.informal.write && !permissions.hybrid.write) {
              target = "informal";
            } else {
              session.messages.push({
                id: call.id,
                role: "tool",
                content: JSON.stringify({
                  ok: false,
                  error: 'propose_source_edit requires target: "informal" or "hybrid".',
                  next: "Re-call propose_source_edit with an explicit target after read_* view=source."
                }),
                timestamp: (/* @__PURE__ */ new Date()).toISOString()
              });
              live.content = live.content || "Source edit needs an explicit target.";
              markCallStatus(live, call.id, "error", sink);
              continue;
            }
          }
          let patch = call.function.name === "propose_refinement_step" ? {
            target: "hybrid",
            mode: "crud",
            explanation: typeof args.explanation === "string" ? args.explanation : void 0,
            operations: [
              {
                op: "refine-step",
                kind: args.kind,
                moduleName: args.moduleName,
                processName: args.processName,
                typeName: args.typeName,
                clause: args.clause,
                fromText: args.fromText,
                toText: args.toText,
                childModuleName: args.childModuleName,
                representationType: args.representationType,
                retrieveFunction: args.retrieveFunction,
                retrieveBody: args.retrieveBody,
                note: args.note,
                grainClass: args.grainClass,
                variationId: args.variationId,
                disposition: args.disposition
              }
            ]
          } : {
            target,
            mode,
            explanation: typeof args.explanation === "string" ? args.explanation : void 0,
            operations: Array.isArray(args.operations) ? args.operations : []
          };
          const allowed = target === "informal" ? permissions.informal.write : target === "hybrid" ? permissions.hybrid.write : permissions.hybrid.write || permissions.informal.write;
          if (!allowed) {
            session.messages.push({
              id: call.id,
              role: "tool",
              content: JSON.stringify({
                ok: false,
                error: `No ${target} write permission.`,
                next: "Do not call write tools for a specification you cannot write."
              }),
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            });
            live.content = live.content || `No ${target} write permission.`;
            markCallStatus(live, call.id, "error", sink);
            continue;
          }
          if (target === "hybrid") {
            const normalized = normalizeHybridPatch(patch);
            patch = normalized.patch;
            if (normalized.unresolved) {
              const error = `Could not auto-repair illegal ASFL (${normalized.unresolved}).`;
              session.context.lastFailedWrite = nextFailedWrite(session.context.lastFailedWrite, {
                fingerprint: patchFingerprint(patch),
                error,
                mode
              });
              session.messages.push({
                id: call.id,
                role: "tool",
                content: JSON.stringify({
                  ok: false,
                  error,
                  next: "Rewrite ^ as conc(seq, elem) and drop VDM primes. Re-propose a different patch. Do not stop."
                }),
                timestamp: (/* @__PURE__ */ new Date()).toISOString()
              });
              live.content = live.content || error;
              markCallStatus(live, call.id, "error", sink);
              continue;
            }
          }
          const blocked = crudBlockedByFailures(session.context.lastFailedWrite, {
            fingerprint: patchFingerprint(patch),
            mode
          });
          if (blocked) {
            session.context.lastFailedWrite = nextFailedWrite(session.context.lastFailedWrite, {
              fingerprint: patchFingerprint(patch),
              error: blocked,
              mode
            });
            session.messages.push({
              id: call.id,
              role: "tool",
              content: JSON.stringify({
                ok: false,
                error: blocked,
                next: "Do not retry the same CRUD. Call read_* with view=source, then propose_source_edit."
              }),
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            });
            live.content = live.content || `Patch rejected: ${blocked}`;
            markCallStatus(live, call.id, "error", sink);
            continue;
          }
          const validity = validateAgentPatch(target, patch, { mode });
          if (!validity.ok) {
            session.context.lastFailedWrite = nextFailedWrite(session.context.lastFailedWrite, {
              fingerprint: patchFingerprint(patch),
              error: validity.message,
              mode
            });
            session.messages.push({
              id: call.id,
              role: "tool",
              content: JSON.stringify({
                ok: false,
                error: validity.message,
                next: mode === "source" ? "Fix the source-edit operations (unique oldText, or append / replace-document). Do not stop." : "Tool rejected that patch. Read the inventory, or view=source then propose_source_edit. Do not stop."
              }),
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            });
            live.content = live.content || `Patch rejected: ${validity.message}`;
            markCallStatus(live, call.id, "error", sink);
            continue;
          }
          live.content = patch.explanation || live.content || (mode === "source" ? `Proposed ${target} source edit.` : `Proposed ${target} specification changes.`);
          live.proposedChanges = patch;
          live.pending = true;
          session.context.pendingToolCallId = call.id;
          completeSiblingToolCalls(session, completion.toolCalls, call.id);
          markCallStatus(live, call.id, "done", sink);
          markRemainingToolCalls(live, "done", sink);
          saveSession(projectRoot, session);
          emit(sink, { kind: "session", session });
          return session;
        }
        if (call.function.name === "read_specification") {
          const view = args.view === "source" ? "source" : "inventory";
          const body = !permissions.informal.read ? "(Informal read permission off)" : view === "source" ? numberedSource(ctx.informalMarkdown) : informalInventoryFromMarkdown(ctx.informalMarkdown);
          session.messages.push({
            id: call.id,
            role: "tool",
            content: JSON.stringify({
              ok: permissions.informal.read,
              view,
              inventory: view === "inventory" ? body : void 0,
              source: view === "source" ? body : void 0
            }),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          live.content = live.content || (view === "source" ? "Read the current Informal Specification source." : "Read the current Informal Specification inventory.");
          markCallStatus(live, call.id, "done", sink);
          continue;
        }
        if (call.function.name === "read_hybrid_specification") {
          const view = args.view === "source" ? "source" : "inventory";
          const body = !permissions.hybrid.read ? "(Hybrid read permission off)" : view === "source" ? numberedHybridSource(ctx.hybridAsfl) : compactHybrid(ctx.hybridAsfl);
          const diagnostics = permissions.hybrid.read ? await hybridDiagnosticsWithSemantic(ctx.hybridAsfl, getExperimentConfig(projectRoot)) : { count: 0, errors: 0, items: [] };
          session.messages.push({
            id: call.id,
            role: "tool",
            content: JSON.stringify({
              ok: permissions.hybrid.read,
              view,
              inventory: view === "inventory" ? body : void 0,
              source: view === "source" ? body : void 0,
              diagnostics
            }),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          live.content = live.content || (view === "source" ? diagnostics.errors ? `Read the current Hybrid Specification source (${diagnostics.errors} syntax error(s)).` : "Read the current Hybrid Specification source." : diagnostics.errors ? `Read the current Hybrid Specification inventory (${diagnostics.errors} syntax error(s)).` : "Read the current Hybrid Specification inventory.");
          markCallStatus(live, call.id, "done", sink);
          continue;
        }
        if (call.function.name === "read_refinement_state") {
          const view = args.view === "tree" || args.view === "log" ? args.view : "summary";
          const allowed = permissions.hybrid.read;
          const digest = !allowed ? "(Hybrid read permission off)" : compactRefinementView(ctx, view);
          session.messages.push({
            id: call.id,
            role: "tool",
            content: JSON.stringify({
              ok: allowed,
              view,
              digest
            }),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          live.content = live.content || "Read the current dual-line refinement state.";
          markCallStatus(live, call.id, "done", sink);
          continue;
        }
        if (call.function.name === "read_gui_specification") {
          const view = args.view === "source" ? "source" : "inventory";
          const allowed = permissions.hybrid.read || permissions.informal.read;
          const body = !allowed ? "(GUI read permission off)" : view === "source" ? gui.numberedGuiSource(ctx.guiHtml ?? "") : gui.formatGuiInventory(ctx.guiHtml ?? "", 2e4);
          session.messages.push({
            id: call.id,
            role: "tool",
            content: JSON.stringify({
              ok: allowed,
              view,
              inventory: view === "inventory" ? body : void 0,
              source: view === "source" ? body : void 0
            }),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          live.content = live.content || (view === "source" ? "Read the current GUI HTML source." : "Read the current GUI inventory.");
          markCallStatus(live, call.id, "done", sink);
          continue;
        }
        if (call.function.name === "review_specification" || call.function.name === "review_hybrid") {
          const typedIssues = Array.isArray(args.issues) ? args.issues.map((i) => ({
            dimension: String(i.dimension || "completeness"),
            message: String(i.message || ""),
            nodeId: i.nodeId
          })) : [];
          live.content = live.content || "Specification review";
          live.review = { issues: typedIssues };
          session.messages.push({
            id: call.id,
            role: "tool",
            content: JSON.stringify({ ok: true, issues: typedIssues }),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          markCallStatus(live, call.id, "done", sink);
          continue;
        }
        session.messages.push({
          id: call.id,
          role: "tool",
          content: JSON.stringify({ ok: false, error: `Unknown tool ${call.function.name}` }),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        markCallStatus(live, call.id, "error", sink);
      }
      markRemainingToolCalls(live, "done", sink);
      saveSession(projectRoot, session);
      emit(sink, { kind: "session", session });
      needsContinuationNudge = false;
      continue;
    }
    if (assistantTurnIsComplete(live.content)) {
      break;
    }
    session.messages = session.messages.filter((m) => m.id !== assistantId);
  }
  saveSession(projectRoot, session);
  emit(sink, { kind: "session", session });
  return session;
}
function completeSiblingToolCalls(session, calls, keepId) {
  for (const call of calls) {
    if (call.id === keepId) continue;
    if (session.messages.some((m) => m.role === "tool" && m.id === call.id)) continue;
    session.messages.push({
      id: call.id,
      role: "tool",
      content: JSON.stringify({
        skipped: true,
        tool: call.function?.name,
        reason: "Not executed. Another tool in this turn is waiting for Apply or Reject. After that tool result, call this tool again if the work is still needed. Do not treat this skip as a user rejection."
      }),
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
}
function parseResumePayload(result) {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
  }
  return {};
}
async function resumeWithToolResult(session, projectRoot, ctx, toolCallId, result, sink, continueTurn = true, signal) {
  const payload = parseResumePayload(result);
  const pending = session.messages.find(
    (m) => m.pending && (m.clarification?.pendingToolCallId === toolCallId || session.context.pendingToolCallId === toolCallId)
  );
  const patch = pending?.proposedChanges;
  if (patch) {
    const cfg = getExperimentConfig(projectRoot);
    const op0 = patch.operations?.[0];
    const isRefine = op0?.op === "refine-step";
    if (payload.action === "applied" || payload.action === "rejected" || payload.action === "error") {
      logTelemetry(projectRoot, cfg, session.id, {
        event: "proposal_decision",
        tool: isRefine ? "propose_refinement_step" : patch.mode === "source" ? "propose_source_edit" : `propose_${patch.target ?? "informal"}_changes`,
        stepType: isRefine ? String(op0?.kind ?? "") : void 0,
        decision: payload.action === "applied" && !payload.error ? "approved" : payload.action === "rejected" ? "rejected" : "error",
        toolCallId
      });
    }
    if (payload.action === "applied" && !payload.error && patch.target === "hybrid" && ctx.hybridAsfl !== void 0) {
      try {
        logTelemetry(projectRoot, cfg, session.id, {
          event: "post_write_diagnostics",
          toolCallId,
          diagnostics: await diagnosticCounts(ctx.hybridAsfl, cfg)
        });
      } catch {
      }
    }
    if (payload.action === "applied" && !payload.error) {
      session.context.lastFailedWrite = void 0;
    } else if (payload.action === "error" || payload.action === "applied" && payload.error) {
      session.context.lastFailedWrite = nextFailedWrite(session.context.lastFailedWrite, {
        fingerprint: patchFingerprint(patch),
        error: payload.error || "Tool failed",
        mode: patch.mode ?? "crud"
      });
    }
  }
  const clarificationMsg = session.messages.find(
    (m) => m.pending && m.clarification && (m.clarification.pendingToolCallId === toolCallId || session.context.pendingToolCallId === toolCallId)
  );
  const pendingWrite = session.messages.find(
    (m) => m.pending && m.proposedChanges && !m.clarification && session.context.pendingToolCallId === toolCallId
  );
  let toolContent = result;
  let clarificationDisplay;
  if (payload.type === "user_instruction") toolContent = userInstructionToolResult(payload.text || result);
  else if (payload.action === "applied")
    toolContent = appliedToolResult({ error: payload.error, userNote: payload.userNote, repair: payload.repair });
  else if (payload.action === "error") toolContent = failedToolResult(payload.error || "Tool failed", payload.userNote);
  else if (payload.action === "rejected") toolContent = rejectedToolResult();
  else if (clarificationMsg?.clarification) {
    const formatted = formatClarificationToolContent(result, {
      labels: clarificationMsg.clarification.options?.map((option) => option.label),
      multiSelect: clarificationMsg.clarification.multiSelect
    });
    toolContent = formatted.toolContent;
    clarificationDisplay = formatted.display;
  } else if (pendingWrite) {
    toolContent = failedToolResult(
      "The pending change was not applied. A chat reply does not reject it.",
      result
    );
  } else {
    toolContent = JSON.stringify({
      type: "clarification_answer",
      answer: result,
      custom: result,
      next: "custom is text the user typed. You MUST use it even when the question was single-choice. Then continue the task."
    });
  }
  for (const m of session.messages) {
    if (!m.pending) continue;
    if (m.clarification?.pendingToolCallId === toolCallId || session.context.pendingToolCallId === toolCallId) {
      m.pending = false;
      if (m.clarification) {
        m.clarification.answer = clarificationDisplay ?? result;
        m.resolution = "answered";
      }
      if (m.proposedChanges) {
        if (payload.type === "user_instruction") {
          m.resolution = "answered";
        } else {
          const unansweredWrite = !payload.action && pendingWrite;
          m.resolution = payload.action === "applied" ? "applied" : payload.action === "error" || unansweredWrite ? "error" : "rejected";
          if (payload.error) m.toolError = payload.error;
          else if (unansweredWrite) m.toolError = "Pending change was not applied.";
        }
      }
    }
  }
  session.messages.push({
    id: toolCallId,
    role: "tool",
    content: toolContent,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
  session.context.pendingToolCallId = void 0;
  saveSession(projectRoot, session);
  emit(sink, { kind: "session", session });
  if (!continueTurn) return session;
  return runAgentTurn(session, projectRoot, ctx, void 0, sink, signal);
}
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function publish(session) {
  return session ? sessionForRenderer(session) : null;
}
function emitDelta(event, payload) {
  if (payload && typeof payload === "object" && payload.kind === "session" && payload.session) {
    const sessionPayload = payload;
    event.sender.send("studio:agent-delta", {
      ...sessionPayload,
      session: sessionForRenderer(sessionPayload.session)
    });
    return;
  }
  event.sender.send("studio:agent-delta", payload);
}
const agentTurns = /* @__PURE__ */ new Map();
function startAgentTurn(sessionId) {
  agentTurns.get(sessionId)?.abort();
  const controller = new AbortController();
  agentTurns.set(sessionId, controller);
  return controller.signal;
}
function finishAgentTurn(sessionId, signal) {
  if (agentTurns.get(sessionId)?.signal === signal) agentTurns.delete(sessionId);
}
function registerAgentHandlers() {
  loadStudioEnv();
  electron.ipcMain.handle("studio:llm-status", () => {
    const cfg = getEcnuConfig();
    return {
      configured: hasEcnuKey(),
      model: cfg.model,
      baseUrl: cfg.baseUrl
    };
  });
  electron.ipcMain.handle("studio:llm-list-profiles", () => clone(listLlmProfiles()));
  electron.ipcMain.handle(
    "studio:llm-save-profile",
    (_e, draft) => clone(saveLlmProfile(draft ?? {}))
  );
  electron.ipcMain.handle("studio:llm-delete-profile", (_e, id) => clone(deleteLlmProfile(String(id))));
  electron.ipcMain.handle(
    "studio:llm-set-active-profile",
    (_e, id) => clone(setActiveLlmProfile(String(id)))
  );
  electron.ipcMain.handle("studio:llm-export-profiles", () => exportLlmProfiles());
  electron.ipcMain.handle("studio:llm-import-profiles", (_e, raw) => clone(importLlmProfiles(raw)));
  electron.ipcMain.handle("studio:llm-test-profile", (_e, request) => testLlmProfile(request));
  electron.ipcMain.handle(
    "studio:agent-skills",
    () => AGENT_SKILLS.map((s) => ({ id: s.id, name: s.name }))
  );
  electron.ipcMain.handle("studio:agent-list-sessions", (_e, projectRoot) => listSessions(projectRoot));
  electron.ipcMain.handle(
    "studio:agent-create-session",
    (_e, payload) => publish(
      createSession(payload.projectRoot, payload.moduleId || "project", payload.title, {
        skillId: payload.skillId,
        permissions: payload.permissions,
        promptExtras: payload.promptExtras
      })
    )
  );
  electron.ipcMain.handle(
    "studio:agent-rename-session",
    (_e, payload) => publish(renameSession(payload.projectRoot, payload.id, payload.title))
  );
  electron.ipcMain.handle(
    "studio:agent-duplicate-session",
    (_e, payload) => publish(duplicateSession(payload.projectRoot, payload.id))
  );
  electron.ipcMain.handle(
    "studio:agent-fork-session",
    (_e, payload) => publish(
      forkSession(payload.projectRoot, payload.id, payload.throughMessageId, {
        mode: payload.mode,
        title: payload.title
      })
    )
  );
  electron.ipcMain.handle(
    "studio:agent-rewind-session",
    (_e, payload) => publish(
      rewindSession(payload.projectRoot, payload.id, payload.throughMessageId, {
        mode: payload.mode,
        exclusive: payload.exclusive
      })
    )
  );
  electron.ipcMain.handle(
    "studio:agent-flag-session",
    (_e, payload) => publish(setSessionFlag(payload.projectRoot, payload.id, payload.flag, payload.value))
  );
  electron.ipcMain.handle(
    "studio:agent-delete-session",
    (_e, payload) => deleteSession(payload.projectRoot, payload.id)
  );
  electron.ipcMain.handle(
    "studio:agent-load-session",
    (_e, payload) => publish(loadSession(payload.projectRoot, payload.id))
  );
  electron.ipcMain.handle(
    "studio:agent-chat",
    async (event, payload) => {
      let session = loadSession(payload.projectRoot, payload.sessionId);
      if (!session) session = createSession(payload.projectRoot, payload.context.moduleId || "project");
      const signal = startAgentTurn(session.id);
      try {
        const next = await runAgentTurn(
          session,
          payload.projectRoot,
          payload.context,
          payload.text,
          (delta) => {
            emitDelta(event, { sessionId: session.id, ...delta });
          },
          signal
        );
        return publish(next);
      } finally {
        finishAgentTurn(session.id, signal);
      }
    }
  );
  electron.ipcMain.handle(
    "studio:agent-resume",
    async (event, payload) => {
      const session = loadSession(payload.projectRoot, payload.sessionId);
      if (!session) return null;
      const signal = startAgentTurn(session.id);
      try {
        const next = await resumeWithToolResult(
          session,
          payload.projectRoot,
          payload.context,
          payload.toolCallId,
          payload.result,
          (delta) => emitDelta(event, { sessionId: session.id, ...delta }),
          payload.continueTurn !== false,
          signal
        );
        return publish(next);
      } finally {
        finishAgentTurn(session.id, signal);
      }
    }
  );
  electron.ipcMain.handle("studio:agent-abort", (_e, sessionId) => {
    const id = String(sessionId || "");
    agentTurns.get(id)?.abort();
    return { ok: true };
  });
}
const MANIFEST_FILENAME = ".agile-sofl.json";
const DEFAULT_COLUMN_WIDTHS = [0.18, 0.6, 0.22];
let SQL = null;
let db = null;
let dbPath = null;
function resolveSqlWasm() {
  const require$12 = node_module.createRequire(require("url").pathToFileURL(__filename).href);
  try {
    return require$12.resolve("sql.js/dist/sql-wasm.wasm");
  } catch {
    const here = node_path.dirname(node_url.fileURLToPath(require("url").pathToFileURL(__filename).href));
    const candidates = [
      node_path.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
      node_path.join(process.cwd(), "packages/studio/node_modules/sql.js/dist/sql-wasm.wasm"),
      node_path.join(here, "../../../../node_modules/sql.js/dist/sql-wasm.wasm"),
      node_path.join(here, "../../../node_modules/sql.js/dist/sql-wasm.wasm")
    ];
    for (const candidate of candidates) {
      if (node_fs.existsSync(candidate)) return candidate;
    }
    throw new Error("sql.js wasm not found");
  }
}
async function getSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs({
    wasmBinary: node_fs.readFileSync(resolveSqlWasm())
  });
  return SQL;
}
function persist() {
  if (!db || !dbPath) return;
  node_fs.mkdirSync(node_path.dirname(dbPath), { recursive: true });
  node_fs.writeFileSync(dbPath, Buffer.from(db.export()));
}
function tableHasColumn(database, table, column) {
  const stmt = database.prepare(`PRAGMA table_info(${table})`);
  let found = false;
  while (stmt.step()) {
    const row = stmt.getAsObject();
    if (row.name === column) found = true;
  }
  stmt.free();
  return found;
}
function migrate(database) {
  database.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      is_gui INTEGER NOT NULL DEFAULT 0,
      parent_name TEXT,
      cached_json TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT,
      mtime INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ui_state (
      project_id TEXT PRIMARY KEY,
      informal_collapsed INTEGER NOT NULL DEFAULT 0,
      structure_collapsed INTEGER NOT NULL DEFAULT 0,
      column_widths TEXT,
      selected_module TEXT,
      expanded INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
  if (!tableHasColumn(database, "ui_state", "structure_collapsed")) {
    database.run(
      "ALTER TABLE ui_state ADD COLUMN structure_collapsed INTEGER NOT NULL DEFAULT 0"
    );
  }
}
async function openProjectIndex(filePath) {
  const sql = await getSql();
  dbPath = filePath;
  if (node_fs.existsSync(filePath)) {
    db = new sql.Database(node_fs.readFileSync(filePath));
  } else {
    node_fs.mkdirSync(node_path.dirname(filePath), { recursive: true });
    db = new sql.Database();
  }
  migrate(db);
  persist();
}
function requireDb() {
  if (!db) throw new Error("Project index database is not open");
  return db;
}
function listProjects() {
  const database = requireDb();
  const stmt = database.prepare(
    "SELECT id, name, root_path, created_at, last_opened_at FROM projects ORDER BY last_opened_at DESC"
  );
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      id: r.id,
      name: r.name,
      rootPath: r.root_path,
      createdAt: r.created_at,
      lastOpenedAt: r.last_opened_at
    });
  }
  stmt.free();
  return rows;
}
function upsertProject(input) {
  const database = requireDb();
  const now = Date.now();
  const existing = database.prepare("SELECT id, created_at FROM projects WHERE root_path = ?");
  existing.bind([input.rootPath]);
  if (existing.step()) {
    const row = existing.getAsObject();
    existing.free();
    database.run("UPDATE projects SET name = ?, last_opened_at = ? WHERE id = ?", [
      input.name,
      now,
      row.id
    ]);
    persist();
    return {
      id: row.id,
      name: input.name,
      rootPath: input.rootPath,
      createdAt: row.created_at,
      lastOpenedAt: now
    };
  }
  existing.free();
  const id = input.id ?? node_crypto.randomUUID();
  database.run(
    "INSERT INTO projects (id, name, root_path, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)",
    [id, input.name, input.rootPath, now, now]
  );
  persist();
  return { id, name: input.name, rootPath: input.rootPath, createdAt: now, lastOpenedAt: now };
}
function touchProject(id) {
  requireDb().run("UPDATE projects SET last_opened_at = ? WHERE id = ?", [Date.now(), id]);
  persist();
}
function removeProject(id) {
  const database = requireDb();
  database.run("DELETE FROM modules WHERE project_id = ?", [id]);
  database.run("DELETE FROM files WHERE project_id = ?", [id]);
  database.run("DELETE FROM ui_state WHERE project_id = ?", [id]);
  database.run("DELETE FROM projects WHERE id = ?", [id]);
  persist();
}
function replaceProjectModules(projectId, modules) {
  const database = requireDb();
  database.run("DELETE FROM modules WHERE project_id = ?", [projectId]);
  const stmt = database.prepare(
    "INSERT INTO modules (project_id, name, file_path, is_gui, parent_name, cached_json) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const mod of modules) {
    stmt.run([
      projectId,
      mod.name,
      mod.filePath,
      mod.isGui ? 1 : 0,
      mod.parentName ?? null,
      JSON.stringify(mod)
    ]);
  }
  stmt.free();
  persist();
}
function cachedModules(projectId) {
  const database = requireDb();
  const stmt = database.prepare("SELECT cached_json FROM modules WHERE project_id = ?");
  stmt.bind([projectId]);
  const out = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    try {
      out.push(JSON.parse(row.cached_json));
    } catch {
    }
  }
  stmt.free();
  return out;
}
function getUiState(projectId) {
  const database = requireDb();
  const stmt = database.prepare(
    "SELECT informal_collapsed, structure_collapsed, column_widths, selected_module, expanded FROM ui_state WHERE project_id = ?"
  );
  stmt.bind([projectId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    let widths = DEFAULT_COLUMN_WIDTHS;
    try {
      if (row.column_widths) widths = JSON.parse(row.column_widths);
    } catch {
      widths = DEFAULT_COLUMN_WIDTHS;
    }
    return {
      informalCollapsed: Boolean(row.informal_collapsed),
      structureCollapsed: Boolean(row.structure_collapsed),
      columnWidths: widths.length === 3 ? widths : widths.length === 4 ? [
        widths[0] ?? DEFAULT_COLUMN_WIDTHS[0],
        (widths[1] ?? 0.22) + (widths[2] ?? 0.38),
        widths[3] ?? DEFAULT_COLUMN_WIDTHS[2]
      ] : DEFAULT_COLUMN_WIDTHS,
      selectedModuleName: typeof row.selected_module === "string" ? row.selected_module : null,
      expanded: row.expanded !== 0
    };
  }
  stmt.free();
  return {
    informalCollapsed: false,
    structureCollapsed: false,
    columnWidths: [...DEFAULT_COLUMN_WIDTHS],
    selectedModuleName: null,
    expanded: true
  };
}
function saveUiState(projectId, state) {
  requireDb().run(
    `INSERT INTO ui_state (project_id, informal_collapsed, structure_collapsed, column_widths, selected_module, expanded)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       informal_collapsed = excluded.informal_collapsed,
       structure_collapsed = excluded.structure_collapsed,
       column_widths = excluded.column_widths,
       selected_module = excluded.selected_module,
       expanded = excluded.expanded`,
    [
      projectId,
      state.informalCollapsed ? 1 : 0,
      state.structureCollapsed ? 1 : 0,
      JSON.stringify(state.columnWidths),
      state.selectedModuleName,
      state.expanded ? 1 : 0
    ]
  );
  persist();
}
function informalMetaPath(projectRoot) {
  return node_path.join(projectRoot, ".agile-sofl", "informal-meta.json");
}
function readInformalMeta(projectRoot) {
  const file = informalMetaPath(projectRoot);
  if (!node_fs.existsSync(file)) return null;
  try {
    return JSON.parse(node_fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}
function writeInformalMeta(projectRoot, meta) {
  const file = informalMetaPath(projectRoot);
  node_fs.mkdirSync(node_path.dirname(file), { recursive: true });
  node_fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}
`, "utf-8");
}
function extractYamlFrontmatter(source) {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("---")) return { meta: {}, body: source, hadFrontmatter: false };
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: source, hadFrontmatter: false };
  const raw = trimmed.slice(4, end).trim();
  const body = trimmed.slice(end + 4).replace(/^(?:\r?\n)+/, "");
  const fields = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  const version = fields.version != null ? Number(fields.version) : void 0;
  return {
    hadFrontmatter: true,
    body,
    meta: {
      id: fields.id,
      moduleId: fields.moduleId,
      version: version != null && Number.isFinite(version) ? version : void 0,
      title: fields.title,
      author: fields.author,
      hybridTarget: fields.hybridTarget,
      guiTarget: fields.guiTarget
    }
  };
}
function inferModuleIdFromAsfl(asfl) {
  if (!asfl) return void 0;
  const match = asfl.match(/\bmodule\s+SYSTEM_([A-Za-z0-9_]+)/);
  return match?.[1];
}
function mergeInformalSidecar(...parts) {
  const merged = {};
  for (const part of parts) {
    if (!part) continue;
    if (part.id) merged.id = part.id;
    if (part.moduleId) merged.moduleId = part.moduleId;
    if (part.version != null) merged.version = part.version;
    if (part.title) merged.title = part.title;
    if (part.author) merged.author = part.author;
    if (part.hybridTarget) merged.hybridTarget = part.hybridTarget;
    if (part.guiTarget) merged.guiTarget = part.guiTarget;
  }
  return merged;
}
function writeInformalSpecFile(projectRoot, relativePath, markdown, extra) {
  const extracted = extractYamlFrontmatter(markdown);
  const existing = readInformalMeta(projectRoot);
  const meta = mergeInformalSidecar(
    { id: node_crypto.randomUUID(), version: 1, moduleId: "project" },
    extracted.meta,
    existing,
    extra
  );
  if (!meta.id) meta.id = node_crypto.randomUUID();
  node_fs.writeFileSync(node_path.join(projectRoot, relativePath), extracted.body.endsWith("\n") ? extracted.body : `${extracted.body}
`, "utf-8");
  writeInformalMeta(projectRoot, meta);
  return meta;
}
const SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", "dist", ".git"]);
function isGuiSpecFile(name) {
  return name === "gui.html" || name.endsWith(".gui.html") || name.endsWith(".guispec");
}
function scanSpecFiles(root, ext, out = []) {
  if (!node_fs.existsSync(root)) return out;
  for (const name of node_fs.readdirSync(root)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = node_path.join(root, name);
    const st = node_fs.statSync(full);
    if (st.isDirectory()) scanSpecFiles(full, ext, out);
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
}
function scanGuiFiles(root, out = []) {
  if (!node_fs.existsSync(root)) return out;
  for (const name of node_fs.readdirSync(root)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = node_path.join(root, name);
    const st = node_fs.statSync(full);
    if (st.isDirectory()) scanGuiFiles(full, out);
    else if (isGuiSpecFile(name)) out.push(full);
  }
  return out;
}
function scanProjectRoot(root) {
  return {
    aspecFiles: scanSpecFiles(root, ".aspec"),
    asflFiles: scanSpecFiles(root, ".asfl"),
    guispecFiles: scanGuiFiles(root)
  };
}
function manifestPath(root) {
  return node_path.join(root, MANIFEST_FILENAME);
}
function readManifest(root) {
  const path = manifestPath(root);
  if (!node_fs.existsSync(path)) return null;
  try {
    const raw = JSON.parse(node_fs.readFileSync(path, "utf-8"));
    if (!raw || typeof raw.name !== "string") return null;
    return normalizeManifest(raw, node_path.basename(root));
  } catch {
    return null;
  }
}
function writeManifest(root, manifest) {
  node_fs.writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}
`, "utf-8");
}
function normalizeManifest(raw, fallbackName) {
  const hybrid = Array.isArray(raw.hybrid) ? raw.hybrid.filter((p) => typeof p === "string" && p.length > 0) : [];
  return {
    version: "1.0",
    name: raw.name?.trim() || fallbackName,
    guiModule: raw.guiModule?.trim() || void 0,
    informal: raw.informal?.trim() || "informal.aspec",
    hybrid: hybrid.length ? hybrid : ["hybrid.asfl"],
    gui: raw.gui?.trim() || void 0
  };
}
async function loadOrCreateManifest(root) {
  const existing = readManifest(root);
  if (existing) return existing;
  const inferred = await inferManifest(root);
  writeManifest(root, inferred);
  return inferred;
}
async function inferManifest(root) {
  const scan = scanProjectRoot(root);
  const informalRel = toRel(root, scan.aspecFiles[0]) ?? "informal.aspec";
  const hybrid = scan.asflFiles.map((p) => toRel(root, p)).filter(Boolean);
  const guiRel = toRel(root, scan.guispecFiles[0]);
  const base = node_path.basename(scan.aspecFiles[0] ?? "", ".aspec");
  const pairGui = scan.guispecFiles.find((p) => node_path.basename(p, ".gui.html") === `${base}-gui`) ?? scan.guispecFiles.find((p) => node_path.basename(p, ".guispec") === `${base}-gui`) ?? scan.guispecFiles.find((p) => node_path.basename(p, ".gui.html") === base.replace(/-informal$/, "") + "-gui") ?? scan.guispecFiles.find((p) => node_path.basename(p, ".guispec") === base.replace(/-informal$/, "") + "-gui");
  return {
    version: "1.0",
    name: node_path.basename(root),
    informal: informalRel,
    hybrid: hybrid.length ? hybrid : ["hybrid.asfl"],
    gui: guiRel ?? (pairGui ? toRel(root, pairGui) : void 0)
  };
}
function toRel(root, abs) {
  if (!abs) return void 0;
  return node_path.relative(root, abs).replace(/\\/g, "/");
}
function slugifyProjectName(name) {
  const slug = name.trim().replace(/[^\w\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "NewSystem";
}
function asflIdent(name) {
  const ident = slugifyProjectName(name).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(ident) ? ident : `System_${ident}`;
}
function createProjectTemplate(root, name) {
  node_fs.mkdirSync(root, { recursive: true });
  const ident = asflIdent(name);
  const informal = "informal.aspec";
  const hybrid = "hybrid.asfl";
  const gui2 = "gui.html";
  const manifest = {
    version: "1.0",
    name,
    guiModule: "GUI_App",
    informal,
    hybrid: [hybrid],
    gui: gui2
  };
  writeInformalSpecFile(
    root,
    informal,
    `# Functions

# Data Resources

# Constraints
`,
    {
      moduleId: ident,
      title: name,
      hybridTarget: `./${hybrid}`,
      guiTarget: `./${gui2}`
    }
  );
  node_fs.writeFileSync(
    node_path.join(root, hybrid),
    `module SYSTEM_${ident};
end_module
module GUI_App / ${ident};
const
    view_home = 0;
    view_next = 1;
type
    ViewId = nat;
var
    current_view: ViewId;
inv
    current_view >= 0 and current_view <= 1;
gui AppGui;
  screen Home triggers OpenNext;
  screen Next triggers OpenHome;
end_gui;
process OpenNext ()
    pre
        true
    post
        current_view = 1
end_process
process OpenHome ()
    pre
        true
    post
        current_view = 0
end_process
end_module
`,
    "utf-8"
  );
  node_fs.writeFileSync(
    node_path.join(root, gui2),
    `<div class="as-app" data-app="${ident}App">
  <section class="as-screen" id="view-home" data-screen="Home">
    <h1 class="as-title">Home</h1>
    <div class="as-stack as-gap-md">
      <p class="as-muted">Application views.</p>
      <button class="as-btn as-btn-primary" data-process="OpenNext" data-nav="Next">Open</button>
    </div>
  </section>
  <section class="as-screen is-hidden" id="view-next" data-screen="Next">
    <h1 class="as-title">Next</h1>
    <div class="as-stack as-gap-md">
      <p class="as-muted">Next view</p>
      <button class="as-btn" data-process="OpenHome" data-nav="Home">Back</button>
    </div>
  </section>
</div>
`,
    "utf-8"
  );
  writeManifest(root, manifest);
  return manifest;
}
const STANDARD_INFORMAL = "informal.aspec";
const STANDARD_HYBRID = "hybrid.asfl";
const STANDARD_GUI = "gui.html";
function resolveTemplatesDir() {
  const candidates = [
    node_path.join(__dirname, "../renderer/templates"),
    node_path.join(__dirname, "../../public/templates"),
    node_path.join(electron.app.getAppPath(), "public/templates")
  ];
  for (const dir of candidates) {
    if (node_fs.existsSync(node_path.join(dir, "project-manifest.json"))) return dir;
  }
  throw new Error("Project templates directory not found");
}
function loadProjectTemplateManifest(templatesDir) {
  const dir = templatesDir ?? resolveTemplatesDir();
  const raw = JSON.parse(node_fs.readFileSync(node_path.join(dir, "project-manifest.json"), "utf-8"));
  return raw.templates;
}
function findProjectTemplate(templateId, templatesDir) {
  return loadProjectTemplateManifest(templatesDir).find((entry) => entry.id === templateId);
}
function readTemplateFile(templatesDir, file) {
  return node_fs.readFileSync(node_path.join(templatesDir, file), "utf-8");
}
function rewriteCrossRefs(content, entry, _projectName) {
  let out = content;
  const hybridSrc = entry.hybrid?.[0];
  if (hybridSrc) {
    out = out.replaceAll(`./${hybridSrc}`, `./${STANDARD_HYBRID}`);
    out = out.replaceAll(hybridSrc, STANDARD_HYBRID);
  }
  if (entry.informal) {
    out = out.replaceAll(`./${entry.informal}`, `./${STANDARD_INFORMAL}`);
    out = out.replaceAll(entry.informal, STANDARD_INFORMAL);
  }
  if (entry.gui) {
    out = out.replaceAll(`./${entry.gui}`, `./${STANDARD_GUI}`);
    out = out.replaceAll(entry.gui, STANDARD_GUI);
  }
  return out;
}
function writeProjectInformal(root, markdown, projectName, hybridContent, hasGui) {
  writeInformalSpecFile(root, STANDARD_INFORMAL, markdown, {
    title: projectName,
    moduleId: inferModuleIdFromAsfl(hybridContent) ?? asflIdent(projectName),
    hybridTarget: `./${STANDARD_HYBRID}`,
    guiTarget: hasGui ? `./${STANDARD_GUI}` : void 0
  });
}
function writeStubInformal(root, projectName, hybridContent) {
  writeProjectInformal(
    root,
    `# Functions

# Data Resources

# Constraints
`,
    projectName,
    hybridContent,
    true
  );
}
function appendGuiModule(hybrid, guiSrc) {
  if (/\bmodule\s+GUI_/.test(hybrid)) return hybrid;
  const body = hybrid.replace(/\s*$/, "\n");
  const snippet = guiSrc.endsWith("\n") ? guiSrc : `${guiSrc}
`;
  return `${body}${snippet}`;
}
function createProjectFromTemplate(root, name, templateId, templatesDir) {
  const dir = resolveTemplatesDir();
  const entry = findProjectTemplate(templateId, dir);
  if (!entry) {
    throw new Error(`Unknown project template: ${templateId}`);
  }
  if (entry.useEmptyProject) {
    return createProjectTemplate(root, name);
  }
  node_fs.mkdirSync(root, { recursive: true });
  const hybridSources = entry.hybrid ?? [];
  if (hybridSources.length === 0) {
    throw new Error(`Project template "${templateId}" has no hybrid files`);
  }
  const hybridPaths = [];
  if (hybridSources.length === 1) {
    let hybridContent = readTemplateFile(dir, hybridSources[0]);
    if (entry.guiHybrid) {
      hybridContent = appendGuiModule(hybridContent, readTemplateFile(dir, entry.guiHybrid));
    }
    node_fs.writeFileSync(node_path.join(root, STANDARD_HYBRID), hybridContent, "utf-8");
    hybridPaths.push(STANDARD_HYBRID);
    if (entry.informal) {
      writeProjectInformal(
        root,
        rewriteCrossRefs(readTemplateFile(dir, entry.informal), entry),
        name,
        hybridContent,
        Boolean(entry.gui)
      );
    } else {
      writeStubInformal(root, name, hybridContent);
    }
  } else {
    let firstContent = "";
    for (const src of hybridSources) {
      const dest = node_path.basename(src);
      const content = readTemplateFile(dir, src);
      node_fs.writeFileSync(node_path.join(root, dest), content, "utf-8");
      hybridPaths.push(dest);
      if (!firstContent) firstContent = content;
    }
    if (entry.informal) {
      writeProjectInformal(
        root,
        rewriteCrossRefs(readTemplateFile(dir, entry.informal), entry),
        name,
        firstContent,
        Boolean(entry.gui)
      );
    } else {
      writeStubInformal(root, name, firstContent);
    }
  }
  let guiPath;
  if (entry.gui) {
    let guiContent = rewriteCrossRefs(readTemplateFile(dir, entry.gui), entry);
    const parsed = gui.parseGuiSpec(guiContent);
    if (parsed.document?.html) guiContent = parsed.document.html;
    node_fs.writeFileSync(node_path.join(root, STANDARD_GUI), guiContent, "utf-8");
    guiPath = STANDARD_GUI;
  }
  const manifest = normalizeManifest(
    {
      name,
      informal: STANDARD_INFORMAL,
      hybrid: hybridPaths,
      gui: guiPath,
      guiModule: guiPath ? entry.guiModule ?? "GUI_App" : entry.guiModule
    },
    node_path.basename(root)
  );
  writeManifest(root, manifest);
  return manifest;
}
async function initProjectIndex() {
  const file = node_path.join(electron.app.getPath("userData"), "studio-index.sqlite");
  await openProjectIndex(file);
}
function registerProjectHandlers(getWindow2) {
  electron.ipcMain.handle("studio:project-list", () => listProjects());
  electron.ipcMain.handle("studio:project-ui-state", (_event, projectId) => getUiState(projectId));
  electron.ipcMain.handle(
    "studio:project-save-ui-state",
    (_event, projectId, state) => {
      saveUiState(projectId, state);
      return true;
    }
  );
  electron.ipcMain.handle(
    "studio:project-cached-modules",
    (_event, projectId) => cachedModules(projectId)
  );
  electron.ipcMain.handle("studio:project-remove", (_event, projectId) => {
    removeProject(projectId);
    return true;
  });
  electron.ipcMain.handle("studio:project-rename", (_event, projectId, name) => {
    const project = listProjects().find((p) => p.id === projectId);
    if (!project) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    const manifest = readManifest(project.rootPath);
    if (manifest) {
      writeManifest(project.rootPath, { ...manifest, name: trimmed });
    }
    return upsertProject({ name: trimmed, rootPath: project.rootPath });
  });
  electron.ipcMain.handle("studio:project-create", async (_event, name) => {
    const win = getWindow2();
    const result = await electron.dialog.showOpenDialog(win ?? void 0, {
      title: "Select folder for new project",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const parent = result.filePaths[0];
    await rememberDialogPath(parent);
    const folderName = slugifyProjectName(name);
    const root = node_path.join(parent, folderName);
    const manifest = createProjectTemplate(root, name.trim() || folderName);
    const project = upsertProject({ name: manifest.name, rootPath: root });
    return { project, root };
  });
  electron.ipcMain.handle(
    "studio:project-create-from-template",
    async (_event, name, templateId) => {
      const win = getWindow2();
      const result = await electron.dialog.showOpenDialog(win ?? void 0, {
        title: "Select folder for new project",
        properties: ["openDirectory", "createDirectory"]
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const parent = result.filePaths[0];
      await rememberDialogPath(parent);
      const folderName = slugifyProjectName(name);
      const root = node_path.join(parent, folderName);
      const manifest = createProjectFromTemplate(root, name.trim() || folderName, templateId);
      const project = upsertProject({ name: manifest.name, rootPath: root });
      return { project, root };
    }
  );
  electron.ipcMain.handle("studio:project-open-folder", async () => {
    const win = getWindow2();
    const result = await electron.dialog.showOpenDialog(win ?? void 0, {
      title: "Open project folder",
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const root = result.filePaths[0];
    await rememberDialogPath(root);
    if (!node_fs.existsSync(root)) return null;
    const manifest = await loadOrCreateManifest(root);
    const project = upsertProject({ name: manifest.name, rootPath: root });
    return { project, root };
  });
  electron.ipcMain.handle("studio:project-touch", (_event, projectId) => {
    touchProject(projectId);
    return true;
  });
  electron.ipcMain.handle(
    "studio:project-cache-modules",
    (_event, projectId, modules) => {
      replaceProjectModules(projectId, modules);
      return true;
    }
  );
}
const execFileAsync = node_util.promisify(node_child_process.execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
const CONFLICT_CODES = /* @__PURE__ */ new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);
function isGitRepo(rootPath) {
  if (!rootPath) return false;
  try {
    return node_fs.existsSync(node_path.join(rootPath, ".git"));
  } catch {
    return false;
  }
}
function normalizeRelPath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
function decodeGitCQuote(inner) {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === "\\" || next === '"' || next === "'") {
      out += next;
      i++;
      continue;
    }
    if (next === "t") {
      out += "	";
      i++;
      continue;
    }
    if (next === "n") {
      out += "\n";
      i++;
      continue;
    }
    if (next === "r") {
      out += "\r";
      i++;
      continue;
    }
    const oct = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) {
      out += String.fromCharCode(parseInt(oct, 8));
      i += 3;
      continue;
    }
    out += next ?? "";
    i++;
  }
  return out;
}
function unquoteGitPath(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return decodeGitCQuote(s.slice(1, -1));
  }
  return s;
}
function mapXy(xy) {
  if (CONFLICT_CODES.has(xy) || xy.includes("U")) return "conflicted";
  if (xy === "??") return "untracked";
  if (xy === "!!") return "ignored";
  if (xy[0] === "M" || xy[1] === "M") return "modified";
  if (xy[0] === "A" || xy[1] === "A") return "added";
  if (xy[0] === "D" || xy[1] === "D") return "deleted";
  if (xy[0] === "R" || xy[1] === "R") return "renamed";
  if (xy[0] === "C" || xy[1] === "C") return "added";
  if (xy[0] === "T" || xy[1] === "T") return "modified";
  return null;
}
function parsePorcelain(stdout) {
  const files = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const xy = line.slice(0, 2);
    const status = mapXy(xy);
    if (!status) continue;
    const rest = line.slice(3);
    const sep = " -> ";
    const sepIdx = rest.indexOf(sep);
    const isRename = xy.includes("R");
    const paths = isRename && sepIdx >= 0 ? [unquoteGitPath(rest.slice(0, sepIdx)), unquoteGitPath(rest.slice(sepIdx + sep.length))] : [unquoteGitPath(rest)];
    for (const raw of paths) {
      const path = normalizeRelPath(raw);
      if (!path) continue;
      files.push({ path, status });
    }
  }
  return files;
}
async function runGit(rootPath, args) {
  try {
    const { stdout, stderr } = await execFileAsync(GIT_BIN, args, {
      cwd: rootPath,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15e3,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const e = err;
    return {
      ok: false,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
      error: e.message || String(err)
    };
  }
}
function registerGitHandlers() {
  electron.ipcMain.handle("studio:git-is-repo", (_event, rootPath) => {
    try {
      return isGitRepo(typeof rootPath === "string" ? rootPath : "");
    } catch {
      return false;
    }
  });
  electron.ipcMain.handle("studio:git-status", async (_event, rootPath) => {
    try {
      const root = typeof rootPath === "string" ? rootPath : "";
      if (!root || !isGitRepo(root)) return { isRepo: false, files: [] };
      const result = await runGit(root, ["status", "--porcelain=v1", "-uall"]);
      if (!result.ok) return { isRepo: true, files: [] };
      return { isRepo: true, files: parsePorcelain(result.stdout) };
    } catch {
      return { isRepo: false, files: [] };
    }
  });
  electron.ipcMain.handle("studio:git-init", async (_event, rootPath) => {
    try {
      const root = typeof rootPath === "string" ? rootPath : "";
      if (!root) return { ok: false, error: "Missing rootPath" };
      const result = await runGit(root, ["init"]);
      if (!result.ok) return { ok: false, error: result.error || result.stderr || "git init failed" };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
function toggleDevTools(win) {
  if (win.webContents.isDevToolsOpened()) {
    win.webContents.closeDevTools();
  } else {
    win.webContents.openDevTools({ mode: "detach" });
  }
}
function attachDevToolsShortcuts(win) {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isF12 = input.key === "F12";
    const isCtrlShiftI = (input.control || input.meta) && input.shift && input.key.toLowerCase() === "i";
    if (isF12 || isCtrlShiftI) {
      event.preventDefault();
      toggleDevTools(win);
    }
  });
}
function attachRendererDiagnostics(win) {
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[studio:renderer] did-fail-load", { errorCode, errorDescription, validatedURL });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[studio:renderer] render-process-gone", details);
  });
  if (electron.app.isPackaged) return;
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const tag = level === 3 ? "error" : level === 2 ? "warn" : "log";
    console[tag === "log" ? "log" : tag](`[studio:renderer:${tag}] ${message} (${sourceId}:${line})`);
  });
}
function openDevTools(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.openDevTools({ mode: "detach" });
}
function parseMessages(buffer) {
  const messages = [];
  let rest = buffer;
  while (true) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = rest.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      rest = rest.slice(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (rest.length < bodyStart + length) break;
    messages.push(rest.slice(bodyStart, bodyStart + length));
    rest = rest.slice(bodyStart + length);
  }
  return { messages, rest };
}
function frameMessage(jsonBody) {
  return `Content-Length: ${Buffer.byteLength(jsonBody, "utf8")}\r
\r
${jsonBody}`;
}
const require$1 = node_module.createRequire(require("url").pathToFileURL(__filename).href);
let lspHandle = null;
let stdoutBuffer = "";
let running = false;
let statusMessage = "";
let mainWindow$1 = null;
let readyTimer = null;
let markedReady = false;
let isShuttingDown = false;
function canSendToRenderer() {
  return !isShuttingDown && mainWindow$1 !== null && !mainWindow$1.isDestroyed() && !mainWindow$1.webContents.isDestroyed();
}
function safeSend(channel, ...args) {
  if (!canSendToRenderer()) return;
  mainWindow$1.webContents.send(channel, ...args);
}
function resolveServerEntry() {
  if (electron.app.isPackaged) {
    return node_path.join(process.resourcesPath, "language-server", "server.js");
  }
  const pkgRoot = node_path.dirname(require$1.resolve("@agile-sofl/language-server/package.json"));
  return node_path.join(pkgRoot, "dist", "server.js");
}
function setLspWindow(win) {
  mainWindow$1 = win;
}
function isLspRunning() {
  return running && lspHandle !== null;
}
function getLspStatusMessage() {
  return statusMessage;
}
function broadcastStatus(runningNow, message) {
  running = runningNow;
  safeSend("studio:lsp-status-changed", {
    running: runningNow,
    message: statusMessage
  });
}
function clearReadyTimer() {
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
}
function markRunningReady() {
  if (markedReady || !lspHandle) return;
  markedReady = true;
  clearReadyTimer();
  statusMessage = "Language server connected";
  broadcastStatus(true);
}
function scheduleReadyFallback() {
  clearReadyTimer();
  readyTimer = setTimeout(() => {
    if (lspHandle && !markedReady) markRunningReady();
  }, 300);
}
function attachStdout(onData) {
  if (!lspHandle) return;
  if (lspHandle.kind === "child") {
    lspHandle.proc.stdout.on("data", onData);
  } else {
    lspHandle.proc.stdout?.on("data", onData);
  }
}
function attachStderr(onData) {
  if (!lspHandle) return;
  if (lspHandle.kind === "child") {
    lspHandle.proc.stderr.on("data", onData);
  } else {
    lspHandle.proc.stderr?.on("data", onData);
  }
}
function attachExit(onExit) {
  if (!lspHandle) return;
  if (lspHandle.kind === "child") {
    lspHandle.proc.on("exit", onExit);
  } else {
    lspHandle.proc.on("exit", onExit);
  }
}
function writeStdin(data) {
  if (!lspHandle) return;
  if (lspHandle.kind === "child") {
    if (lspHandle.proc.stdin.writable) lspHandle.proc.stdin.write(data);
  } else {
    lspHandle.proc.stdin?.write(data);
  }
}
function killHandle() {
  if (!lspHandle) return;
  if (lspHandle.kind === "child") lspHandle.proc.kill();
  else lspHandle.proc.kill();
}
function wireProcess(label) {
  if (!lspHandle) return false;
  stdoutBuffer = "";
  markedReady = false;
  let stderrBuf = "";
  attachStdout((chunk) => {
    if (!markedReady) markRunningReady();
    stdoutBuffer += chunk.toString("utf8");
    const { messages, rest } = parseMessages(stdoutBuffer);
    stdoutBuffer = rest;
    for (const msg of messages) {
      safeSend("studio:lsp-message", msg);
    }
  });
  attachStderr((chunk) => {
    stderrBuf += chunk.toString("utf8");
    const text = chunk.toString("utf8").trim();
    if (text) console.error(`[studio] lsp stderr (${label}):`, text);
  });
  attachExit((code) => {
    clearReadyTimer();
    if (!isShuttingDown) {
      console.error(`[studio] language server exited (${label})`, code);
      if (stderrBuf.trim()) console.error("[studio] lsp stderr summary:", stderrBuf.trim().slice(0, 500));
    }
    lspHandle = null;
    markedReady = false;
    if (isShuttingDown) return;
    const hint = stderrBuf.trim().slice(0, 200) || "Run: npm run bundle --workspace @agile-sofl/language-server";
    statusMessage = `Language server failed (${label}): ${hint}`;
    broadcastStatus(false);
  });
  scheduleReadyFallback();
  console.log(`[studio] spawned language server via ${label}`);
  return true;
}
function tryUtilityProcess(serverEntry) {
  try {
    const proc = electron.utilityProcess.fork(serverEntry, ["--stdio"], {
      serviceName: "agile-sofl-lsp",
      stdio: "pipe",
      cwd: node_path.dirname(serverEntry)
    });
    lspHandle = { kind: "utility", proc };
    return wireProcess("utilityProcess");
  } catch (err) {
    console.warn("[studio] utilityProcess.fork failed:", err);
    lspHandle = null;
    return false;
  }
}
function tryNodeSpawn(serverEntry) {
  const nodeBin = process.env.npm_node_execpath ?? "node";
  try {
    const proc = node_child_process.spawn(nodeBin, [serverEntry, "--stdio"], {
      cwd: node_path.dirname(serverEntry),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    lspHandle = { kind: "child", proc };
    return wireProcess("node");
  } catch (err) {
    console.warn("[studio] node spawn failed:", err);
    lspHandle = null;
    return false;
  }
}
function tryElectronAsNode(serverEntry) {
  try {
    const proc = node_child_process.spawn(process.execPath, [serverEntry, "--stdio"], {
      cwd: node_path.dirname(serverEntry),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    lspHandle = { kind: "child", proc };
    return wireProcess("electron-as-node");
  } catch (err) {
    console.warn("[studio] electron-as-node spawn failed:", err);
    lspHandle = null;
    return false;
  }
}
function startLanguageServer() {
  if (lspHandle) return isLspRunning();
  isShuttingDown = false;
  const serverEntry = resolveServerEntry();
  if (!node_fs.existsSync(serverEntry)) {
    statusMessage = "Language server not built — run: npm run bundle --workspace @agile-sofl/language-server";
    console.warn("[studio]", statusMessage);
    broadcastStatus(false);
    return false;
  }
  const strategies = [
    () => tryNodeSpawn(serverEntry),
    () => tryElectronAsNode(serverEntry),
    () => tryUtilityProcess(serverEntry)
  ];
  for (const strategy of strategies) {
    if (strategy()) return true;
  }
  statusMessage = "Failed to spawn language server with all strategies";
  broadcastStatus(false);
  return false;
}
function sendToLanguageServer(jsonBody) {
  writeStdin(frameMessage(jsonBody));
}
function stopLanguageServer() {
  isShuttingDown = true;
  clearReadyTimer();
  if (!lspHandle) return;
  killHandle();
  lspHandle = null;
  running = false;
  markedReady = false;
}
let mainWindow = null;
let allowClose = false;
let resolveBackendReady = () => {
};
const backendReady = new Promise((resolve) => {
  resolveBackendReady = resolve;
});
function resolveAppIcon() {
  const candidates = [
    node_path.join(__dirname, "../../build/icon.png"),
    node_path.join(__dirname, "../../build/icons/256x256.png")
  ];
  return candidates.find((p) => node_fs.existsSync(p));
}
function getWindow() {
  return mainWindow;
}
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    icon: resolveAppIcon(),
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "Agile-SOFL Studio"
  });
  setLspWindow(mainWindow);
  attachDevToolsShortcuts(mainWindow);
  attachRendererDiagnostics(mainWindow);
  mainWindow.on("closed", () => {
    setLspWindow(null);
    mainWindow = null;
  });
  mainWindow.on("close", (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow?.webContents.send("studio:request-close");
  });
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("studio:window-maximized-changed", true);
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("studio:window-maximized-changed", false);
  });
  mainWindow.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) startLanguageServer();
    }, 2e3);
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
}
electron.app.whenReady().then(async () => {
  loadStudioEnv();
  console.warn(conditionNotice(getExperimentConfig()));
  registerFileHandlers(getWindow);
  registerWindowHandlers(getWindow);
  registerProjectHandlers(getWindow);
  registerAgentHandlers();
  registerGitHandlers();
  electron.ipcMain.handle("studio:backend-ready", () => backendReady);
  electron.ipcMain.on("studio:lsp-send", (_event, jsonBody) => {
    sendToLanguageServer(jsonBody);
  });
  electron.ipcMain.handle("studio:lsp-status", () => ({
    running: isLspRunning(),
    message: isLspRunning() ? getLspStatusMessage() || "Language server connected" : getLspStatusMessage() || "Language server not available — run npm run bundle --workspace @agile-sofl/language-server"
  }));
  electron.ipcMain.handle("studio:open-devtools", () => {
    openDevTools(mainWindow);
  });
  electron.ipcMain.on("studio:confirm-close", () => {
    allowClose = true;
    stopLanguageServer();
    setLspWindow(null);
    mainWindow?.close();
  });
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  setTimeout(() => {
    void (async () => {
      try {
        await initProjectIndex();
      } catch (err) {
        console.error("[studio] Failed to open project index:", err);
      }
      try {
        registerParseHandlers();
      } catch (err) {
        console.error("[studio] Failed to register parse handlers:", err);
      } finally {
        resolveBackendReady();
      }
    })();
  }, 0);
});
electron.app.on("window-all-closed", () => {
  stopLanguageServer();
  if (process.platform !== "darwin") electron.app.quit();
});
