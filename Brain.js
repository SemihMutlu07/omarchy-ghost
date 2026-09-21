// Casper v0 — deterministic, local, command-finished companion.
//
// Pure logic. No I/O, no network, no clock of its own beyond Date.now().
// Loaded by both Quickshell (overlay + settings panel) and Node (tests), so it
// stays dependency-free and ES5-shaped.
//
// What Casper knows about a command: an allowlisted family, an optional
// allowlisted subcommand, the exit status, the duration and an ephemeral
// per-shell session id. Raw command lines, arguments, output, cwd, git state
// and history never reach this file.

var CONFIG_NAME = "casper.json"

// Allowlist of families -> accepted subcommands ("" = bare invocation).
// bin/casper-hook mirrors these lists; test/brain.test.js fails when they drift.
var FAMILIES = {
  git: ["", "status", "diff", "log", "show", "pull", "push", "commit", "add", "checkout", "branch", "test"],
  npm: ["", "test", "run", "install", "build", "start"],
  pnpm: ["", "test", "run", "install", "build", "start"],
  yarn: ["", "test", "run", "install", "build", "start"],
  cargo: ["", "test", "build", "check", "run", "clippy"],
  make: [""],
  go: ["", "test", "build", "run", "fmt", "vet"],
  node: [""],
  python: [""],
  python3: [""],
  pytest: [""],
  bun: ["", "test", "run", "install", "build"],
  docker: ["", "build", "run", "compose"],
  systemctl: ["", "start", "stop", "restart", "status"],
  omarchy: ["", "restart", "theme", "plugin", "update", "refresh"],
  sleep: [""],
  true: [""],
  false: [""],
  ls: [""],
  rg: [""]
}

// Dosage presets. A mode sets the ceiling; explicit keys in casper.json win.
var MODES = {
  Quiet: { cooldownSec: 300, budgetPerHour: 3, rates: { failure: 1, recovery: 0.6, slow: 0.35 } },
  Balanced: { cooldownSec: 90, budgetPerHour: 8, rates: { failure: 1, recovery: 0.8, slow: 0.5 } },
  Chatty: { cooldownSec: 30, budgetPerHour: 16, rates: { failure: 1, recovery: 1, slow: 0.75 } }
}

var DEFAULTS = {
  enabled: true,
  mode: "Balanced",
  silenceUntil: 0,
  cooldownSec: MODES.Balanced.cooldownSec,
  budgetPerHour: MODES.Balanced.budgetPerHour,
  minDurationMs: 2500,
  failureWindowMs: 900000,
  maxSessions: 24,
  triggers: { failure: true, recovery: true, slow: true },
  rates: { failure: 1, recovery: 0.8, slow: 0.5 },
  sarcasm: 0.55,
  technical: 0.5,
  verbosity: 0.45,
  profanity: false
}

var PHRASES = {
  failure: [
    "{cmd} kırıldı. Terminaller de bazen sınırlarını hatırlatıyor.",
    "{cmd} olmadı. Küçük bir yenilgi, büyük bir dram değil.",
    "{cmd} failed. The shell has filed its objection.",
    "{cmd} patladı. Teknik adı: bugün değil.",
    "{cmd} hata verdi. exit {code}, kimse şaşırmadı."
  ],
  repeat: [
    "{cmd} yine aynı yerden kırıldı. Bu artık bir örüntü.",
    "{cmd} tekrar patladı. Üçüncü kez, aynı aile.",
    "{cmd} failed again. Repetition is not a debugging strategy.",
    "{cmd} bir daha olmadı. Belki argümanlar değil, varsayım sorunlu."
  ],
  recovery: [
    "{cmd} toparlandı. Same session, different ending.",
    "{cmd} sonunda geçti. Şüpheci ama memnun.",
    "Recovery noted: {cmd}. Birinci deneme sadece fragmandı.",
    "{cmd} düzeldi. Terminal affetmedi, sadece devam etti."
  ],
  slow: [
    "{cmd} biraz ağırdan aldı: {seconds}s.",
    "{cmd} bitti — sabır da bir dependency galiba ({seconds}s).",
    "{cmd} took {seconds}s. The shell had time to think.",
    "{cmd}: {seconds}s. Hız değil, karakter gelişimi."
  ]
}

