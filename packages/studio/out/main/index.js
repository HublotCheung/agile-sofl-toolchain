"use strict";
const editorApi = require("@agile-sofl/editor-api");
const node_fs = require("node:fs");
const node_path = require("node:path");
const parser$2 = require("@agile-sofl/parser");
const electron = require("electron");
const promises = require("node:fs/promises");
const node_crypto = require("node:crypto");
const require$$0 = require("process");
const require$$0$1 = require("buffer");
const gui = require("@agile-sofl/gui");
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
function repairQuantifierAndIff(text) {
  const notes = [];
  let out = text;
  const forall = out.replace(
    /\bforall\s+([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)\s*:\s*([^,\|\n;]+)\s*,\s*/g,
    "forall[$1: $2] | "
  );
  if (forall !== out) {
    out = forall;
    notes.push("rewrote forall u: T, to forall[u: T] |");
  }
  const iff = out.replace(/([^;\n]+?)\s+iff\s+([^;\n]+)/g, "($1 implies $2) and ($2 implies $1)");
  if (iff !== out) {
    out = iff;
    notes.push("rewrote iff to (A implies B) and (B implies A)");
  }
  return { text: out, notes };
}
function repairCode(code) {
  const notes = [];
  let text = code;
  const quant = repairQuantifierAndIff(text);
  text = quant.text;
  notes.push(...quant.notes);
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
  const r = parser$2.check(asfl, { fsfL1: false });
  if (!r.ast) return [];
  return [...parser$2.checkFsfL1(r.ast).diagnostics, ...(await parser$2.checkFsfL2(r.ast)).diagnostics];
}
async function diagnosticCounts(asfl, cfg) {
  const r = parser$2.check(asfl, { fsfL1: false });
  const parser2 = count(r.diagnostics.filter((d) => !isL1Code(d.code) && !isL2Code(d.code)));
  if (!cfg.semanticChecks || !r.ast) {
    return { parser: parser2, l1: { error: 0, warning: 0, enabled: cfg.semanticChecks, ran: false }, l2: { error: 0, warning: 0, enabled: cfg.semanticChecks, ran: false } };
  }
  const l1 = count(parser$2.checkFsfL1(r.ast).diagnostics);
  const l2 = count((await parser$2.checkFsfL2(r.ast)).diagnostics);
  return { parser: parser2, l1: { ...l1, enabled: true, ran: true }, l2: { ...l2, enabled: true, ran: true } };
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function runCopyrightCapture(win) {
  const outDir = process.env.STUDIO_CAPTURE_DIR;
  const samplePath = process.env.STUDIO_CAPTURE_SAMPLE;
  if (!outDir || !samplePath) {
    throw new Error("STUDIO_CAPTURE_DIR and STUDIO_CAPTURE_SAMPLE are required");
  }
  node_fs.mkdirSync(outDir, { recursive: true });
  const source = node_fs.readFileSync(samplePath, "utf8");
  const log2 = [];
  const note = (message) => {
    log2.push(message);
    console.log(`[copyright-capture] ${message}`);
  };
  const ev = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    win.show();
    win.focus();
    await sleep(900);
    const image = await win.capturePage();
    const file = node_path.join(outDir, `${name}.png`);
    node_fs.writeFileSync(file, image.toPNG());
    note(`saved ${file}`);
  };
  const clickExact = (label) => ev(`(() => {
      const nodes = [...document.querySelectorAll('button, [role="menuitem"], a')]
      const el = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)})
      if (!el) return false
      el.click()
      return true
    })()`);
  const waitFor = async (label, timeoutMs = 25e3) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await ev(
        `document.body && document.body.innerText.includes(${JSON.stringify(label)})`
      );
      if (found) return;
      await sleep(300);
    }
    throw new Error(`timed out waiting for: ${label}`);
  };
  try {
    note("waiting for first-run dialog");
    await waitFor("Agile-SOFL Studio", 3e4);
    await ev(`(() => {
      const sel = document.querySelector('select')
      if (!sel) return
      sel.value = 'zh-CN'
      sel.dispatchEvent(new Event('change'))
    })()`);
    await sleep(400);
    if (!await clickExact("浅色")) note("light theme button not found, continuing");
    await sleep(300);
    await shot("01-first-run");
    if (!await clickExact("暂不配置 AI")) {
      throw new Error("could not skip onboarding");
    }
    await waitFor("最近打开", 2e4);
    await ev(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const pinia = app.config.globalProperties.$pinia
      const ui = pinia._s.get('app')
      ui.setLanguage('zh-CN')
      ui.setTheme('light')
    })()`);
    await sleep(600);
    await shot("02-home");
    if (await clickExact("从模板新建")) {
      const dialogStart = Date.now();
      let dialogOpen = false;
      while (Date.now() - dialogStart < 8e3) {
        dialogOpen = await ev(`!!document.querySelector('[role="dialog"]')`);
        if (dialogOpen) break;
        await sleep(200);
      }
      if (dialogOpen) {
        await sleep(700);
        await shot("03-template-dialog");
        const closed = await ev(`(() => {
          const dialog = document.querySelector('[role="dialog"]')
          const btn = dialog && [...dialog.querySelectorAll('button')].find((n) => (n.textContent || '').trim() === '取消')
          if (!btn) return false
          btn.click()
          return true
        })()`);
        if (!closed) note("template cancel not found");
        await sleep(400);
      } else {
        note("template dialog did not open");
      }
    } else {
      note("template button not found");
    }
    await ev(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const pinia = app.config.globalProperties.$pinia
      const doc = pinia._s.get('document')
      const editorUi = pinia._s.get('editorUi')
      doc.openFromFile(${JSON.stringify(samplePath)}, ${JSON.stringify(source)}, 'library-system.asfl')
      editorUi.setViewMode('split')
    })()`);
    await waitFor("library-system.asfl", 15e3);
    const monacoStart = Date.now();
    while (Date.now() - monacoStart < 2e4) {
      const ready = await ev(`!!document.querySelector('.monaco-editor')`);
      if (ready) break;
      await sleep(300);
    }
    await sleep(2200);
    await shot("04-split-editor");
    await ev(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editorUi').setViewMode('code')`);
    await sleep(800);
    await shot("05-code-editor");
    await ev(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editorUi').setViewMode('visual')`);
    await sleep(1500);
    await shot("06-visual-editor");
    if (await clickExact("关系图")) {
      await sleep(1800);
      await shot("07-module-graph");
    } else {
      note("graph button not found");
    }
    await ev(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings').show()`);
    await waitFor("外观", 1e4);
    await sleep(400);
    await shot("08-settings");
    await ev(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute('aria-label') === '设置')
      const close = dialog?.querySelector('button[aria-label="关闭"]')
      if (close) close.click()
      const settings = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings')
      settings.hide()
      settings.open = false
      return true
    })()`);
    const settingsGone = Date.now();
    while (Date.now() - settingsGone < 5e3) {
      const stillOpen = await ev(
        `!![...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute('aria-label') === '设置')`
      );
      if (!stillOpen) break;
      await sleep(200);
    }
    await ev(`(() => {
      const modal = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('modal')
      void modal.show({
        title: '关于 Agile-SOFL Studio',
        message: 'Agile-SOFL Studio v0.1.0\\n用于 .asfl 规格的 Electron 可视化编辑器。',
        buttons: ['确定']
      })
    })()`);
    await waitFor("Electron 可视化编辑器", 8e3);
    await shot("09-about");
    await ev(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('modal').respond(0)`);
    node_fs.writeFileSync(node_path.join(outDir, "capture-log.txt"), log2.join("\n"), "utf8");
    note("done");
    electron.app.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    try {
      await shot("99-capture-failed");
    } catch {
    }
    node_fs.writeFileSync(node_path.join(outDir, "capture-error.txt"), `${message}

${log2.join("\n")}`, "utf8");
    console.error(message);
    electron.app.exit(1);
  }
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
    ast = parser$2.parse(content).ast;
  } catch (e) {
    return { written: [], skipped: `parse failed: ${String(e)}` };
  }
  if (!ast || ast.type !== "program" || ast.modules.length === 0) return { written: [], skipped: "no parsable modules" };
  const dir = moduleArtifactDir(filePath);
  node_fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const keep = /* @__PURE__ */ new Set();
  for (const a of parser$2.moduleArtifacts(ast, content)) {
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
const showOpenDialog = (win, options) => win ? electron.dialog.showOpenDialog(win, options) : electron.dialog.showOpenDialog(options);
const showSaveDialog = (win, options) => win ? electron.dialog.showSaveDialog(win, options) : electron.dialog.showSaveDialog(options);
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
    const filters = kind === "json" ? [{ name: "JSON", extensions: ["json"] }] : kind === "aspec" ? [{ name: "Informal Spec", extensions: ["aspec"] }] : kind === "asfl" ? [{ name: "Hybrid Spec", extensions: ["asfl"] }] : [
      { name: "Agile-SOFL Specs", extensions: ["asfl", "aspec"] },
      { name: "Hybrid (.asfl)", extensions: ["asfl"] },
      { name: "Informal (.aspec)", extensions: ["aspec"] },
      { name: "All files", extensions: ["*"] }
    ];
    const result = await showOpenDialog(win, {
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
      const ext = kind === "json" ? "json" : kind === "aspec" ? "aspec" : "asfl";
      const defaultPath = defaultName ?? `untitled.${ext}`;
      const result = await showSaveDialog(win, {
        filters: [{ name: kind === "json" ? "JSON" : kind === "aspec" ? "Informal Spec" : "Hybrid Spec", extensions: [ext] }],
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
    const result = await showOpenDialog(win, {
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
const MAX_TEXT_SEARCH_MATCHES = 5e3;
function normalizePathKey(filePath) {
  let normalized = filePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(normalized)) normalized = normalized[0].toLowerCase() + normalized.slice(1);
  else if (normalized.startsWith("/")) normalized = normalized.toLowerCase();
  return normalized;
}
function toRelativePath(root, filePath) {
  const rootKey = normalizePathKey(root).replace(/\/$/, "");
  const fileSlash = filePath.replace(/\\/g, "/");
  const fileKey = normalizePathKey(filePath);
  if (fileKey === rootKey) return "";
  if (fileKey.startsWith(`${rootKey}/`)) {
    return fileSlash.slice(fileSlash.length - (fileKey.length - rootKey.length - 1));
  }
  return fileSlash;
}
function editorDocumentKind(filePath) {
  const path = filePath.replace(/\\/g, "/").toLowerCase();
  if (path.endsWith(".aspec")) return "aspec";
  if (path.endsWith(".asfl")) return "asfl";
  if (path.endsWith(".guispec") || path.endsWith(".gui.html") || path.endsWith("/gui.html")) {
    return "guispec";
  }
  return null;
}
function isEditorDocumentPath(filePath) {
  return editorDocumentKind(filePath) != null;
}
function splitGlobList(raw) {
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}
function globToRegExp(pattern) {
  let out = "";
  const source = pattern.replace(/\\/g, "/");
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "*") {
      if (source[i + 1] === "*") {
        if (source[i + 2] === "/") {
          out += "(?:.*/?)";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^(?:${out})$`, "i");
}
function matchGlob(relativePath, pattern) {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const pat = pattern.trim().replace(/\\/g, "/");
  if (!pat || pat === "**" || pat === "**/*") return true;
  if (globToRegExp(pat).test(rel)) return true;
  if (!pat.includes("/")) {
    const base2 = rel.slice(rel.lastIndexOf("/") + 1);
    if (globToRegExp(pat).test(base2)) return true;
  }
  return false;
}
function pathAllowed(relativePath, include, exclude) {
  const includes = splitGlobList(include);
  const excludes = splitGlobList(exclude);
  if (includes.length > 0 && !includes.some((glob) => matchGlob(relativePath, glob))) return false;
  if (excludes.some((glob) => matchGlob(relativePath, glob))) return false;
  return true;
}
function escapeRegExp(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
function compileSearch(query) {
  const raw = query.query;
  if (!raw) return { error: "empty" };
  let pattern = query.useRegex ? raw : escapeRegExp(raw);
  if (query.wholeWord) {
    pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
  }
  const flags = `${query.matchCase ? "" : "i"}gu`;
  try {
    return { re: new RegExp(pattern, flags) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "invalid" };
  }
}
function buildPreview(lineText, matchStart, matchEnd) {
  const max = 180;
  if (lineText.length <= max) {
    return { preview: lineText, previewStart: matchStart, previewEnd: matchEnd };
  }
  const radius = 70;
  const from = Math.max(0, matchStart - radius);
  const to = Math.min(lineText.length, matchEnd + radius);
  const prefix = from > 0;
  const suffix = to < lineText.length;
  const preview = `${prefix ? "…" : ""}${lineText.slice(from, to)}${suffix ? "…" : ""}`;
  const shift = (prefix ? 1 : 0) - from;
  return {
    preview,
    previewStart: matchStart + shift,
    previewEnd: matchEnd + shift
  };
}
function searchInText(content, re, limit) {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const regex = new RegExp(re.source, flags);
  const matches = [];
  let truncated = false;
  let found;
  while (found = regex.exec(content)) {
    if (found[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    const start = found.index;
    const end = start + found[0].length;
    const lineStart = content.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = content.indexOf("\n", end);
    const lineEnd = lineEndIdx === -1 ? content.length : lineEndIdx;
    const lineText = content.slice(lineStart, lineEnd).replace(/\r$/, "");
    const line = content.slice(0, start).split("\n").length;
    const column = start - lineStart + 1;
    const inLineStart = start - lineStart;
    const inLineEnd = Math.min(lineText.length, end - lineStart);
    const preview = buildPreview(lineText, inLineStart, inLineEnd);
    const groups = [];
    for (let i = 0; i < found.length; i++) groups.push(found[i] ?? "");
    matches.push({
      line,
      column,
      start,
      end,
      text: found[0],
      groups,
      ...preview
    });
  }
  return { matches, truncated };
}
const SKIP_DIRS$1 = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "release",
  "coverage",
  ".vite"
]);
const BINARY_EXT = /* @__PURE__ */ new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "exe",
  "dll",
  "wasm",
  "pdf",
  "zip",
  "gz",
  "7z",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "bin",
  "obj",
  "class",
  "jar",
  "pyc",
  "sqlite",
  "db"
]);
const MAX_FILE_BYTES = 1e6;
const MAX_FILES = 4e3;
function extensionOf(name) {
  const base2 = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const dot = base2.lastIndexOf(".");
  if (dot <= 0) return "";
  return base2.slice(dot + 1).toLowerCase();
}
function readTextFile(filePath) {
  const ext = extensionOf(filePath);
  if (ext && BINARY_EXT.has(ext)) return null;
  let size = 0;
  try {
    size = node_fs.statSync(filePath).size;
  } catch {
    return null;
  }
  if (size <= 0 || size > MAX_FILE_BYTES) return null;
  let content;
  try {
    content = node_fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (content.includes("\0")) return null;
  return content;
}
function searchProjectFiles(request) {
  const root = request.root;
  if (!root) return { files: [], truncated: false, error: null };
  const compiled = compileSearch(request);
  if ("error" in compiled) {
    if (compiled.error === "empty") return { files: [], truncated: false, error: null };
    return { files: [], truncated: false, error: compiled.error };
  }
  const skip = new Set((request.skipPaths ?? []).map((path) => normalizePathKey(path)));
  const files = [];
  let truncated = false;
  let remaining = MAX_TEXT_SEARCH_MATCHES;
  let seenFiles = 0;
  const walk = (dir) => {
    if (truncated) return;
    let entries;
    try {
      entries = node_fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const full = node_path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS$1.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seenFiles += 1;
      if (seenFiles > MAX_FILES) {
        truncated = true;
        return;
      }
      if (skip.has(normalizePathKey(full))) continue;
      const relative = toRelativePath(root, full);
      if (!pathAllowed(relative, request.include, request.exclude)) continue;
      const content = readTextFile(full);
      if (content == null) continue;
      const found = searchInText(content, compiled.re, remaining);
      if (!found.matches.length) continue;
      remaining -= found.matches.length;
      if (found.truncated) truncated = true;
      files.push({
        path: full,
        replaceable: isEditorDocumentPath(full),
        matches: found.matches
      });
      if (remaining <= 0) {
        truncated = true;
        return;
      }
    }
  };
  walk(root);
  files.sort((a, b) => toRelativePath(root, a.path).localeCompare(toRelativePath(root, b.path)));
  return { files, truncated, error: null };
}
function registerTextSearchHandlers() {
  electron.ipcMain.handle("studio:search-project-text", (_event, payload) => {
    if (!payload || typeof payload.root !== "string") {
      return { files: [], truncated: false, error: null };
    }
    return searchProjectFiles({
      root: payload.root,
      query: String(payload.query ?? ""),
      matchCase: Boolean(payload.matchCase),
      wholeWord: Boolean(payload.wholeWord),
      useRegex: Boolean(payload.useRegex),
      include: String(payload.include ?? ""),
      exclude: String(payload.exclude ?? ""),
      skipPaths: Array.isArray(payload.skipPaths) ? payload.skipPaths.map((path) => String(path)) : []
    });
  });
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
function asRecord$1(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function parseProfile(raw, fallbackId) {
  const object = asRecord$1(raw);
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
  const object = asRecord$1(value);
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
const CHAT_TIMEOUT_MS = (() => {
  const fromEnv = Number(process.env.ECNU_CHAT_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 3e4) return Math.floor(fromEnv);
  return 3e5;
})();
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
      throw new Error(`ChatECNU timed out after ${Math.round(CHAT_TIMEOUT_MS / 1e3)}s. Send again to continue.`);
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
const DEFAULT_STREAM_MAX_TOKENS = 8192;
function resolveStreamMaxTokens(explicit) {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const fromEnv = Number(process.env.ECNU_MAX_TOKENS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_STREAM_MAX_TOKENS;
}
function buildStreamBody(options) {
  const body = {
    messages: options.messages,
    temperature: options.temperature ?? 0.35,
    stream: true,
    thinking: { type: options.thinking === false ? "disabled" : "enabled" },
    max_tokens: resolveStreamMaxTokens(options.maxTokens)
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
function compactDiagnosticPayload(payload) {
  const items = [];
  let used = 0;
  let shortened = false;
  for (const d of payload.items.slice(0, 12)) {
    const item = {
      severity: d.severity,
      code: d.code?.slice(0, 80),
      source: d.source?.slice(0, 80),
      module: d.module?.slice(0, 80),
      line: d.line,
      column: d.column,
      message: (d.message ?? "").slice(0, 800)
    };
    if ((d.message?.length ?? 0) > 800) shortened = true;
    const size = JSON.stringify(item).length;
    if (used + size > 12e3) break;
    used += size;
    items.push(item);
  }
  return {
    ...payload,
    items,
    omittedItems: payload.items.length - items.length,
    truncated: shortened || items.length !== payload.items.length,
    diagnosticView: "At most 12 items, 800 message characters per item, 12000 item characters; full counts retained."
  };
}
var composer$1 = {};
var directives$2 = {};
var identity$x = {};
const ALIAS = Symbol.for("yaml.alias");
const DOC = Symbol.for("yaml.document");
const MAP = Symbol.for("yaml.map");
const PAIR = Symbol.for("yaml.pair");
const SCALAR$1 = Symbol.for("yaml.scalar");
const SEQ = Symbol.for("yaml.seq");
const NODE_TYPE = Symbol.for("yaml.node.type");
const isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
const isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
const isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
const isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
const isScalar$1 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR$1;
const isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
function isCollection$1(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case MAP:
      case SEQ:
        return true;
    }
  return false;
}
function isNode(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case ALIAS:
      case MAP:
      case SCALAR$1:
      case SEQ:
        return true;
    }
  return false;
}
const hasAnchor = (node) => (isScalar$1(node) || isCollection$1(node)) && !!node.anchor;
identity$x.ALIAS = ALIAS;
identity$x.DOC = DOC;
identity$x.MAP = MAP;
identity$x.NODE_TYPE = NODE_TYPE;
identity$x.PAIR = PAIR;
identity$x.SCALAR = SCALAR$1;
identity$x.SEQ = SEQ;
identity$x.hasAnchor = hasAnchor;
identity$x.isAlias = isAlias;
identity$x.isCollection = isCollection$1;
identity$x.isDocument = isDocument;
identity$x.isMap = isMap;
identity$x.isNode = isNode;
identity$x.isPair = isPair;
identity$x.isScalar = isScalar$1;
identity$x.isSeq = isSeq;
var visit$6 = {};
var identity$w = identity$x;
const BREAK$1 = Symbol("break visit");
const SKIP$1 = Symbol("skip children");
const REMOVE$1 = Symbol("remove node");
function visit$5(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (identity$w.isDocument(node)) {
    const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE$1)
      node.contents = null;
  } else
    visit_(null, node, visitor_, Object.freeze([]));
}
visit$5.BREAK = BREAK$1;
visit$5.SKIP = SKIP$1;
visit$5.REMOVE = REMOVE$1;
function visit_(key, node, visitor, path) {
  const ctrl = callVisitor(key, node, visitor, path);
  if (identity$w.isNode(ctrl) || identity$w.isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visit_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (identity$w.isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = visit_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK$1)
          return BREAK$1;
        else if (ci === REMOVE$1) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (identity$w.isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = visit_("key", node.key, visitor, path);
      if (ck === BREAK$1)
        return BREAK$1;
      else if (ck === REMOVE$1)
        node.key = null;
      const cv = visit_("value", node.value, visitor, path);
      if (cv === BREAK$1)
        return BREAK$1;
      else if (cv === REMOVE$1)
        node.value = null;
    }
  }
  return ctrl;
}
async function visitAsync(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (identity$w.isDocument(node)) {
    const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE$1)
      node.contents = null;
  } else
    await visitAsync_(null, node, visitor_, Object.freeze([]));
}
visitAsync.BREAK = BREAK$1;
visitAsync.SKIP = SKIP$1;
visitAsync.REMOVE = REMOVE$1;
async function visitAsync_(key, node, visitor, path) {
  const ctrl = await callVisitor(key, node, visitor, path);
  if (identity$w.isNode(ctrl) || identity$w.isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visitAsync_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (identity$w.isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = await visitAsync_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK$1)
          return BREAK$1;
        else if (ci === REMOVE$1) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (identity$w.isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = await visitAsync_("key", node.key, visitor, path);
      if (ck === BREAK$1)
        return BREAK$1;
      else if (ck === REMOVE$1)
        node.key = null;
      const cv = await visitAsync_("value", node.value, visitor, path);
      if (cv === BREAK$1)
        return BREAK$1;
      else if (cv === REMOVE$1)
        node.value = null;
    }
  }
  return ctrl;
}
function initVisitor(visitor) {
  if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
    return Object.assign({
      Alias: visitor.Node,
      Map: visitor.Node,
      Scalar: visitor.Node,
      Seq: visitor.Node
    }, visitor.Value && {
      Map: visitor.Value,
      Scalar: visitor.Value,
      Seq: visitor.Value
    }, visitor.Collection && {
      Map: visitor.Collection,
      Seq: visitor.Collection
    }, visitor);
  }
  return visitor;
}
function callVisitor(key, node, visitor, path) {
  if (typeof visitor === "function")
    return visitor(key, node, path);
  if (identity$w.isMap(node))
    return visitor.Map?.(key, node, path);
  if (identity$w.isSeq(node))
    return visitor.Seq?.(key, node, path);
  if (identity$w.isPair(node))
    return visitor.Pair?.(key, node, path);
  if (identity$w.isScalar(node))
    return visitor.Scalar?.(key, node, path);
  if (identity$w.isAlias(node))
    return visitor.Alias?.(key, node, path);
  return void 0;
}
function replaceNode(key, path, node) {
  const parent = path[path.length - 1];
  if (identity$w.isCollection(parent)) {
    parent.items[key] = node;
  } else if (identity$w.isPair(parent)) {
    if (key === "key")
      parent.key = node;
    else
      parent.value = node;
  } else if (identity$w.isDocument(parent)) {
    parent.contents = node;
  } else {
    const pt = identity$w.isAlias(parent) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${pt} parent`);
  }
}
visit$6.visit = visit$5;
visit$6.visitAsync = visitAsync;
var identity$v = identity$x;
var visit$4 = visit$6;
const escapeChars = {
  "!": "%21",
  ",": "%2C",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D"
};
const escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
class Directives {
  constructor(yaml, tags2) {
    this.docStart = null;
    this.docEnd = false;
    this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
    this.tags = Object.assign({}, Directives.defaultTags, tags2);
  }
  clone() {
    const copy = new Directives(this.yaml, this.tags);
    copy.docStart = this.docStart;
    return copy;
  }
  /**
   * During parsing, get a Directives instance for the current document and
   * update the stream state according to the current version's spec.
   */
  atDocument() {
    const res = new Directives(this.yaml, this.tags);
    switch (this.yaml.version) {
      case "1.1":
        this.atNextDocument = true;
        break;
      case "1.2":
        this.atNextDocument = false;
        this.yaml = {
          explicit: Directives.defaultYaml.explicit,
          version: "1.2"
        };
        this.tags = Object.assign({}, Directives.defaultTags);
        break;
    }
    return res;
  }
  /**
   * @param onError - May be called even if the action was successful
   * @returns `true` on success
   */
  add(line, onError) {
    if (this.atNextDocument) {
      this.yaml = { explicit: Directives.defaultYaml.explicit, version: "1.1" };
      this.tags = Object.assign({}, Directives.defaultTags);
      this.atNextDocument = false;
    }
    const parts = line.trim().split(/[ \t]+/);
    const name = parts.shift();
    switch (name) {
      case "%TAG": {
        if (parts.length !== 2) {
          onError(0, "%TAG directive should contain exactly two parts");
          if (parts.length < 2)
            return false;
        }
        const [handle, prefix] = parts;
        this.tags[handle] = prefix;
        return true;
      }
      case "%YAML": {
        this.yaml.explicit = true;
        if (parts.length !== 1) {
          onError(0, "%YAML directive should contain exactly one part");
          return false;
        }
        const [version] = parts;
        if (version === "1.1" || version === "1.2") {
          this.yaml.version = version;
          return true;
        } else {
          const isValid = /^\d+\.\d+$/.test(version);
          onError(6, `Unsupported YAML version ${version}`, isValid);
          return false;
        }
      }
      default:
        onError(0, `Unknown directive ${name}`, true);
        return false;
    }
  }
  /**
   * Resolves a tag, matching handles to those defined in %TAG directives.
   *
   * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
   *   `'!local'` tag, or `null` if unresolvable.
   */
  tagName(source, onError) {
    if (source === "!")
      return "!";
    if (source[0] !== "!") {
      onError(`Not a valid tag: ${source}`);
      return null;
    }
    if (source[1] === "<") {
      const verbatim = source.slice(2, -1);
      if (verbatim === "!" || verbatim === "!!") {
        onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
        return null;
      }
      if (source[source.length - 1] !== ">")
        onError("Verbatim tags must end with a >");
      return verbatim;
    }
    const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
    if (!suffix)
      onError(`The ${source} tag has no suffix`);
    const prefix = this.tags[handle];
    if (prefix) {
      try {
        return prefix + decodeURIComponent(suffix);
      } catch (error) {
        onError(String(error));
        return null;
      }
    }
    if (handle === "!")
      return source;
    onError(`Could not resolve tag: ${source}`);
    return null;
  }
  /**
   * Given a fully resolved tag, returns its printable string form,
   * taking into account current tag prefixes and defaults.
   */
  tagString(tag) {
    for (const [handle, prefix] of Object.entries(this.tags)) {
      if (tag.startsWith(prefix))
        return handle + escapeTagName(tag.substring(prefix.length));
    }
    return tag[0] === "!" ? tag : `!<${tag}>`;
  }
  toString(doc) {
    const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
    const tagEntries = Object.entries(this.tags);
    let tagNames;
    if (doc && tagEntries.length > 0 && identity$v.isNode(doc.contents)) {
      const tags2 = {};
      visit$4.visit(doc.contents, (_key, node) => {
        if (identity$v.isNode(node) && node.tag)
          tags2[node.tag] = true;
      });
      tagNames = Object.keys(tags2);
    } else
      tagNames = [];
    for (const [handle, prefix] of tagEntries) {
      if (handle === "!!" && prefix === "tag:yaml.org,2002:")
        continue;
      if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
        lines.push(`%TAG ${handle} ${prefix}`);
    }
    return lines.join("\n");
  }
}
Directives.defaultYaml = { explicit: false, version: "1.2" };
Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
directives$2.Directives = Directives;
var Document$4 = {};
var Alias$4 = {};
var anchors$3 = {};
var identity$u = identity$x;
var visit$3 = visit$6;
function anchorIsValid(anchor) {
  if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
    const sa = JSON.stringify(anchor);
    const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
    throw new Error(msg);
  }
  return true;
}
function anchorNames(root) {
  const anchors2 = /* @__PURE__ */ new Set();
  visit$3.visit(root, {
    Value(_key, node) {
      if (node.anchor)
        anchors2.add(node.anchor);
    }
  });
  return anchors2;
}
function findNewAnchor(prefix, exclude) {
  for (let i = 1; true; ++i) {
    const name = `${prefix}${i}`;
    if (!exclude.has(name))
      return name;
  }
}
function createNodeAnchors(doc, prefix) {
  const aliasObjects = [];
  const sourceObjects = /* @__PURE__ */ new Map();
  let prevAnchors = null;
  return {
    onAnchor: (source) => {
      aliasObjects.push(source);
      prevAnchors ?? (prevAnchors = anchorNames(doc));
      const anchor = findNewAnchor(prefix, prevAnchors);
      prevAnchors.add(anchor);
      return anchor;
    },
    /**
     * With circular references, the source node is only resolved after all
     * of its child nodes are. This is why anchors are set only after all of
     * the nodes have been created.
     */
    setAnchors: () => {
      for (const source of aliasObjects) {
        const ref = sourceObjects.get(source);
        if (typeof ref === "object" && ref.anchor && (identity$u.isScalar(ref.node) || identity$u.isCollection(ref.node))) {
          ref.node.anchor = ref.anchor;
        } else {
          const error = new Error("Failed to resolve repeated object (this should not happen)");
          error.source = source;
          throw error;
        }
      }
    },
    sourceObjects
  };
}
anchors$3.anchorIsValid = anchorIsValid;
anchors$3.anchorNames = anchorNames;
anchors$3.createNodeAnchors = createNodeAnchors;
anchors$3.findNewAnchor = findNewAnchor;
var Node$3 = {};
var applyReviver$3 = {};
function applyReviver$2(reviver, obj, key, val) {
  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      for (let i = 0, len = val.length; i < len; ++i) {
        const v0 = val[i];
        const v1 = applyReviver$2(reviver, val, String(i), v0);
        if (v1 === void 0)
          delete val[i];
        else if (v1 !== v0)
          val[i] = v1;
      }
    } else if (val instanceof Map) {
      for (const k of Array.from(val.keys())) {
        const v0 = val.get(k);
        const v1 = applyReviver$2(reviver, val, k, v0);
        if (v1 === void 0)
          val.delete(k);
        else if (v1 !== v0)
          val.set(k, v1);
      }
    } else if (val instanceof Set) {
      for (const v0 of Array.from(val)) {
        const v1 = applyReviver$2(reviver, val, v0, v0);
        if (v1 === void 0)
          val.delete(v0);
        else if (v1 !== v0) {
          val.delete(v0);
          val.add(v1);
        }
      }
    } else {
      for (const [k, v0] of Object.entries(val)) {
        const v1 = applyReviver$2(reviver, val, k, v0);
        if (v1 === void 0)
          delete val[k];
        else if (v1 !== v0)
          val[k] = v1;
      }
    }
  }
  return reviver.call(obj, key, val);
}
applyReviver$3.applyReviver = applyReviver$2;
var toJS$8 = {};
var identity$t = identity$x;
function toJS$7(value, arg, ctx) {
  if (Array.isArray(value))
    return value.map((v, i) => toJS$7(v, String(i), ctx));
  if (value && typeof value.toJSON === "function") {
    if (!ctx || !identity$t.hasAnchor(value))
      return value.toJSON(arg, ctx);
    const data = { aliasCount: 0, count: 1, res: void 0 };
    ctx.anchors.set(value, data);
    ctx.onCreate = (res2) => {
      data.res = res2;
      delete ctx.onCreate;
    };
    const res = value.toJSON(arg, ctx);
    if (ctx.onCreate)
      ctx.onCreate(res);
    return res;
  }
  if (typeof value === "bigint" && !ctx?.keep)
    return Number(value);
  return value;
}
toJS$8.toJS = toJS$7;
var applyReviver$1 = applyReviver$3;
var identity$s = identity$x;
var toJS$6 = toJS$8;
class NodeBase {
  constructor(type) {
    Object.defineProperty(this, identity$s.NODE_TYPE, { value: type });
  }
  /** Create a copy of this node.  */
  clone() {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** A plain JavaScript representation of this node. */
  toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    if (!identity$s.isDocument(doc))
      throw new TypeError("A document argument is required");
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc,
      keep: true,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS$6.toJS(this, "", ctx);
    if (typeof onAnchor === "function")
      for (const { count: count2, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count2);
    return typeof reviver === "function" ? applyReviver$1.applyReviver(reviver, { "": res }, "", res) : res;
  }
}
Node$3.NodeBase = NodeBase;
var anchors$2 = anchors$3;
var visit$2 = visit$6;
var identity$r = identity$x;
var Node$2 = Node$3;
var toJS$5 = toJS$8;
let Alias$3 = class Alias extends Node$2.NodeBase {
  constructor(source) {
    super(identity$r.ALIAS);
    this.source = source;
    Object.defineProperty(this, "tag", {
      set() {
        throw new Error("Alias nodes cannot have tags");
      }
    });
  }
  /**
   * Resolve the value of this alias within `doc`, finding the last
   * instance of the `source` anchor before this node.
   */
  resolve(doc, ctx) {
    if (ctx?.maxAliasCount === 0)
      throw new ReferenceError("Alias resolution is disabled");
    let nodes;
    if (ctx?.aliasResolveCache) {
      nodes = ctx.aliasResolveCache;
    } else {
      nodes = [];
      visit$2.visit(doc, {
        Node: (_key, node) => {
          if (identity$r.isAlias(node) || identity$r.hasAnchor(node))
            nodes.push(node);
        }
      });
      if (ctx)
        ctx.aliasResolveCache = nodes;
    }
    let found = void 0;
    for (const node of nodes) {
      if (node === this)
        break;
      if (node.anchor === this.source)
        found = node;
    }
    return found;
  }
  toJSON(_arg, ctx) {
    if (!ctx)
      return { source: this.source };
    const { anchors: anchors2, doc, maxAliasCount } = ctx;
    const source = this.resolve(doc, ctx);
    if (!source) {
      const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
      throw new ReferenceError(msg);
    }
    let data = anchors2.get(source);
    if (!data) {
      toJS$5.toJS(source, null, ctx);
      data = anchors2.get(source);
    }
    if (data?.res === void 0) {
      const msg = "This should not happen: Alias anchor was not resolved?";
      throw new ReferenceError(msg);
    }
    if (maxAliasCount >= 0) {
      data.count += 1;
      if (data.aliasCount === 0)
        data.aliasCount = getAliasCount(doc, source, anchors2);
      if (data.count * data.aliasCount > maxAliasCount) {
        const msg = "Excessive alias count indicates a resource exhaustion attack";
        throw new ReferenceError(msg);
      }
    }
    return data.res;
  }
  toString(ctx, _onComment, _onChompKeep) {
    const src = `*${this.source}`;
    if (ctx) {
      anchors$2.anchorIsValid(this.source);
      if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new Error(msg);
      }
      if (ctx.implicitKey)
        return `${src} `;
    }
    return src;
  }
};
function getAliasCount(doc, node, anchors2) {
  if (identity$r.isAlias(node)) {
    const source = node.resolve(doc);
    const anchor = anchors2 && source && anchors2.get(source);
    return anchor ? anchor.count * anchor.aliasCount : 0;
  } else if (identity$r.isCollection(node)) {
    let count2 = 0;
    for (const item of node.items) {
      const c = getAliasCount(doc, item, anchors2);
      if (c > count2)
        count2 = c;
    }
    return count2;
  } else if (identity$r.isPair(node)) {
    const kc = getAliasCount(doc, node.key, anchors2);
    const vc = getAliasCount(doc, node.value, anchors2);
    return Math.max(kc, vc);
  }
  return 1;
}
Alias$4.Alias = Alias$3;
var Collection$4 = {};
var createNode$5 = {};
var Scalar$k = {};
var identity$q = identity$x;
var Node$1 = Node$3;
var toJS$4 = toJS$8;
const isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
let Scalar$j = class Scalar extends Node$1.NodeBase {
  constructor(value) {
    super(identity$q.SCALAR);
    this.value = value;
  }
  toJSON(arg, ctx) {
    return ctx?.keep ? this.value : toJS$4.toJS(this.value, arg, ctx);
  }
  toString() {
    return String(this.value);
  }
};
Scalar$j.BLOCK_FOLDED = "BLOCK_FOLDED";
Scalar$j.BLOCK_LITERAL = "BLOCK_LITERAL";
Scalar$j.PLAIN = "PLAIN";
Scalar$j.QUOTE_DOUBLE = "QUOTE_DOUBLE";
Scalar$j.QUOTE_SINGLE = "QUOTE_SINGLE";
Scalar$k.Scalar = Scalar$j;
Scalar$k.isScalarValue = isScalarValue;
var Alias$2 = Alias$4;
var identity$p = identity$x;
var Scalar$i = Scalar$k;
const defaultTagPrefix = "tag:yaml.org,2002:";
function findTagObject(value, tagName, tags2) {
  if (tagName) {
    const match = tags2.filter((t) => t.tag === tagName);
    const tagObj = match.find((t) => !t.format) ?? match[0];
    if (!tagObj)
      throw new Error(`Tag ${tagName} not found`);
    return tagObj;
  }
  return tags2.find((t) => t.identify?.(value) && !t.format);
}
function createNode$4(value, tagName, ctx) {
  if (identity$p.isDocument(value))
    value = value.contents;
  if (identity$p.isNode(value))
    return value;
  if (identity$p.isPair(value)) {
    const map2 = ctx.schema[identity$p.MAP].createNode?.(ctx.schema, null, ctx);
    map2.items.push(value);
    return map2;
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
    value = value.valueOf();
  }
  const { aliasDuplicateObjects, onAnchor, onTagObj, schema: schema2, sourceObjects } = ctx;
  let ref = void 0;
  if (aliasDuplicateObjects && value && typeof value === "object") {
    ref = sourceObjects.get(value);
    if (ref) {
      ref.anchor ?? (ref.anchor = onAnchor(value));
      return new Alias$2.Alias(ref.anchor);
    } else {
      ref = { anchor: null, node: null };
      sourceObjects.set(value, ref);
    }
  }
  if (tagName?.startsWith("!!"))
    tagName = defaultTagPrefix + tagName.slice(2);
  let tagObj = findTagObject(value, tagName, schema2.tags);
  if (!tagObj) {
    if (value && typeof value.toJSON === "function") {
      value = value.toJSON();
    }
    if (!value || typeof value !== "object") {
      const node2 = new Scalar$i.Scalar(value);
      if (ref)
        ref.node = node2;
      return node2;
    }
    tagObj = value instanceof Map ? schema2[identity$p.MAP] : Symbol.iterator in Object(value) ? schema2[identity$p.SEQ] : schema2[identity$p.MAP];
  }
  if (onTagObj) {
    onTagObj(tagObj);
    delete ctx.onTagObj;
  }
  const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar$i.Scalar(value);
  if (tagName)
    node.tag = tagName;
  else if (!tagObj.default)
    node.tag = tagObj.tag;
  if (ref)
    ref.node = node;
  return node;
}
createNode$5.createNode = createNode$4;
var createNode$3 = createNode$5;
var identity$o = identity$x;
var Node = Node$3;
function collectionFromPath(schema2, path, value) {
  let v = value;
  for (let i = path.length - 1; i >= 0; --i) {
    const k = path[i];
    if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
      const a = [];
      a[k] = v;
      v = a;
    } else {
      v = /* @__PURE__ */ new Map([[k, v]]);
    }
  }
  return createNode$3.createNode(v, void 0, {
    aliasDuplicateObjects: false,
    keepUndefined: false,
    onAnchor: () => {
      throw new Error("This should not happen, please report a bug.");
    },
    schema: schema2,
    sourceObjects: /* @__PURE__ */ new Map()
  });
}
const isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
let Collection$3 = class Collection extends Node.NodeBase {
  constructor(type, schema2) {
    super(type);
    Object.defineProperty(this, "schema", {
      value: schema2,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  /**
   * Create a copy of this collection.
   *
   * @param schema - If defined, overwrites the original's schema
   */
  clone(schema2) {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (schema2)
      copy.schema = schema2;
    copy.items = copy.items.map((it) => identity$o.isNode(it) || identity$o.isPair(it) ? it.clone(schema2) : it);
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /**
   * Adds a value to the collection. For `!!map` and `!!omap` the value must
   * be a Pair instance or a `{ key, value }` object, which may not have a key
   * that already exists in the map.
   */
  addIn(path, value) {
    if (isEmptyPath(path))
      this.add(value);
    else {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (identity$o.isCollection(node))
        node.addIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
  /**
   * Removes a value from the collection.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.delete(key);
    const node = this.get(key, true);
    if (identity$o.isCollection(node))
      return node.deleteIn(rest);
    else
      throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    const [key, ...rest] = path;
    const node = this.get(key, true);
    if (rest.length === 0)
      return !keepScalar && identity$o.isScalar(node) ? node.value : node;
    else
      return identity$o.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
  }
  hasAllNullValues(allowScalar) {
    return this.items.every((node) => {
      if (!identity$o.isPair(node))
        return false;
      const n = node.value;
      return n == null || allowScalar && identity$o.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
    });
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   */
  hasIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.has(key);
    const node = this.get(key, true);
    return identity$o.isCollection(node) ? node.hasIn(rest) : false;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    const [key, ...rest] = path;
    if (rest.length === 0) {
      this.set(key, value);
    } else {
      const node = this.get(key, true);
      if (identity$o.isCollection(node))
        node.setIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
};
Collection$4.Collection = Collection$3;
Collection$4.collectionFromPath = collectionFromPath;
Collection$4.isEmptyPath = isEmptyPath;
var Pair$8 = {};
var stringifyPair$2 = {};
var stringify$7 = {};
var stringifyComment$5 = {};
const stringifyComment$4 = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
function indentComment(comment, indent) {
  if (/^\n+$/.test(comment))
    return comment.substring(1);
  return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
}
const lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
stringifyComment$5.indentComment = indentComment;
stringifyComment$5.lineComment = lineComment;
stringifyComment$5.stringifyComment = stringifyComment$4;
var stringifyString$5 = {};
var foldFlowLines$2 = {};
const FOLD_FLOW = "flow";
const FOLD_BLOCK = "block";
const FOLD_QUOTED = "quoted";
function foldFlowLines$1(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
  if (!lineWidth || lineWidth < 0)
    return text;
  if (lineWidth < minContentWidth)
    minContentWidth = 0;
  const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
  if (text.length <= endStep)
    return text;
  const folds = [];
  const escapedFolds = {};
  let end = lineWidth - indent.length;
  if (typeof indentAtStart === "number") {
    if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
      folds.push(0);
    else
      end = lineWidth - indentAtStart;
  }
  let split = void 0;
  let prev = void 0;
  let overflow = false;
  let i = -1;
  let escStart = -1;
  let escEnd = -1;
  if (mode === FOLD_BLOCK) {
    i = consumeMoreIndentedLines(text, i, indent.length);
    if (i !== -1)
      end = i + endStep;
  }
  for (let ch; ch = text[i += 1]; ) {
    if (mode === FOLD_QUOTED && ch === "\\") {
      escStart = i;
      switch (text[i + 1]) {
        case "x":
          i += 3;
          break;
        case "u":
          i += 5;
          break;
        case "U":
          i += 9;
          break;
        default:
          i += 1;
      }
      escEnd = i;
    }
    if (ch === "\n") {
      if (mode === FOLD_BLOCK)
        i = consumeMoreIndentedLines(text, i, indent.length);
      end = i + indent.length + endStep;
      split = void 0;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
        const next = text[i + 1];
        if (next && next !== " " && next !== "\n" && next !== "	")
          split = i;
      }
      if (i >= end) {
        if (split) {
          folds.push(split);
          end = split + endStep;
          split = void 0;
        } else if (mode === FOLD_QUOTED) {
          while (prev === " " || prev === "	") {
            prev = ch;
            ch = text[i += 1];
            overflow = true;
          }
          const j = i > escEnd + 1 ? i - 2 : escStart - 1;
          if (escapedFolds[j])
            return text;
          folds.push(j);
          escapedFolds[j] = true;
          end = j + endStep;
          split = void 0;
        } else {
          overflow = true;
        }
      }
    }
    prev = ch;
  }
  if (overflow && onOverflow)
    onOverflow();
  if (folds.length === 0)
    return text;
  if (onFold)
    onFold();
  let res = text.slice(0, folds[0]);
  for (let i2 = 0; i2 < folds.length; ++i2) {
    const fold = folds[i2];
    const end2 = folds[i2 + 1] || text.length;
    if (fold === 0)
      res = `
${indent}${text.slice(0, end2)}`;
    else {
      if (mode === FOLD_QUOTED && escapedFolds[fold])
        res += `${text[fold]}\\`;
      res += `
${indent}${text.slice(fold + 1, end2)}`;
    }
  }
  return res;
}
function consumeMoreIndentedLines(text, i, indent) {
  let end = i;
  let start = i + 1;
  let ch = text[start];
  while (ch === " " || ch === "	") {
    if (i < start + indent) {
      ch = text[++i];
    } else {
      do {
        ch = text[++i];
      } while (ch && ch !== "\n");
      end = i;
      start = i + 1;
      ch = text[start];
    }
  }
  return end;
}
foldFlowLines$2.FOLD_BLOCK = FOLD_BLOCK;
foldFlowLines$2.FOLD_FLOW = FOLD_FLOW;
foldFlowLines$2.FOLD_QUOTED = FOLD_QUOTED;
foldFlowLines$2.foldFlowLines = foldFlowLines$1;
var Scalar$h = Scalar$k;
var foldFlowLines = foldFlowLines$2;
const getFoldOptions = (ctx, isBlock2) => ({
  indentAtStart: isBlock2 ? ctx.indent.length : ctx.indentAtStart,
  lineWidth: ctx.options.lineWidth,
  minContentWidth: ctx.options.minContentWidth
});
const containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
function lineLengthOverLimit(str, lineWidth, indentLength) {
  if (!lineWidth || lineWidth < 0)
    return false;
  const limit = lineWidth - indentLength;
  const strLen = str.length;
  if (strLen <= limit)
    return false;
  for (let i = 0, start = 0; i < strLen; ++i) {
    if (str[i] === "\n") {
      if (i - start > limit)
        return true;
      start = i + 1;
      if (strLen - start <= limit)
        return false;
    }
  }
  return true;
}
function doubleQuotedString(value, ctx) {
  const json = JSON.stringify(value);
  if (ctx.options.doubleQuotedAsJSON)
    return json;
  const { implicitKey } = ctx;
  const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  let str = "";
  let start = 0;
  for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
    if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
      str += json.slice(start, i) + "\\ ";
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json[i + 1]) {
        case "u":
          {
            str += json.slice(start, i);
            const code = json.substr(i + 2, 4);
            switch (code) {
              case "0000":
                str += "\\0";
                break;
              case "0007":
                str += "\\a";
                break;
              case "000b":
                str += "\\v";
                break;
              case "001b":
                str += "\\e";
                break;
              case "0085":
                str += "\\N";
                break;
              case "00a0":
                str += "\\_";
                break;
              case "2028":
                str += "\\L";
                break;
              case "2029":
                str += "\\P";
                break;
              default:
                if (code.substr(0, 2) === "00")
                  str += "\\x" + code.substr(2);
                else
                  str += json.substr(i, 6);
            }
            i += 5;
            start = i + 1;
          }
          break;
        case "n":
          if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
            i += 1;
          } else {
            str += json.slice(start, i) + "\n\n";
            while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
              str += "\n";
              i += 2;
            }
            str += indent;
            if (json[i + 2] === " ")
              str += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str = start ? str + json.slice(start) : json;
  return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
}
function singleQuotedString(value, ctx) {
  if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
    return doubleQuotedString(value, ctx);
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
  return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
}
function quotedString(value, ctx) {
  const { singleQuote } = ctx.options;
  let qs;
  if (singleQuote === false)
    qs = doubleQuotedString;
  else {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && !hasSingle)
      qs = singleQuotedString;
    else if (hasSingle && !hasDouble)
      qs = doubleQuotedString;
    else
      qs = singleQuote ? singleQuotedString : doubleQuotedString;
  }
  return qs(value, ctx);
}
let blockEndNewlines;
try {
  blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
} catch {
  blockEndNewlines = /\n+(?!\n|$)/g;
}
function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
  const { blockQuote, commentString, lineWidth } = ctx.options;
  if (!blockQuote || /\n[\t ]+$/.test(value)) {
    return quotedString(value, ctx);
  }
  const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
  const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar$h.Scalar.BLOCK_FOLDED ? false : type === Scalar$h.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
  if (!value)
    return literal ? "|\n" : ">\n";
  let chomp;
  let endStart;
  for (endStart = value.length; endStart > 0; --endStart) {
    const ch = value[endStart - 1];
    if (ch !== "\n" && ch !== "	" && ch !== " ")
      break;
  }
  let end = value.substring(endStart);
  const endNlPos = end.indexOf("\n");
  if (endNlPos === -1) {
    chomp = "-";
  } else if (value === end || endNlPos !== end.length - 1) {
    chomp = "+";
    if (onChompKeep)
      onChompKeep();
  } else {
    chomp = "";
  }
  if (end) {
    value = value.slice(0, -end.length);
    if (end[end.length - 1] === "\n")
      end = end.slice(0, -1);
    end = end.replace(blockEndNewlines, `$&${indent}`);
  }
  let startWithSpace = false;
  let startEnd;
  let startNlPos = -1;
  for (startEnd = 0; startEnd < value.length; ++startEnd) {
    const ch = value[startEnd];
    if (ch === " ")
      startWithSpace = true;
    else if (ch === "\n")
      startNlPos = startEnd;
    else
      break;
  }
  let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
  if (start) {
    value = value.substring(start.length);
    start = start.replace(/\n+/g, `$&${indent}`);
  }
  const indentSize = indent ? "2" : "1";
  let header = (startWithSpace ? indentSize : "") + chomp;
  if (comment) {
    header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
    if (onComment)
      onComment();
  }
  if (!literal) {
    const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
    let literalFallback = false;
    const foldOptions = getFoldOptions(ctx, true);
    if (blockQuote !== "folded" && type !== Scalar$h.Scalar.BLOCK_FOLDED) {
      foldOptions.onOverflow = () => {
        literalFallback = true;
      };
    }
    const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
    if (!literalFallback)
      return `>${header}
${indent}${body}`;
  }
  value = value.replace(/\n+/g, `$&${indent}`);
  return `|${header}
${indent}${start}${value}${end}`;
}
function plainString(item, ctx, onComment, onChompKeep) {
  const { type, value } = item;
  const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
  if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
    return quotedString(value, ctx);
  }
  if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
    return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
  }
  if (!implicitKey && !inFlow && type !== Scalar$h.Scalar.PLAIN && value.includes("\n")) {
    return blockString(item, ctx, onComment, onChompKeep);
  }
  if (containsDocumentMarker(value)) {
    if (indent === "") {
      ctx.forceBlockIndent = true;
      return blockString(item, ctx, onComment, onChompKeep);
    } else if (implicitKey && indent === indentStep) {
      return quotedString(value, ctx);
    }
  }
  const str = value.replace(/\n+/g, `$&
${indent}`);
  if (actualString) {
    const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
    const { compat, tags: tags2 } = ctx.doc.schema;
    if (tags2.some(test) || compat?.some(test))
      return quotedString(value, ctx);
  }
  return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
}
function stringifyString$4(item, ctx, onComment, onChompKeep) {
  const { implicitKey, inFlow } = ctx;
  const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
  let { type } = item;
  if (type !== Scalar$h.Scalar.QUOTE_DOUBLE) {
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
      type = Scalar$h.Scalar.QUOTE_DOUBLE;
  }
  const _stringify = (_type) => {
    switch (_type) {
      case Scalar$h.Scalar.BLOCK_FOLDED:
      case Scalar$h.Scalar.BLOCK_LITERAL:
        return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
      case Scalar$h.Scalar.QUOTE_DOUBLE:
        return doubleQuotedString(ss.value, ctx);
      case Scalar$h.Scalar.QUOTE_SINGLE:
        return singleQuotedString(ss.value, ctx);
      case Scalar$h.Scalar.PLAIN:
        return plainString(ss, ctx, onComment, onChompKeep);
      default:
        return null;
    }
  };
  let res = _stringify(type);
  if (res === null) {
    const { defaultKeyType, defaultStringType } = ctx.options;
    const t = implicitKey && defaultKeyType || defaultStringType;
    res = _stringify(t);
    if (res === null)
      throw new Error(`Unsupported default string type ${t}`);
  }
  return res;
}
stringifyString$5.stringifyString = stringifyString$4;
var anchors$1 = anchors$3;
var identity$n = identity$x;
var stringifyComment$3 = stringifyComment$5;
var stringifyString$3 = stringifyString$5;
function createStringifyContext(doc, options) {
  const opt = Object.assign({
    blockQuote: true,
    commentString: stringifyComment$3.stringifyComment,
    defaultKeyType: null,
    defaultStringType: "PLAIN",
    directives: null,
    doubleQuotedAsJSON: false,
    doubleQuotedMinMultiLineLength: 40,
    falseStr: "false",
    flowCollectionPadding: true,
    indentSeq: true,
    lineWidth: 80,
    minContentWidth: 20,
    nullStr: "null",
    simpleKeys: false,
    singleQuote: null,
    trailingComma: false,
    trueStr: "true",
    verifyAliasOrder: true
  }, doc.schema.toStringOptions, options);
  let inFlow;
  switch (opt.collectionStyle) {
    case "block":
      inFlow = false;
      break;
    case "flow":
      inFlow = true;
      break;
    default:
      inFlow = null;
  }
  return {
    anchors: /* @__PURE__ */ new Set(),
    doc,
    flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
    indent: "",
    indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
    inFlow,
    options: opt
  };
}
function getTagObject(tags2, item) {
  if (item.tag) {
    const match = tags2.filter((t) => t.tag === item.tag);
    if (match.length > 0)
      return match.find((t) => t.format === item.format) ?? match[0];
  }
  let tagObj = void 0;
  let obj;
  if (identity$n.isScalar(item)) {
    obj = item.value;
    let match = tags2.filter((t) => t.identify?.(obj));
    if (match.length > 1) {
      const testMatch = match.filter((t) => t.test);
      if (testMatch.length > 0)
        match = testMatch;
    }
    tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
  } else {
    obj = item;
    tagObj = tags2.find((t) => t.nodeClass && obj instanceof t.nodeClass);
  }
  if (!tagObj) {
    const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
    throw new Error(`Tag not resolved for ${name} value`);
  }
  return tagObj;
}
function stringifyProps(node, tagObj, { anchors: anchors$1$1, doc }) {
  if (!doc.directives)
    return "";
  const props = [];
  const anchor = (identity$n.isScalar(node) || identity$n.isCollection(node)) && node.anchor;
  if (anchor && anchors$1.anchorIsValid(anchor)) {
    anchors$1$1.add(anchor);
    props.push(`&${anchor}`);
  }
  const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
  if (tag)
    props.push(doc.directives.tagString(tag));
  return props.join(" ");
}
function stringify$6(item, ctx, onComment, onChompKeep) {
  if (identity$n.isPair(item))
    return item.toString(ctx, onComment, onChompKeep);
  if (identity$n.isAlias(item)) {
    if (ctx.doc.directives)
      return item.toString(ctx);
    if (ctx.resolvedAliases?.has(item)) {
      throw new TypeError(`Cannot stringify circular structure without alias nodes`);
    } else {
      if (ctx.resolvedAliases)
        ctx.resolvedAliases.add(item);
      else
        ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
      item = item.resolve(ctx.doc);
    }
  }
  let tagObj = void 0;
  const node = identity$n.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
  tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
  const props = stringifyProps(node, tagObj, ctx);
  if (props.length > 0)
    ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
  const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity$n.isScalar(node) ? stringifyString$3.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
  if (!props)
    return str;
  return identity$n.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
}
stringify$7.createStringifyContext = createStringifyContext;
stringify$7.stringify = stringify$6;
var identity$m = identity$x;
var Scalar$g = Scalar$k;
var stringify$5 = stringify$7;
var stringifyComment$2 = stringifyComment$5;
function stringifyPair$1({ key, value }, ctx, onComment, onChompKeep) {
  const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
  let keyComment = identity$m.isNode(key) && key.comment || null;
  if (simpleKeys) {
    if (keyComment) {
      throw new Error("With simple keys, key nodes cannot have comments");
    }
    if (identity$m.isCollection(key) || !identity$m.isNode(key) && typeof key === "object") {
      const msg = "With simple keys, collection cannot be used as a key value";
      throw new Error(msg);
    }
  }
  let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity$m.isCollection(key) || (identity$m.isScalar(key) ? key.type === Scalar$g.Scalar.BLOCK_FOLDED || key.type === Scalar$g.Scalar.BLOCK_LITERAL : typeof key === "object"));
  ctx = Object.assign({}, ctx, {
    allNullValues: false,
    implicitKey: !explicitKey && (simpleKeys || !allNullValues),
    indent: indent + indentStep
  });
  let keyCommentDone = false;
  let chompKeep = false;
  let str = stringify$5.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
  if (!explicitKey && !ctx.inFlow && str.length > 1024) {
    if (simpleKeys)
      throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
    explicitKey = true;
  }
  if (ctx.inFlow) {
    if (allNullValues || value == null) {
      if (keyCommentDone && onComment)
        onComment();
      return str === "" ? "?" : explicitKey ? `? ${str}` : str;
    }
  } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
    str = `? ${str}`;
    if (keyComment && !keyCommentDone) {
      str += stringifyComment$2.lineComment(str, ctx.indent, commentString(keyComment));
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  if (keyCommentDone)
    keyComment = null;
  if (explicitKey) {
    if (keyComment)
      str += stringifyComment$2.lineComment(str, ctx.indent, commentString(keyComment));
    str = `? ${str}
${indent}:`;
  } else {
    str = `${str}:`;
    if (keyComment)
      str += stringifyComment$2.lineComment(str, ctx.indent, commentString(keyComment));
  }
  let vsb, vcb, valueComment;
  if (identity$m.isNode(value)) {
    vsb = !!value.spaceBefore;
    vcb = value.commentBefore;
    valueComment = value.comment;
  } else {
    vsb = false;
    vcb = null;
    valueComment = null;
    if (value && typeof value === "object")
      value = doc.createNode(value);
  }
  ctx.implicitKey = false;
  if (!explicitKey && !keyComment && identity$m.isScalar(value))
    ctx.indentAtStart = str.length + 1;
  chompKeep = false;
  if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity$m.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
    ctx.indent = ctx.indent.substring(2);
  }
  let valueCommentDone = false;
  const valueStr = stringify$5.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
  let ws = " ";
  if (keyComment || vsb || vcb) {
    ws = vsb ? "\n" : "";
    if (vcb) {
      const cs = commentString(vcb);
      ws += `
${stringifyComment$2.indentComment(cs, ctx.indent)}`;
    }
    if (valueStr === "" && !ctx.inFlow) {
      if (ws === "\n" && valueComment)
        ws = "\n\n";
    } else {
      ws += `
${ctx.indent}`;
    }
  } else if (!explicitKey && identity$m.isCollection(value)) {
    const vs0 = valueStr[0];
    const nl0 = valueStr.indexOf("\n");
    const hasNewline = nl0 !== -1;
    const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
    if (hasNewline || !flow) {
      let hasPropsLine = false;
      if (hasNewline && (vs0 === "&" || vs0 === "!")) {
        let sp0 = valueStr.indexOf(" ");
        if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
          sp0 = valueStr.indexOf(" ", sp0 + 1);
        }
        if (sp0 === -1 || nl0 < sp0)
          hasPropsLine = true;
      }
      if (!hasPropsLine)
        ws = `
${ctx.indent}`;
    }
  } else if (valueStr === "" || valueStr[0] === "\n") {
    ws = "";
  }
  str += ws + valueStr;
  if (ctx.inFlow) {
    if (valueCommentDone && onComment)
      onComment();
  } else if (valueComment && !valueCommentDone) {
    str += stringifyComment$2.lineComment(str, ctx.indent, commentString(valueComment));
  } else if (chompKeep && onChompKeep) {
    onChompKeep();
  }
  return str;
}
stringifyPair$2.stringifyPair = stringifyPair$1;
var addPairToJSMap$3 = {};
var log$2 = {};
var node_process$2 = require$$0;
function debug(logLevel, ...messages) {
  if (logLevel === "debug")
    console.log(...messages);
}
function warn(logLevel, warning) {
  if (logLevel === "debug" || logLevel === "warn") {
    if (typeof node_process$2.emitWarning === "function")
      node_process$2.emitWarning(warning);
    else
      console.warn(warning);
  }
}
log$2.debug = debug;
log$2.warn = warn;
var merge$4 = {};
var identity$l = identity$x;
var Scalar$f = Scalar$k;
const MERGE_KEY = "<<";
const merge$3 = {
  identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
  default: "key",
  tag: "tag:yaml.org,2002:merge",
  test: /^<<$/,
  resolve: () => Object.assign(new Scalar$f.Scalar(Symbol(MERGE_KEY)), {
    addToJSMap: addMergeToJSMap
  }),
  stringify: () => MERGE_KEY
};
const isMergeKey = (ctx, key) => (merge$3.identify(key) || identity$l.isScalar(key) && (!key.type || key.type === Scalar$f.Scalar.PLAIN) && merge$3.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge$3.tag && tag.default);
function addMergeToJSMap(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (identity$l.isSeq(source))
    for (const it of source.items)
      mergeValue(ctx, map2, it);
  else if (Array.isArray(source))
    for (const it of source)
      mergeValue(ctx, map2, it);
  else
    mergeValue(ctx, map2, source);
}
function mergeValue(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (!identity$l.isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  const srcMap = source.toJSON(null, ctx, Map);
  for (const [key, value2] of srcMap) {
    if (map2 instanceof Map) {
      if (!map2.has(key))
        map2.set(key, value2);
    } else if (map2 instanceof Set) {
      map2.add(key);
    } else if (!Object.prototype.hasOwnProperty.call(map2, key)) {
      Object.defineProperty(map2, key, {
        value: value2,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return map2;
}
function resolveAliasValue(ctx, value) {
  return ctx && identity$l.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
}
merge$4.addMergeToJSMap = addMergeToJSMap;
merge$4.isMergeKey = isMergeKey;
merge$4.merge = merge$3;
var log$1 = log$2;
var merge$2 = merge$4;
var stringify$4 = stringify$7;
var identity$k = identity$x;
var toJS$3 = toJS$8;
function addPairToJSMap$2(ctx, map2, { key, value }) {
  if (identity$k.isNode(key) && key.addToJSMap)
    key.addToJSMap(ctx, map2, value);
  else if (merge$2.isMergeKey(ctx, key))
    merge$2.addMergeToJSMap(ctx, map2, value);
  else {
    const jsKey = toJS$3.toJS(key, "", ctx);
    if (map2 instanceof Map) {
      map2.set(jsKey, toJS$3.toJS(value, jsKey, ctx));
    } else if (map2 instanceof Set) {
      map2.add(jsKey);
    } else {
      const stringKey = stringifyKey(key, jsKey, ctx);
      const jsValue = toJS$3.toJS(value, stringKey, ctx);
      if (stringKey in map2)
        Object.defineProperty(map2, stringKey, {
          value: jsValue,
          writable: true,
          enumerable: true,
          configurable: true
        });
      else
        map2[stringKey] = jsValue;
    }
  }
  return map2;
}
function stringifyKey(key, jsKey, ctx) {
  if (jsKey === null)
    return "";
  if (typeof jsKey !== "object")
    return String(jsKey);
  if (identity$k.isNode(key) && ctx?.doc) {
    const strCtx = stringify$4.createStringifyContext(ctx.doc, {});
    strCtx.anchors = /* @__PURE__ */ new Set();
    for (const node of ctx.anchors.keys())
      strCtx.anchors.add(node.anchor);
    strCtx.inFlow = true;
    strCtx.inStringifyKey = true;
    const strKey = key.toString(strCtx);
    if (!ctx.mapKeyWarned) {
      let jsonStr = JSON.stringify(strKey);
      if (jsonStr.length > 40)
        jsonStr = jsonStr.substring(0, 36) + '..."';
      log$1.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
      ctx.mapKeyWarned = true;
    }
    return strKey;
  }
  return JSON.stringify(jsKey);
}
addPairToJSMap$3.addPairToJSMap = addPairToJSMap$2;
var createNode$2 = createNode$5;
var stringifyPair = stringifyPair$2;
var addPairToJSMap$1 = addPairToJSMap$3;
var identity$j = identity$x;
function createPair(key, value, ctx) {
  const k = createNode$2.createNode(key, void 0, ctx);
  const v = createNode$2.createNode(value, void 0, ctx);
  return new Pair$7(k, v);
}
let Pair$7 = class Pair {
  constructor(key, value = null) {
    Object.defineProperty(this, identity$j.NODE_TYPE, { value: identity$j.PAIR });
    this.key = key;
    this.value = value;
  }
  clone(schema2) {
    let { key, value } = this;
    if (identity$j.isNode(key))
      key = key.clone(schema2);
    if (identity$j.isNode(value))
      value = value.clone(schema2);
    return new Pair(key, value);
  }
  toJSON(_, ctx) {
    const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    return addPairToJSMap$1.addPairToJSMap(ctx, pair, this);
  }
  toString(ctx, onComment, onChompKeep) {
    return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
  }
};
Pair$8.Pair = Pair$7;
Pair$8.createPair = createPair;
var Schema$2 = {};
var map$6 = {};
var YAMLMap$8 = {};
var stringifyCollection$3 = {};
var identity$i = identity$x;
var stringify$3 = stringify$7;
var stringifyComment$1 = stringifyComment$5;
function stringifyCollection$2(collection, ctx, options) {
  const flow = ctx.inFlow ?? collection.flow;
  const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
  return stringify2(collection, ctx, options);
}
function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
  const { indent, options: { commentString } } = ctx;
  const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
  let chompKeep = false;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment2 = null;
    if (identity$i.isNode(item)) {
      if (!chompKeep && item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
      if (item.comment)
        comment2 = item.comment;
    } else if (identity$i.isPair(item)) {
      const ik = identity$i.isNode(item.key) ? item.key : null;
      if (ik) {
        if (!chompKeep && ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
      }
    }
    chompKeep = false;
    let str2 = stringify$3.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
    if (comment2)
      str2 += stringifyComment$1.lineComment(str2, itemIndent, commentString(comment2));
    if (chompKeep && comment2)
      chompKeep = false;
    lines.push(blockItemPrefix + str2);
  }
  let str;
  if (lines.length === 0) {
    str = flowChars.start + flowChars.end;
  } else {
    str = lines[0];
    for (let i = 1; i < lines.length; ++i) {
      const line = lines[i];
      str += line ? `
${indent}${line}` : "\n";
    }
  }
  if (comment) {
    str += "\n" + stringifyComment$1.indentComment(commentString(comment), indent);
    if (onComment)
      onComment();
  } else if (chompKeep && onChompKeep)
    onChompKeep();
  return str;
}
function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
  const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
  itemIndent += indentStep;
  const itemCtx = Object.assign({}, ctx, {
    indent: itemIndent,
    inFlow: true,
    type: null
  });
  let reqNewline = false;
  let linesAtValue = 0;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment = null;
    if (identity$i.isNode(item)) {
      if (item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, false);
      if (item.comment)
        comment = item.comment;
    } else if (identity$i.isPair(item)) {
      const ik = identity$i.isNode(item.key) ? item.key : null;
      if (ik) {
        if (ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, false);
        if (ik.comment)
          reqNewline = true;
      }
      const iv = identity$i.isNode(item.value) ? item.value : null;
      if (iv) {
        if (iv.comment)
          comment = iv.comment;
        if (iv.commentBefore)
          reqNewline = true;
      } else if (item.value == null && ik?.comment) {
        comment = ik.comment;
      }
    }
    if (comment)
      reqNewline = true;
    let str = stringify$3.stringify(item, itemCtx, () => comment = null);
    reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
    if (i < items.length - 1) {
      str += ",";
    } else if (ctx.options.trailingComma) {
      if (ctx.options.lineWidth > 0) {
        reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
      }
      if (reqNewline) {
        str += ",";
      }
    }
    if (comment)
      str += stringifyComment$1.lineComment(str, itemIndent, commentString(comment));
    lines.push(str);
    linesAtValue = lines.length;
  }
  const { start, end } = flowChars;
  if (lines.length === 0) {
    return start + end;
  } else {
    if (!reqNewline) {
      const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
      reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
    }
    if (reqNewline) {
      let str = start;
      for (const line of lines)
        str += line ? `
${indentStep}${indent}${line}` : "\n";
      return `${str}
${indent}${end}`;
    } else {
      return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
    }
  }
}
function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
  if (comment && chompKeep)
    comment = comment.replace(/^\n+/, "");
  if (comment) {
    const ic = stringifyComment$1.indentComment(commentString(comment), indent);
    lines.push(ic.trimStart());
  }
}
stringifyCollection$3.stringifyCollection = stringifyCollection$2;
var stringifyCollection$1 = stringifyCollection$3;
var addPairToJSMap = addPairToJSMap$3;
var Collection$2 = Collection$4;
var identity$h = identity$x;
var Pair$6 = Pair$8;
var Scalar$e = Scalar$k;
function findPair(items, key) {
  const k = identity$h.isScalar(key) ? key.value : key;
  for (const it of items) {
    if (identity$h.isPair(it)) {
      if (it.key === key || it.key === k)
        return it;
      if (identity$h.isScalar(it.key) && it.key.value === k)
        return it;
    }
  }
  return void 0;
}
let YAMLMap$7 = class YAMLMap extends Collection$2.Collection {
  static get tagName() {
    return "tag:yaml.org,2002:map";
  }
  constructor(schema2) {
    super(identity$h.MAP, schema2);
    this.items = [];
  }
  /**
   * A generic collection parsing method that can be extended
   * to other node classes that inherit from YAMLMap
   */
  static from(schema2, obj, ctx) {
    const { keepUndefined, replacer } = ctx;
    const map2 = new this(schema2);
    const add = (key, value) => {
      if (typeof replacer === "function")
        value = replacer.call(obj, key, value);
      else if (Array.isArray(replacer) && !replacer.includes(key))
        return;
      if (value !== void 0 || keepUndefined)
        map2.items.push(Pair$6.createPair(key, value, ctx));
    };
    if (obj instanceof Map) {
      for (const [key, value] of obj)
        add(key, value);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj))
        add(key, obj[key]);
    }
    if (typeof schema2.sortMapEntries === "function") {
      map2.items.sort(schema2.sortMapEntries);
    }
    return map2;
  }
  /**
   * Adds a value to the collection.
   *
   * @param overwrite - If not set `true`, using a key that is already in the
   *   collection will throw. Otherwise, overwrites the previous value.
   */
  add(pair, overwrite) {
    let _pair;
    if (identity$h.isPair(pair))
      _pair = pair;
    else if (!pair || typeof pair !== "object" || !("key" in pair)) {
      _pair = new Pair$6.Pair(pair, pair?.value);
    } else
      _pair = new Pair$6.Pair(pair.key, pair.value);
    const prev = findPair(this.items, _pair.key);
    const sortEntries = this.schema?.sortMapEntries;
    if (prev) {
      if (!overwrite)
        throw new Error(`Key ${_pair.key} already set`);
      if (identity$h.isScalar(prev.value) && Scalar$e.isScalarValue(_pair.value))
        prev.value.value = _pair.value;
      else
        prev.value = _pair.value;
    } else if (sortEntries) {
      const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
      if (i === -1)
        this.items.push(_pair);
      else
        this.items.splice(i, 0, _pair);
    } else {
      this.items.push(_pair);
    }
  }
  delete(key) {
    const it = findPair(this.items, key);
    if (!it)
      return false;
    const del = this.items.splice(this.items.indexOf(it), 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const it = findPair(this.items, key);
    const node = it?.value;
    return (!keepScalar && identity$h.isScalar(node) ? node.value : node) ?? void 0;
  }
  has(key) {
    return !!findPair(this.items, key);
  }
  set(key, value) {
    this.add(new Pair$6.Pair(key, value), true);
  }
  /**
   * @param ctx - Conversion context, originally set in Document#toJS()
   * @param {Class} Type - If set, forces the returned collection type
   * @returns Instance of Type, Map, or Object
   */
  toJSON(_, ctx, Type) {
    const map2 = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const item of this.items)
      addPairToJSMap.addPairToJSMap(ctx, map2, item);
    return map2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    for (const item of this.items) {
      if (!identity$h.isPair(item))
        throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
    }
    if (!ctx.allNullValues && this.hasAllNullValues(false))
      ctx = Object.assign({}, ctx, { allNullValues: true });
    return stringifyCollection$1.stringifyCollection(this, ctx, {
      blockItemPrefix: "",
      flowChars: { start: "{", end: "}" },
      itemIndent: ctx.indent || "",
      onChompKeep,
      onComment
    });
  }
};
YAMLMap$8.YAMLMap = YAMLMap$7;
YAMLMap$8.findPair = findPair;
var identity$g = identity$x;
var YAMLMap$6 = YAMLMap$8;
const map$5 = {
  collection: "map",
  default: true,
  nodeClass: YAMLMap$6.YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map2, onError) {
    if (!identity$g.isMap(map2))
      onError("Expected a mapping for this tag");
    return map2;
  },
  createNode: (schema2, obj, ctx) => YAMLMap$6.YAMLMap.from(schema2, obj, ctx)
};
map$6.map = map$5;
var seq$6 = {};
var YAMLSeq$7 = {};
var createNode$1 = createNode$5;
var stringifyCollection = stringifyCollection$3;
var Collection$1 = Collection$4;
var identity$f = identity$x;
var Scalar$d = Scalar$k;
var toJS$2 = toJS$8;
let YAMLSeq$6 = class YAMLSeq extends Collection$1.Collection {
  static get tagName() {
    return "tag:yaml.org,2002:seq";
  }
  constructor(schema2) {
    super(identity$f.SEQ, schema2);
    this.items = [];
  }
  add(value) {
    this.items.push(value);
  }
  /**
   * Removes a value from the collection.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   *
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return false;
    const del = this.items.splice(idx, 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return void 0;
    const it = this.items[idx];
    return !keepScalar && identity$f.isScalar(it) ? it.value : it;
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   */
  has(key) {
    const idx = asItemIndex(key);
    return typeof idx === "number" && idx < this.items.length;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   *
   * If `key` does not contain a representation of an integer, this will throw.
   * It may be wrapped in a `Scalar`.
   */
  set(key, value) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      throw new Error(`Expected a valid index, not ${key}.`);
    const prev = this.items[idx];
    if (identity$f.isScalar(prev) && Scalar$d.isScalarValue(value))
      prev.value = value;
    else
      this.items[idx] = value;
  }
  toJSON(_, ctx) {
    const seq2 = [];
    if (ctx?.onCreate)
      ctx.onCreate(seq2);
    let i = 0;
    for (const item of this.items)
      seq2.push(toJS$2.toJS(item, String(i++), ctx));
    return seq2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    return stringifyCollection.stringifyCollection(this, ctx, {
      blockItemPrefix: "- ",
      flowChars: { start: "[", end: "]" },
      itemIndent: (ctx.indent || "") + "  ",
      onChompKeep,
      onComment
    });
  }
  static from(schema2, obj, ctx) {
    const { replacer } = ctx;
    const seq2 = new this(schema2);
    if (obj && Symbol.iterator in Object(obj)) {
      let i = 0;
      for (let it of obj) {
        if (typeof replacer === "function") {
          const key = obj instanceof Set ? it : String(i++);
          it = replacer.call(obj, key, it);
        }
        seq2.items.push(createNode$1.createNode(it, void 0, ctx));
      }
    }
    return seq2;
  }
};
function asItemIndex(key) {
  let idx = identity$f.isScalar(key) ? key.value : key;
  if (idx && typeof idx === "string")
    idx = Number(idx);
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}
YAMLSeq$7.YAMLSeq = YAMLSeq$6;
var identity$e = identity$x;
var YAMLSeq$5 = YAMLSeq$7;
const seq$5 = {
  collection: "seq",
  default: true,
  nodeClass: YAMLSeq$5.YAMLSeq,
  tag: "tag:yaml.org,2002:seq",
  resolve(seq2, onError) {
    if (!identity$e.isSeq(seq2))
      onError("Expected a sequence for this tag");
    return seq2;
  },
  createNode: (schema2, obj, ctx) => YAMLSeq$5.YAMLSeq.from(schema2, obj, ctx)
};
seq$6.seq = seq$5;
var string$5 = {};
var stringifyString$2 = stringifyString$5;
const string$4 = {
  identify: (value) => typeof value === "string",
  default: true,
  tag: "tag:yaml.org,2002:str",
  resolve: (str) => str,
  stringify(item, ctx, onComment, onChompKeep) {
    ctx = Object.assign({ actualString: true }, ctx);
    return stringifyString$2.stringifyString(item, ctx, onComment, onChompKeep);
  }
};
string$5.string = string$4;
var tags$1 = {};
var _null$3 = {};
var Scalar$c = Scalar$k;
const nullTag = {
  identify: (value) => value == null,
  createNode: () => new Scalar$c.Scalar(null),
  default: true,
  tag: "tag:yaml.org,2002:null",
  test: /^(?:~|[Nn]ull|NULL)?$/,
  resolve: () => new Scalar$c.Scalar(null),
  stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
};
_null$3.nullTag = nullTag;
var bool$4 = {};
var Scalar$b = Scalar$k;
const boolTag = {
  identify: (value) => typeof value === "boolean",
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  resolve: (str) => new Scalar$b.Scalar(str[0] === "t" || str[0] === "T"),
  stringify({ source, value }, ctx) {
    if (source && boolTag.test.test(source)) {
      const sv = source[0] === "t" || source[0] === "T";
      if (value === sv)
        return source;
    }
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
};
bool$4.boolTag = boolTag;
var float$6 = {};
var stringifyNumber$6 = {};
function stringifyNumber$5({ format, minFractionDigits, tag, value }) {
  if (typeof value === "bigint")
    return String(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num))
    return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
  let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
  if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
    let i = n.indexOf(".");
    if (i < 0) {
      i = n.length;
      n += ".";
    }
    let d = minFractionDigits - (n.length - i - 1);
    while (d-- > 0)
      n += "0";
  }
  return n;
}
stringifyNumber$6.stringifyNumber = stringifyNumber$5;
var Scalar$a = Scalar$k;
var stringifyNumber$4 = stringifyNumber$6;
const floatNaN$1 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber$4.stringifyNumber
};
const floatExp$1 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber$4.stringifyNumber(node);
  }
};
const float$5 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
  resolve(str) {
    const node = new Scalar$a.Scalar(parseFloat(str));
    const dot = str.indexOf(".");
    if (dot !== -1 && str[str.length - 1] === "0")
      node.minFractionDigits = str.length - dot - 1;
    return node;
  },
  stringify: stringifyNumber$4.stringifyNumber
};
float$6.float = float$5;
float$6.floatExp = floatExp$1;
float$6.floatNaN = floatNaN$1;
var int$6 = {};
var stringifyNumber$3 = stringifyNumber$6;
const intIdentify$2 = (value) => typeof value === "bigint" || Number.isInteger(value);
const intResolve$1 = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
function intStringify$1(node, radix, prefix) {
  const { value } = node;
  if (intIdentify$2(value) && value >= 0)
    return prefix + value.toString(radix);
  return stringifyNumber$3.stringifyNumber(node);
}
const intOct$1 = {
  identify: (value) => intIdentify$2(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^0o[0-7]+$/,
  resolve: (str, _onError, opt) => intResolve$1(str, 2, 8, opt),
  stringify: (node) => intStringify$1(node, 8, "0o")
};
const int$5 = {
  identify: intIdentify$2,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9]+$/,
  resolve: (str, _onError, opt) => intResolve$1(str, 0, 10, opt),
  stringify: stringifyNumber$3.stringifyNumber
};
const intHex$1 = {
  identify: (value) => intIdentify$2(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^0x[0-9a-fA-F]+$/,
  resolve: (str, _onError, opt) => intResolve$1(str, 2, 16, opt),
  stringify: (node) => intStringify$1(node, 16, "0x")
};
int$6.int = int$5;
int$6.intHex = intHex$1;
int$6.intOct = intOct$1;
var schema$8 = {};
var map$4 = map$6;
var _null$2 = _null$3;
var seq$4 = seq$6;
var string$3 = string$5;
var bool$3 = bool$4;
var float$4 = float$6;
var int$4 = int$6;
const schema$7 = [
  map$4.map,
  seq$4.seq,
  string$3.string,
  _null$2.nullTag,
  bool$3.boolTag,
  int$4.intOct,
  int$4.int,
  int$4.intHex,
  float$4.floatNaN,
  float$4.floatExp,
  float$4.float
];
schema$8.schema = schema$7;
var schema$6 = {};
var Scalar$9 = Scalar$k;
var map$3 = map$6;
var seq$3 = seq$6;
function intIdentify$1(value) {
  return typeof value === "bigint" || Number.isInteger(value);
}
const stringifyJSON = ({ value }) => JSON.stringify(value);
const jsonScalars = [
  {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify: stringifyJSON
  },
  {
    identify: (value) => value == null,
    createNode: () => new Scalar$9.Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^null$/,
    resolve: () => null,
    stringify: stringifyJSON
  },
  {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^true$|^false$/,
    resolve: (str) => str === "true",
    stringify: stringifyJSON
  },
  {
    identify: intIdentify$1,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^-?(?:0|[1-9][0-9]*)$/,
    resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
    stringify: ({ value }) => intIdentify$1(value) ? value.toString() : JSON.stringify(value)
  },
  {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
    resolve: (str) => parseFloat(str),
    stringify: stringifyJSON
  }
];
const jsonError = {
  default: true,
  tag: "",
  test: /^/,
  resolve(str, onError) {
    onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
    return str;
  }
};
const schema$5 = [map$3.map, seq$3.seq].concat(jsonScalars, jsonError);
schema$6.schema = schema$5;
var binary$3 = {};
var node_buffer = require$$0$1;
var Scalar$8 = Scalar$k;
var stringifyString$1 = stringifyString$5;
const binary$2 = {
  identify: (value) => value instanceof Uint8Array,
  // Buffer inherits from Uint8Array
  default: false,
  tag: "tag:yaml.org,2002:binary",
  /**
   * Returns a Buffer in node and an Uint8Array in browsers
   *
   * To use the resulting buffer as an image, you'll want to do something like:
   *
   *   const blob = new Blob([buffer], { type: 'image/jpeg' })
   *   document.querySelector('#photo').src = URL.createObjectURL(blob)
   */
  resolve(src, onError) {
    if (typeof node_buffer.Buffer === "function") {
      return node_buffer.Buffer.from(src, "base64");
    } else if (typeof atob === "function") {
      const str = atob(src.replace(/[\n\r]/g, ""));
      const buffer = new Uint8Array(str.length);
      for (let i = 0; i < str.length; ++i)
        buffer[i] = str.charCodeAt(i);
      return buffer;
    } else {
      onError("This environment does not support reading binary tags; either Buffer or atob is required");
      return src;
    }
  },
  stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
    if (!value)
      return "";
    const buf = value;
    let str;
    if (typeof node_buffer.Buffer === "function") {
      str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
    } else if (typeof btoa === "function") {
      let s = "";
      for (let i = 0; i < buf.length; ++i)
        s += String.fromCharCode(buf[i]);
      str = btoa(s);
    } else {
      throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
    }
    type ?? (type = Scalar$8.Scalar.BLOCK_LITERAL);
    if (type !== Scalar$8.Scalar.QUOTE_DOUBLE) {
      const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
      const n = Math.ceil(str.length / lineWidth);
      const lines = new Array(n);
      for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
        lines[i] = str.substr(o, lineWidth);
      }
      str = lines.join(type === Scalar$8.Scalar.BLOCK_LITERAL ? "\n" : " ");
    }
    return stringifyString$1.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
  }
};
binary$3.binary = binary$2;
var omap$3 = {};
var pairs$4 = {};
var identity$d = identity$x;
var Pair$5 = Pair$8;
var Scalar$7 = Scalar$k;
var YAMLSeq$4 = YAMLSeq$7;
function resolvePairs(seq2, onError) {
  if (identity$d.isSeq(seq2)) {
    for (let i = 0; i < seq2.items.length; ++i) {
      let item = seq2.items[i];
      if (identity$d.isPair(item))
        continue;
      else if (identity$d.isMap(item)) {
        if (item.items.length > 1)
          onError("Each pair must have its own sequence indicator");
        const pair = item.items[0] || new Pair$5.Pair(new Scalar$7.Scalar(null));
        if (item.commentBefore)
          pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
        if (item.comment) {
          const cn = pair.value ?? pair.key;
          cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
        }
        item = pair;
      }
      seq2.items[i] = identity$d.isPair(item) ? item : new Pair$5.Pair(item);
    }
  } else
    onError("Expected a sequence for this tag");
  return seq2;
}
function createPairs(schema2, iterable, ctx) {
  const { replacer } = ctx;
  const pairs2 = new YAMLSeq$4.YAMLSeq(schema2);
  pairs2.tag = "tag:yaml.org,2002:pairs";
  let i = 0;
  if (iterable && Symbol.iterator in Object(iterable))
    for (let it of iterable) {
      if (typeof replacer === "function")
        it = replacer.call(iterable, String(i++), it);
      let key, value;
      if (Array.isArray(it)) {
        if (it.length === 2) {
          key = it[0];
          value = it[1];
        } else
          throw new TypeError(`Expected [key, value] tuple: ${it}`);
      } else if (it && it instanceof Object) {
        const keys = Object.keys(it);
        if (keys.length === 1) {
          key = keys[0];
          value = it[key];
        } else {
          throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
        }
      } else {
        key = it;
      }
      pairs2.items.push(Pair$5.createPair(key, value, ctx));
    }
  return pairs2;
}
const pairs$3 = {
  collection: "seq",
  default: false,
  tag: "tag:yaml.org,2002:pairs",
  resolve: resolvePairs,
  createNode: createPairs
};
pairs$4.createPairs = createPairs;
pairs$4.pairs = pairs$3;
pairs$4.resolvePairs = resolvePairs;
var identity$c = identity$x;
var toJS$1 = toJS$8;
var YAMLMap$5 = YAMLMap$8;
var YAMLSeq$3 = YAMLSeq$7;
var pairs$2 = pairs$4;
class YAMLOMap extends YAMLSeq$3.YAMLSeq {
  constructor() {
    super();
    this.add = YAMLMap$5.YAMLMap.prototype.add.bind(this);
    this.delete = YAMLMap$5.YAMLMap.prototype.delete.bind(this);
    this.get = YAMLMap$5.YAMLMap.prototype.get.bind(this);
    this.has = YAMLMap$5.YAMLMap.prototype.has.bind(this);
    this.set = YAMLMap$5.YAMLMap.prototype.set.bind(this);
    this.tag = YAMLOMap.tag;
  }
  /**
   * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
   * but TypeScript won't allow widening the signature of a child method.
   */
  toJSON(_, ctx) {
    if (!ctx)
      return super.toJSON(_);
    const map2 = /* @__PURE__ */ new Map();
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const pair of this.items) {
      let key, value;
      if (identity$c.isPair(pair)) {
        key = toJS$1.toJS(pair.key, "", ctx);
        value = toJS$1.toJS(pair.value, key, ctx);
      } else {
        key = toJS$1.toJS(pair, "", ctx);
      }
      if (map2.has(key))
        throw new Error("Ordered maps must not include duplicate keys");
      map2.set(key, value);
    }
    return map2;
  }
  static from(schema2, iterable, ctx) {
    const pairs$12 = pairs$2.createPairs(schema2, iterable, ctx);
    const omap2 = new this();
    omap2.items = pairs$12.items;
    return omap2;
  }
}
YAMLOMap.tag = "tag:yaml.org,2002:omap";
const omap$2 = {
  collection: "seq",
  identify: (value) => value instanceof Map,
  nodeClass: YAMLOMap,
  default: false,
  tag: "tag:yaml.org,2002:omap",
  resolve(seq2, onError) {
    const pairs$12 = pairs$2.resolvePairs(seq2, onError);
    const seenKeys = [];
    for (const { key } of pairs$12.items) {
      if (identity$c.isScalar(key)) {
        if (seenKeys.includes(key.value)) {
          onError(`Ordered maps must not include duplicate keys: ${key.value}`);
        } else {
          seenKeys.push(key.value);
        }
      }
    }
    return Object.assign(new YAMLOMap(), pairs$12);
  },
  createNode: (schema2, iterable, ctx) => YAMLOMap.from(schema2, iterable, ctx)
};
omap$3.YAMLOMap = YAMLOMap;
omap$3.omap = omap$2;
var schema$4 = {};
var bool$2 = {};
var Scalar$6 = Scalar$k;
function boolStringify({ value, source }, ctx) {
  const boolObj = value ? trueTag : falseTag;
  if (source && boolObj.test.test(source))
    return source;
  return value ? ctx.options.trueStr : ctx.options.falseStr;
}
const trueTag = {
  identify: (value) => value === true,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: () => new Scalar$6.Scalar(true),
  stringify: boolStringify
};
const falseTag = {
  identify: (value) => value === false,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: () => new Scalar$6.Scalar(false),
  stringify: boolStringify
};
bool$2.falseTag = falseTag;
bool$2.trueTag = trueTag;
var float$3 = {};
var Scalar$5 = Scalar$k;
var stringifyNumber$2 = stringifyNumber$6;
const floatNaN = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber$2.stringifyNumber
};
const floatExp = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str.replace(/_/g, "")),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber$2.stringifyNumber(node);
  }
};
const float$2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
  resolve(str) {
    const node = new Scalar$5.Scalar(parseFloat(str.replace(/_/g, "")));
    const dot = str.indexOf(".");
    if (dot !== -1) {
      const f = str.substring(dot + 1).replace(/_/g, "");
      if (f[f.length - 1] === "0")
        node.minFractionDigits = f.length;
    }
    return node;
  },
  stringify: stringifyNumber$2.stringifyNumber
};
float$3.float = float$2;
float$3.floatExp = floatExp;
float$3.floatNaN = floatNaN;
var int$3 = {};
var stringifyNumber$1 = stringifyNumber$6;
const intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
function intResolve(str, offset, radix, { intAsBigInt }) {
  const sign = str[0];
  if (sign === "-" || sign === "+")
    offset += 1;
  str = str.substring(offset).replace(/_/g, "");
  if (intAsBigInt) {
    switch (radix) {
      case 2:
        str = `0b${str}`;
        break;
      case 8:
        str = `0o${str}`;
        break;
      case 16:
        str = `0x${str}`;
        break;
    }
    const n2 = BigInt(str);
    return sign === "-" ? BigInt(-1) * n2 : n2;
  }
  const n = parseInt(str, radix);
  return sign === "-" ? -1 * n : n;
}
function intStringify(node, radix, prefix) {
  const { value } = node;
  if (intIdentify(value)) {
    const str = value.toString(radix);
    return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
  }
  return stringifyNumber$1.stringifyNumber(node);
}
const intBin = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "BIN",
  test: /^[-+]?0b[0-1_]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
  stringify: (node) => intStringify(node, 2, "0b")
};
const intOct = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^[-+]?0[0-7_]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
  stringify: (node) => intStringify(node, 8, "0")
};
const int$2 = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9][0-9_]*$/,
  resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
  stringify: stringifyNumber$1.stringifyNumber
};
const intHex = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^[-+]?0x[0-9a-fA-F_]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
  stringify: (node) => intStringify(node, 16, "0x")
};
int$3.int = int$2;
int$3.intBin = intBin;
int$3.intHex = intHex;
int$3.intOct = intOct;
var set$3 = {};
var identity$b = identity$x;
var Pair$4 = Pair$8;
var YAMLMap$4 = YAMLMap$8;
class YAMLSet extends YAMLMap$4.YAMLMap {
  constructor(schema2) {
    super(schema2);
    this.tag = YAMLSet.tag;
  }
  add(key) {
    let pair;
    if (identity$b.isPair(key))
      pair = key;
    else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
      pair = new Pair$4.Pair(key.key, null);
    else
      pair = new Pair$4.Pair(key, null);
    const prev = YAMLMap$4.findPair(this.items, pair.key);
    if (!prev)
      this.items.push(pair);
  }
  /**
   * If `keepPair` is `true`, returns the Pair matching `key`.
   * Otherwise, returns the value of that Pair's key.
   */
  get(key, keepPair) {
    const pair = YAMLMap$4.findPair(this.items, key);
    return !keepPair && identity$b.isPair(pair) ? identity$b.isScalar(pair.key) ? pair.key.value : pair.key : pair;
  }
  set(key, value) {
    if (typeof value !== "boolean")
      throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
    const prev = YAMLMap$4.findPair(this.items, key);
    if (prev && !value) {
      this.items.splice(this.items.indexOf(prev), 1);
    } else if (!prev && value) {
      this.items.push(new Pair$4.Pair(key));
    }
  }
  toJSON(_, ctx) {
    return super.toJSON(_, ctx, Set);
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    if (this.hasAllNullValues(true))
      return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
    else
      throw new Error("Set items must all have null values");
  }
  static from(schema2, iterable, ctx) {
    const { replacer } = ctx;
    const set2 = new this(schema2);
    if (iterable && Symbol.iterator in Object(iterable))
      for (let value of iterable) {
        if (typeof replacer === "function")
          value = replacer.call(iterable, value, value);
        set2.items.push(Pair$4.createPair(value, null, ctx));
      }
    return set2;
  }
}
YAMLSet.tag = "tag:yaml.org,2002:set";
const set$2 = {
  collection: "map",
  identify: (value) => value instanceof Set,
  nodeClass: YAMLSet,
  default: false,
  tag: "tag:yaml.org,2002:set",
  createNode: (schema2, iterable, ctx) => YAMLSet.from(schema2, iterable, ctx),
  resolve(map2, onError) {
    if (identity$b.isMap(map2)) {
      if (map2.hasAllNullValues(true))
        return Object.assign(new YAMLSet(), map2);
      else
        onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map2;
  }
};
set$3.YAMLSet = YAMLSet;
set$3.set = set$2;
var timestamp$3 = {};
var stringifyNumber = stringifyNumber$6;
function parseSexagesimal(str, asBigInt) {
  const sign = str[0];
  const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
  const num = (n) => asBigInt ? BigInt(n) : Number(n);
  const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
  return sign === "-" ? num(-1) * res : res;
}
function stringifySexagesimal(node) {
  let { value } = node;
  let num = (n) => n;
  if (typeof value === "bigint")
    num = (n) => BigInt(n);
  else if (isNaN(value) || !isFinite(value))
    return stringifyNumber.stringifyNumber(node);
  let sign = "";
  if (value < 0) {
    sign = "-";
    value *= num(-1);
  }
  const _60 = num(60);
  const parts = [value % _60];
  if (value < 60) {
    parts.unshift(0);
  } else {
    value = (value - parts[0]) / _60;
    parts.unshift(value % _60);
    if (value >= 60) {
      value = (value - parts[0]) / _60;
      parts.unshift(value);
    }
  }
  return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
}
const intTime = {
  identify: (value) => typeof value === "bigint" || Number.isInteger(value),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
  resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
  stringify: stringifySexagesimal
};
const floatTime = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
  resolve: (str) => parseSexagesimal(str, false),
  stringify: stringifySexagesimal
};
const timestamp$2 = {
  identify: (value) => value instanceof Date,
  default: true,
  tag: "tag:yaml.org,2002:timestamp",
  // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
  // may be omitted altogether, resulting in a date format. In such a case, the time part is
  // assumed to be 00:00:00Z (start of day, UTC).
  test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
  resolve(str) {
    const match = str.match(timestamp$2.test);
    if (!match)
      throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
    let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
    const tz = match[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, false);
      if (Math.abs(d) < 30)
        d *= 60;
      date -= 6e4 * d;
    }
    return new Date(date);
  },
  stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
};
timestamp$3.floatTime = floatTime;
timestamp$3.intTime = intTime;
timestamp$3.timestamp = timestamp$2;
var map$2 = map$6;
var _null$1 = _null$3;
var seq$2 = seq$6;
var string$2 = string$5;
var binary$1 = binary$3;
var bool$1 = bool$2;
var float$1 = float$3;
var int$1 = int$3;
var merge$1 = merge$4;
var omap$1 = omap$3;
var pairs$1 = pairs$4;
var set$1 = set$3;
var timestamp$1 = timestamp$3;
const schema$3 = [
  map$2.map,
  seq$2.seq,
  string$2.string,
  _null$1.nullTag,
  bool$1.trueTag,
  bool$1.falseTag,
  int$1.intBin,
  int$1.intOct,
  int$1.int,
  int$1.intHex,
  float$1.floatNaN,
  float$1.floatExp,
  float$1.float,
  binary$1.binary,
  merge$1.merge,
  omap$1.omap,
  pairs$1.pairs,
  set$1.set,
  timestamp$1.intTime,
  timestamp$1.floatTime,
  timestamp$1.timestamp
];
schema$4.schema = schema$3;
var map$1 = map$6;
var _null = _null$3;
var seq$1 = seq$6;
var string$1 = string$5;
var bool = bool$4;
var float = float$6;
var int = int$6;
var schema = schema$8;
var schema$1 = schema$6;
var binary = binary$3;
var merge = merge$4;
var omap = omap$3;
var pairs = pairs$4;
var schema$2 = schema$4;
var set = set$3;
var timestamp = timestamp$3;
const schemas = /* @__PURE__ */ new Map([
  ["core", schema.schema],
  ["failsafe", [map$1.map, seq$1.seq, string$1.string]],
  ["json", schema$1.schema],
  ["yaml11", schema$2.schema],
  ["yaml-1.1", schema$2.schema]
]);
const tagsByName = {
  binary: binary.binary,
  bool: bool.boolTag,
  float: float.float,
  floatExp: float.floatExp,
  floatNaN: float.floatNaN,
  floatTime: timestamp.floatTime,
  int: int.int,
  intHex: int.intHex,
  intOct: int.intOct,
  intTime: timestamp.intTime,
  map: map$1.map,
  merge: merge.merge,
  null: _null.nullTag,
  omap: omap.omap,
  pairs: pairs.pairs,
  seq: seq$1.seq,
  set: set.set,
  timestamp: timestamp.timestamp
};
const coreKnownTags = {
  "tag:yaml.org,2002:binary": binary.binary,
  "tag:yaml.org,2002:merge": merge.merge,
  "tag:yaml.org,2002:omap": omap.omap,
  "tag:yaml.org,2002:pairs": pairs.pairs,
  "tag:yaml.org,2002:set": set.set,
  "tag:yaml.org,2002:timestamp": timestamp.timestamp
};
function getTags(customTags, schemaName, addMergeTag) {
  const schemaTags = schemas.get(schemaName);
  if (schemaTags && !customTags) {
    return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
  }
  let tags2 = schemaTags;
  if (!tags2) {
    if (Array.isArray(customTags))
      tags2 = [];
    else {
      const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  }
  if (Array.isArray(customTags)) {
    for (const tag of customTags)
      tags2 = tags2.concat(tag);
  } else if (typeof customTags === "function") {
    tags2 = customTags(tags2.slice());
  }
  if (addMergeTag)
    tags2 = tags2.concat(merge.merge);
  return tags2.reduce((tags3, tag) => {
    const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      const tagName = JSON.stringify(tag);
      const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    if (!tags3.includes(tagObj))
      tags3.push(tagObj);
    return tags3;
  }, []);
}
tags$1.coreKnownTags = coreKnownTags;
tags$1.getTags = getTags;
var identity$a = identity$x;
var map = map$6;
var seq = seq$6;
var string = string$5;
var tags = tags$1;
const sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
let Schema$1 = class Schema {
  constructor({ compat, customTags, merge: merge2, resolveKnownTags, schema: schema2, sortMapEntries, toStringDefaults }) {
    this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
    this.name = typeof schema2 === "string" && schema2 || "core";
    this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
    this.tags = tags.getTags(customTags, this.name, merge2);
    this.toStringOptions = toStringDefaults ?? null;
    Object.defineProperty(this, identity$a.MAP, { value: map.map });
    Object.defineProperty(this, identity$a.SCALAR, { value: string.string });
    Object.defineProperty(this, identity$a.SEQ, { value: seq.seq });
    this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
  }
  clone() {
    const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
    copy.tags = this.tags.slice();
    return copy;
  }
};
Schema$2.Schema = Schema$1;
var stringifyDocument$2 = {};
var identity$9 = identity$x;
var stringify$2 = stringify$7;
var stringifyComment = stringifyComment$5;
function stringifyDocument$1(doc, options) {
  const lines = [];
  let hasDirectives = options.directives === true;
  if (options.directives !== false && doc.directives) {
    const dir = doc.directives.toString(doc);
    if (dir) {
      lines.push(dir);
      hasDirectives = true;
    } else if (doc.directives.docStart)
      hasDirectives = true;
  }
  if (hasDirectives)
    lines.push("---");
  const ctx = stringify$2.createStringifyContext(doc, options);
  const { commentString } = ctx.options;
  if (doc.commentBefore) {
    if (lines.length !== 1)
      lines.unshift("");
    const cs = commentString(doc.commentBefore);
    lines.unshift(stringifyComment.indentComment(cs, ""));
  }
  let chompKeep = false;
  let contentComment = null;
  if (doc.contents) {
    if (identity$9.isNode(doc.contents)) {
      if (doc.contents.spaceBefore && hasDirectives)
        lines.push("");
      if (doc.contents.commentBefore) {
        const cs = commentString(doc.contents.commentBefore);
        lines.push(stringifyComment.indentComment(cs, ""));
      }
      ctx.forceBlockIndent = !!doc.comment;
      contentComment = doc.contents.comment;
    }
    const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
    let body = stringify$2.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
    if (contentComment)
      body += stringifyComment.lineComment(body, "", commentString(contentComment));
    if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
      lines[lines.length - 1] = `--- ${body}`;
    } else
      lines.push(body);
  } else {
    lines.push(stringify$2.stringify(doc.contents, ctx));
  }
  if (doc.directives?.docEnd) {
    if (doc.comment) {
      const cs = commentString(doc.comment);
      if (cs.includes("\n")) {
        lines.push("...");
        lines.push(stringifyComment.indentComment(cs, ""));
      } else {
        lines.push(`... ${cs}`);
      }
    } else {
      lines.push("...");
    }
  } else {
    let dc = doc.comment;
    if (dc && chompKeep)
      dc = dc.replace(/^\n+/, "");
    if (dc) {
      if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
        lines.push("");
      lines.push(stringifyComment.indentComment(commentString(dc), ""));
    }
  }
  return lines.join("\n") + "\n";
}
stringifyDocument$2.stringifyDocument = stringifyDocument$1;
var Alias$1 = Alias$4;
var Collection2 = Collection$4;
var identity$8 = identity$x;
var Pair$3 = Pair$8;
var toJS = toJS$8;
var Schema2 = Schema$2;
var stringifyDocument = stringifyDocument$2;
var anchors = anchors$3;
var applyReviver = applyReviver$3;
var createNode = createNode$5;
var directives$1 = directives$2;
let Document$3 = class Document {
  constructor(value, replacer, options) {
    this.commentBefore = null;
    this.comment = null;
    this.errors = [];
    this.warnings = [];
    Object.defineProperty(this, identity$8.NODE_TYPE, { value: identity$8.DOC });
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const opt = Object.assign({
      intAsBigInt: false,
      keepSourceTokens: false,
      logLevel: "warn",
      prettyErrors: true,
      strict: true,
      stringKeys: false,
      uniqueKeys: true,
      version: "1.2"
    }, options);
    this.options = opt;
    let { version } = opt;
    if (options?._directives) {
      this.directives = options._directives.atDocument();
      if (this.directives.yaml.explicit)
        version = this.directives.yaml.version;
    } else
      this.directives = new directives$1.Directives({ version });
    this.setSchema(version, options);
    this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
  }
  /**
   * Create a deep copy of this Document and its contents.
   *
   * Custom Node values that inherit from `Object` still refer to their original instances.
   */
  clone() {
    const copy = Object.create(Document.prototype, {
      [identity$8.NODE_TYPE]: { value: identity$8.DOC }
    });
    copy.commentBefore = this.commentBefore;
    copy.comment = this.comment;
    copy.errors = this.errors.slice();
    copy.warnings = this.warnings.slice();
    copy.options = Object.assign({}, this.options);
    if (this.directives)
      copy.directives = this.directives.clone();
    copy.schema = this.schema.clone();
    copy.contents = identity$8.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** Adds a value to the document. */
  add(value) {
    if (assertCollection(this.contents))
      this.contents.add(value);
  }
  /** Adds a value to the document. */
  addIn(path, value) {
    if (assertCollection(this.contents))
      this.contents.addIn(path, value);
  }
  /**
   * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
   *
   * If `node` already has an anchor, `name` is ignored.
   * Otherwise, the `node.anchor` value will be set to `name`,
   * or if an anchor with that name is already present in the document,
   * `name` will be used as a prefix for a new unique anchor.
   * If `name` is undefined, the generated anchor will use 'a' as a prefix.
   */
  createAlias(node, name) {
    if (!node.anchor) {
      const prev = anchors.anchorNames(this);
      node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
    }
    return new Alias$1.Alias(node.anchor);
  }
  createNode(value, replacer, options) {
    let _replacer = void 0;
    if (typeof replacer === "function") {
      value = replacer.call({ "": value }, "", value);
      _replacer = replacer;
    } else if (Array.isArray(replacer)) {
      const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
      const asStr = replacer.filter(keyToStr).map(String);
      if (asStr.length > 0)
        replacer = replacer.concat(asStr);
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
    const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
      this,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      anchorPrefix || "a"
    );
    const ctx = {
      aliasDuplicateObjects: aliasDuplicateObjects ?? true,
      keepUndefined: keepUndefined ?? false,
      onAnchor,
      onTagObj,
      replacer: _replacer,
      schema: this.schema,
      sourceObjects
    };
    const node = createNode.createNode(value, tag, ctx);
    if (flow && identity$8.isCollection(node))
      node.flow = true;
    setAnchors();
    return node;
  }
  /**
   * Convert a key and a value into a `Pair` using the current schema,
   * recursively wrapping all values as `Scalar` or `Collection` nodes.
   */
  createPair(key, value, options = {}) {
    const k = this.createNode(key, null, options);
    const v = this.createNode(value, null, options);
    return new Pair$3.Pair(k, v);
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    return assertCollection(this.contents) ? this.contents.delete(key) : false;
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    if (Collection2.isEmptyPath(path)) {
      if (this.contents == null)
        return false;
      this.contents = null;
      return true;
    }
    return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  get(key, keepScalar) {
    return identity$8.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
  }
  /**
   * Returns item at `path`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    if (Collection2.isEmptyPath(path))
      return !keepScalar && identity$8.isScalar(this.contents) ? this.contents.value : this.contents;
    return identity$8.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
  }
  /**
   * Checks if the document includes a value with the key `key`.
   */
  has(key) {
    return identity$8.isCollection(this.contents) ? this.contents.has(key) : false;
  }
  /**
   * Checks if the document includes a value at `path`.
   */
  hasIn(path) {
    if (Collection2.isEmptyPath(path))
      return this.contents !== void 0;
    return identity$8.isCollection(this.contents) ? this.contents.hasIn(path) : false;
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  set(key, value) {
    if (this.contents == null) {
      this.contents = Collection2.collectionFromPath(this.schema, [key], value);
    } else if (assertCollection(this.contents)) {
      this.contents.set(key, value);
    }
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    if (Collection2.isEmptyPath(path)) {
      this.contents = value;
    } else if (this.contents == null) {
      this.contents = Collection2.collectionFromPath(this.schema, Array.from(path), value);
    } else if (assertCollection(this.contents)) {
      this.contents.setIn(path, value);
    }
  }
  /**
   * Change the YAML version and schema used by the document.
   * A `null` version disables support for directives, explicit tags, anchors, and aliases.
   * It also requires the `schema` option to be given as a `Schema` instance value.
   *
   * Overrides all previously set schema options.
   */
  setSchema(version, options = {}) {
    if (typeof version === "number")
      version = String(version);
    let opt;
    switch (version) {
      case "1.1":
        if (this.directives)
          this.directives.yaml.version = "1.1";
        else
          this.directives = new directives$1.Directives({ version: "1.1" });
        opt = { resolveKnownTags: false, schema: "yaml-1.1" };
        break;
      case "1.2":
      case "next":
        if (this.directives)
          this.directives.yaml.version = version;
        else
          this.directives = new directives$1.Directives({ version });
        opt = { resolveKnownTags: true, schema: "core" };
        break;
      case null:
        if (this.directives)
          delete this.directives;
        opt = null;
        break;
      default: {
        const sv = JSON.stringify(version);
        throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
      }
    }
    if (options.schema instanceof Object)
      this.schema = options.schema;
    else if (opt)
      this.schema = new Schema2.Schema(Object.assign(opt, options));
    else
      throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
  }
  // json & jsonArg are only used from toJSON()
  toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc: this,
      keep: !json,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
    if (typeof onAnchor === "function")
      for (const { count: count2, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count2);
    return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
  }
  /**
   * A JSON representation of the document `contents`.
   *
   * @param jsonArg Used by `JSON.stringify` to indicate the array index or
   *   property name.
   */
  toJSON(jsonArg, onAnchor) {
    return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
  }
  /** A YAML representation of the document. */
  toString(options = {}) {
    if (this.errors.length > 0)
      throw new Error("Document with errors cannot be stringified");
    if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
      const s = JSON.stringify(options.indent);
      throw new Error(`"indent" option must be a positive integer, not ${s}`);
    }
    return stringifyDocument.stringifyDocument(this, options);
  }
};
function assertCollection(contents) {
  if (identity$8.isCollection(contents))
    return true;
  throw new Error("Expected a YAML collection as document contents");
}
Document$4.Document = Document$3;
var errors$4 = {};
class YAMLError extends Error {
  constructor(name, pos, code, message) {
    super();
    this.name = name;
    this.code = code;
    this.message = message;
    this.pos = pos;
  }
}
class YAMLParseError extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLParseError", pos, code, message);
  }
}
class YAMLWarning extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLWarning", pos, code, message);
  }
}
const prettifyError = (src, lc) => (error) => {
  if (error.pos[0] === -1)
    return;
  error.linePos = error.pos.map((pos) => lc.linePos(pos));
  const { line, col } = error.linePos[0];
  error.message += ` at line ${line}, column ${col}`;
  let ci = col - 1;
  let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
  if (ci >= 60 && lineStr.length > 80) {
    const trimStart = Math.min(ci - 39, lineStr.length - 79);
    lineStr = "…" + lineStr.substring(trimStart);
    ci -= trimStart - 1;
  }
  if (lineStr.length > 80)
    lineStr = lineStr.substring(0, 79) + "…";
  if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
    let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
    if (prev.length > 80)
      prev = prev.substring(0, 79) + "…\n";
    lineStr = prev + lineStr;
  }
  if (/[^ ]/.test(lineStr)) {
    let count2 = 1;
    const end = error.linePos[1];
    if (end?.line === line && end.col > col) {
      count2 = Math.max(1, Math.min(end.col - col, 80 - ci));
    }
    const pointer = " ".repeat(ci) + "^".repeat(count2);
    error.message += `:

${lineStr}
${pointer}
`;
  }
};
errors$4.YAMLError = YAMLError;
errors$4.YAMLParseError = YAMLParseError;
errors$4.YAMLWarning = YAMLWarning;
errors$4.prettifyError = prettifyError;
var composeDoc$2 = {};
var composeNode$2 = {};
var composeCollection$2 = {};
var resolveBlockMap$2 = {};
var resolveProps$5 = {};
function resolveProps$4(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
  let spaceBefore = false;
  let atNewline = startOnNewline;
  let hasSpace = startOnNewline;
  let comment = "";
  let commentSep = "";
  let hasNewline = false;
  let reqSpace = false;
  let tab = null;
  let anchor = null;
  let tag = null;
  let newlineAfterProp = null;
  let comma = null;
  let found = null;
  let start = null;
  for (const token of tokens) {
    if (reqSpace) {
      if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
        onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      reqSpace = false;
    }
    if (tab) {
      if (atNewline && token.type !== "comment" && token.type !== "newline") {
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      }
      tab = null;
    }
    switch (token.type) {
      case "space":
        if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
          tab = token;
        }
        hasSpace = true;
        break;
      case "comment": {
        if (!hasSpace)
          onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
        const cb = token.source.substring(1) || " ";
        if (!comment)
          comment = cb;
        else
          comment += commentSep + cb;
        commentSep = "";
        atNewline = false;
        break;
      }
      case "newline":
        if (atNewline) {
          if (comment)
            comment += token.source;
          else if (!found || indicator !== "seq-item-ind")
            spaceBefore = true;
        } else
          commentSep += token.source;
        atNewline = true;
        hasNewline = true;
        if (anchor || tag)
          newlineAfterProp = token;
        hasSpace = true;
        break;
      case "anchor":
        if (anchor)
          onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
        if (token.source.endsWith(":"))
          onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
        anchor = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      case "tag": {
        if (tag)
          onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
        tag = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      }
      case indicator:
        if (anchor || tag)
          onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
        if (found)
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
        found = token;
        atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
        hasSpace = false;
        break;
      case "comma":
        if (flow) {
          if (comma)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
          comma = token;
          atNewline = false;
          hasSpace = false;
          break;
        }
      default:
        onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
        atNewline = false;
        hasSpace = false;
    }
  }
  const last = tokens[tokens.length - 1];
  const end = last ? last.offset + last.source.length : offset;
  if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
    onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
  }
  if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
    onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
  return {
    comma,
    found,
    spaceBefore,
    comment,
    hasNewline,
    anchor,
    tag,
    newlineAfterProp,
    end,
    start: start ?? end
  };
}
resolveProps$5.resolveProps = resolveProps$4;
var utilContainsNewline$3 = {};
function containsNewline(key) {
  if (!key)
    return null;
  switch (key.type) {
    case "alias":
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      if (key.source.includes("\n"))
        return true;
      if (key.end) {
        for (const st of key.end)
          if (st.type === "newline")
            return true;
      }
      return false;
    case "flow-collection":
      for (const it of key.items) {
        for (const st of it.start)
          if (st.type === "newline")
            return true;
        if (it.sep) {
          for (const st of it.sep)
            if (st.type === "newline")
              return true;
        }
        if (containsNewline(it.key) || containsNewline(it.value))
          return true;
      }
      return false;
    default:
      return true;
  }
}
utilContainsNewline$3.containsNewline = containsNewline;
var utilFlowIndentCheck$2 = {};
var utilContainsNewline$2 = utilContainsNewline$3;
function flowIndentCheck(indent, fc, onError) {
  if (fc?.type === "flow-collection") {
    const end = fc.end[0];
    if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline$2.containsNewline(fc)) {
      const msg = "Flow end indicator should be more indented than parent";
      onError(end, "BAD_INDENT", msg, true);
    }
  }
}
utilFlowIndentCheck$2.flowIndentCheck = flowIndentCheck;
var utilMapIncludes$2 = {};
var identity$7 = identity$x;
function mapIncludes(ctx, items, search) {
  const { uniqueKeys } = ctx.options;
  if (uniqueKeys === false)
    return false;
  const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity$7.isScalar(a) && identity$7.isScalar(b) && a.value === b.value;
  return items.some((pair) => isEqual(pair.key, search));
}
utilMapIncludes$2.mapIncludes = mapIncludes;
var Pair$2 = Pair$8;
var YAMLMap$3 = YAMLMap$8;
var resolveProps$3 = resolveProps$5;
var utilContainsNewline$1 = utilContainsNewline$3;
var utilFlowIndentCheck$1 = utilFlowIndentCheck$2;
var utilMapIncludes$1 = utilMapIncludes$2;
const startColMsg = "All mapping items must start at the same column";
function resolveBlockMap$1({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bm, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLMap$3.YAMLMap;
  const map2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  let offset = bm.offset;
  let commentEnd = null;
  for (const collItem of bm.items) {
    const { start, key, sep, value } = collItem;
    const keyProps = resolveProps$3.resolveProps(start, {
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: bm.indent,
      startOnNewline: true
    });
    const implicitKey = !keyProps.found;
    if (implicitKey) {
      if (key) {
        if (key.type === "block-seq")
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
        else if ("indent" in key && key.indent !== bm.indent)
          onError(offset, "BAD_INDENT", startColMsg);
      }
      if (!keyProps.anchor && !keyProps.tag && !sep) {
        commentEnd = keyProps.end;
        if (keyProps.comment) {
          if (map2.comment)
            map2.comment += "\n" + keyProps.comment;
          else
            map2.comment = keyProps.comment;
        }
        continue;
      }
      if (keyProps.newlineAfterProp || utilContainsNewline$1.containsNewline(key)) {
        onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
      }
    } else if (keyProps.found?.indent !== bm.indent) {
      onError(offset, "BAD_INDENT", startColMsg);
    }
    ctx.atKey = true;
    const keyStart = keyProps.end;
    const keyNode = key ? composeNode2(ctx, key, keyProps, onError) : composeEmptyNode2(ctx, keyStart, start, null, keyProps, onError);
    if (ctx.schema.compat)
      utilFlowIndentCheck$1.flowIndentCheck(bm.indent, key, onError);
    ctx.atKey = false;
    if (utilMapIncludes$1.mapIncludes(ctx, map2.items, keyNode))
      onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
    const valueProps = resolveProps$3.resolveProps(sep ?? [], {
      indicator: "map-value-ind",
      next: value,
      offset: keyNode.range[2],
      onError,
      parentIndent: bm.indent,
      startOnNewline: !key || key.type === "block-scalar"
    });
    offset = valueProps.end;
    if (valueProps.found) {
      if (implicitKey) {
        if (value?.type === "block-map" && !valueProps.hasNewline)
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
        if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
          onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : composeEmptyNode2(ctx, offset, sep, null, valueProps, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck$1.flowIndentCheck(bm.indent, value, onError);
      offset = valueNode.range[2];
      const pair = new Pair$2.Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    } else {
      if (implicitKey)
        onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
      if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair$2.Pair(keyNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    }
  }
  if (commentEnd && commentEnd < offset)
    onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
  map2.range = [bm.offset, offset, commentEnd ?? offset];
  return map2;
}
resolveBlockMap$2.resolveBlockMap = resolveBlockMap$1;
var resolveBlockSeq$2 = {};
var YAMLSeq$2 = YAMLSeq$7;
var resolveProps$2 = resolveProps$5;
var utilFlowIndentCheck = utilFlowIndentCheck$2;
function resolveBlockSeq$1({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bs, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLSeq$2.YAMLSeq;
  const seq2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = bs.offset;
  let commentEnd = null;
  for (const { start, value } of bs.items) {
    const props = resolveProps$2.resolveProps(start, {
      indicator: "seq-item-ind",
      next: value,
      offset,
      onError,
      parentIndent: bs.indent,
      startOnNewline: true
    });
    if (!props.found) {
      if (props.anchor || props.tag || value) {
        if (value?.type === "block-seq")
          onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
        else
          onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
      } else {
        commentEnd = props.end;
        if (props.comment)
          seq2.comment = props.comment;
        continue;
      }
    }
    const node = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, start, null, props, onError);
    if (ctx.schema.compat)
      utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
    offset = node.range[2];
    seq2.items.push(node);
  }
  seq2.range = [bs.offset, offset, commentEnd ?? offset];
  return seq2;
}
resolveBlockSeq$2.resolveBlockSeq = resolveBlockSeq$1;
var resolveFlowCollection$2 = {};
var resolveEnd$6 = {};
function resolveEnd$5(end, offset, reqSpace, onError) {
  let comment = "";
  if (end) {
    let hasSpace = false;
    let sep = "";
    for (const token of end) {
      const { source, type } = token;
      switch (type) {
        case "space":
          hasSpace = true;
          break;
        case "comment": {
          if (reqSpace && !hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += sep + cb;
          sep = "";
          break;
        }
        case "newline":
          if (comment)
            sep += source;
          hasSpace = true;
          break;
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
      }
      offset += source.length;
    }
  }
  return { comment, offset };
}
resolveEnd$6.resolveEnd = resolveEnd$5;
var identity$6 = identity$x;
var Pair$1 = Pair$8;
var YAMLMap$2 = YAMLMap$8;
var YAMLSeq$1 = YAMLSeq$7;
var resolveEnd$4 = resolveEnd$6;
var resolveProps$1 = resolveProps$5;
var utilContainsNewline = utilContainsNewline$3;
var utilMapIncludes = utilMapIncludes$2;
const blockMsg = "Block collections are not allowed within flow collections";
const isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
function resolveFlowCollection$1({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, fc, onError, tag) {
  const isMap2 = fc.start.source === "{";
  const fcName = isMap2 ? "flow map" : "flow sequence";
  const NodeClass = tag?.nodeClass ?? (isMap2 ? YAMLMap$2.YAMLMap : YAMLSeq$1.YAMLSeq);
  const coll = new NodeClass(ctx.schema);
  coll.flow = true;
  const atRoot = ctx.atRoot;
  if (atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = fc.offset + fc.start.source.length;
  for (let i = 0; i < fc.items.length; ++i) {
    const collItem = fc.items[i];
    const { start, key, sep, value } = collItem;
    const props = resolveProps$1.resolveProps(start, {
      flow: fcName,
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: fc.indent,
      startOnNewline: false
    });
    if (!props.found) {
      if (!props.anchor && !props.tag && !sep && !value) {
        if (i === 0 && props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        else if (i < fc.items.length - 1)
          onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
        if (props.comment) {
          if (coll.comment)
            coll.comment += "\n" + props.comment;
          else
            coll.comment = props.comment;
        }
        offset = props.end;
        continue;
      }
      if (!isMap2 && ctx.options.strict && utilContainsNewline.containsNewline(key))
        onError(
          key,
          // checked by containsNewline()
          "MULTILINE_IMPLICIT_KEY",
          "Implicit keys of flow sequence pairs need to be on a single line"
        );
    }
    if (i === 0) {
      if (props.comma)
        onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
    } else {
      if (!props.comma)
        onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
      if (props.comment) {
        let prevItemComment = "";
        loop: for (const st of start) {
          switch (st.type) {
            case "comma":
            case "space":
              break;
            case "comment":
              prevItemComment = st.source.substring(1);
              break loop;
            default:
              break loop;
          }
        }
        if (prevItemComment) {
          let prev = coll.items[coll.items.length - 1];
          if (identity$6.isPair(prev))
            prev = prev.value ?? prev.key;
          if (prev.comment)
            prev.comment += "\n" + prevItemComment;
          else
            prev.comment = prevItemComment;
          props.comment = props.comment.substring(prevItemComment.length + 1);
        }
      }
    }
    if (!isMap2 && !sep && !props.found) {
      const valueNode = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, sep, null, props, onError);
      coll.items.push(valueNode);
      offset = valueNode.range[2];
      if (isBlock(value))
        onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
    } else {
      ctx.atKey = true;
      const keyStart = props.end;
      const keyNode = key ? composeNode2(ctx, key, props, onError) : composeEmptyNode2(ctx, keyStart, start, null, props, onError);
      if (isBlock(key))
        onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
      ctx.atKey = false;
      const valueProps = resolveProps$1.resolveProps(sep ?? [], {
        flow: fcName,
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (valueProps.found) {
        if (!isMap2 && !props.found && ctx.options.strict) {
          if (sep)
            for (const st of sep) {
              if (st === valueProps.found)
                break;
              if (st.type === "newline") {
                onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                break;
              }
            }
          if (props.start < valueProps.found.offset - 1024)
            onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
        }
      } else if (value) {
        if ("source" in value && value.source?.[0] === ":")
          onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
        else
          onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode2(ctx, valueProps.end, sep, null, valueProps, onError) : null;
      if (valueNode) {
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair$1.Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      if (isMap2) {
        const map2 = coll;
        if (utilMapIncludes.mapIncludes(ctx, map2.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        map2.items.push(pair);
      } else {
        const map2 = new YAMLMap$2.YAMLMap(ctx.schema);
        map2.flow = true;
        map2.items.push(pair);
        const endRange = (valueNode ?? keyNode).range;
        map2.range = [keyNode.range[0], endRange[1], endRange[2]];
        coll.items.push(map2);
      }
      offset = valueNode ? valueNode.range[2] : valueProps.end;
    }
  }
  const expectedEnd = isMap2 ? "}" : "]";
  const [ce, ...ee] = fc.end;
  let cePos = offset;
  if (ce?.source === expectedEnd)
    cePos = ce.offset + ce.source.length;
  else {
    const name = fcName[0].toUpperCase() + fcName.substring(1);
    const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
    onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
    if (ce && ce.source.length !== 1)
      ee.unshift(ce);
  }
  if (ee.length > 0) {
    const end = resolveEnd$4.resolveEnd(ee, cePos, ctx.options.strict, onError);
    if (end.comment) {
      if (coll.comment)
        coll.comment += "\n" + end.comment;
      else
        coll.comment = end.comment;
    }
    coll.range = [fc.offset, cePos, end.offset];
  } else {
    coll.range = [fc.offset, cePos, cePos];
  }
  return coll;
}
resolveFlowCollection$2.resolveFlowCollection = resolveFlowCollection$1;
var identity$5 = identity$x;
var Scalar$4 = Scalar$k;
var YAMLMap$1 = YAMLMap$8;
var YAMLSeq2 = YAMLSeq$7;
var resolveBlockMap = resolveBlockMap$2;
var resolveBlockSeq = resolveBlockSeq$2;
var resolveFlowCollection = resolveFlowCollection$2;
function resolveCollection(CN2, ctx, token, onError, tagName, tag) {
  const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN2, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN2, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN2, ctx, token, onError, tag);
  const Coll = coll.constructor;
  if (tagName === "!" || tagName === Coll.tagName) {
    coll.tag = Coll.tagName;
    return coll;
  }
  if (tagName)
    coll.tag = tagName;
  return coll;
}
function composeCollection$1(CN2, ctx, token, props, onError) {
  const tagToken = props.tag;
  const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
  if (token.type === "block-seq") {
    const { anchor, newlineAfterProp: nl } = props;
    const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
    if (lastProp && (!nl || nl.offset < lastProp.offset)) {
      const message = "Missing newline after block sequence props";
      onError(lastProp, "MISSING_CHAR", message);
    }
  }
  const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
  if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap$1.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq2.YAMLSeq.tagName && expType === "seq") {
    return resolveCollection(CN2, ctx, token, onError, tagName);
  }
  let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
  if (!tag) {
    const kt = ctx.schema.knownTags[tagName];
    if (kt?.collection === expType) {
      ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
      tag = kt;
    } else {
      if (kt) {
        onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
      } else {
        onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
      }
      return resolveCollection(CN2, ctx, token, onError, tagName);
    }
  }
  const coll = resolveCollection(CN2, ctx, token, onError, tagName, tag);
  const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
  const node = identity$5.isNode(res) ? res : new Scalar$4.Scalar(res);
  node.range = coll.range;
  node.tag = tagName;
  if (tag?.format)
    node.format = tag.format;
  return node;
}
composeCollection$2.composeCollection = composeCollection$1;
var composeScalar$2 = {};
var resolveBlockScalar$3 = {};
var Scalar$3 = Scalar$k;
function resolveBlockScalar$2(ctx, scalar, onError) {
  const start = scalar.offset;
  const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
  if (!header)
    return { value: "", type: null, comment: "", range: [start, start, start] };
  const type = header.mode === ">" ? Scalar$3.Scalar.BLOCK_FOLDED : Scalar$3.Scalar.BLOCK_LITERAL;
  const lines = scalar.source ? splitLines(scalar.source) : [];
  let chompStart = lines.length;
  for (let i = lines.length - 1; i >= 0; --i) {
    const content = lines[i][1];
    if (content === "" || content === "\r")
      chompStart = i;
    else
      break;
  }
  if (chompStart === 0) {
    const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
    let end2 = start + header.length;
    if (scalar.source)
      end2 += scalar.source.length;
    return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
  }
  let trimIndent = scalar.indent + header.indent;
  let offset = scalar.offset + header.length;
  let contentStart = 0;
  for (let i = 0; i < chompStart; ++i) {
    const [indent, content] = lines[i];
    if (content === "" || content === "\r") {
      if (header.indent === 0 && indent.length > trimIndent)
        trimIndent = indent.length;
    } else {
      if (indent.length < trimIndent) {
        const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
        onError(offset + indent.length, "MISSING_CHAR", message);
      }
      if (header.indent === 0)
        trimIndent = indent.length;
      contentStart = i;
      if (trimIndent === 0 && !ctx.atRoot) {
        const message = "Block scalar values in collections must be indented";
        onError(offset, "BAD_INDENT", message);
      }
      break;
    }
    offset += indent.length + content.length + 1;
  }
  for (let i = lines.length - 1; i >= chompStart; --i) {
    if (lines[i][0].length > trimIndent)
      chompStart = i + 1;
  }
  let value = "";
  let sep = "";
  let prevMoreIndented = false;
  for (let i = 0; i < contentStart; ++i)
    value += lines[i][0].slice(trimIndent) + "\n";
  for (let i = contentStart; i < chompStart; ++i) {
    let [indent, content] = lines[i];
    offset += indent.length + content.length + 1;
    const crlf = content[content.length - 1] === "\r";
    if (crlf)
      content = content.slice(0, -1);
    if (content && indent.length < trimIndent) {
      const src = header.indent ? "explicit indentation indicator" : "first line";
      const message = `Block scalar lines must not be less indented than their ${src}`;
      onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
      indent = "";
    }
    if (type === Scalar$3.Scalar.BLOCK_LITERAL) {
      value += sep + indent.slice(trimIndent) + content;
      sep = "\n";
    } else if (indent.length > trimIndent || content[0] === "	") {
      if (sep === " ")
        sep = "\n";
      else if (!prevMoreIndented && sep === "\n")
        sep = "\n\n";
      value += sep + indent.slice(trimIndent) + content;
      sep = "\n";
      prevMoreIndented = true;
    } else if (content === "") {
      if (sep === "\n")
        value += "\n";
      else
        sep = "\n";
    } else {
      value += sep + content;
      sep = " ";
      prevMoreIndented = false;
    }
  }
  switch (header.chomp) {
    case "-":
      break;
    case "+":
      for (let i = chompStart; i < lines.length; ++i)
        value += "\n" + lines[i][0].slice(trimIndent);
      if (value[value.length - 1] !== "\n")
        value += "\n";
      break;
    default:
      value += "\n";
  }
  const end = start + header.length + scalar.source.length;
  return { value, type, comment: header.comment, range: [start, end, end] };
}
function parseBlockScalarHeader({ offset, props }, strict, onError) {
  if (props[0].type !== "block-scalar-header") {
    onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
    return null;
  }
  const { source } = props[0];
  const mode = source[0];
  let indent = 0;
  let chomp = "";
  let error = -1;
  for (let i = 1; i < source.length; ++i) {
    const ch = source[i];
    if (!chomp && (ch === "-" || ch === "+"))
      chomp = ch;
    else {
      const n = Number(ch);
      if (!indent && n)
        indent = n;
      else if (error === -1)
        error = offset + i;
    }
  }
  if (error !== -1)
    onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
  let hasSpace = false;
  let comment = "";
  let length = source.length;
  for (let i = 1; i < props.length; ++i) {
    const token = props[i];
    switch (token.type) {
      case "space":
        hasSpace = true;
      case "newline":
        length += token.source.length;
        break;
      case "comment":
        if (strict && !hasSpace) {
          const message = "Comments must be separated from other tokens by white space characters";
          onError(token, "MISSING_CHAR", message);
        }
        length += token.source.length;
        comment = token.source.substring(1);
        break;
      case "error":
        onError(token, "UNEXPECTED_TOKEN", token.message);
        length += token.source.length;
        break;
      default: {
        const message = `Unexpected token in block scalar header: ${token.type}`;
        onError(token, "UNEXPECTED_TOKEN", message);
        const ts = token.source;
        if (ts && typeof ts === "string")
          length += ts.length;
      }
    }
  }
  return { mode, indent, chomp, comment, length };
}
function splitLines(source) {
  const split = source.split(/\n( *)/);
  const first = split[0];
  const m = first.match(/^( *)/);
  const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
  const lines = [line0];
  for (let i = 1; i < split.length; i += 2)
    lines.push([split[i], split[i + 1]]);
  return lines;
}
resolveBlockScalar$3.resolveBlockScalar = resolveBlockScalar$2;
var resolveFlowScalar$3 = {};
var Scalar$2 = Scalar$k;
var resolveEnd$3 = resolveEnd$6;
function resolveFlowScalar$2(scalar, strict, onError) {
  const { offset, type, source, end } = scalar;
  let _type;
  let value;
  const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
  switch (type) {
    case "scalar":
      _type = Scalar$2.Scalar.PLAIN;
      value = plainValue(source, _onError);
      break;
    case "single-quoted-scalar":
      _type = Scalar$2.Scalar.QUOTE_SINGLE;
      value = singleQuotedValue(source, _onError);
      break;
    case "double-quoted-scalar":
      _type = Scalar$2.Scalar.QUOTE_DOUBLE;
      value = doubleQuotedValue(source, _onError);
      break;
    default:
      onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
      return {
        value: "",
        type: null,
        comment: "",
        range: [offset, offset + source.length, offset + source.length]
      };
  }
  const valueEnd = offset + source.length;
  const re = resolveEnd$3.resolveEnd(end, valueEnd, strict, onError);
  return {
    value,
    type: _type,
    comment: re.comment,
    range: [offset, valueEnd, re.offset]
  };
}
function plainValue(source, onError) {
  let badChar = "";
  switch (source[0]) {
    case "	":
      badChar = "a tab character";
      break;
    case ",":
      badChar = "flow indicator character ,";
      break;
    case "%":
      badChar = "directive indicator character %";
      break;
    case "|":
    case ">": {
      badChar = `block scalar indicator ${source[0]}`;
      break;
    }
    case "@":
    case "`": {
      badChar = `reserved character ${source[0]}`;
      break;
    }
  }
  if (badChar)
    onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
  return foldLines(source);
}
function singleQuotedValue(source, onError) {
  if (source[source.length - 1] !== "'" || source.length === 1)
    onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
  return foldLines(source.slice(1, -1)).replace(/''/g, "'");
}
function foldLines(source) {
  let first, line;
  try {
    first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
    line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
  } catch {
    first = /(.*?)[ \t]*\r?\n/sy;
    line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
  }
  let match = first.exec(source);
  if (!match)
    return source;
  let res = match[1];
  let sep = " ";
  let pos = first.lastIndex;
  line.lastIndex = pos;
  while (match = line.exec(source)) {
    if (match[1] === "") {
      if (sep === "\n")
        res += sep;
      else
        sep = "\n";
    } else {
      res += sep + match[1];
      sep = " ";
    }
    pos = line.lastIndex;
  }
  const last = /[ \t]*(.*)/sy;
  last.lastIndex = pos;
  match = last.exec(source);
  return res + sep + (match?.[1] ?? "");
}
function doubleQuotedValue(source, onError) {
  let res = "";
  for (let i = 1; i < source.length - 1; ++i) {
    const ch = source[i];
    if (ch === "\r" && source[i + 1] === "\n")
      continue;
    if (ch === "\n") {
      const { fold, offset } = foldNewline(source, i);
      res += fold;
      i = offset;
    } else if (ch === "\\") {
      let next = source[++i];
      const cc = escapeCodes[next];
      if (cc)
        res += cc;
      else if (next === "\n") {
        next = source[i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "\r" && source[i + 1] === "\n") {
        next = source[++i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "x" || next === "u" || next === "U") {
        const length = next === "x" ? 2 : next === "u" ? 4 : 8;
        res += parseCharCode(source, i + 1, length, onError);
        i += length;
      } else {
        const raw = source.substr(i - 1, 2);
        onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        res += raw;
      }
    } else if (ch === " " || ch === "	") {
      const wsStart = i;
      let next = source[i + 1];
      while (next === " " || next === "	")
        next = source[++i + 1];
      if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
        res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
    } else {
      res += ch;
    }
  }
  if (source[source.length - 1] !== '"' || source.length === 1)
    onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
  return res;
}
function foldNewline(source, offset) {
  let fold = "";
  let ch = source[offset + 1];
  while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
    if (ch === "\r" && source[offset + 2] !== "\n")
      break;
    if (ch === "\n")
      fold += "\n";
    offset += 1;
    ch = source[offset + 1];
  }
  if (!fold)
    fold = " ";
  return { fold, offset };
}
const escapeCodes = {
  "0": "\0",
  // null character
  a: "\x07",
  // bell character
  b: "\b",
  // backspace
  e: "\x1B",
  // escape character
  f: "\f",
  // form feed
  n: "\n",
  // line feed
  r: "\r",
  // carriage return
  t: "	",
  // horizontal tab
  v: "\v",
  // vertical tab
  N: "",
  // Unicode next line
  _: " ",
  // Unicode non-breaking space
  L: "\u2028",
  // Unicode line separator
  P: "\u2029",
  // Unicode paragraph separator
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  "	": "	"
};
function parseCharCode(source, offset, length, onError) {
  const cc = source.substr(offset, length);
  const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
  const code = ok ? parseInt(cc, 16) : NaN;
  try {
    return String.fromCodePoint(code);
  } catch {
    const raw = source.substr(offset - 2, length + 2);
    onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
    return raw;
  }
}
resolveFlowScalar$3.resolveFlowScalar = resolveFlowScalar$2;
var identity$4 = identity$x;
var Scalar$1 = Scalar$k;
var resolveBlockScalar$1 = resolveBlockScalar$3;
var resolveFlowScalar$1 = resolveFlowScalar$3;
function composeScalar$1(ctx, token, tagToken, onError) {
  const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar$1.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar$1.resolveFlowScalar(token, ctx.options.strict, onError);
  const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
  let tag;
  if (ctx.options.stringKeys && ctx.atKey) {
    tag = ctx.schema[identity$4.SCALAR];
  } else if (tagName)
    tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
  else if (token.type === "scalar")
    tag = findScalarTagByTest(ctx, value, token, onError);
  else
    tag = ctx.schema[identity$4.SCALAR];
  let scalar;
  try {
    const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
    scalar = identity$4.isScalar(res) ? res : new Scalar$1.Scalar(res);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
    scalar = new Scalar$1.Scalar(value);
  }
  scalar.range = range;
  scalar.source = value;
  if (type)
    scalar.type = type;
  if (tagName)
    scalar.tag = tagName;
  if (tag.format)
    scalar.format = tag.format;
  if (comment)
    scalar.comment = comment;
  return scalar;
}
function findScalarTagByName(schema2, value, tagName, tagToken, onError) {
  if (tagName === "!")
    return schema2[identity$4.SCALAR];
  const matchWithTest = [];
  for (const tag of schema2.tags) {
    if (!tag.collection && tag.tag === tagName) {
      if (tag.default && tag.test)
        matchWithTest.push(tag);
      else
        return tag;
    }
  }
  for (const tag of matchWithTest)
    if (tag.test?.test(value))
      return tag;
  const kt = schema2.knownTags[tagName];
  if (kt && !kt.collection) {
    schema2.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
    return kt;
  }
  onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
  return schema2[identity$4.SCALAR];
}
function findScalarTagByTest({ atKey, directives: directives2, schema: schema2 }, value, token, onError) {
  const tag = schema2.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema2[identity$4.SCALAR];
  if (schema2.compat) {
    const compat = schema2.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema2[identity$4.SCALAR];
    if (tag.tag !== compat.tag) {
      const ts = directives2.tagString(tag.tag);
      const cs = directives2.tagString(compat.tag);
      const msg = `Value may be parsed as either ${ts} or ${cs}`;
      onError(token, "TAG_RESOLVE_FAILED", msg, true);
    }
  }
  return tag;
}
composeScalar$2.composeScalar = composeScalar$1;
var utilEmptyScalarPosition$1 = {};
function emptyScalarPosition(offset, before, pos) {
  if (before) {
    pos ?? (pos = before.length);
    for (let i = pos - 1; i >= 0; --i) {
      let st = before[i];
      switch (st.type) {
        case "space":
        case "comment":
        case "newline":
          offset -= st.source.length;
          continue;
      }
      st = before[++i];
      while (st?.type === "space") {
        offset += st.source.length;
        st = before[++i];
      }
      break;
    }
  }
  return offset;
}
utilEmptyScalarPosition$1.emptyScalarPosition = emptyScalarPosition;
var Alias2 = Alias$4;
var identity$3 = identity$x;
var composeCollection = composeCollection$2;
var composeScalar = composeScalar$2;
var resolveEnd$2 = resolveEnd$6;
var utilEmptyScalarPosition = utilEmptyScalarPosition$1;
const CN = { composeNode: composeNode$1, composeEmptyNode };
function composeNode$1(ctx, token, props, onError) {
  const atKey = ctx.atKey;
  const { spaceBefore, comment, anchor, tag } = props;
  let node;
  let isSrcToken = true;
  switch (token.type) {
    case "alias":
      node = composeAlias(ctx, token, onError);
      if (anchor || tag)
        onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
      break;
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "block-scalar":
      node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor)
        node.anchor = anchor.source.substring(1);
      break;
    case "block-map":
    case "block-seq":
    case "flow-collection":
      try {
        node = composeCollection.composeCollection(CN, ctx, token, props, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(token, "RESOURCE_EXHAUSTION", message);
      }
      break;
    default: {
      const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
      onError(token, "UNEXPECTED_TOKEN", message);
      isSrcToken = false;
    }
  }
  node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
  if (anchor && node.anchor === "")
    onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  if (atKey && ctx.options.stringKeys && (!identity$3.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
    const msg = "With stringKeys, all keys must be strings";
    onError(tag ?? token, "NON_STRING_KEY", msg);
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    if (token.type === "scalar" && token.source === "")
      node.comment = comment;
    else
      node.commentBefore = comment;
  }
  if (ctx.options.keepSourceTokens && isSrcToken)
    node.srcToken = token;
  return node;
}
function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
  const token = {
    type: "scalar",
    offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
    indent: -1,
    source: ""
  };
  const node = composeScalar.composeScalar(ctx, token, tag, onError);
  if (anchor) {
    node.anchor = anchor.source.substring(1);
    if (node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    node.comment = comment;
    node.range[2] = end;
  }
  return node;
}
function composeAlias({ options }, { offset, source, end }, onError) {
  const alias = new Alias2.Alias(source.substring(1));
  if (alias.source === "")
    onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
  if (alias.source.endsWith(":"))
    onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
  const valueEnd = offset + source.length;
  const re = resolveEnd$2.resolveEnd(end, valueEnd, options.strict, onError);
  alias.range = [offset, valueEnd, re.offset];
  if (re.comment)
    alias.comment = re.comment;
  return alias;
}
composeNode$2.composeEmptyNode = composeEmptyNode;
composeNode$2.composeNode = composeNode$1;
var Document$2 = Document$4;
var composeNode = composeNode$2;
var resolveEnd$1 = resolveEnd$6;
var resolveProps = resolveProps$5;
function composeDoc$1(options, directives2, { offset, start, value, end }, onError) {
  const opts = Object.assign({ _directives: directives2 }, options);
  const doc = new Document$2.Document(void 0, opts);
  const ctx = {
    atKey: false,
    atRoot: true,
    directives: doc.directives,
    options: doc.options,
    schema: doc.schema
  };
  const props = resolveProps.resolveProps(start, {
    indicator: "doc-start",
    next: value ?? end?.[0],
    offset,
    onError,
    parentIndent: 0,
    startOnNewline: true
  });
  if (props.found) {
    doc.directives.docStart = true;
    if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
      onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
  }
  doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
  const contentEnd = doc.contents.range[2];
  const re = resolveEnd$1.resolveEnd(end, contentEnd, false, onError);
  if (re.comment)
    doc.comment = re.comment;
  doc.range = [offset, contentEnd, re.offset];
  return doc;
}
composeDoc$2.composeDoc = composeDoc$1;
var node_process$1 = require$$0;
var directives = directives$2;
var Document$1 = Document$4;
var errors$3 = errors$4;
var identity$2 = identity$x;
var composeDoc = composeDoc$2;
var resolveEnd = resolveEnd$6;
function getErrorPos(src) {
  if (typeof src === "number")
    return [src, src + 1];
  if (Array.isArray(src))
    return src.length === 2 ? src : [src[0], src[1]];
  const { offset, source } = src;
  return [offset, offset + (typeof source === "string" ? source.length : 1)];
}
function parsePrelude(prelude) {
  let comment = "";
  let atComment = false;
  let afterEmptyLine = false;
  for (let i = 0; i < prelude.length; ++i) {
    const source = prelude[i];
    switch (source[0]) {
      case "#":
        comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
        atComment = true;
        afterEmptyLine = false;
        break;
      case "%":
        if (prelude[i + 1]?.[0] !== "#")
          i += 1;
        atComment = false;
        break;
      default:
        if (!atComment)
          afterEmptyLine = true;
        atComment = false;
    }
  }
  return { comment, afterEmptyLine };
}
class Composer {
  constructor(options = {}) {
    this.doc = null;
    this.atDirectives = false;
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
    this.onError = (source, code, message, warning) => {
      const pos = getErrorPos(source);
      if (warning)
        this.warnings.push(new errors$3.YAMLWarning(pos, code, message));
      else
        this.errors.push(new errors$3.YAMLParseError(pos, code, message));
    };
    this.directives = new directives.Directives({ version: options.version || "1.2" });
    this.options = options;
  }
  decorate(doc, afterDoc) {
    const { comment, afterEmptyLine } = parsePrelude(this.prelude);
    if (comment) {
      const dc = doc.contents;
      if (afterDoc) {
        doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
      } else if (afterEmptyLine || doc.directives.docStart || !dc) {
        doc.commentBefore = comment;
      } else if (identity$2.isCollection(dc) && !dc.flow && dc.items.length > 0) {
        let it = dc.items[0];
        if (identity$2.isPair(it))
          it = it.key;
        const cb = it.commentBefore;
        it.commentBefore = cb ? `${comment}
${cb}` : comment;
      } else {
        const cb = dc.commentBefore;
        dc.commentBefore = cb ? `${comment}
${cb}` : comment;
      }
    }
    if (afterDoc) {
      for (let i = 0; i < this.errors.length; ++i)
        doc.errors.push(this.errors[i]);
      for (let i = 0; i < this.warnings.length; ++i)
        doc.warnings.push(this.warnings[i]);
    } else {
      doc.errors = this.errors;
      doc.warnings = this.warnings;
    }
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
  }
  /**
   * Current stream status information.
   *
   * Mostly useful at the end of input for an empty stream.
   */
  streamInfo() {
    return {
      comment: parsePrelude(this.prelude).comment,
      directives: this.directives,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  /**
   * Compose tokens into documents.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *compose(tokens, forceDoc = false, endOffset = -1) {
    for (const token of tokens)
      yield* this.next(token);
    yield* this.end(forceDoc, endOffset);
  }
  /** Advance the composer by one CST token. */
  *next(token) {
    if (node_process$1.env.LOG_STREAM)
      console.dir(token, { depth: null });
    switch (token.type) {
      case "directive":
        this.directives.add(token.source, (offset, message, warning) => {
          const pos = getErrorPos(token);
          pos[0] += offset;
          this.onError(pos, "BAD_DIRECTIVE", message, warning);
        });
        this.prelude.push(token.source);
        this.atDirectives = true;
        break;
      case "document": {
        const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
        if (this.atDirectives && !doc.directives.docStart)
          this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
        this.decorate(doc, false);
        if (this.doc)
          yield this.doc;
        this.doc = doc;
        this.atDirectives = false;
        break;
      }
      case "byte-order-mark":
      case "space":
        break;
      case "comment":
      case "newline":
        this.prelude.push(token.source);
        break;
      case "error": {
        const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
        const error = new errors$3.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
        if (this.atDirectives || !this.doc)
          this.errors.push(error);
        else
          this.doc.errors.push(error);
        break;
      }
      case "doc-end": {
        if (!this.doc) {
          const msg = "Unexpected doc-end without preceding document";
          this.errors.push(new errors$3.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
          break;
        }
        this.doc.directives.docEnd = true;
        const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
        this.decorate(this.doc, true);
        if (end.comment) {
          const dc = this.doc.comment;
          this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
        }
        this.doc.range[2] = end.offset;
        break;
      }
      default:
        this.errors.push(new errors$3.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
    }
  }
  /**
   * Call at end of input to yield any remaining document.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *end(forceDoc = false, endOffset = -1) {
    if (this.doc) {
      this.decorate(this.doc, true);
      yield this.doc;
      this.doc = null;
    } else if (forceDoc) {
      const opts = Object.assign({ _directives: this.directives }, this.options);
      const doc = new Document$1.Document(void 0, opts);
      if (this.atDirectives)
        this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
      doc.range = [0, endOffset, endOffset];
      this.decorate(doc, false);
      yield doc;
    }
  }
}
composer$1.Composer = Composer;
var cst$2 = {};
var cstScalar$1 = {};
var resolveBlockScalar = resolveBlockScalar$3;
var resolveFlowScalar = resolveFlowScalar$3;
var errors$2 = errors$4;
var stringifyString = stringifyString$5;
function resolveAsScalar(token, strict = true, onError) {
  if (token) {
    const _onError = (pos, code, message) => {
      const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
      if (onError)
        onError(offset, code, message);
      else
        throw new errors$2.YAMLParseError([offset, offset + 1], code, message);
    };
    switch (token.type) {
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
      case "block-scalar":
        return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
    }
  }
  return null;
}
function createScalarToken(value, context) {
  const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
  const source = stringifyString.stringifyString({ type, value }, {
    implicitKey,
    indent: indent > 0 ? " ".repeat(indent) : "",
    inFlow,
    options: { blockQuote: true, lineWidth: -1 }
  });
  const end = context.end ?? [
    { type: "newline", offset: -1, indent, source: "\n" }
  ];
  switch (source[0]) {
    case "|":
    case ">": {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      const props = [
        { type: "block-scalar-header", offset, indent, source: head }
      ];
      if (!addEndtoBlockProps(props, end))
        props.push({ type: "newline", offset: -1, indent, source: "\n" });
      return { type: "block-scalar", offset, indent, props, source: body };
    }
    case '"':
      return { type: "double-quoted-scalar", offset, indent, source, end };
    case "'":
      return { type: "single-quoted-scalar", offset, indent, source, end };
    default:
      return { type: "scalar", offset, indent, source, end };
  }
}
function setScalarValue(token, value, context = {}) {
  let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
  let indent = "indent" in token ? token.indent : null;
  if (afterKey && typeof indent === "number")
    indent += 2;
  if (!type)
    switch (token.type) {
      case "single-quoted-scalar":
        type = "QUOTE_SINGLE";
        break;
      case "double-quoted-scalar":
        type = "QUOTE_DOUBLE";
        break;
      case "block-scalar": {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
        break;
      }
      default:
        type = "PLAIN";
    }
  const source = stringifyString.stringifyString({ type, value }, {
    implicitKey: implicitKey || indent === null,
    indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
    inFlow,
    options: { blockQuote: true, lineWidth: -1 }
  });
  switch (source[0]) {
    case "|":
    case ">":
      setBlockScalarValue(token, source);
      break;
    case '"':
      setFlowScalarValue(token, source, "double-quoted-scalar");
      break;
    case "'":
      setFlowScalarValue(token, source, "single-quoted-scalar");
      break;
    default:
      setFlowScalarValue(token, source, "scalar");
  }
}
function setBlockScalarValue(token, source) {
  const he = source.indexOf("\n");
  const head = source.substring(0, he);
  const body = source.substring(he + 1) + "\n";
  if (token.type === "block-scalar") {
    const header = token.props[0];
    if (header.type !== "block-scalar-header")
      throw new Error("Invalid block scalar header");
    header.source = head;
    token.source = body;
  } else {
    const { offset } = token;
    const indent = "indent" in token ? token.indent : -1;
    const props = [
      { type: "block-scalar-header", offset, indent, source: head }
    ];
    if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
      props.push({ type: "newline", offset: -1, indent, source: "\n" });
    for (const key of Object.keys(token))
      if (key !== "type" && key !== "offset")
        delete token[key];
    Object.assign(token, { type: "block-scalar", indent, props, source: body });
  }
}
function addEndtoBlockProps(props, end) {
  if (end)
    for (const st of end)
      switch (st.type) {
        case "space":
        case "comment":
          props.push(st);
          break;
        case "newline":
          props.push(st);
          return true;
      }
  return false;
}
function setFlowScalarValue(token, source, type) {
  switch (token.type) {
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      token.type = type;
      token.source = source;
      break;
    case "block-scalar": {
      const end = token.props.slice(1);
      let oa = source.length;
      if (token.props[0].type === "block-scalar-header")
        oa -= token.props[0].source.length;
      for (const tok of end)
        tok.offset += oa;
      delete token.props;
      Object.assign(token, { type, source, end });
      break;
    }
    case "block-map":
    case "block-seq": {
      const offset = token.offset + source.length;
      const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
      delete token.items;
      Object.assign(token, { type, source, end: [nl] });
      break;
    }
    default: {
      const indent = "indent" in token ? token.indent : -1;
      const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
      for (const key of Object.keys(token))
        if (key !== "type" && key !== "offset")
          delete token[key];
      Object.assign(token, { type, indent, source, end });
    }
  }
}
cstScalar$1.createScalarToken = createScalarToken;
cstScalar$1.resolveAsScalar = resolveAsScalar;
cstScalar$1.setScalarValue = setScalarValue;
var cstStringify$1 = {};
const stringify$1 = (cst2) => "type" in cst2 ? stringifyToken(cst2) : stringifyItem(cst2);
function stringifyToken(token) {
  switch (token.type) {
    case "block-scalar": {
      let res = "";
      for (const tok of token.props)
        res += stringifyToken(tok);
      return res + token.source;
    }
    case "block-map":
    case "block-seq": {
      let res = "";
      for (const item of token.items)
        res += stringifyItem(item);
      return res;
    }
    case "flow-collection": {
      let res = token.start.source;
      for (const item of token.items)
        res += stringifyItem(item);
      for (const st of token.end)
        res += st.source;
      return res;
    }
    case "document": {
      let res = stringifyItem(token);
      if (token.end)
        for (const st of token.end)
          res += st.source;
      return res;
    }
    default: {
      let res = token.source;
      if ("end" in token && token.end)
        for (const st of token.end)
          res += st.source;
      return res;
    }
  }
}
function stringifyItem({ start, key, sep, value }) {
  let res = "";
  for (const st of start)
    res += st.source;
  if (key)
    res += stringifyToken(key);
  if (sep)
    for (const st of sep)
      res += st.source;
  if (value)
    res += stringifyToken(value);
  return res;
}
cstStringify$1.stringify = stringify$1;
var cstVisit$1 = {};
const BREAK = Symbol("break visit");
const SKIP = Symbol("skip children");
const REMOVE = Symbol("remove item");
function visit$1(cst2, visitor) {
  if ("type" in cst2 && cst2.type === "document")
    cst2 = { start: cst2.start, value: cst2.value };
  _visit(Object.freeze([]), cst2, visitor);
}
visit$1.BREAK = BREAK;
visit$1.SKIP = SKIP;
visit$1.REMOVE = REMOVE;
visit$1.itemAtPath = (cst2, path) => {
  let item = cst2;
  for (const [field, index] of path) {
    const tok = item?.[field];
    if (tok && "items" in tok) {
      item = tok.items[index];
    } else
      return void 0;
  }
  return item;
};
visit$1.parentCollection = (cst2, path) => {
  const parent = visit$1.itemAtPath(cst2, path.slice(0, -1));
  const field = path[path.length - 1][0];
  const coll = parent?.[field];
  if (coll && "items" in coll)
    return coll;
  throw new Error("Parent collection not found");
};
function _visit(path, item, visitor) {
  let ctrl = visitor(item, path);
  if (typeof ctrl === "symbol")
    return ctrl;
  for (const field of ["key", "value"]) {
    const token = item[field];
    if (token && "items" in token) {
      for (let i = 0; i < token.items.length; ++i) {
        const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          token.items.splice(i, 1);
          i -= 1;
        }
      }
      if (typeof ctrl === "function" && field === "key")
        ctrl = ctrl(item, path);
    }
  }
  return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
}
cstVisit$1.visit = visit$1;
var cstScalar = cstScalar$1;
var cstStringify = cstStringify$1;
var cstVisit = cstVisit$1;
const BOM = "\uFEFF";
const DOCUMENT = "";
const FLOW_END = "";
const SCALAR = "";
const isCollection = (token) => !!token && "items" in token;
const isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
function prettyToken(token) {
  switch (token) {
    case BOM:
      return "<BOM>";
    case DOCUMENT:
      return "<DOC>";
    case FLOW_END:
      return "<FLOW_END>";
    case SCALAR:
      return "<SCALAR>";
    default:
      return JSON.stringify(token);
  }
}
function tokenType(source) {
  switch (source) {
    case BOM:
      return "byte-order-mark";
    case DOCUMENT:
      return "doc-mode";
    case FLOW_END:
      return "flow-error-end";
    case SCALAR:
      return "scalar";
    case "---":
      return "doc-start";
    case "...":
      return "doc-end";
    case "":
    case "\n":
    case "\r\n":
      return "newline";
    case "-":
      return "seq-item-ind";
    case "?":
      return "explicit-key-ind";
    case ":":
      return "map-value-ind";
    case "{":
      return "flow-map-start";
    case "}":
      return "flow-map-end";
    case "[":
      return "flow-seq-start";
    case "]":
      return "flow-seq-end";
    case ",":
      return "comma";
  }
  switch (source[0]) {
    case " ":
    case "	":
      return "space";
    case "#":
      return "comment";
    case "%":
      return "directive-line";
    case "*":
      return "alias";
    case "&":
      return "anchor";
    case "!":
      return "tag";
    case "'":
      return "single-quoted-scalar";
    case '"':
      return "double-quoted-scalar";
    case "|":
    case ">":
      return "block-scalar-header";
  }
  return null;
}
cst$2.createScalarToken = cstScalar.createScalarToken;
cst$2.resolveAsScalar = cstScalar.resolveAsScalar;
cst$2.setScalarValue = cstScalar.setScalarValue;
cst$2.stringify = cstStringify.stringify;
cst$2.visit = cstVisit.visit;
cst$2.BOM = BOM;
cst$2.DOCUMENT = DOCUMENT;
cst$2.FLOW_END = FLOW_END;
cst$2.SCALAR = SCALAR;
cst$2.isCollection = isCollection;
cst$2.isScalar = isScalar;
cst$2.prettyToken = prettyToken;
cst$2.tokenType = tokenType;
var lexer$1 = {};
var cst$1 = cst$2;
function isEmpty(ch) {
  switch (ch) {
    case void 0:
    case " ":
    case "\n":
    case "\r":
    case "	":
      return true;
    default:
      return false;
  }
}
const hexDigits = new Set("0123456789ABCDEFabcdef");
const tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
const flowIndicatorChars = new Set(",[]{}");
const invalidAnchorChars = new Set(" ,[]{}\n\r	");
const isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
class Lexer {
  constructor() {
    this.atEnd = false;
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    this.buffer = "";
    this.flowKey = false;
    this.flowLevel = 0;
    this.indentNext = 0;
    this.indentValue = 0;
    this.lineEndPos = null;
    this.next = null;
    this.pos = 0;
  }
  /**
   * Generate YAML tokens from the `source` string. If `incomplete`,
   * a part of the last line may be left as a buffer for the next call.
   *
   * @returns A generator of lexical tokens
   */
  *lex(source, incomplete = false) {
    if (source) {
      if (typeof source !== "string")
        throw TypeError("source is not a string");
      this.buffer = this.buffer ? this.buffer + source : source;
      this.lineEndPos = null;
    }
    this.atEnd = !incomplete;
    let next = this.next ?? "stream";
    while (next && (incomplete || this.hasChars(1)))
      next = yield* this.parseNext(next);
  }
  atLineEnd() {
    let i = this.pos;
    let ch = this.buffer[i];
    while (ch === " " || ch === "	")
      ch = this.buffer[++i];
    if (!ch || ch === "#" || ch === "\n")
      return true;
    if (ch === "\r")
      return this.buffer[i + 1] === "\n";
    return false;
  }
  charAt(n) {
    return this.buffer[this.pos + n];
  }
  continueScalar(offset) {
    let ch = this.buffer[offset];
    if (this.indentNext > 0) {
      let indent = 0;
      while (ch === " ")
        ch = this.buffer[++indent + offset];
      if (ch === "\r") {
        const next = this.buffer[indent + offset + 1];
        if (next === "\n" || !next && !this.atEnd)
          return offset + indent + 1;
      }
      return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
    }
    if (ch === "-" || ch === ".") {
      const dt = this.buffer.substr(offset, 3);
      if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
        return -1;
    }
    return offset;
  }
  getLine() {
    let end = this.lineEndPos;
    if (typeof end !== "number" || end !== -1 && end < this.pos) {
      end = this.buffer.indexOf("\n", this.pos);
      this.lineEndPos = end;
    }
    if (end === -1)
      return this.atEnd ? this.buffer.substring(this.pos) : null;
    if (this.buffer[end - 1] === "\r")
      end -= 1;
    return this.buffer.substring(this.pos, end);
  }
  hasChars(n) {
    return this.pos + n <= this.buffer.length;
  }
  setNext(state) {
    this.buffer = this.buffer.substring(this.pos);
    this.pos = 0;
    this.lineEndPos = null;
    this.next = state;
    return null;
  }
  peek(n) {
    return this.buffer.substr(this.pos, n);
  }
  *parseNext(next) {
    switch (next) {
      case "stream":
        return yield* this.parseStream();
      case "line-start":
        return yield* this.parseLineStart();
      case "block-start":
        return yield* this.parseBlockStart();
      case "doc":
        return yield* this.parseDocument();
      case "flow":
        return yield* this.parseFlowCollection();
      case "quoted-scalar":
        return yield* this.parseQuotedScalar();
      case "block-scalar":
        return yield* this.parseBlockScalar();
      case "plain-scalar":
        return yield* this.parsePlainScalar();
    }
  }
  *parseStream() {
    let line = this.getLine();
    if (line === null)
      return this.setNext("stream");
    if (line[0] === cst$1.BOM) {
      yield* this.pushCount(1);
      line = line.substring(1);
    }
    if (line[0] === "%") {
      let dirEnd = line.length;
      let cs = line.indexOf("#");
      while (cs !== -1) {
        const ch = line[cs - 1];
        if (ch === " " || ch === "	") {
          dirEnd = cs - 1;
          break;
        } else {
          cs = line.indexOf("#", cs + 1);
        }
      }
      while (true) {
        const ch = line[dirEnd - 1];
        if (ch === " " || ch === "	")
          dirEnd -= 1;
        else
          break;
      }
      const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
      yield* this.pushCount(line.length - n);
      this.pushNewline();
      return "stream";
    }
    if (this.atLineEnd()) {
      const sp = yield* this.pushSpaces(true);
      yield* this.pushCount(line.length - sp);
      yield* this.pushNewline();
      return "stream";
    }
    yield cst$1.DOCUMENT;
    return yield* this.parseLineStart();
  }
  *parseLineStart() {
    const ch = this.charAt(0);
    if (!ch && !this.atEnd)
      return this.setNext("line-start");
    if (ch === "-" || ch === ".") {
      if (!this.atEnd && !this.hasChars(4))
        return this.setNext("line-start");
      const s = this.peek(3);
      if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
        yield* this.pushCount(3);
        this.indentValue = 0;
        this.indentNext = 0;
        return s === "---" ? "doc" : "stream";
      }
    }
    this.indentValue = yield* this.pushSpaces(false);
    if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
      this.indentNext = this.indentValue;
    return yield* this.parseBlockStart();
  }
  *parseBlockStart() {
    const [ch0, ch1] = this.peek(2);
    if (!ch1 && !this.atEnd)
      return this.setNext("block-start");
    if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
      const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
      this.indentNext = this.indentValue + 1;
      this.indentValue += n;
      return "block-start";
    }
    return "doc";
  }
  *parseDocument() {
    yield* this.pushSpaces(true);
    const line = this.getLine();
    if (line === null)
      return this.setNext("doc");
    let n = yield* this.pushIndicators();
    switch (line[n]) {
      case "#":
        yield* this.pushCount(line.length - n);
      case void 0:
        yield* this.pushNewline();
        return yield* this.parseLineStart();
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel = 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        return "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "doc";
      case '"':
      case "'":
        return yield* this.parseQuotedScalar();
      case "|":
      case ">":
        n += yield* this.parseBlockScalarHeader();
        n += yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - n);
        yield* this.pushNewline();
        return yield* this.parseBlockScalar();
      default:
        return yield* this.parsePlainScalar();
    }
  }
  *parseFlowCollection() {
    let nl, sp;
    let indent = -1;
    do {
      nl = yield* this.pushNewline();
      if (nl > 0) {
        sp = yield* this.pushSpaces(false);
        this.indentValue = indent = sp;
      } else {
        sp = 0;
      }
      sp += yield* this.pushSpaces(true);
    } while (nl + sp > 0);
    const line = this.getLine();
    if (line === null)
      return this.setNext("flow");
    if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
      const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
      if (!atFlowEndMarker) {
        this.flowLevel = 0;
        yield cst$1.FLOW_END;
        return yield* this.parseLineStart();
      }
    }
    let n = 0;
    while (line[n] === ",") {
      n += yield* this.pushCount(1);
      n += yield* this.pushSpaces(true);
      this.flowKey = false;
    }
    n += yield* this.pushIndicators();
    switch (line[n]) {
      case void 0:
        return "flow";
      case "#":
        yield* this.pushCount(line.length - n);
        return "flow";
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel += 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        this.flowKey = true;
        this.flowLevel -= 1;
        return this.flowLevel ? "flow" : "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "flow";
      case '"':
      case "'":
        this.flowKey = true;
        return yield* this.parseQuotedScalar();
      case ":": {
        const next = this.charAt(1);
        if (this.flowKey || isEmpty(next) || next === ",") {
          this.flowKey = false;
          yield* this.pushCount(1);
          yield* this.pushSpaces(true);
          return "flow";
        }
      }
      default:
        this.flowKey = false;
        return yield* this.parsePlainScalar();
    }
  }
  *parseQuotedScalar() {
    const quote = this.charAt(0);
    let end = this.buffer.indexOf(quote, this.pos + 1);
    if (quote === "'") {
      while (end !== -1 && this.buffer[end + 1] === "'")
        end = this.buffer.indexOf("'", end + 2);
    } else {
      while (end !== -1) {
        let n = 0;
        while (this.buffer[end - 1 - n] === "\\")
          n += 1;
        if (n % 2 === 0)
          break;
        end = this.buffer.indexOf('"', end + 1);
      }
    }
    const qb = this.buffer.substring(0, end);
    let nl = qb.indexOf("\n", this.pos);
    if (nl !== -1) {
      while (nl !== -1) {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = qb.indexOf("\n", cs);
      }
      if (nl !== -1) {
        end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
      }
    }
    if (end === -1) {
      if (!this.atEnd)
        return this.setNext("quoted-scalar");
      end = this.buffer.length;
    }
    yield* this.pushToIndex(end + 1, false);
    return this.flowLevel ? "flow" : "doc";
  }
  *parseBlockScalarHeader() {
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    let i = this.pos;
    while (true) {
      const ch = this.buffer[++i];
      if (ch === "+")
        this.blockScalarKeep = true;
      else if (ch > "0" && ch <= "9")
        this.blockScalarIndent = Number(ch) - 1;
      else if (ch !== "-")
        break;
    }
    return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
  }
  *parseBlockScalar() {
    let nl = this.pos - 1;
    let indent = 0;
    let ch;
    loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
      switch (ch) {
        case " ":
          indent += 1;
          break;
        case "\n":
          nl = i2;
          indent = 0;
          break;
        case "\r": {
          const next = this.buffer[i2 + 1];
          if (!next && !this.atEnd)
            return this.setNext("block-scalar");
          if (next === "\n")
            break;
        }
        default:
          break loop;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("block-scalar");
    if (indent >= this.indentNext) {
      if (this.blockScalarIndent === -1)
        this.indentNext = indent;
      else {
        this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
      }
      do {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = this.buffer.indexOf("\n", cs);
      } while (nl !== -1);
      if (nl === -1) {
        if (!this.atEnd)
          return this.setNext("block-scalar");
        nl = this.buffer.length;
      }
    }
    let i = nl + 1;
    ch = this.buffer[i];
    while (ch === " ")
      ch = this.buffer[++i];
    if (ch === "	") {
      while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
        ch = this.buffer[++i];
      nl = i - 1;
    } else if (!this.blockScalarKeep) {
      do {
        let i2 = nl - 1;
        let ch2 = this.buffer[i2];
        if (ch2 === "\r")
          ch2 = this.buffer[--i2];
        const lastChar = i2;
        while (ch2 === " ")
          ch2 = this.buffer[--i2];
        if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
          nl = i2;
        else
          break;
      } while (true);
    }
    yield cst$1.SCALAR;
    yield* this.pushToIndex(nl + 1, true);
    return yield* this.parseLineStart();
  }
  *parsePlainScalar() {
    const inFlow = this.flowLevel > 0;
    let end = this.pos - 1;
    let i = this.pos - 1;
    let ch;
    while (ch = this.buffer[++i]) {
      if (ch === ":") {
        const next = this.buffer[i + 1];
        if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
          break;
        end = i;
      } else if (isEmpty(ch)) {
        let next = this.buffer[i + 1];
        if (ch === "\r") {
          if (next === "\n") {
            i += 1;
            ch = "\n";
            next = this.buffer[i + 1];
          } else
            end = i;
        }
        if (next === "#" || inFlow && flowIndicatorChars.has(next))
          break;
        if (ch === "\n") {
          const cs = this.continueScalar(i + 1);
          if (cs === -1)
            break;
          i = Math.max(i, cs - 2);
        }
      } else {
        if (inFlow && flowIndicatorChars.has(ch))
          break;
        end = i;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("plain-scalar");
    yield cst$1.SCALAR;
    yield* this.pushToIndex(end + 1, true);
    return inFlow ? "flow" : "doc";
  }
  *pushCount(n) {
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos += n;
      return n;
    }
    return 0;
  }
  *pushToIndex(i, allowEmpty) {
    const s = this.buffer.slice(this.pos, i);
    if (s) {
      yield s;
      this.pos += s.length;
      return s.length;
    } else if (allowEmpty)
      yield "";
    return 0;
  }
  *pushIndicators() {
    let n = 0;
    loop: while (true) {
      switch (this.charAt(0)) {
        case "!":
          n += yield* this.pushTag();
          n += yield* this.pushSpaces(true);
          continue loop;
        case "&":
          n += yield* this.pushUntil(isNotAnchorChar);
          n += yield* this.pushSpaces(true);
          continue loop;
        case "-":
        case "?":
        case ":": {
          const inFlow = this.flowLevel > 0;
          const ch1 = this.charAt(1);
          if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
            if (!inFlow)
              this.indentNext = this.indentValue + 1;
            else if (this.flowKey)
              this.flowKey = false;
            n += yield* this.pushCount(1);
            n += yield* this.pushSpaces(true);
            continue loop;
          }
        }
      }
      break loop;
    }
    return n;
  }
  *pushTag() {
    if (this.charAt(1) === "<") {
      let i = this.pos + 2;
      let ch = this.buffer[i];
      while (!isEmpty(ch) && ch !== ">")
        ch = this.buffer[++i];
      return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
    } else {
      let i = this.pos + 1;
      let ch = this.buffer[i];
      while (ch) {
        if (tagChars.has(ch))
          ch = this.buffer[++i];
        else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
          ch = this.buffer[i += 3];
        } else
          break;
      }
      return yield* this.pushToIndex(i, false);
    }
  }
  *pushNewline() {
    const ch = this.buffer[this.pos];
    if (ch === "\n")
      return yield* this.pushCount(1);
    else if (ch === "\r" && this.charAt(1) === "\n")
      return yield* this.pushCount(2);
    else
      return 0;
  }
  *pushSpaces(allowTabs) {
    let i = this.pos - 1;
    let ch;
    do {
      ch = this.buffer[++i];
    } while (ch === " " || allowTabs && ch === "	");
    const n = i - this.pos;
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos = i;
    }
    return n;
  }
  *pushUntil(test) {
    let i = this.pos;
    let ch = this.buffer[i];
    while (!test(ch))
      ch = this.buffer[++i];
    return yield* this.pushToIndex(i, false);
  }
}
lexer$1.Lexer = Lexer;
var lineCounter$1 = {};
class LineCounter {
  constructor() {
    this.lineStarts = [];
    this.addNewLine = (offset) => this.lineStarts.push(offset);
    this.linePos = (offset) => {
      let low = 0;
      let high = this.lineStarts.length;
      while (low < high) {
        const mid = low + high >> 1;
        if (this.lineStarts[mid] < offset)
          low = mid + 1;
        else
          high = mid;
      }
      if (this.lineStarts[low] === offset)
        return { line: low + 1, col: 1 };
      if (low === 0)
        return { line: 0, col: offset };
      const start = this.lineStarts[low - 1];
      return { line: low, col: offset - start + 1 };
    };
  }
}
lineCounter$1.LineCounter = LineCounter;
var parser$1 = {};
var node_process = require$$0;
var cst = cst$2;
var lexer = lexer$1;
function includesToken(list, type) {
  for (let i = 0; i < list.length; ++i)
    if (list[i].type === type)
      return true;
  return false;
}
function findNonEmptyIndex(list) {
  for (let i = 0; i < list.length; ++i) {
    switch (list[i].type) {
      case "space":
      case "comment":
      case "newline":
        break;
      default:
        return i;
    }
  }
  return -1;
}
function isFlowToken(token) {
  switch (token?.type) {
    case "alias":
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "flow-collection":
      return true;
    default:
      return false;
  }
}
function getPrevProps(parent) {
  switch (parent.type) {
    case "document":
      return parent.start;
    case "block-map": {
      const it = parent.items[parent.items.length - 1];
      return it.sep ?? it.start;
    }
    case "block-seq":
      return parent.items[parent.items.length - 1].start;
    default:
      return [];
  }
}
function getFirstKeyStartProps(prev) {
  if (prev.length === 0)
    return [];
  let i = prev.length;
  loop: while (--i >= 0) {
    switch (prev[i].type) {
      case "doc-start":
      case "explicit-key-ind":
      case "map-value-ind":
      case "seq-item-ind":
      case "newline":
        break loop;
    }
  }
  while (prev[++i]?.type === "space") {
  }
  return prev.splice(i, prev.length);
}
function arrayPushArray(target, source) {
  if (source.length < 1e5)
    Array.prototype.push.apply(target, source);
  else
    for (let i = 0; i < source.length; ++i)
      target.push(source[i]);
}
function fixFlowSeqItems(fc) {
  if (fc.start.type === "flow-seq-start") {
    for (const it of fc.items) {
      if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
        if (it.key)
          it.value = it.key;
        delete it.key;
        if (isFlowToken(it.value)) {
          if (it.value.end)
            arrayPushArray(it.value.end, it.sep);
          else
            it.value.end = it.sep;
        } else
          arrayPushArray(it.start, it.sep);
        delete it.sep;
      }
    }
  }
}
class Parser {
  /**
   * @param onNewLine - If defined, called separately with the start position of
   *   each new line (in `parse()`, including the start of input).
   */
  constructor(onNewLine) {
    this.atNewLine = true;
    this.atScalar = false;
    this.indent = 0;
    this.offset = 0;
    this.onKeyLine = false;
    this.stack = [];
    this.source = "";
    this.type = "";
    this.lexer = new lexer.Lexer();
    this.onNewLine = onNewLine;
  }
  /**
   * Parse `source` as a YAML stream.
   * If `incomplete`, a part of the last line may be left as a buffer for the next call.
   *
   * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
   *
   * @returns A generator of tokens representing each directive, document, and other structure.
   */
  *parse(source, incomplete = false) {
    if (this.onNewLine && this.offset === 0)
      this.onNewLine(0);
    for (const lexeme of this.lexer.lex(source, incomplete))
      yield* this.next(lexeme);
    if (!incomplete)
      yield* this.end();
  }
  /**
   * Advance the parser by the `source` of one lexical token.
   */
  *next(source) {
    this.source = source;
    if (node_process.env.LOG_TOKENS)
      console.log("|", cst.prettyToken(source));
    if (this.atScalar) {
      this.atScalar = false;
      yield* this.step();
      this.offset += source.length;
      return;
    }
    const type = cst.tokenType(source);
    if (!type) {
      const message = `Not a YAML token: ${source}`;
      yield* this.pop({ type: "error", offset: this.offset, message, source });
      this.offset += source.length;
    } else if (type === "scalar") {
      this.atNewLine = false;
      this.atScalar = true;
      this.type = "scalar";
    } else {
      this.type = type;
      yield* this.step();
      switch (type) {
        case "newline":
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine)
            this.onNewLine(this.offset + source.length);
          break;
        case "space":
          if (this.atNewLine && source[0] === " ")
            this.indent += source.length;
          break;
        case "explicit-key-ind":
        case "map-value-ind":
        case "seq-item-ind":
          if (this.atNewLine)
            this.indent += source.length;
          break;
        case "doc-mode":
        case "flow-error-end":
          return;
        default:
          this.atNewLine = false;
      }
      this.offset += source.length;
    }
  }
  /** Call at end of input to push out any remaining constructions */
  *end() {
    while (this.stack.length > 0)
      yield* this.pop();
  }
  get sourceToken() {
    const st = {
      type: this.type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
    return st;
  }
  *step() {
    const top = this.peek(1);
    if (this.type === "doc-end" && top?.type !== "doc-end") {
      while (this.stack.length > 0)
        yield* this.pop();
      this.stack.push({
        type: "doc-end",
        offset: this.offset,
        source: this.source
      });
      return;
    }
    if (!top)
      return yield* this.stream();
    switch (top.type) {
      case "document":
        return yield* this.document(top);
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return yield* this.scalar(top);
      case "block-scalar":
        return yield* this.blockScalar(top);
      case "block-map":
        return yield* this.blockMap(top);
      case "block-seq":
        return yield* this.blockSequence(top);
      case "flow-collection":
        return yield* this.flowCollection(top);
      case "doc-end":
        return yield* this.documentEnd(top);
    }
    yield* this.pop();
  }
  peek(n) {
    return this.stack[this.stack.length - n];
  }
  *pop(error) {
    const token = error ?? this.stack.pop();
    if (!token) {
      const message = "Tried to pop an empty stack";
      yield { type: "error", offset: this.offset, source: "", message };
    } else if (this.stack.length === 0) {
      yield token;
    } else {
      const top = this.peek(1);
      if (token.type === "block-scalar") {
        token.indent = "indent" in top ? top.indent : 0;
      } else if (token.type === "flow-collection" && top.type === "document") {
        token.indent = 0;
      }
      if (token.type === "flow-collection")
        fixFlowSeqItems(token);
      switch (top.type) {
        case "document":
          top.value = token;
          break;
        case "block-scalar":
          top.props.push(token);
          break;
        case "block-map": {
          const it = top.items[top.items.length - 1];
          if (it.value) {
            top.items.push({ start: [], key: token, sep: [] });
            this.onKeyLine = true;
            return;
          } else if (it.sep) {
            it.value = token;
          } else {
            Object.assign(it, { key: token, sep: [] });
            this.onKeyLine = !it.explicitKey;
            return;
          }
          break;
        }
        case "block-seq": {
          const it = top.items[top.items.length - 1];
          if (it.value)
            top.items.push({ start: [], value: token });
          else
            it.value = token;
          break;
        }
        case "flow-collection": {
          const it = top.items[top.items.length - 1];
          if (!it || it.value)
            top.items.push({ start: [], key: token, sep: [] });
          else if (it.sep)
            it.value = token;
          else
            Object.assign(it, { key: token, sep: [] });
          return;
        }
        default:
          yield* this.pop();
          yield* this.pop(token);
      }
      if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
        const last = token.items[token.items.length - 1];
        if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
          if (top.type === "document")
            top.end = last.start;
          else
            top.items.push({ start: last.start });
          token.items.splice(-1, 1);
        }
      }
    }
  }
  *stream() {
    switch (this.type) {
      case "directive-line":
        yield { type: "directive", offset: this.offset, source: this.source };
        return;
      case "byte-order-mark":
      case "space":
      case "comment":
      case "newline":
        yield this.sourceToken;
        return;
      case "doc-mode":
      case "doc-start": {
        const doc = {
          type: "document",
          offset: this.offset,
          start: []
        };
        if (this.type === "doc-start")
          doc.start.push(this.sourceToken);
        this.stack.push(doc);
        return;
      }
    }
    yield {
      type: "error",
      offset: this.offset,
      message: `Unexpected ${this.type} token in YAML stream`,
      source: this.source
    };
  }
  *document(doc) {
    if (doc.value)
      return yield* this.lineEnd(doc);
    switch (this.type) {
      case "doc-start": {
        if (findNonEmptyIndex(doc.start) !== -1) {
          yield* this.pop();
          yield* this.step();
        } else
          doc.start.push(this.sourceToken);
        return;
      }
      case "anchor":
      case "tag":
      case "space":
      case "comment":
      case "newline":
        doc.start.push(this.sourceToken);
        return;
    }
    const bv = this.startBlockValue(doc);
    if (bv)
      this.stack.push(bv);
    else {
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML document`,
        source: this.source
      };
    }
  }
  *scalar(scalar) {
    if (this.type === "map-value-ind") {
      const prev = getPrevProps(this.peek(2));
      const start = getFirstKeyStartProps(prev);
      let sep;
      if (scalar.end) {
        sep = scalar.end;
        sep.push(this.sourceToken);
        delete scalar.end;
      } else
        sep = [this.sourceToken];
      const map2 = {
        type: "block-map",
        offset: scalar.offset,
        indent: scalar.indent,
        items: [{ start, key: scalar, sep }]
      };
      this.onKeyLine = true;
      this.stack[this.stack.length - 1] = map2;
    } else
      yield* this.lineEnd(scalar);
  }
  *blockScalar(scalar) {
    switch (this.type) {
      case "space":
      case "comment":
      case "newline":
        scalar.props.push(this.sourceToken);
        return;
      case "scalar":
        scalar.source = this.source;
        this.atNewLine = true;
        this.indent = 0;
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        yield* this.pop();
        break;
      default:
        yield* this.pop();
        yield* this.step();
    }
  }
  *blockMap(map2) {
    const it = map2.items[map2.items.length - 1];
    switch (this.type) {
      case "newline":
        this.onKeyLine = false;
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          it.start.push(this.sourceToken);
        }
        return;
      case "space":
      case "comment":
        if (it.value) {
          map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          if (this.atIndentedComment(it.start, map2.indent)) {
            const prev = map2.items[map2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              map2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
    }
    if (this.indent >= map2.indent) {
      const atMapIndent = !this.onKeyLine && this.indent === map2.indent;
      const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
      let start = [];
      if (atNextItem && it.sep && !it.value) {
        const nl = [];
        for (let i = 0; i < it.sep.length; ++i) {
          const st = it.sep[i];
          switch (st.type) {
            case "newline":
              nl.push(i);
              break;
            case "space":
              break;
            case "comment":
              if (st.indent > map2.indent)
                nl.length = 0;
              break;
            default:
              nl.length = 0;
          }
        }
        if (nl.length >= 2)
          start = it.sep.splice(nl[1]);
      }
      switch (this.type) {
        case "anchor":
        case "tag":
          if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start });
            this.onKeyLine = true;
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "explicit-key-ind":
          if (!it.sep && !it.explicitKey) {
            it.start.push(this.sourceToken);
            it.explicitKey = true;
          } else if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start, explicitKey: true });
          } else {
            this.stack.push({
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken], explicitKey: true }]
            });
          }
          this.onKeyLine = true;
          return;
        case "map-value-ind":
          if (it.explicitKey) {
            if (!it.sep) {
              if (includesToken(it.start, "newline")) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else {
                const start2 = getFirstKeyStartProps(it.start);
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                });
              }
            } else if (it.value) {
              map2.items.push({ start: [], key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start, key: null, sep: [this.sourceToken] }]
              });
            } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
              const start2 = getFirstKeyStartProps(it.start);
              const key = it.key;
              const sep = it.sep;
              sep.push(this.sourceToken);
              delete it.key;
              delete it.sep;
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: start2, key, sep }]
              });
            } else if (start.length > 0) {
              it.sep = it.sep.concat(start, this.sourceToken);
            } else {
              it.sep.push(this.sourceToken);
            }
          } else {
            if (!it.sep) {
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            } else if (it.value || atNextItem) {
              map2.items.push({ start, key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [], key: null, sep: [this.sourceToken] }]
              });
            } else {
              it.sep.push(this.sourceToken);
            }
          }
          this.onKeyLine = true;
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (atNextItem || it.value) {
            map2.items.push({ start, key: fs, sep: [] });
            this.onKeyLine = true;
          } else if (it.sep) {
            this.stack.push(fs);
          } else {
            Object.assign(it, { key: fs, sep: [] });
            this.onKeyLine = true;
          }
          return;
        }
        default: {
          const bv = this.startBlockValue(map2);
          if (bv) {
            if (bv.type === "block-seq") {
              if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                yield* this.pop({
                  type: "error",
                  offset: this.offset,
                  message: "Unexpected block-seq-ind on same line with key",
                  source: this.source
                });
                return;
              }
            } else if (atMapIndent) {
              map2.items.push({ start });
            }
            this.stack.push(bv);
            return;
          }
        }
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *blockSequence(seq2) {
    const it = seq2.items[seq2.items.length - 1];
    switch (this.type) {
      case "newline":
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            seq2.items.push({ start: [this.sourceToken] });
        } else
          it.start.push(this.sourceToken);
        return;
      case "space":
      case "comment":
        if (it.value)
          seq2.items.push({ start: [this.sourceToken] });
        else {
          if (this.atIndentedComment(it.start, seq2.indent)) {
            const prev = seq2.items[seq2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              seq2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
      case "anchor":
      case "tag":
        if (it.value || this.indent <= seq2.indent)
          break;
        it.start.push(this.sourceToken);
        return;
      case "seq-item-ind":
        if (this.indent !== seq2.indent)
          break;
        if (it.value || includesToken(it.start, "seq-item-ind"))
          seq2.items.push({ start: [this.sourceToken] });
        else
          it.start.push(this.sourceToken);
        return;
    }
    if (this.indent > seq2.indent) {
      const bv = this.startBlockValue(seq2);
      if (bv) {
        this.stack.push(bv);
        return;
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *flowCollection(fc) {
    const it = fc.items[fc.items.length - 1];
    if (this.type === "flow-error-end") {
      let top;
      do {
        yield* this.pop();
        top = this.peek(1);
      } while (top?.type === "flow-collection");
    } else if (fc.end.length === 0) {
      switch (this.type) {
        case "comma":
        case "explicit-key-ind":
          if (!it || it.sep)
            fc.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
        case "map-value-ind":
          if (!it || it.value)
            fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            Object.assign(it, { key: null, sep: [this.sourceToken] });
          return;
        case "space":
        case "comment":
        case "newline":
        case "anchor":
        case "tag":
          if (!it || it.value)
            fc.items.push({ start: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            it.start.push(this.sourceToken);
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (!it || it.value)
            fc.items.push({ start: [], key: fs, sep: [] });
          else if (it.sep)
            this.stack.push(fs);
          else
            Object.assign(it, { key: fs, sep: [] });
          return;
        }
        case "flow-map-end":
        case "flow-seq-end":
          fc.end.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(fc);
      if (bv)
        this.stack.push(bv);
      else {
        yield* this.pop();
        yield* this.step();
      }
    } else {
      const parent = this.peek(2);
      if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
        yield* this.pop();
        yield* this.step();
      } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        fixFlowSeqItems(fc);
        const sep = fc.end.splice(1, fc.end.length);
        sep.push(this.sourceToken);
        const map2 = {
          type: "block-map",
          offset: fc.offset,
          indent: fc.indent,
          items: [{ start, key: fc, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map2;
      } else {
        yield* this.lineEnd(fc);
      }
    }
  }
  flowScalar(type) {
    if (this.onNewLine) {
      let nl = this.source.indexOf("\n") + 1;
      while (nl !== 0) {
        this.onNewLine(this.offset + nl);
        nl = this.source.indexOf("\n", nl) + 1;
      }
    }
    return {
      type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
  }
  startBlockValue(parent) {
    switch (this.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return this.flowScalar(this.type);
      case "block-scalar-header":
        return {
          type: "block-scalar",
          offset: this.offset,
          indent: this.indent,
          props: [this.sourceToken],
          source: ""
        };
      case "flow-map-start":
      case "flow-seq-start":
        return {
          type: "flow-collection",
          offset: this.offset,
          indent: this.indent,
          start: this.sourceToken,
          items: [],
          end: []
        };
      case "seq-item-ind":
        return {
          type: "block-seq",
          offset: this.offset,
          indent: this.indent,
          items: [{ start: [this.sourceToken] }]
        };
      case "explicit-key-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        start.push(this.sourceToken);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, explicitKey: true }]
        };
      }
      case "map-value-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, key: null, sep: [this.sourceToken] }]
        };
      }
    }
    return null;
  }
  atIndentedComment(start, indent) {
    if (this.type !== "comment")
      return false;
    if (this.indent <= indent)
      return false;
    return start.every((st) => st.type === "newline" || st.type === "space");
  }
  *documentEnd(docEnd) {
    if (this.type !== "doc-mode") {
      if (docEnd.end)
        docEnd.end.push(this.sourceToken);
      else
        docEnd.end = [this.sourceToken];
      if (this.type === "newline")
        yield* this.pop();
    }
  }
  *lineEnd(token) {
    switch (this.type) {
      case "comma":
      case "doc-start":
      case "doc-end":
      case "flow-seq-end":
      case "flow-map-end":
      case "map-value-ind":
        yield* this.pop();
        yield* this.step();
        break;
      case "newline":
        this.onKeyLine = false;
      case "space":
      case "comment":
      default:
        if (token.end)
          token.end.push(this.sourceToken);
        else
          token.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
    }
  }
}
parser$1.Parser = Parser;
var publicApi$1 = {};
var composer = composer$1;
var Document2 = Document$4;
var errors$1 = errors$4;
var log = log$2;
var identity$1 = identity$x;
var lineCounter = lineCounter$1;
var parser = parser$1;
function parseOptions(options) {
  const prettyErrors = options.prettyErrors !== false;
  const lineCounter$12 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
  return { lineCounter: lineCounter$12, prettyErrors };
}
function parseAllDocuments(source, options = {}) {
  const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
  const parser$12 = new parser.Parser(lineCounter2?.addNewLine);
  const composer$12 = new composer.Composer(options);
  const docs = Array.from(composer$12.compose(parser$12.parse(source)));
  if (prettyErrors && lineCounter2)
    for (const doc of docs) {
      doc.errors.forEach(errors$1.prettifyError(source, lineCounter2));
      doc.warnings.forEach(errors$1.prettifyError(source, lineCounter2));
    }
  if (docs.length > 0)
    return docs;
  return Object.assign([], { empty: true }, composer$12.streamInfo());
}
function parseDocument(source, options = {}) {
  const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
  const parser$12 = new parser.Parser(lineCounter2?.addNewLine);
  const composer$12 = new composer.Composer(options);
  let doc = null;
  for (const _doc of composer$12.compose(parser$12.parse(source), true, source.length)) {
    if (!doc)
      doc = _doc;
    else if (doc.options.logLevel !== "silent") {
      doc.errors.push(new errors$1.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
      break;
    }
  }
  if (prettyErrors && lineCounter2) {
    doc.errors.forEach(errors$1.prettifyError(source, lineCounter2));
    doc.warnings.forEach(errors$1.prettifyError(source, lineCounter2));
  }
  return doc;
}
function parse$1(src, reviver, options) {
  let _reviver = void 0;
  if (typeof reviver === "function") {
    _reviver = reviver;
  } else if (options === void 0 && reviver && typeof reviver === "object") {
    options = reviver;
  }
  const doc = parseDocument(src, options);
  if (!doc)
    return null;
  doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
  if (doc.errors.length > 0) {
    if (doc.options.logLevel !== "silent")
      throw doc.errors[0];
    else
      doc.errors = [];
  }
  return doc.toJS(Object.assign({ reviver: _reviver }, options));
}
function stringify(value, replacer, options) {
  let _replacer = null;
  if (typeof replacer === "function" || Array.isArray(replacer)) {
    _replacer = replacer;
  } else if (options === void 0 && replacer) {
    options = replacer;
  }
  if (typeof options === "string")
    options = options.length;
  if (typeof options === "number") {
    const indent = Math.round(options);
    options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
  }
  if (value === void 0) {
    const { keepUndefined } = options ?? replacer ?? {};
    if (!keepUndefined)
      return void 0;
  }
  if (identity$1.isDocument(value) && !_replacer)
    return value.toString(options);
  return new Document2.Document(value, _replacer, options).toString(options);
}
publicApi$1.parse = parse$1;
publicApi$1.parseAllDocuments = parseAllDocuments;
publicApi$1.parseDocument = parseDocument;
publicApi$1.stringify = stringify;
var errors = errors$4;
var identity = identity$x;
var Pair2 = Pair$8;
var Scalar2 = Scalar$k;
var YAMLMap2 = YAMLMap$8;
var publicApi = publicApi$1;
var visit = visit$6;
errors.YAMLError;
errors.YAMLParseError;
errors.YAMLWarning;
identity.isAlias;
identity.isCollection;
identity.isDocument;
identity.isMap;
identity.isNode;
identity.isPair;
identity.isScalar;
identity.isSeq;
Pair2.Pair;
Scalar2.Scalar;
YAMLMap2.YAMLMap;
var parse = publicApi.parse;
visit.visit;
visit.visitAsync;
const DiagnosticCodes = {
  PARSE_ERROR: "ASPEC_PARSE_001",
  SCHEMA_ERROR: "ASPEC_SCHEMA_001",
  STYLE_NO_PURPOSE: "ASPEC_STYLE_001",
  STYLE_NO_MODULE_DESC: "ASPEC_STYLE_002",
  STYLE_NO_PROCESS_DESC: "ASPEC_STYLE_003",
  STYLE_NO_DECOMP: "ASPEC_STYLE_004",
  STYLE_NO_OTHERS: "ASPEC_STYLE_005",
  STYLE_DUPLICATE_ID: "ASPEC_STYLE_006",
  STYLE_DUPLICATE_NAME: "ASPEC_STYLE_010",
  REFINE_TYPE_FALLBACK: "ASPEC_REFINE_001",
  BOOK_ALIGN_NO_FUNCTIONS: "BOOK_ALIGN_001",
  BOOK_ALIGN_DATA_REFS: "BOOK_ALIGN_002",
  BOOK_ALIGN_CONSTRAINT_REFS: "BOOK_ALIGN_003",
  BOOK_ALIGN_NO_CONSTRAINTS: "BOOK_ALIGN_004",
  BOOK_ALIGN_SYMMETRIC: "BOOK_ALIGN_005",
  BOOK_ALIGN_SHARED_DATA: "BOOK_ALIGN_006",
  BOOK_ALIGN_FUNCTION_FORMAT: "BOOK_ALIGN_007",
  BOOK_ALIGN_DATA_FORMAT: "BOOK_ALIGN_008",
  BOOK_ALIGN_CONSTRAINT_FORMAT: "BOOK_ALIGN_009",
  INFORMAL_UNKNOWN_SECTION: "ASPEC_MD_001",
  INFORMAL_ORPHAN_HEADING: "ASPEC_MD_002",
  INFORMAL_MISSING_SECTION: "ASPEC_MD_003",
  INFORMAL_EMPTY_TITLE: "ASPEC_MD_004"
};
function createDiagnostic(code, message, severity, path) {
  return { code, message, severity, path };
}
function detectAspecFormat(source) {
  const head = source.slice(0, 2500);
  if (/^aspecVersion\s*:/m.test(head) && /^(meta|system|modules)\s*:/m.test(head)) {
    return "yaml";
  }
  return "markdown";
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
function toIdent(title) {
  const parts = title.trim().split(/[^A-Za-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  if (parts.length === 0)
    return "Item";
  return parts.map((p, i) => {
    if (/^[\u4e00-\u9fff]/.test(p))
      return p;
    const lower = p.toLowerCase();
    if (i === 0)
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join("");
}
function toSnakeIdent(title) {
  const slug = slugify(title).replace(/-/g, "_");
  return slug.replace(/[^\w]/g, "_") || "item";
}
function createNodeId(type, title, used) {
  const prefix = PREFIX[type] ?? "n";
  const base2 = `${prefix}-${slugify(title)}`;
  if (!used.has(base2)) {
    used.add(base2);
    return base2;
  }
  let i = 2;
  while (used.has(`${base2}-${i}`))
    i += 1;
  const id = `${base2}-${i}`;
  used.add(id);
  return id;
}
function createSpecId() {
  return `spec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function emptyInformalSpecification(partial) {
  return {
    id: partial?.id ?? "spec-new",
    moduleId: partial?.moduleId ?? "project",
    version: partial?.version ?? 1,
    metadata: {
      title: "Informal Specification",
      sourceFormat: "markdown",
      ...partial?.metadata
    },
    sections: partial?.sections ?? [
      { id: "sec-fn", type: "functions", title: "Functions", children: [] },
      { id: "sec-dr", type: "data-resources", title: "Data Resources", children: [] },
      { id: "sec-c", type: "constraints", title: "Constraints", children: [] }
    ]
  };
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
        const nested2 = node.metadata?.nested ?? [];
        node.children = nested2.map((c) => c.id);
        walk(nested2, node.id);
      }
    };
    walk(section.children, void 0);
  }
}
function specToTree(spec) {
  const fromFlat = (node) => {
    const nested2 = node.metadata?.nested ?? [];
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      description: node.description,
      parentId: node.parentId,
      metadata: omitNested(node.metadata),
      children: nested2.map(fromFlat)
    };
  };
  return {
    id: spec.id,
    moduleId: spec.moduleId,
    version: spec.version,
    metadata: spec.metadata,
    sections: spec.sections.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      children: s.children.map(fromFlat)
    }))
  };
}
function omitNested(meta) {
  if (!meta)
    return void 0;
  const { nested: _nested, ...rest } = meta;
  return Object.keys(rest).length ? rest : void 0;
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
const HEADING = /^(#+)\s+(.+?)\s*$/;
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
function nested$1(node) {
  return node.metadata?.nested ?? [];
}
function informalToAspec(spec) {
  const title = spec.metadata.title || "Informal Specification";
  const fromModule = spec.moduleId && spec.moduleId !== "project" ? toIdent(spec.moduleId.replace(/^SYSTEM_/i, "")) : "";
  const fromTitle = toIdent(title).replace(/InformalSpecification$/i, "").replace(/InformalSpec$/i, "") || "System";
  const systemName = fromModule || fromTitle;
  const moduleName = systemName.startsWith("SYSTEM_") ? systemName : `SYSTEM_${systemName}`;
  const functions = spec.sections.find((s) => s.type === "functions")?.children ?? [];
  const data = spec.sections.find((s) => s.type === "data-resources")?.children ?? [];
  const constraints = spec.sections.find((s) => s.type === "constraints")?.children ?? [];
  const types = [];
  const variables = [];
  for (const resource of data) {
    const fields = nested$1(resource);
    const typeName = toIdent(resource.title);
    if (fields.length) {
      types.push({
        id: `type-${resource.id}`,
        name: typeName,
        typeHint: composedTypeHint(fields) || "string",
        description: resource.description
      });
    }
    variables.push({
      id: `var-${resource.id}`,
      name: toSnakeIdent(resource.title),
      typeHint: fields.length ? typeName : "string",
      description: resource.description
    });
  }
  const processes = [];
  const walkFn = (node, parentName) => {
    const children = nested$1(node);
    processes.push({
      id: node.id,
      name: toIdent(node.title),
      description: node.description,
      decomposition: children.length ? children.map((c) => toIdent(c.title)).join(", ") : parentName,
      notes: node.description
    });
    for (const child of children)
      walkFn(child, toIdent(node.title));
  };
  for (const fn of functions)
    walkFn(fn);
  const invariants = constraints.map((c) => ({
    id: c.id,
    description: c.title,
    textHint: c.description?.trim() || c.title
  }));
  const bookAlign = {
    functions: functions.map((f, i) => ({
      ref: `F_${i + 1}`,
      description: [f.title, f.description].filter(Boolean).join(" — ")
    })),
    data: data.map((d, i) => ({
      ref: `D_${i + 1}`,
      description: [d.title, d.description].filter(Boolean).join(" — "),
      usedBy: functions.map((_, fi) => `F_${fi + 1}`)
    })),
    constraints: constraints.map((c, i) => ({
      ref: `C_${i + 1}`,
      description: [c.title, c.description].filter(Boolean).join(" — "),
      refs: functions.map((_, fi) => `F_${fi + 1}`)
    }))
  };
  const mod = {
    id: `mod-${spec.moduleId}`,
    name: moduleName,
    description: title,
    types,
    variables,
    invariants,
    processes
  };
  return {
    aspecVersion: "1.0",
    meta: {
      id: spec.id,
      title,
      hybridTarget: spec.metadata.hybridTarget,
      guiTarget: spec.metadata.guiTarget
    },
    system: {
      name: systemName,
      purpose: title
    },
    modules: [mod],
    bookAlign
  };
}
function composedTypeHint(fields) {
  const inner = fields.map((f) => `${toSnakeIdent(f.title)}: string`).join(" ");
  return inner ? `composed of ${inner} end` : "string";
}
function aspecToInformal(document) {
  const used = /* @__PURE__ */ new Set();
  const spec = emptyInformalSpecification({
    id: document.meta.id || createSpecId(),
    moduleId: document.system.name || "project",
    metadata: {
      title: document.meta.title,
      author: document.meta.author,
      hybridTarget: document.meta.hybridTarget,
      guiTarget: document.meta.guiTarget,
      sourceFormat: "yaml"
    }
  });
  const fnSection = spec.sections.find((s) => s.type === "functions");
  const drSection = spec.sections.find((s) => s.type === "data-resources");
  const cSection = spec.sections.find((s) => s.type === "constraints");
  if (document.bookAlign?.functions?.length) {
    fnSection.children = document.bookAlign.functions.map((item) => leaf("function", item.description, used));
  } else {
    for (const mod of document.modules) {
      for (const proc of mod.processes ?? []) {
        fnSection.children.push(leaf("function", proc.name, used, proc.description ?? proc.notes));
      }
    }
  }
  if (document.bookAlign?.data?.length) {
    drSection.children = document.bookAlign.data.map((item) => leaf("data-resource", item.description, used));
  } else {
    for (const mod of document.modules) {
      for (const t of mod.types ?? []) {
        drSection.children.push(leaf("data-resource", t.name, used, t.description));
      }
      for (const v of mod.variables ?? []) {
        if (!drSection.children.some((c) => c.title === v.name)) {
          drSection.children.push(leaf("data-resource", v.name, used, v.description));
        }
      }
    }
  }
  if (document.bookAlign?.constraints?.length) {
    cSection.children = document.bookAlign.constraints.map((item) => leaf("constraint", item.description, used));
  } else {
    for (const mod of document.modules) {
      for (const inv of mod.invariants ?? []) {
        cSection.children.push(leaf("constraint", inv.description || inv.textHint || "Invariant", used, inv.textHint));
      }
    }
  }
  return spec;
}
function leaf(type, title, used, description) {
  const short = title.split(/[—–-]/)[0].trim() || title;
  const id = createNodeId(type, short, used);
  return {
    id,
    type,
    title: short,
    description: description ?? (short === title ? void 0 : title),
    children: []
  };
}
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function normalizeDocument(raw) {
  if (!isRecord(raw))
    return null;
  const aspecVersion = String(raw.aspecVersion ?? "1.0");
  if (!isRecord(raw.meta) || !isRecord(raw.system) || !Array.isArray(raw.modules)) {
    return null;
  }
  const meta = raw.meta;
  const system = raw.system;
  const modules = raw.modules;
  return {
    aspecVersion,
    meta,
    system,
    modules,
    bookAlign: isRecord(raw.bookAlign) ? raw.bookAlign : void 0
  };
}
function parseYamlAspec(source) {
  const diagnostics = [];
  try {
    const raw = parse(source);
    const document = normalizeDocument(raw);
    if (!document) {
      diagnostics.push(createDiagnostic(DiagnosticCodes.SCHEMA_ERROR, "Invalid aspec structure: requires aspecVersion, meta, system, modules", "error"));
      return { document: null, diagnostics, format: "yaml", informal: null };
    }
    return { document, diagnostics, format: "yaml" };
  } catch (e) {
    diagnostics.push(createDiagnostic(DiagnosticCodes.PARSE_ERROR, e instanceof Error ? e.message : String(e), "error"));
    return { document: null, diagnostics, format: "yaml", informal: null };
  }
}
function parseAspec(source, options) {
  if (detectAspecFormat(source) === "markdown") {
    const parsed = parseInformalSpec(source, options);
    if (!parsed.specification) {
      return { document: null, diagnostics: parsed.diagnostics, format: "markdown", informal: null };
    }
    return {
      document: informalToAspec(parsed.specification),
      diagnostics: parsed.diagnostics,
      format: "markdown",
      informal: parsed.specification
    };
  }
  const yaml = parseYamlAspec(source);
  return yaml;
}
function resolveModuleParents(document) {
  const byId = new Map(document.modules.map((m) => [m.id, m]));
  for (const mod of document.modules) {
    if (mod.parent) {
      const parent = byId.get(mod.parent);
      mod.parentModuleName = parent?.name;
    }
  }
}
function contentHash(source) {
  return "sha256:" + node_crypto.createHash("sha256").update(source, "utf8").digest("hex");
}
function sanitizeInformalText(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}
function buildFunctionBody(fn) {
  const hint = fn.bodyHint?.trim();
  if (!hint)
    return "undefined";
  const bottom = fn.refinementHints?.bottomLevel ?? false;
  const formal = fn.refinementHints?.expectedFsfLevel === "formal" || bottom;
  if (formal && /^[a-zA-Z_(]/.test(hint))
    return hint;
  return `informal ${sanitizeInformalText(hint)}`;
}
function shouldRenderFunctionFsf(fn) {
  const level = fn.refinementHints?.expectedFsfLevel;
  return level === "semi-formal" || level === "formal" && Boolean(fn.bodyHint?.trim());
}
function buildFunctionFsf(fn) {
  const hint = fn.bodyHint?.trim();
  const formal = fn.refinementHints?.expectedFsfLevel === "formal" || fn.refinementHints?.bottomLevel;
  if (formal && hint && /^[a-zA-Z_(]/.test(hint)) {
    return `true && ${hint}`;
  }
  const test = hint ? `informal ${sanitizeInformalText(hint)}` : "true";
  return `${test} && true`;
}
function aspecCommentTag(aspecId, _notes) {
  const tag = `aspec_${aspecId.replace(/-/g, "_")}`;
  return `comment: informal ${tag}`;
}
function mapTypeHint(typeHint, warnings, path) {
  if (!typeHint?.trim()) {
    warnings.push(createDiagnostic(DiagnosticCodes.REFINE_TYPE_FALLBACK, `Missing typeHint at ${path}, using nat`, "warning", path));
    return "nat";
  }
  return typeHint.trim();
}
function buildProcessSignature(proc) {
  const inputs = proc.signature?.inputs ?? [];
  const outputs = proc.signature?.outputs ?? [];
  const inPart = inputs.length === 0 ? "" : inputs.length === 1 ? `(${inputs[0].name}: ${inputs[0].typeHint ?? "nat"})` : `(${inputs.map((p) => `${p.name}: ${p.typeHint ?? "nat"}`).join(", ")})`;
  const outPart = outputs.length === 0 ? "" : outputs.map((p) => `${p.name}: ${p.typeHint ?? "nat"}`).join(", ");
  if (inPart && outPart)
    return `${inPart} ${outPart}`;
  if (inPart)
    return inPart;
  if (outPart)
    return `() ${outPart}`;
  return "()";
}
function buildFunctionSignature(fn) {
  const inputs = fn.signature?.inputs ?? [];
  const outputs = fn.signature?.outputs ?? [];
  const inList = inputs.map((p) => `${p.name}: ${p.typeHint ?? "nat"}`).join(", ");
  const ret = outputs[0]?.typeHint ?? "nat";
  return `(${inList}): ${ret}`;
}
function spanOf(field) {
  if (!field || typeof field === "string")
    return null;
  return field.span;
}
function findProcessInProgram(ast, name) {
  for (const mod of ast.modules) {
    const proc = mod.processes.find((p) => p.name === name);
    if (proc)
      return proc;
  }
  return void 0;
}
function mergeExistingAsfl(generated, existing, plans) {
  if (!existing.trim())
    return generated;
  const { ast: genAst } = parser$2.parse(generated);
  const { ast: existAst } = parser$2.parse(existing);
  if (!genAst || genAst.type !== "program" || !existAst || existAst.type !== "program") {
    return generated;
  }
  const replacements = [];
  for (const mod of genAst.modules) {
    for (const genProc of mod.processes) {
      const plan = plans?.find((p) => p.processName === genProc.name);
      const strategy = plan?.strategy ?? "merge_fsf_only";
      if (strategy === "use_generated")
        continue;
      const existProc = findProcessInProgram(existAst, genProc.name);
      if (!existProc)
        continue;
      if (strategy === "keep_hybrid") {
        replacements.push({
          start: genProc.span.start,
          end: genProc.span.end,
          text: existing.slice(existProc.span.start, existProc.span.end)
        });
        continue;
      }
      if (strategy === "merge_fsf_only") {
        if (genProc.body?.pre && existProc.body?.pre) {
          replacements.push({
            start: genProc.body.pre.span.start,
            end: genProc.body.pre.span.end,
            text: existing.slice(existProc.body.pre.span.start, existProc.body.pre.span.end)
          });
        }
        if (genProc.body?.post && existProc.body?.post) {
          replacements.push({
            start: genProc.body.post.span.start,
            end: genProc.body.post.span.end,
            text: existing.slice(existProc.body.post.span.start, existProc.body.post.span.end)
          });
        }
        if (genProc.body?.fsf && existProc.body?.fsf) {
          const genFsf = genProc.body.fsf;
          const existFsf = existProc.body.fsf;
          replacements.push({
            start: genFsf.span.start,
            end: genFsf.span.end,
            text: existing.slice(existFsf.span.start, existFsf.span.end)
          });
        }
        if (genProc.body?.decomposition && existProc.body?.decomposition) {
          const gSpan = spanOf(genProc.body.decomposition);
          const eSpan = spanOf(existProc.body.decomposition);
          if (gSpan && eSpan) {
            replacements.push({
              start: gSpan.start,
              end: gSpan.end,
              text: existing.slice(eSpan.start, eSpan.end)
            });
          }
        }
        if (genProc.body?.comment && existProc.body?.comment) {
          const gSpan = spanOf(genProc.body.comment);
          const eSpan = spanOf(existProc.body.comment);
          if (gSpan && eSpan) {
            replacements.push({
              start: gSpan.start,
              end: gSpan.end,
              text: existing.slice(eSpan.start, eSpan.end)
            });
          }
        }
      }
    }
  }
  replacements.sort((a, b) => b.start - a.start);
  let out = generated;
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}
function buildGuiBlockFromSection(gui$1) {
  return gui.buildSlimGuiBlock(gui$1);
}
function resolveGuiSection(source, guiSource) {
  if (guiSource?.trim()) {
    const { document } = gui.parseGuiSpec(guiSource);
    if (document?.gui.screens.length)
      return document.gui;
    const { gui: gui$1 } = gui.parseGuiFromAspecYaml(guiSource);
    return gui$1;
  }
  return gui.parseGuiFromAspecYaml(source).gui;
}
function buildGuiBlockForRefine(aspecSource, guiSource) {
  const section = resolveGuiSection(aspecSource, guiSource);
  if (!section?.screens?.length)
    return null;
  return buildGuiBlockFromSection(section);
}
function asflSafeClause(text) {
  const cleaned = text.replace(/[''`]/g, "").replace(/[.;!?]+$/g, "").replace(/\s+/g, " ").trim();
  return cleaned || "true";
}
function asflSafeInvariant(text) {
  const t = asflSafeClause(text);
  if (/^(forall|exists|forevery|forsome|true|false|not)\b/i.test(t) || /[=<>]|inset|notin|\|/.test(t)) {
    return t;
  }
  return "true";
}
function buildProcessPost(proc) {
  if (proc.postconditions?.trim())
    return asflSafeClause(proc.postconditions);
  const scens = proc.scenarios ?? [];
  const normal = scens.filter((s) => !s.condition.toLowerCase().includes("other"));
  if (normal.length === 0)
    return "true";
  if (normal.length === 1)
    return asflSafeClause(normal[0].outcome);
  return asflSafeClause(normal.map((s, i) => {
    if (i === 0)
      return `if ${s.condition} then ${s.outcome}`;
    if (i === normal.length - 1)
      return `else ${s.outcome}`;
    return `else if ${s.condition} then ${s.outcome}`;
  }).join(" "));
}
function moduleHeader(mod) {
  if (mod.parentModuleName) {
    return `module ${mod.name} / ${mod.parentModuleName};`;
  }
  return `module ${mod.name};`;
}
function renderModule(mod, warnings, skeletonOnly, guiBlock) {
  const lines = [moduleHeader(mod)];
  if (mod.constants?.length) {
    lines.push("const");
    for (const c of mod.constants) {
      lines.push(`    ${c.name} = ${c.valueHint ?? "0"};`);
    }
  }
  if (mod.types?.length) {
    lines.push("type");
    for (const t of mod.types) {
      const hint = mapTypeHint(t.typeHint, warnings, `types.${t.id}`);
      lines.push(`    ${t.name} = ${hint};`);
    }
  }
  if (mod.variables?.length) {
    lines.push("var");
    for (const v of mod.variables) {
      const hint = mapTypeHint(v.typeHint, warnings, `variables.${v.id}`);
      lines.push(`    ${v.name}: ${hint};`);
    }
  }
  if (mod.invariants?.length) {
    lines.push("inv");
    for (const inv of mod.invariants) {
      lines.push(`    ${asflSafeInvariant(inv.textHint?.trim() || "true")};`);
    }
  }
  if (guiBlock) {
    lines.push(guiBlock.split("\n").join("\n"));
  }
  for (const proc of mod.processes ?? []) {
    lines.push(`process ${proc.name} ${buildProcessSignature(proc)}`);
    const extNames = proc.ext;
    if (!skeletonOnly && Array.isArray(extNames) && extNames.length) {
      lines.push("    ext");
      for (const e of extNames) {
        lines.push(`    ${e.access} ${e.name}${e.typeHint ? `: ${e.typeHint}` : ""}`);
      }
    }
    const pre = asflSafeClause(proc.preconditions?.trim() || "true");
    const post = buildProcessPost(proc);
    lines.push("    pre");
    lines.push(`        ${skeletonOnly ? "true" : pre}`);
    lines.push("    post");
    lines.push(`        ${skeletonOnly ? "true" : post}`);
    if (proc.decomposition?.trim()) {
      lines.push(`    decom: ${proc.decomposition.trim()}`);
    }
    lines.push("    " + aspecCommentTag(proc.id, proc.notes ?? proc.description));
    lines.push("end_process");
  }
  for (const fn of mod.functions ?? []) {
    lines.push(`function ${fn.name} ${buildFunctionSignature(fn)}`);
    if (!skeletonOnly && shouldRenderFunctionFsf(fn)) {
      lines.push("    FSF :");
      lines.push(`    ${buildFunctionFsf(fn)}`);
    } else {
      lines.push(`    == ${skeletonOnly ? "undefined" : buildFunctionBody(fn)}`);
    }
    lines.push("end_function");
  }
  lines.push("end_module");
  return lines.join("\n");
}
function buildLinks(document) {
  const links = [];
  for (const mod of document.modules) {
    links.push({ aspecId: mod.id, kind: "module", asflSymbol: mod.name, status: "covered" });
    for (const p of mod.processes ?? []) {
      links.push({ aspecId: p.id, kind: "process", asflSymbol: p.name, status: "covered" });
      for (const s of p.scenarios ?? []) {
        links.push({ aspecId: s.id, kind: "scenario", asflSymbol: p.name, status: "covered" });
      }
    }
    for (const f of mod.functions ?? []) {
      links.push({ aspecId: f.id, kind: "function", asflSymbol: f.name, status: "covered" });
    }
  }
  return links;
}
function refineToAsfl(document, source, options = {}) {
  resolveModuleParents(document);
  const warnings = [];
  const skeletonOnly = options.skeletonOnly ?? false;
  const guiBlock = options.emitGuiBlock !== false ? buildGuiBlockForRefine(source, options.guiSource) : null;
  const moduleTexts = document.modules.map((m, i) => renderModule(m, warnings, skeletonOnly, i === 0 ? guiBlock : null));
  let asflText = moduleTexts.join(";\n") + "\n";
  if (options.preserveExisting && options.existingAsfl?.trim()) {
    asflText = mergeExistingAsfl(asflText, options.existingAsfl, options.mergePlans);
  }
  const traceability = {
    traceVersion: "1.0",
    aspecUri: options.aspecUri,
    asflUri: options.asflUri ?? document.meta.hybridTarget,
    contentHash: contentHash(source),
    links: buildLinks(document)
  };
  return { asflText, traceability, warnings };
}
function emitNode(node, level) {
  const heading = `${"#".repeat(level)} ${node.title}`;
  const parts = [heading];
  if (node.description?.trim()) {
    parts.push("", node.description.trim());
  }
  for (const child of node.children) {
    parts.push("", emitNode(child, level + 1));
  }
  return parts.join("\n");
}
function serializeInformalSpec(spec) {
  const tree = specToTree(spec);
  const chunks = [];
  const ordered = [...tree.sections].sort((a, b) => sectionDef(a.type).order - sectionDef(b.type).order);
  for (const section of ordered) {
    chunks.push(`# ${section.title}`, "");
    for (const child of section.children) {
      chunks.push(emitNode(child, 2), "");
    }
  }
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
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
function nested(node) {
  return node.metadata?.nested ?? [];
}
function isStructuralTitle(title) {
  return /^(input|output|result|precondition|postcondition)s?$/i.test(title.trim());
}
function inferTypeHint(name, description) {
  const n = `${name} ${description ?? ""}`.toLowerCase();
  if (/\b(balance|amount|limit|rate|price|cash)\b/.test(n))
    return "real";
  if (/\b(id|number|count|qty|quantity|age|nat)\b/.test(n))
    return "nat";
  if (/\b(flag|valid|ok|bool)\b/.test(n))
    return "bool";
  return "string";
}
function parseNamedItems(text) {
  if (!text?.trim())
    return [];
  const items = [];
  for (const line of text.split(/\n/)) {
    const bullet = line.replace(/^\s*[-*]\s*/, "").trim();
    if (!bullet)
      continue;
    const name = toSnakeIdent(bullet.split(/[:–—-]/)[0] || bullet);
    items.push({ name, typeHint: inferTypeHint(name, bullet) });
  }
  return items;
}
function foldSignature(node) {
  let inputs = [];
  let outputs = [];
  let pre;
  let post;
  for (const child of nested(node)) {
    const title = child.title.trim();
    if (/^inputs?$/i.test(title)) {
      inputs = parseNamedItems(child.description);
    } else if (/^(outputs?|results?)$/i.test(title)) {
      const parsed = parseNamedItems(child.description);
      outputs = parsed.length ? parsed : [{ name: "result", typeHint: "string" }];
      if (!parsed.length && child.description?.trim())
        post = child.description.trim();
    } else if (/^preconditions?$/i.test(title)) {
      pre = child.description?.trim();
    } else if (/^postconditions?$/i.test(title)) {
      post = child.description?.trim();
    }
  }
  return { inputs, outputs, pre, post };
}
function informalToHybridIR(spec) {
  const title = spec.metadata.title || spec.moduleId || "System";
  const ident = toIdent(title.replace(/Informal Specification/i, "").trim() || spec.moduleId);
  const moduleName = ident.startsWith("SYSTEM_") ? ident : `SYSTEM_${ident}`;
  const functions = spec.sections.find((s) => s.type === "functions")?.children ?? [];
  const data = spec.sections.find((s) => s.type === "data-resources")?.children ?? [];
  const constraints = spec.sections.find((s) => s.type === "constraints")?.children ?? [];
  const types = [];
  const variables = [];
  for (const resource of data) {
    const fields = nested(resource);
    const typeName = toIdent(resource.title);
    types.push({
      name: typeName,
      informalId: resource.id,
      fields: fields.map((f) => ({
        name: toSnakeIdent(f.title),
        typeHint: inferTypeHint(f.title, f.description),
        description: f.description
      }))
    });
    const isCollection2 = /file|list|set|accounts|users/i.test(resource.title);
    variables.push({
      name: toSnakeIdent(resource.title),
      typeHint: fields.length ? isCollection2 ? `set of ${typeName}` : typeName : inferTypeHint(resource.title, resource.description),
      informalId: resource.id
    });
  }
  const processes = [];
  const walk = (node) => {
    if (isStructuralTitle(node.title))
      return;
    const children = nested(node);
    const behavioral = children.filter((c) => !isStructuralTitle(c.title));
    const folded = foldSignature(node);
    const scenarios = behavioral.map((c) => ({
      id: c.id,
      name: toIdent(c.title),
      guard: c.description?.trim() || c.title,
      definingCondition: c.description?.trim() || c.title,
      exceptional: /fail|error|invalid|unknown|not exist/i.test(`${c.title} ${c.description ?? ""}`)
    }));
    const pre = folded.pre || node.description?.trim() || "true";
    const post = folded.post || (scenarios.length ? scenarios.filter((s) => !s.exceptional).map((s, i, arr) => arr.length === 1 ? s.definingCondition : i === 0 ? `if ${s.guard} then ${s.definingCondition}` : `else ${s.definingCondition}`).join(" ") : node.description?.trim());
    processes.push({
      name: toIdent(node.title),
      informalId: node.id,
      description: node.description,
      inputs: folded.inputs,
      outputs: folded.outputs.length ? folded.outputs : [{ name: "result", typeHint: "string" }],
      pre,
      post,
      preconditions: pre ? [pre] : [],
      postconditions: post ? [post] : [],
      scenarios,
      children: behavioral.map((c) => toIdent(c.title)),
      formalizationStatus: "semi-formal"
    });
    for (const child of behavioral) {
      if (nested(child).some((c) => isStructuralTitle(c.title)))
        walk(child);
    }
  };
  for (const fn of functions)
    walk(fn);
  return {
    moduleName,
    types,
    variables,
    processes,
    invariants: constraints.map((c) => ({
      name: toIdent(c.title),
      informalId: c.id,
      description: c.description?.trim() || c.title
    }))
  };
}
function hybridIRToAspec(spec, ir) {
  const modules = ir.modules?.length ? ir.modules : [
    {
      id: `mod-${spec.moduleId}`,
      name: ir.moduleName,
      types: ir.types,
      variables: ir.variables,
      processes: ir.processes,
      invariants: ir.invariants
    }
  ];
  return {
    aspecVersion: "1.0",
    meta: {
      id: spec.id,
      title: spec.metadata.title ?? ir.moduleName,
      hybridTarget: spec.metadata.hybridTarget
    },
    system: {
      name: ir.moduleName.replace(/^SYSTEM_/, ""),
      purpose: spec.metadata.title ?? ir.moduleName
    },
    modules: modules.map((m, mi) => {
      const processes = m.processes.map((p) => ({
        id: p.informalId ?? p.id ?? `proc-${p.name}`,
        name: p.name,
        description: p.description,
        signature: {
          inputs: p.inputs.map((i) => ({ name: i.name, typeHint: i.typeHint })),
          outputs: p.outputs.map((o) => ({ name: o.name, typeHint: o.typeHint }))
        },
        preconditions: p.pre || p.preconditions.join("\n") || void 0,
        postconditions: p.post || p.postconditions.join("\n") || void 0,
        scenarios: (p.scenarios ?? []).map((s, i) => ({
          id: s.id ?? `${p.informalId ?? p.name}-s${i + 1}`,
          condition: s.guard,
          outcome: s.definingCondition
        })),
        decomposition: p.children?.length ? `${p.name}_Decom` : void 0
      }));
      return {
        id: m.id ?? `mod-${spec.moduleId}-${mi}`,
        name: m.name,
        description: spec.metadata.title ?? m.name,
        types: m.types.map((t) => ({
          id: t.informalId ?? t.id ?? `type-${t.name}`,
          name: t.name,
          typeHint: t.fields.length ? `composed of ${t.fields.map((f) => `${f.name}: ${f.typeHint}`).join(" ")} end` : "string",
          description: t.fields.map((f) => f.description).filter(Boolean).join("; ")
        })),
        variables: m.variables.map((v) => ({
          id: v.informalId ?? `var-${v.name}`,
          name: v.name,
          typeHint: v.typeHint
        })),
        invariants: m.invariants.map((inv) => ({
          id: inv.informalId ?? inv.id ?? `inv-${inv.name}`,
          description: inv.description || inv.name,
          textHint: inv.description || "true"
        })),
        processes
      };
    })
  };
}
function changeItems(ir) {
  const items = [];
  for (const t of ir.types) {
    items.push({ id: `type-${t.name}`, kind: "type", name: t.name, summary: `Type ${t.name}`, selected: true });
  }
  for (const v of ir.variables) {
    items.push({ id: `var-${v.name}`, kind: "variable", name: v.name, summary: `Variable ${v.name}`, selected: true });
  }
  for (const p of ir.processes) {
    items.push({
      id: p.informalId ?? `proc-${p.name}`,
      kind: "process",
      name: p.name,
      summary: `Process ${p.name}${p.scenarios?.length ? ` (${p.scenarios.length} scenarios)` : ""}`,
      selected: true
    });
    for (const s of p.scenarios ?? []) {
      items.push({
        id: s.id ?? `${p.name}-${s.name}`,
        kind: "scenario",
        name: s.name ?? "Scenario",
        summary: `${p.name} / ${s.name ?? "scenario"}`,
        selected: true
      });
    }
  }
  for (const inv of ir.invariants) {
    items.push({ id: inv.informalId ?? `inv-${inv.name}`, kind: "invariant", name: inv.name, summary: `Invariant ${inv.name}`, selected: true });
  }
  return items;
}
function scenarioPost(scenarios) {
  const normal = scenarios.filter((s) => !s.exceptional);
  if (!normal.length)
    return "true";
  if (normal.length === 1)
    return normal[0].definingCondition;
  return normal.map((s, i) => {
    if (i === 0)
      return `if ${s.guard} then ${s.definingCondition}`;
    if (i === normal.length - 1)
      return `else ${s.definingCondition}`;
    return `else if ${s.guard} then ${s.definingCondition}`;
  }).join(" ");
}
function idHit(ids, ...candidates) {
  return candidates.some((c) => Boolean(c && ids.has(c)));
}
function filterHybridIR(ir, context = {}) {
  let types = ir.types;
  let variables = ir.variables;
  let processes = ir.processes;
  let invariants = ir.invariants;
  const stages = context.params?.stages;
  if (stages && !stages.hybridSpec) {
    if (stages.typesVars === false) {
      types = [];
      variables = [];
    }
    if (stages.invariants === false)
      invariants = [];
    if (!stages.processes && !stages.scenarios)
      processes = [];
    else if (!stages.scenarios) {
      processes = processes.map((p) => ({ ...p, scenarios: [] }));
    }
  }
  if ((context.scope === "process" || context.scope === "scenario") && context.processName) {
    processes = processes.filter((p) => p.name === context.processName);
  }
  if (context.scope === "module" && context.moduleName) {
    const modules = ir.modules?.filter((m) => m.name === context.moduleName);
    if (modules?.length) {
      return {
        ...ir,
        moduleName: modules[0].name,
        modules,
        types: modules[0].types,
        variables: modules[0].variables,
        processes: modules[0].processes,
        invariants: modules[0].invariants
      };
    }
  }
  const ids = context.selectedNodeIds;
  if (ids?.length) {
    const set2 = new Set(ids);
    types = types.filter((t) => idHit(set2, t.informalId, t.id, `type-${t.name}`));
    variables = variables.filter((v) => idHit(set2, v.informalId, `var-${v.name}`));
    invariants = invariants.filter((inv) => idHit(set2, inv.informalId, inv.id, `inv-${inv.name}`));
    const anyProc = processes.some((p) => idHit(set2, p.informalId, p.id, `proc-${p.name}`));
    processes = processes.map((p) => {
      const keepProcess = idHit(set2, p.informalId, p.id, `proc-${p.name}`);
      const scenarios = (p.scenarios ?? []).filter((s) => idHit(set2, s.id, `${p.name}-${s.name}`));
      if (keepProcess)
        return p;
      if (!anyProc && scenarios.length) {
        const post = scenarioPost(scenarios);
        return { ...p, scenarios, post, postconditions: [post] };
      }
      return null;
    }).filter((p) => p !== null);
  }
  return { ...ir, types, variables, processes, invariants };
}
function irToGenerationResult(spec, ir, context = {}) {
  const filtered = filterHybridIR(ir, context);
  const document = hybridIRToAspec(spec, filtered);
  const source = serializeInformalSpec(spec);
  const partial = Boolean(context.selectedNodeIds?.length) || context.scope !== void 0 && context.scope !== "hybrid";
  const refined = refineToAsfl(document, source, {
    preserveExisting: partial && Boolean(context.existingAsfl?.trim()),
    existingAsfl: context.existingAsfl
  });
  const traceLinks = [];
  for (const proc of filtered.processes) {
    if (!proc.informalId)
      continue;
    traceLinks.push({
      id: `tr-${proc.informalId}-${proc.name}`,
      sourceId: proc.informalId,
      targetId: proc.name,
      relation: "refines",
      confidence: 0.7
    });
  }
  for (const t of filtered.types) {
    if (!t.informalId)
      continue;
    traceLinks.push({
      id: `tr-${t.informalId}-${t.name}`,
      sourceId: t.informalId,
      targetId: t.name,
      relation: "derives-from",
      confidence: 0.7
    });
  }
  for (const inv of filtered.invariants) {
    if (!inv.informalId)
      continue;
    traceLinks.push({
      id: `tr-${inv.informalId}-${inv.name}`,
      sourceId: inv.informalId,
      targetId: inv.name,
      relation: "constrains",
      confidence: 0.7
    });
  }
  return {
    specification: filtered,
    asflText: refined.asflText,
    traceLinks,
    warnings: refined.warnings.map((w) => ({ code: w.code, message: w.message })),
    changes: changeItems(ir)
  };
}
const RULE_BASED_GENERATOR_ID = "rule-based";
const ruleBasedHybridGenerator = {
  id: RULE_BASED_GENERATOR_ID,
  name: "Rule-based Hybrid Generator",
  runtime: "batch",
  async generate(input, context) {
    const ir = informalToHybridIR(input);
    return irToGenerationResult(input, ir, context);
  }
};
const generators = /* @__PURE__ */ new Map();
generators.set(RULE_BASED_GENERATOR_ID, ruleBasedHybridGenerator);
function canonicalTraceText(text) {
  return text.replace(/\r\n/g, "\n").split("\n").map((s) => s.trimEnd()).join("\n").trim();
}
function base(side, locator, kind, title, parent, text, start, end) {
  return {
    id: "",
    side,
    locator,
    kind,
    title,
    parent,
    text,
    shape: "",
    context: text,
    dependencies: [],
    start,
    end,
    leaf: true,
    present: true
  };
}
function informalEntities(source) {
  const spec = detectAspecFormat(source) === "yaml" ? (() => {
    const { document } = parseAspec(source);
    return document ? aspecToInformal(document) : null;
  })() : parseInformalSpec(source).specification;
  if (!spec) throw new Error("Cannot read informal specification. Fix its structure before tracing.");
  const headings = [...source.matchAll(/^(#{2,})\s+(.+?)\s*\r?$/gm)].map((m) => ({
    start: m.index,
    title: m[2].replace(/<!--\s*@id:[^>]+-->/g, "").trim()
  }));
  const allHeadings = [...source.matchAll(/^#+\s+.+\r?$/gm)].map((m) => m.index);
  const used = /* @__PURE__ */ new Set();
  const out = [];
  const walk = (nodes, ancestors, section) => {
    for (const node of nodes) {
      const heading = headings.find((h) => !used.has(h.start) && h.title === node.title);
      if (heading) used.add(heading.start);
      const start = heading?.start ?? -1;
      const end = start < 0 ? -1 : allHeadings.find((n) => n > start) ?? source.length;
      const text = start < 0 ? `${node.title}
${node.description ?? ""}` : source.slice(start, end);
      const e = base("informal", node.id, node.type, node.title, ancestors[ancestors.length - 1]?.locator ?? section, text, start, end);
      const nested2 = node.metadata?.nested ?? [];
      e.leaf = nested2.length === 0;
      e.shape = canonicalTraceText(node.description ?? "");
      e.context = [...ancestors.map((a) => a.text), text].join("\n");
      e.dependencies = ancestors.map((a) => a.locator);
      out.push(e);
      walk(nested2, [...ancestors, e], section);
    }
  };
  for (const section of spec.sections) walk(section.children, [], section.type);
  const constraints = out.filter((e) => e.kind === "constraint");
  for (const e of out.filter((e2) => e2.kind === "function")) {
    e.context += constraints.length ? "\nConstraints:\n" + constraints.map((c) => c.text).join("\n") : "";
    e.dependencies.push(...constraints.map((c) => c.locator));
    const referenced = out.filter((d) => ["data-resource", "data-field"].includes(d.kind) && d.title.length > 1 && e.context.includes(d.title));
    const resources = out.filter((d) => referenced.includes(d) || referenced.some((r) => d.dependencies.includes(r.locator)));
    if (resources.length) e.context += "\nData resources:\n" + resources.map((d) => d.text).join("\n");
    e.dependencies.push(...resources.map((d) => d.locator));
  }
  return out;
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
    prompt: "Find vague, missing, or ambiguous information. Ask focused questions (options + optional custom input) via ask_clarification. When a stakeholder choice is unresolved (threshold, permission/role scope, policy boundary, capacity limit, open course-assignment or export scope, undecided allow/deny rule), ask before writing that concrete value into the specification. If the requirement names a policy without defining it (e.g. 'according to the course assignment policy'), that is an open policy slot: call ask_clarification before proposing any concrete allow/deny default. Do not invent details the user did not confirm."
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
Stakeholder decisions:
- If a threshold, permission/role scope, policy boundary, capacity limit, open course-assignment/export scope, undecided allow/deny rule, or other stakeholder choice is unresolved in the task, call ask_clarification before writing that concrete value into Informal or Hybrid.
- An open policy/scope slot includes phrases like "according to the X policy" or "per assignment policy" when X is not defined: you MUST call ask_clarification before propose_hybrid_changes / replace-process-body writes any concrete allow/deny default (e.g. assigned=true allows, assigned=false denies).
- Until answered, do not invent defaults for those parameters and do not treat silence as approval of a specific number, role, scope, or allow/deny mapping.
- After an answer, apply only what was confirmed; ask again if another distinct stakeholder choice remains open.
Pipeline — keep going after each applied patch until every enabled stage is done, then summarize:
1. Read Informal and Hybrid inventories. If Hybrid already exists and strategy is ask, call ask_clarification (merge vs rebuild).
2. Module architecture: add the SYSTEM_ module, then each semantic module (and a GUI module) with propose_hybrid_changes op=add kind=module. Do not paste module source.
3. Per module: add types/variables from Data Resources (kind=type|var, parentId=mod:…).
4. Per module: add process signatures from Functions (kind=process).
5. Per process: replace-process-body or add scenarios. Write the FSF (FSF : T1 && D1 || T2 && D2 || … || others && Dn); Ti/Di may be structured natural language at this stage. Enumerations use {<Tag>}.
6. Add invariants (kind=inv) from Constraints. One predicate per inv op; use ASFL syntax only: forall[u: Type] | expr; (not "forall u: Type,"). No iff — use (A implies B) and (B implies A). traceLinks target invariants as inv:Module.0 (zero-based index from inventory, not a slug). Do NOT dump GUI widgets into Hybrid CRUD.
7. For UI, call read_gui_specification then propose_gui_changes. Each screen is its own HTML page (data-screen) with data-nav to sibling screens so the prototype can click-switch. ONE screen per call — a multi-screen payload is truncated and rejected. Build a high-fidelity HTML prototype (shell, sidebar, hero, cards, forms, lists, empty states) — not a page of three buttons. Use whitelist tags plus any as-* class. Bind with data-process / data-bind / data-nav. Prefer replace-screen-html with the full inner layout of that one screen. Inline <script type="text/as-logic"> may compute or animate inside that screen (price ticks, counters); it cannot reload the host app. Hybrid gui blocks stay as slim screen→process traces.
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
If a stakeholder choice (threshold, permission/role scope, policy boundary, capacity, open course-assignment/export scope, undecided allow/deny) is unresolved, ask_clarification before writing that concrete value into the Hybrid. Do not silently hard-code allow/deny defaults for an undefined policy via propose_hybrid_changes.
Pipeline:
1. read_refinement_state (tree or summary) plus Informal/Hybrid inventories. Identify the named module/process/data item from the user message, or ask_clarification if several slices are open.
2. Prefer propose_refinement_step: FormalizePredicate, DecomposeProcess, SetCdfd, DeclareAtomic, IntroduceRetrieve, DischargeDataObligation, DefineType, ClassifyGrain, ResolveVariation.
   Grain: read the digest. ask_clarification only about variations already extracted (and name-claim). Then ClassifyGrain (grainClass=operation|abstract) or ResolveVariation (variationId, disposition=scenario|child|waived, toText=child process name, note required when waived). Do not invent a CRUD catalog. Do not clear grainAmbiguity by rewriting pre/post; that counter drops only after those steps or DecomposeProcess. DeclareAtomic requires operational grain to be closed.
3. Use propose_hybrid_changes for new types/vars/processes/scenarios when the shell is empty. Include traceLinks with exact Informal sourceId and fully qualified Hybrid targetId for every derived node. Provenance is mandatory for new semantic nodes: it is validated and committed together with the modeling operation, without a separate user link review. Existing nodes keep their stable bindings; scenarios and referenced declarations may inherit their process provenance. If validation reports missing provenance, repair the tool call yourself using read_specification inventory and retry; never ask the user to manage links. Never treat missing members as done.
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
      description: "Ask the user a structured clarification question when a stakeholder decision is needed (threshold, permission/role scope, policy boundary, capacity, open course-assignment/export scope, undecided allow/deny, merge vs rebuild, next refinement slice). The UI renders options plus a custom text field. The tool result has selected (clicked options) and custom (text the user typed). A non-empty custom answer is required context for both single-choice and multi-choice, even when selected is also set. Never ignore custom. Do not invent those concrete values in the specification before this tool returns — especially do not write allow/deny defaults for an undefined policy via propose_hybrid_changes first. Use this instead of listing questions only in prose when a decision is needed.",
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
                  description: "add only: functions | data-resources | constraints, or a parent node id. Depth is unlimited."
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
                    description: { type: "string" },
                    children: {
                      type: "array",
                      description: "Optional nested nodes. Each item repeats type, title, description, and children.",
                      items: { type: "object" }
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
      description: "Propose an incremental Hybrid/.asfl CRUD patch against inventory ids (mod:, proc:Module.Name). Prefer this over source edits. SYSTEM_ is the unique top-level system module (named after the whole system) and is inserted first; other modules use parentId=mod:SYSTEM_…. Default process signature is (). Never emit raw SOFL or replace-document here. Use add/update/remove/replace-process-body. Write process logic as FSF via replace-process-body.fsf: FSF : T1 && D1 || T2 && D2 || … || others && Dn. There is no implication operator; write not A or B. If the task leaves an open policy/scope slot (undefined course-assignment policy, unresolved role/export scope, undecided allow/deny), call ask_clarification first; do not write concrete allow/deny defaults into FSF until answered.",
      parameters: {
        type: "object",
        properties: {
          explanation: { type: "string" },
          traceLinks: {
            type: "array",
            description: "Required provenance for new semantic nodes. Include exact Informal source inventory IDs and fully qualified target IDs from the inventory (proc:Module.Name, type:Module.Name, var:Module.Name, const:Module.Name, fn:Module.Name, inv:Module.zeroBasedIndex). Modules (mod:) are scaffolding and need no link. Every new type/var/const declared in the same patch needs its own link unless a new linked process references it. Existing bindings are preserved; use [] only for edits to already bound nodes or module scaffolding. Source and bindings are applied together.",
            items: { type: "object", properties: { sourceId: { type: "string" }, targetId: { type: "string" }, relation: { type: "string", enum: ["refines", "constrains", "uses"] } }, required: ["sourceId", "targetId"] }
          },
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
      description: 'Propose a structured GUI HTML patch. ONE screen per call (replace-screen-html or add-screen) with a complete inner layout (navbar/sidebar/hero/cards/forms/tables), not a single button and not every screen at once. Ops: add-screen (optional html), remove-screen, add-widget, replace-html, replace-screen-html, insert-html, patch-node, remove-node. Whitelist HTML5 tags; any as-* class is allowed. Bind with data-process / data-bind / data-nav. Inline <script type="text/as-logic"> is allowed for calculations and animations and runs in a sandbox. Also allowed: onclick, oninput, onchange. Never emit <script src>, style=, href, or src.',
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
          traceLinks: {
            type: "array",
            description: "For any new semantic nodes introduced by this refinement, include their exact Informal sourceId and complete resulting Hybrid targetId. Retain existing source bindings.",
            items: { type: "object", properties: { sourceId: { type: "string" }, targetId: { type: "string" }, relation: { type: "string", enum: ["refines", "constrains", "uses"] } }, required: ["sourceId", "targetId"] }
          },
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
      description: 'Last-resort source-level edit of Informal markdown, Hybrid .asfl, or GUI html. Prefer propose_changes / propose_hybrid_changes / propose_gui_changes. Use this only when CRUD failed, leftover unparsed text remains, inventory is empty/out of sync, or you must fix text the structured tools cannot express. Read view=source first. Pass target "gui" for the GUI file and edit one screen, not the whole document. Ops: replace (unique oldText → newText; all:true to replace every match), append, replace-document.',
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["informal", "hybrid", "gui"],
            description: "Which open specification file to edit"
          },
          explanation: { type: "string" },
          traceLinks: {
            type: "array",
            description: "For target=hybrid, include exact Informal sourceId and fully qualified targetId for every new semantic node; existing bindings are retained.",
            items: { type: "object", properties: { sourceId: { type: "string" }, targetId: { type: "string" }, relation: { type: "string", enum: ["refines", "constrains", "uses"] } }, required: ["sourceId", "targetId"] }
          },
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
  const base2 = defaultAgentPermissions();
  const informal = { ...base2.informal, ...raw?.informal };
  const hybrid = { ...base2.hybrid, ...raw?.hybrid };
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
      notes.push(...parser$2.authorNotesFromInformalMarkdown(node_fs.readFileSync(node_path.join(projectRoot, name), "utf-8")));
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
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function sliceFirstJsonValue(raw) {
  const obj = raw.indexOf("{");
  const arr = raw.indexOf("[");
  let start = -1;
  if (obj < 0) start = arr;
  else if (arr < 0) start = obj;
  else start = Math.min(obj, arr);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
function closeTruncatedJson(raw) {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  const source = raw.slice(start);
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if ((c === "}" || c === "]") && stack[stack.length - 1] === c) stack.pop();
  }
  let text = source;
  if (inStr) {
    if (text.endsWith("\\")) text += "\\";
    text += '"';
  }
  text = text.replace(/,\s*$/, "");
  while (stack.length) text += stack.pop();
  return { text, closedString: inStr };
}
function tryParse(text) {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}
function inflateOperations(value) {
  if (typeof value.operations !== "string") return;
  const raw = value.operations.trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      value.operations = parsed;
      return;
    }
    const record = asRecord(parsed);
    if (record && Array.isArray(record.operations)) value.operations = record.operations;
  } catch {
    const closed = closeTruncatedJson(raw.startsWith("{") ? raw : `{"operations":${raw}`);
    if (!closed) return;
    const parsed = tryParse(closed.text);
    if (parsed && Array.isArray(parsed.operations)) value.operations = parsed.operations;
  }
}
function dropPartialOperation(value) {
  const ops = value.operations;
  if (!Array.isArray(ops) || ops.length < 2) return false;
  ops.pop();
  return true;
}
function truncatedWholeDocument(value) {
  const ops = value.operations;
  if (!Array.isArray(ops) || ops.length !== 1) return false;
  const op = asRecord(ops[0]);
  if (!op) return false;
  const kind = String(op.op || op.action || "");
  return kind === "replace-document" || kind === "replace-html";
}
function isLengthFinishReason(finishReason) {
  if (!finishReason) return false;
  const normalized = finishReason.trim().toLowerCase();
  return normalized === "length" || normalized === "max_tokens";
}
function parseToolArguments(raw, options) {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Tool arguments were empty." };
  if (isLengthFinishReason(options?.finishReason)) {
    return {
      ok: false,
      error: "Model output was truncated (finish_reason=" + String(options?.finishReason) + ", " + String(trimmed.length) + " characters). Do not treat partial tool JSON as success. Split into smaller tool calls or increase max_tokens."
    };
  }
  const direct = tryParse(trimmed);
  if (direct) {
    inflateOperations(direct);
    return { ok: true, value: direct, repaired: false, droppedPartialOperation: false };
  }
  const first = sliceFirstJsonValue(trimmed);
  if (first && first.length < trimmed.length) {
    const parsed = tryParse(first);
    if (parsed) {
      inflateOperations(parsed);
      return { ok: true, value: parsed, repaired: true, droppedPartialOperation: false };
    }
  }
  const closed = closeTruncatedJson(trimmed);
  if (closed) {
    const parsed = tryParse(closed.text);
    if (parsed) {
      inflateOperations(parsed);
      if (closed.closedString && truncatedWholeDocument(parsed)) {
        return {
          ok: false,
          error: `Tool arguments were truncated (${trimmed.length} characters) inside a whole-document replace. Do not resend that payload. Send one screen per propose_gui_changes call (add-screen or replace-screen-html).`
        };
      }
      const dropped = closed.closedString ? dropPartialOperation(parsed) : false;
      return { ok: true, value: parsed, repaired: true, droppedPartialOperation: dropped };
    }
  }
  return {
    ok: false,
    error: `Tool arguments were malformed or truncated (${trimmed.length} characters). Do not resend the same payload. Split it into smaller calls — for GUI, one screen per propose_gui_changes.`
  };
}
const MAX_HISTORY = 20;
const MAX_POST_CLARIFY_CONSECUTIVE_SPEC_READS = 3;
const SPEC_READ_TOOL_NAMES = /* @__PURE__ */ new Set([
  "read_hybrid_specification",
  "read_specification",
  "read_refinement_state"
]);
function postClarifyReadBudget(session) {
  if (!session.context.postClarifyReadBudget) {
    session.context.postClarifyReadBudget = {
      answeredClarifications: 0,
      proposalsEmitted: 0,
      consecutiveSpecReads: 0
    };
  }
  return session.context.postClarifyReadBudget;
}
function noteAnsweredClarification(session) {
  const b = postClarifyReadBudget(session);
  b.answeredClarifications += 1;
  b.consecutiveSpecReads = 0;
}
function noteProposalEmitted(session) {
  const b = postClarifyReadBudget(session);
  b.proposalsEmitted += 1;
  b.consecutiveSpecReads = 0;
}
function takePostClarifySpecReadDenial(session, toolName) {
  if (!SPEC_READ_TOOL_NAMES.has(toolName)) return null;
  const b = postClarifyReadBudget(session);
  if (b.answeredClarifications <= 0 || b.proposalsEmitted > 0) {
    b.consecutiveSpecReads = 0;
    return null;
  }
  b.consecutiveSpecReads += 1;
  if (b.consecutiveSpecReads <= MAX_POST_CLARIFY_CONSECUTIVE_SPEC_READS) return null;
  return {
    ok: false,
    error: "post_clarify_read_budget_exhausted",
    consecutiveSpecReads: b.consecutiveSpecReads,
    maxConsecutiveSpecReads: MAX_POST_CLARIFY_CONSECUTIVE_SPEC_READS,
    next: "Fair call budget ended this turn after consecutive specification reads following clarification without a propose_* write. No further tool calls in this turn."
  };
}
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
  const base2 = hybridDiagnosticsPayload(asfl);
  let semantic = [];
  try {
    semantic = await semanticDiagnostics(asfl ?? "", cfg);
  } catch {
  }
  const items = [
    ...base2.items,
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
    toolLines.push(
      '- propose_gui_changes: one GUI screen per call (full layout). Inline <script type="text/as-logic"> may animate that screen; it runs in a sandbox and cannot reload Studio'
    );
  }
  if (permissions.informal.write || permissions.hybrid.write) {
    toolLines.push(
      "- propose_source_edit: last-resort source edit (target informal, hybrid, or gui) when CRUD cannot unstick"
    );
  }
  const informalGuide = permissions.informal.write ? `For propose_changes, operate on the CURRENT Informal inventory (ids like fn-login, dr-account, c-unique):
- add: target = functions | data-resources | constraints, or any parent node id. Nesting depth is unlimited for functions, data sources (children are data-field), and constraints. node.type = function | data-resource | data-field | constraint. Include title and description. Optional node.children repeats the same shape.
- update: id = existing node id (or unique title). Set title and/or description.
- remove: id = existing node id.
- move: id + parentId + optional afterId.
Prefer update/remove on existing nodes over adding a second copy of the same idea.
Do not invent YAML frontmatter or document-level metadata.` : "You do not have Informal write permission. Do not call propose_changes.";
  const hybridGuide = permissions.hybrid.write ? `For propose_hybrid_changes, operate on Hybrid inventory ids with CRUD only:
- add: kind (module|type|var|const|inv|process|function|scenario|gui-screen) + parentId (mod:Module or proc:Module.Name) + name. Bare ids like proc:Login or Chinese titles are resolved when possible, but prefer inventory ids. Types/vars/invs use text. Processes use signature + FSF (final grammar): FSF : T1 && D1 || T2 && D2 || … || others && Dn (Ti = test condition over inputs and ~x initial values, never outputs; Di = defining condition that constrains outputs / written ext vars). Inside Ti/Di use and, or, not; && and || only separate scenarios. If ports are unknown, signature is () — do not invent dummy (x: nat) ok: nat.
- update / remove: id of existing entity (mod:, proc:, type:, var:, inv:, scn:, gui:). Invariant ids are inv:Module.0, inv:Module.1, … (index from inventory). Removing a parent module rewrites child headers (drops / Parent).
- inv text: legal ASFL only (forall[u: T] | …; implies/and/or/not). Never iff or VDM "forall u: T," comma form.
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
- ONE screen per tool call (add-screen or replace-screen-html). A long multi-screen payload is often truncated and rejected. If a call is recovered after truncation, continue with the next screen in a new call.
- Prefer replace-screen-html (or add-screen with html) with the FULL inner markup of that screen. All children are kept; do not flatten a layout down to the first widget.
- Tags: common HTML5 (header/main/aside/nav/table/form/img/a/…). Classes: any as-* token (as-shell, as-hero, as-card, as-grid-3, as-btn-primary, …). Bind with data-process / data-bind / data-nav.
- Do not ship a page that is only two or three unlabeled buttons. Navigation must be visible in the layout, not implied.
- Prototype logic may be an inline <script type="text/as-logic"> (calculations, setInterval / requestAnimationFrame number ticks, button feedback). It runs in a sandbox iframe: it can query and update the prototype DOM, and it cannot reload Studio, open windows, or use the network. Also allowed: onclick, oninput, onchange. Do not emit <script src>, javascript: URLs, href, src, or style=.
- Buttons inside forms must not rely on form submit. Use type="button" plus data-nav / data-process, or a logic script.` : "You do not have GUI write permission. Do not call propose_gui_changes.";
  const sourceGuide = permissions.informal.write || permissions.hybrid.write ? `propose_source_edit is an escape hatch, not the default:
- Prefer propose_changes / propose_hybrid_changes / propose_gui_changes / propose_refinement_step for almost every write.
- Use source edit after CRUD fails, when leftover unparsed text remains, when inventory is empty/out of sync with the file, when Diagnostics lists syntax/parse errors CRUD cannot fix, or when you must fix text CRUD cannot express. For GUI pass target "gui". Do not replace the whole GUI document in one call; patch one screen.
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

Stakeholder decisions (product rule):
- If a threshold, permission/role scope, policy boundary, capacity limit, open course-assignment/export scope, undecided allow/deny rule, or other stakeholder choice is unresolved in the task text, call ask_clarification BEFORE writing that concrete value into Informal or Hybrid.
- Open policy/scope slots (e.g. "according to the course assignment policy" without defining who may export) require ask_clarification before propose_hybrid_changes / replace-process-body commits any concrete allow/deny default. Do not silently hard-code mappings such as assigned=true allows / assigned=false denies unless the user confirmed them.
- Until the user answers, do not invent defaults for those parameters and do not treat silence as approval of a specific number, role, scope, or allow/deny mapping.
- After an answer arrives, apply only what was confirmed; ask again if another distinct stakeholder choice remains open.

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
  const firstUser = body.findIndex((message) => message.role === "user");
  let lastUser = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (firstUser >= 0) startIndexes.add(firstUser);
  if (lastUser >= 0) startIndexes.add(lastUser);
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
    let endTurnForReadBudget = false;
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
        const parsedArgs = parseToolArguments(call.function.arguments || "{}", { finishReason: completion.finishReason });
        if (!parsedArgs.ok) {
          session.messages.push({
            id: call.id,
            role: "tool",
            content: JSON.stringify({
              ok: false,
              error: parsedArgs.error,
              next: "Do not resend that payload. Split it into smaller tool calls and continue."
            }),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          live.content = live.content || parsedArgs.error;
          markCallStatus(live, call.id, "error", sink);
          continue;
        }
        const args = parsedArgs.value;
        if (parsedArgs.droppedPartialOperation) {
          const note = "Recovered a truncated tool call. The incomplete last operation was dropped. Continue the remaining work in a new, smaller call.";
          args.explanation = typeof args.explanation === "string" && args.explanation.trim() ? `${args.explanation}

${note}` : note;
        }
        const readBudgetDenial = takePostClarifySpecReadDenial(session, call.function.name);
        if (readBudgetDenial) {
          session.messages.push({
            id: call.id,
            role: "tool",
            content: JSON.stringify(readBudgetDenial),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          live.content = live.content || "Post-clarify specification read budget reached.";
          markCallStatus(live, call.id, "error", sink);
          markRemainingToolCalls(live, "done", sink);
          endTurnForReadBudget = true;
          break;
        }
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
            if (raw === "hybrid" || raw === "informal" || raw === "gui") {
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
                  error: 'propose_source_edit requires target: "informal", "hybrid", or "gui".',
                  next: 'Re-call propose_source_edit with an explicit target after read_* view=source. For GUI, target is "gui" and each call should touch one screen.'
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
          if (target === "hybrid" && Array.isArray(args.traceLinks)) {
            patch.traceLinks = args.traceLinks.filter((l) => {
              const item = l;
              return !!item && typeof item.sourceId === "string" && typeof item.targetId === "string";
            });
          }
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
            const emptyPatch = !Array.isArray(patch.operations) || patch.operations.length === 0;
            if (!emptyPatch) {
              session.context.lastFailedWrite = nextFailedWrite(session.context.lastFailedWrite, {
                fingerprint: patchFingerprint(patch),
                error: validity.message,
                mode
              });
            }
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
          if (target === "hybrid" && ctx.informalMarkdown.trim()) {
            const sources = new Set(informalEntities(ctx.informalMarkdown).map((e) => e.locator));
            const createsNodes = patch.operations.some((op) => op.op === "add" && !["module", "gui-screen", "scenario"].includes(String(op.kind)));
            const invalid = patch.traceLinks?.some((l) => !sources.has(l.sourceId) || !l.targetId);
            if (invalid || createsNodes && sources.size > 0 && !patch.traceLinks?.length) {
              session.messages.push({ id: call.id, role: "tool", content: JSON.stringify({ ok: false, error: "Missing or invalid modeling provenance.", next: "Read the Informal inventory. Re-propose the patch with traceLinks containing exact sourceId and fully qualified targetId for each new semantic node. Fix this yourself; do not ask the user to manage links." }), timestamp: (/* @__PURE__ */ new Date()).toISOString() });
              markCallStatus(live, call.id, "error", sink);
              continue;
            }
          }
          live.content = patch.explanation || live.content || (mode === "source" ? `Proposed ${target} source edit.` : `Proposed ${target} specification changes.`);
          live.proposedChanges = patch;
          live.pending = true;
          session.context.pendingToolCallId = call.id;
          noteProposalEmitted(session);
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
          const fullDiagnostics = permissions.hybrid.read ? await hybridDiagnosticsWithSemantic(ctx.hybridAsfl, getExperimentConfig(projectRoot)) : { count: 0, errors: 0, items: [] };
          const diagnostics = compactDiagnosticPayload(fullDiagnostics);
          if (diagnostics.truncated) {
            logTelemetry(projectRoot, getExperimentConfig(projectRoot), session.id, {
              event: "full_read_diagnostics",
              toolCallId: call.id,
              diagnostics: fullDiagnostics
            });
          }
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
      if (endTurnForReadBudget) break;
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
        noteAnsweredClarification(session);
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
  const base2 = node_path.basename(scan.aspecFiles[0] ?? "", ".aspec");
  const pairGui = scan.guispecFiles.find((p) => node_path.basename(p, ".gui.html") === `${base2}-gui`) ?? scan.guispecFiles.find((p) => node_path.basename(p, ".guispec") === `${base2}-gui`) ?? scan.guispecFiles.find((p) => node_path.basename(p, ".gui.html") === base2.replace(/-informal$/, "") + "-gui") ?? scan.guispecFiles.find((p) => node_path.basename(p, ".guispec") === base2.replace(/-informal$/, "") + "-gui");
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
if (process.env.STUDIO_CAPTURE === "1" && process.env.STUDIO_CAPTURE_USER_DATA) {
  node_fs.mkdirSync(process.env.STUDIO_CAPTURE_USER_DATA, { recursive: true });
  electron.app.setPath("userData", process.env.STUDIO_CAPTURE_USER_DATA);
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
  const capture = process.env.STUDIO_CAPTURE === "1";
  mainWindow = new electron.BrowserWindow({
    width: capture ? 1440 : 1280,
    height: capture ? 900 : 800,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    icon: resolveAppIcon(),
    backgroundColor: "#0e1418",
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
    if (process.env.STUDIO_CAPTURE === "1" && mainWindow) {
      const win = mainWindow;
      void runCopyrightCapture(win).catch((err) => {
        console.error("[copyright-capture]", err);
        electron.app.exit(1);
      });
    }
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
  registerTextSearchHandlers();
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