var cfg = parseConfig("{}"), lastShownAt = 0, shown = [], events = {}, sessions = [],
  lastMessage = "", lastKind = ""

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)) } catch (e) { return {} }
}
function clamp(value, low, high) {
  var n = Number(value)
  return isFinite(n) ? Math.max(low, Math.min(high, n)) : low
}
function hash(text) {
  var h = 0
  for (var i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return h
}
function pick(list, seed) { return list[Math.abs(seed) % list.length] }
function nowMs() { return Date.now() }
function configPath(home) { return String(home || "") + "/.config/omarchy/" + CONFIG_NAME }

function parseConfig(raw) {
  var parsed = {}
  try { parsed = JSON.parse(String(raw || "{}")) } catch (e) { parsed = {} }
  if (!parsed || typeof parsed !== "object") parsed = {}
  var merged = clone(DEFAULTS)
  var mode = MODES[String(parsed.mode)] ? String(parsed.mode) : DEFAULTS.mode
  merged.mode = mode
  merged.cooldownSec = MODES[mode].cooldownSec
  merged.budgetPerHour = MODES[mode].budgetPerHour
  merged.rates = clone(MODES[mode].rates)
  var key, nested
  for (key in parsed) {
    if (key === "mode") continue
    if ((key === "triggers" || key === "rates") && parsed[key] && typeof parsed[key] === "object") {
      for (nested in parsed[key]) merged[key][nested] = parsed[key][nested]
    } else if (parsed[key] !== undefined && parsed[key] !== null) {
      merged[key] = parsed[key]
    }
  }
  merged.enabled = merged.enabled !== false
  merged.profanity = merged.profanity === true
  merged.cooldownSec = clamp(merged.cooldownSec, 0, 86400)
  merged.budgetPerHour = clamp(merged.budgetPerHour, 0, 60)
  merged.minDurationMs = clamp(merged.minDurationMs, 0, 3600000)
  merged.failureWindowMs = clamp(merged.failureWindowMs, 1000, 86400000)
  merged.maxSessions = clamp(merged.maxSessions, 1, 128)
  merged.sarcasm = clamp(merged.sarcasm, 0, 1)
  merged.technical = clamp(merged.technical, 0, 1)
  merged.verbosity = clamp(merged.verbosity, 0, 1)
  merged.silenceUntil = Math.max(0, Number(merged.silenceUntil) || 0)
  merged.triggers = {
    failure: merged.triggers.failure !== false,
    recovery: merged.triggers.recovery !== false,
    slow: merged.triggers.slow !== false
  }
  cfg = merged
  return cfg
}
function setConfig(next) { return parseConfig(JSON.stringify(next || {})) }
function resetMemory() {
  lastShownAt = 0; shown = []; events = {}; sessions = []
  lastMessage = ""; lastKind = ""
}
function setSilence(until) { cfg.silenceUntil = Math.max(0, Number(until) || 0) }

// --- event validation -----------------------------------------------------

function validEvent(ev) {
  if (!ev || typeof ev !== "object") return false
  var family = String(ev.family || ""), sub = String(ev.subcommand || "")
  if (!Object.prototype.hasOwnProperty.call(FAMILIES, family)) return false
  if (FAMILIES[family].indexOf(sub) === -1) return false
  return /^\d{1,7}$/.test(String(ev.code)) &&
    /^\d{1,9}$/.test(String(ev.durationMs)) &&
    /^[A-Za-z0-9_-]{1,32}$/.test(String(ev.session || ""))
}

function familyName(family, subcommand) {
  var names = {
    git: "git", npm: "npm", pnpm: "pnpm", yarn: "yarn", cargo: "cargo", make: "make",
    go: "go", node: "node", python: "python", python3: "python3", pytest: "pytest",
    bun: "bun", docker: "docker", systemctl: "systemctl", omarchy: "Omarchy",
    sleep: "sleep", true: "true", false: "false", ls: "ls", rg: "rg"
  }
  var name = names[family] || family
  var parts = String(subcommand || "")
  return parts ? name + " " + parts : name
}

function render(kind, ev, config) {
  var settings = config || cfg
  var seed = hash(String(ev.family) + ":" + String(ev.subcommand) + ":" + kind + ":" + String(shown.length))
  var line = pick(PHRASES[kind], seed)
  line = line.replace("{cmd}", familyName(ev.family, ev.subcommand))
    .replace("{code}", String(ev.code))
    .replace("{seconds}", String(Math.max(1, Math.round(Number(ev.durationMs) / 1000))))
  if (Number(settings.verbosity) < 0.35) line = line.split(". ")[0] + "."
  if (Number(settings.technical) > 0.7 && kind !== "slow") line += " exit " + String(ev.code) + "."
  if (Number(settings.sarcasm) < 0.25) {
    line = line.replace(/Küçük bir yenilgi, büyük bir dram değil|Şüpheci ama memnun|affetmedi, sadece devam etti|Bu artık bir örüntü/g, "tamam")
  }
  if (settings.profanity === true) line = line.replace("patladı", "lanet olası şekilde patladı")
  return line
}

// A deterministic sample line, for the "test personality" action in the panel.
function preview(config) {
  var settings = parseConfig(JSON.stringify(config || cfg))
  var sample = { family: "git", subcommand: "status", code: 1, durationMs: 4200, session: "preview" }
  var keep = cfg
  cfg = settings
  var line = render("failure", sample, settings)
  cfg = keep
  return line
}

// --- memory (bounded, ephemeral: this process only, never written down) ---

function pruneEvents(now) {
  var key, stale = []
  for (key in events) {
    if (events[key].failures === 0 && now - events[key].lastSeenAt > cfg.failureWindowMs) stale.push(key)
  }
  for (var i = 0; i < stale.length; i++) delete events[stale[i]]
  while (sessions.length > cfg.maxSessions) {
    var oldest = sessions.shift()
    for (key in events) {
      if (key.indexOf(oldest + ":") === 0) delete events[key]
    }
  }
}

function touchSession(session, now) {
  var at = sessions.indexOf(session)
  if (at !== -1) sessions.splice(at, 1)
  sessions.push(session)
  if (sessions.length > cfg.maxSessions) {
    var dropped = sessions.shift()
    for (var key in events) {
      if (key.indexOf(dropped + ":") === 0) delete events[key]
    }
  }
  pruneEvents(now)
}

function budgetOk(now) {
  var cutoff = now - 3600000, fresh = []
  for (var i = 0; i < shown.length; i++) if (shown[i] > cutoff) fresh.push(shown[i])
  shown = fresh
  return shown.length < Number(cfg.budgetPerHour)
}

function rateAllows(kind, now, ev) {
  var rate = clamp(cfg.rates[kind === "repeat" ? "failure" : kind], 0, 1)
  if (rate >= 1) return true
  return ((hash(String(ev.family) + ":" + ev.subcommand + ":" + ev.code) & 1023) / 1023) <= rate
}

function shouldShow(kind, now, ev) {
  var trigger = kind === "repeat" ? "failure" : kind
  if (!cfg.enabled) return false
  if (Number(cfg.silenceUntil) > now) return false
  if (cfg.triggers[trigger] !== true) return false
  if (now - lastShownAt < Number(cfg.cooldownSec) * 1000) return false
  if (!budgetOk(now)) return false
  return rateAllows(kind, now, ev)
}

// The single entry point used by the shell hook. Returns a line to say, or "".
function finish(ev) {
  if (!validEvent(ev)) return ""
  var now = nowMs(), code = Number(ev.code), duration = Number(ev.durationMs)
  var session = String(ev.session), key = session + ":" + String(ev.family)
  var previous = events[key] || { failures: 0, lastFailureAt: 0, lastSeenAt: 0 }
  touchSession(session, now)
  // Ctrl-C and signal-like exits are not failures, and leave no trace at all.
  if (code === 130 || code >= 128) return ""
  var kind = ""
  if (code !== 0) {
    var inWindow = previous.failures > 0 && now - previous.lastFailureAt <= cfg.failureWindowMs
    previous.failures = inWindow ? previous.failures + 1 : 1
    previous.lastFailureAt = now
    kind = previous.failures >= 3 ? "repeat" : "failure"
  } else if (previous.failures > 0 && now - previous.lastFailureAt <= cfg.failureWindowMs) {
    previous.failures = 0
    previous.lastFailureAt = 0
    kind = "recovery"
  } else if (duration >= Number(cfg.minDurationMs)) {
    kind = "slow"
  } else {
    previous.failures = 0
  }
  previous.lastSeenAt = now
  previous.lastCode = code
  events[key] = previous
  if (!kind || !shouldShow(kind, now, ev)) return ""
  var msg = render(kind, ev)
  if (msg === lastMessage) return ""
  lastMessage = msg
  lastKind = kind
  lastShownAt = now
  shown.push(now)
  return msg
}

function state() {
  return { lastKind: lastKind, lastMessage: lastMessage, shownThisHour: shown.length, trackedFamilies: Object.keys(events).length }
}

if (typeof module !== "undefined" && module.exports) module.exports = {
  CONFIG_NAME: CONFIG_NAME, FAMILIES: FAMILIES, MODES: MODES, DEFAULTS: DEFAULTS,
  configPath: configPath, parseConfig: parseConfig, setConfig: setConfig,
  resetMemory: resetMemory, setSilence: setSilence, validEvent: validEvent,
  render: render, preview: preview, finish: finish, state: state,
  _setNow: function(fn) { nowMs = fn }
}
