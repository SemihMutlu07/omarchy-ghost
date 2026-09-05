// Ghost — the brain.
//
// Watches events fed from Ghost.qml, keeps a small memory of what you are
// doing, decides *whether* to say something (cooldowns, quiet hours, idle,
// noise gates) and *what* to say (weighted, de-duplicated templates, or a
// hand-off to bin/ghost-llm when configured).
//
// ES5-only: this file runs in the QML JS engine (and in Node for tests),
// so no arrow functions, no template literals, no let/const.

// ------------------------------------------------------------------ config

var DEFAULTS = {
  enabled: true,
  minIntervalSec: 180,        // floor between whispers (presence ping)
  maxIntervalSec: 720,        // ambient boo lands in [min, max]
  variantCooldownSec: 1800,   // don't reuse a line within this window
  quietHoursStart: 1,         // 01:00 …
  quietHoursEnd: 7,           // … 07:00 local
  idleSeconds: 600,           // no focused window this long = you're away
  whisperDurationSec: 6,
  graceSec: 10,              // ignore desktop events for this long after load
  brain: "templates",         // "templates" | "auto" | "llm"
  llmCommand: "",             // optional override for the LLM brain
  maxWidth: 340,
  chances: {
    focus: 0.12,              // on each app switch (only when calm)
    window: 0.4,              // on each window open/close
    workspace: 0.4,           // on each workspace switch (only when interesting)
    fullscreen: 0.8,
    longSession: 0.5,         // per hour of continuous activity
    lateNight: 1.0,           // once per night
    title: 0.5,               // on each focused-window title change
    unexpected: 0.5,          // on habit deviations
    insight: 0.6              // on each metric-based insight check
  },
  insightDailyCap: 6          // max metric insights per day (don't overdo it)
}

var cfg = clone(DEFAULTS)

function parseConfig(raw) {
  var parsed = {}
  try {
    parsed = JSON.parse(String(raw || "{}"))
  } catch (e) { /* keep defaults */ }
  var merged = clone(DEFAULTS)
  for (var k in parsed) {
    if (k === "chances") {
      for (var c in parsed.chances) merged.chances[c] = parsed.chances[c]
    } else if (parsed[k] !== undefined && parsed[k] !== null) {
      merged[k] = parsed[k]
    }
  }
  cfg = merged
  return cfg
}

function getCfg() { return cfg }

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)) } catch (e) { return {} }
}

// ------------------------------------------------------------------ state

var lastActivityAt = Date.now()
var idle = false
var lastMessageAt = 0
var lastApp = ""
var lastTheme = ""
var sessionStart = Date.now()

var windowsOpened = 0
var windowsClosed = 0
var wsSwitches = 0
var messagesSent = 0

var variantUsed = {}     // templateId -> last-used timestamp
var appSeen = {}         // app category -> timestamp of last comment
var recentFocus = []     // timestamps of focus events (noise gate)
var llmLastTry = 0       // rate-limit LLM failures

var LOADED_AT = Date.now()

function resetMemory() {
  lastActivityAt = Date.now()
  idle = false
  lastMessageAt = 0
  lastApp = ""
  variantUsed = {}
  appSeen = {}
  recentFocus = []
}

// ------------------------------------------------------------------ helpers

function nowMs() { return Date.now() }
function hourNow() {
  var d = new Date()
  return d.getHours()
}
function minutesNow() {
  var d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}
function chance(p) { return Math.random() < p }
function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function minutesBetween(aMs, bMs) {
  return Math.max(0, Math.round((aMs - bMs) / 60000))
}
function hoursBetween(aMs, bMs) {
  return Math.max(0, Math.round((aMs - bMs) / 3600000))
}

function fill(template, ctx) {
  return String(template).replace(/\{([a-zA-Z]+)(?::([a-zA-Z]+))?\}/g, function(_, key, word) {
    var val = ctx[key]
    if (val === undefined) return ""
    if (word) {
      var n = Number(val)
      return val + " " + word + (n === 1 ? "" : "s")
    }
    return String(val)
  })
}

// Pick an unused variant for a template id, remembering recent use.
function pickVariant(id, variants, ctx) {
  var now = nowMs()
  var cooldown = cfg.variantCooldownSec * 1000
  var fresh = []
  for (var i = 0; i < variants.length; i++) {
    var usedAt = variantUsed[id + "#" + i] || 0
    if (now - usedAt > cooldown) fresh.push(i)
  }
  if (fresh.length === 0) {
    for (var j = 0; j < variants.length; j++) variantUsed[id + "#" + j] = 0
    fresh = []
    for (var k = 0; k < variants.length; k++) fresh.push(k)
  }
  var idx = pickOne(fresh)
  variantUsed[id + "#" + idx] = now
  return fill(variants[idx], ctx)
}

// Friendly name for an app class: "org.kde.dolphin" -> "dolphin".
function baseClass(raw) {
  return String(raw || "").split(".").pop().toLowerCase()
}

// Map a raw window class to a category key used by the templates.
function appCategory(raw) {
  var c = baseClass(raw)
  var map = {
    firefox: "browser", librewolf: "browser", zen: "browser",
    chromium: "browser", "google-chrome": "browser", brave: "browser",
    vivaldi: "browser", thorium: "browser", "microsoft-edge": "browser",
    kitty: "terminal", alacritty: "terminal", foot: "terminal",
    ghostty: "terminal", konsole: "terminal", wezterm: "terminal",
    xterm: "terminal", urxvt: "terminal", tilix: "terminal",
    code: "editor", codium: "editor", cursor: "editor", zed: "editor",
    "code-oss": "editor", vscode: "editor", sublime_text: "editor",
    vim: "vim", nvim: "vim", neovim: "vim", gvim: "vim",
    spotify: "music", lollypop: "music", strawberry: "music", audacious: "music",
    discord: "chat", slack: "chat", telegramdesktop: "chat",
    "org.telegram.desktop": "chat", whatsapp: "chat", signal: "chat",
    steam: "games", lutris: "games", heroic: "games",
    "youtube-music": "music",
    mpv: "video", vlc: "video", celluloid: "video",
    figma: "design", inkscape: "design", gimp: "design", krita: "design",
    nautilus: "files", dolphin: "files", nemo: "files", thunar: "files",
    pcmanfm: "files", "org.gnome.Nautilus": "files"
  }
  return map[c] || ""
}

function friendlyAppName(raw, fallback) {
  var c = baseClass(raw)
  var display = {
    "google-chrome": "Chrome", "microsoft-edge": "Edge",
    telegramdesktop: "Telegram", "org.telegram.desktop": "Telegram",
    "code-oss": "VS Code", codium: "VS Codium", zed: "Zed",
    sublime_text: "Sublime", vlc: "VLC", celluloid: "Celluloid",
    mpv: "mpv", lutris: "Lutris", heroic: "Heroic", pcmanfm: "PCManFM",
    nautilus: "Files", dolphin: "Dolphin", nemo: "Nemo", thunar: "Thunar",
    konsole: "Konsole", wezterm: "WezTerm", foot: "Foot", ghostty: "Ghostty"
  }
  if (display[c]) return display[c]
  if (c.length > 0) return c.charAt(0).toUpperCase() + c.slice(1)
  return fallback || "that app"
}

function titleText(raw) {
  return String(raw || "").trim()
}

// ------------------------------------------------------------------ gating

function inQuietHours() {
  var h = hourNow()
  var start = Number(cfg.quietHoursStart)
  var end = Number(cfg.quietHoursEnd)
  if (start === end) return false
  if (start < end) return h >= start && h < end
  return h >= start || h < end
}

function calmEnough() {
  var now = nowMs()
  var recent = []
  for (var i = 0; i < recentFocus.length; i++) {
    if (now - recentFocus[i] < 60000) recent.push(recentFocus[i])
  }
  recentFocus = recent
  return recentFocus.length < 6
}

function cooldownOk(priority) {
  var now = nowMs()
  var elapsed = now - lastMessageAt
  // High-priority events (theme change, welcome back, late night) may cut
  // through the quiet floor; everything else waits for minIntervalSec.
  return priority >= 2 || elapsed >= cfg.minIntervalSec * 1000
}

function activity() {
  lastActivityAt = nowMs()
  if (idle) {
    idle = false
    return true
  }
  return false
}

function markIdle() {
  if (idle) return
  idle = true
}

function isIdle() { return idle }

// ---------------------------------------------------------------- templates

var T = {}

// Semih's taste lives here. Dry, self-aware, sometimes a real quote from
// the wall (Orhan Veli / Hamlet TR / NGE / Eternity and a Day). Mostly
// lowercase, TR-for-comment + EN-for-dev-word, no em dash, no inspiration.

T.browser = [
  "{app}.",
  "the browser.",
  "{app}. still.",
  "tabs.",
  "yine {app}.",
  "{tabs} sekme.",
  "{tabs} sekmeymiş.",
  "kırk sekme. sanki bir iş.",
  "kırk sekme açık. hiçbirini okumayacaksın.",
  "{app}. sonsuz.",
  "bir sekme daha. ok.",
  "scrolly death."
]

T.terminal = [
  "the terminal.",
  "this.",
  "{app}.",
  "typing.",
  "ne yazıyorsan onu yaz.",
  "{app}. komut.",
  "sessiz ama çalışıyor.",
  "ekranda dönen şey.",
  "bu bitti mi?",
  "state şişti. bi restart paklar."
]

T.editor = [
  "the editor.",
  "{app}.",
  "still writing.",
  "the cursor.",
  "cursor. imleç.",
  "{app}. bir satır daha.",
  "yazıyorsun. bildiğim.",
  "kaydet. ne olursa olsun.",
  "yine overengineer ediyorsun, farkındayım.",
  "loop'a girdin. (işe yararsa iyi)."
]

T.vim = [
  "vim.",
  "esc.",
  "vim. still.",
  ":w.",
  "normal mode. orada dur."
]

T.music = [
  "{app}.",
  "music.",
  "this song.",
  "bu çalarken.",
  "tek şarkı. bu an.",
  "{app}. sesi aç.",
  "şarkı bitince."
]

T.chat = [
  "{app}.",
  "people.",
  "chat.",
  "birileri yazıyor.",
  "{app}. dünya.",
  "mesaj geldi. belki.",
  "sohbet."
]

T.games = [
  "{app}.",
  "game.",
  "loading.",
  "bir tur daha.",
  "{app}. kaçış.",
  "kaydetmeden çıkma."
]

T.video = [
  "{app}.",
  "movie.",
  "shh.",
  "sessiz. film.",
  "bir sahne daha.",
  "{app}."
]

T.design = [
  "{app}.",
  "pixels.",
  "designing.",
  "piksel piksel.",
  "{app}. renk.",
  "kaydır. yeter."
]

T.files = [
  "{app}.",
  "files.",
  "sorting.",
  "dosyalar. hep orada.",
  "bir kalsın. ya.",
  "{app}. arama."
]

T.focusFallback = [
  "{app}.",
  "{app}. ok.",
  "you and {app}.",
  "sen ve {app}.",
  "{app}. demek.",
  "{app}. şimdilik."
]

T["window-open"] = [
  "a window.",
  "another one. {count} today.",
  "window.",
  "bir pencere daha. {count}.",
  "aç. kapanmaz.",
  "{count}. bugün."
]

T["window-close"] = [
  "gone.",
  "closed.",
  "one less.",
  "kapandı.",
  "biri daha gitti.",
  "temiz."
]

T.workspace = [
  "workspace {ws}. {windows:window}.",
  "{ws}.",
  "{windows:window} on {ws}.",
  "{ws}. burada."
]

T.home = [
  "home.",
  "workspace 1.",
  "ev. 1.",
  "ana ekran."
]

T.fullscreen = [
  "fullscreen.",
  "big.",
  "ok. fullscreen.",
  "tam ekran."
]

T.theme = [
  "{theme}.",
  "new colours. {theme}.",
  "{theme}. ok.",
  "{theme}. boyadın."
]

T.morning = [
  "morning.",
  "hi.",
  "you again.",
  "günaydın.",
  "yine biz.",
  "sabah. başladı."
]

T["late-night"] = [
  "{time} AM.",
  "still up.",
  "late.",
  "{time} AM. just us.",
  "{time} AM. hâlâ buradasın.",
  "uyku da bir şey.",
  "bilmezler yalnız yaşamıyanlar, nasıl korku verir sessizlik insana.",
  "bilinç böyle korkak ediyor hepimizi."
]

T["welcome-back"] = [
  "you're back.",
  "hi.",
  "boo.",
  "still here.",
  "boo. buradayım.",
  "geri geldin."
]

T["long-session"] = [
  "{hours} hours.",
  "still going. {hours} hours.",
  "{hours} hours in.",
  "{hours} saat. devam.",
  "otur. kalk. {hours} saat.",
  "kalk artık. {hours} saat oldu.",
  "{hours} saat. mola.",
  "kişiliğini insanlardan aldığın övgüler ile oluşturuyorsun."
]

T.ambient = [
  "boo.",
  "boo",
  "still here.",
  "hi.",
  ".",
  "{windows:window}.",
  "{minutes} minutes in {app}.",
  "bir şey söyleyecektim. unuttum.",
  "o pencere hâlâ açık.",
  "bilmemek ve hayal etmek daha iyi."
]

T.unexpected = [
  "{app}? usually {usual}.",
  "{app} instead of {usual}.",
  "{app}. not {usual}.",
  "{usual} yerine {app}?",
  "bugün {app}. değişiklik."
]

T.digest = [
  "yesterday: {summary}. {opens:window}.",
  "{summary}. that was yesterday.",
  "yesterday was {summary}.",
  "dün: {summary}.",
  "{summary}. bir gün daha."
]

T.week = [
  "this week: {summary}.",
  "{days} days. {summary}.",
  "bu hafta: {summary}.",
  "{days} gün. {summary}.",
  "hafta bitti: {summary}."
]

T.month = [
  "{month}: {summary}.",
  "this month: {summary}.",
  "bu ay: {summary}.",
  "{month}. {summary}.",
  "ay bitti: {summary}."
]

T.stale = [
  "{n} open.",
  "{name} is still there.",
  "{stale} of {n} sitting.",
  "{name}.",
  "{name} hâlâ açık.",
  "sen yokken {name} bekliyor.",
  "{name}. unuttun galiba."
]

T["title-change"] = [
  "{title}.",
  "now: {title}.",
  "{title}.",
  "şimdi: {title}.",
  "yeni başlık. {title}."
]

// -------------------------------------------------------------- generation

var lastSayId = ""

function say(id, variants, ctx) {
  lastSayId = id
  lastMessageAt = nowMs()
  messagesSent++
  return pickVariant(id, variants, ctx)
}

function lastKind() { return lastSayId }

// Build the context object handed to templates and (optionally) the LLM.
function contextFor(ev) {
  var ctx = {}
  var ws = ev.workspace !== undefined ? Number(ev.workspace) : -1
  ctx.ws = ws > 0 ? String(ws) : "?"
  ctx.windows = String(ev.windows || 0)
  ctx.count = String(ev.count || 0)
  ctx.theme = String(ev.theme || "a new theme")
  ctx.minutes = String(minutesBetween(nowMs(), sessionStart))
  ctx.hours = String(hoursBetween(nowMs(), sessionStart))
  ctx.messages = String(messagesSent)
  ctx.switches = String(wsSwitches)
  ctx.opens = String(windowsOpened)
  var hour = hourNow()
  var h12 = hour % 12
  if (h12 === 0) h12 = 12
  ctx.time = String(h12)
  ctx.app = String(ev.appName || "that app")
  ctx.tabs = String(14 + Math.floor(Math.random() * 8)) // a ghost can dream
  ctx.title = titleText(ev.title)
  return ctx
}

function feed(ev) {
  if (!cfg.enabled) return ""
  var now = nowMs()
  var grace = Number(cfg.graceSec || 0) * 1000
  if (now - LOADED_AT < grace) return "" // let the desktop settle first

  var type = String(ev.type || "")
  var ctx = contextFor(ev)

  if (type === "focus") {
    var cat = appCategory(ev.class)
    var appName = friendlyAppName(ev.class, ctx.app)
    ctx.app = appName
    lastApp = String(ev.class || "")
    recentFocus.push(now)

    // The same app twice in a row isn't an event; Ghost.qml only feeds on
    // actual changes. But rapid cycling looks like frenzy — stay quiet.
    if (!calmEnough()) return ""
    if (inQuietHours()) return ""
    if (!cooldownOk(1)) return ""

    // Don't comment on the same app category over and over.
    if (cat && appSeen[cat] && now - appSeen[cat] < 7200000) return ""
    if (cat) appSeen[cat] = now

    var weight = weightFor(cat)
    if (!chance(Number(cfg.chances.focus) * weight)) return ""

    // A deviation from the day's usual rhythm is worth noticing.
    var part = dayPart(hourNow())
    if (cat && chance(Number(cfg.chances.unexpected)) && !appSeen["unexpected-" + part]) {
      var usual = usualFor(part, cat)
      if (usual !== "") {
        appSeen["unexpected-" + part] = now
        ctx.app = appName
        ctx.usual = friendlyCategory(usual)
        return say("unexpected", T.unexpected, ctx)
      }
    }

    if (cat && T[cat]) return say("focus-" + cat, T[cat], ctx)
    return say("focus-other", T.focusFallback, ctx)
  }

  if (type === "window-open" || type === "window-close") {
    windowsOpened += type === "window-open" ? Number(ev.count || 1) : 0
    windowsClosed += type === "window-close" ? Number(ev.count || 1) : 0
    if (idle) return ""
    if (inQuietHours()) return ""
    if (!chance(Number(cfg.chances.window) * weightFor("window"))) return ""
    if (!cooldownOk(0.5)) return ""
    ctx.count = String(type === "window-open" ? windowsOpened : windowsClosed)
    return say(type, T[type], ctx)
  }

  if (type === "workspace") {
    wsSwitches++
    if (idle) return ""
    if (inQuietHours()) return ""
    var ws = Number(ev.workspace)
    if (!cooldownOk(0.7)) return ""
    var isHome = ws === 1 || ws === 0
    var interesting = Number(ev.windows || 0) >= 4
    if (isHome) {
      if (!chance(0.5)) return ""
      return say("workspace-home", T.home, ctx)
    }
    if (!interesting) return ""
    if (!chance(Number(cfg.chances.workspace) * weightFor("workspace"))) return ""
    return say("workspace-" + ws, T.workspace, ctx)
  }

  if (type === "fullscreen") {
    if (idle) return ""
    if (!chance(Number(cfg.chances.fullscreen) * weightFor("fullscreen"))) return ""
    if (!cooldownOk(0.8)) return ""
    return say("fullscreen", T.fullscreen, ctx)
  }

  if (type === "theme") {
    ctx.theme = String(ev.theme || "a new theme")
    return say("theme", T.theme, ctx)
  }

  if (type === "welcome-back") {
    if (!cooldownOk(2)) return ""
    return say("welcome-back", T["welcome-back"], ctx)
  }

  if (type === "late-night") {
    if (!cooldownOk(2)) return ""
    return say("late-night", T["late-night"], ctx)
  }

  if (type === "long-session") {
    if (!cooldownOk(1.2)) return ""
    if (!chance(Number(cfg.chances.longSession))) return ""
    ctx.hours = String(hoursBetween(nowMs(), sessionStart))
    if (Number(ctx.hours) < 1) return ""
    return say("long-session", T["long-session"], ctx)
  }

  if (type === "ambient") {
    if (idle) return ""
    if (inQuietHours()) return ""
    if (!cooldownOk(0)) return ""
    if (!chance(weightFor("ambient"))) return ""
    // Prefer something that reflects reality when we can.
    var lastCat = lastApp ? appCategory(lastApp) : ""
    ctx.app = friendlyAppName(lastApp, "the same app")
    ctx.windows = String(currentWindowCount || 0)
    return say("ambient", T.ambient, ctx)
  }

  // Focused window's title changed (e.g. a terminal switching from vim to
  // a test run). Fed from QML's heartbeat poll.
  if (type === "title") {
    if (idle) return ""
    if (inQuietHours()) return ""
    if (!cooldownOk(0.6)) return ""
    var t = titleText(ev.title)
    if (t === "") return ""
    if (/^(~|\/)/.test(t)) return ""          // path-like shell prompts
    if (t.length > 60) t = t.slice(0, 57) + "…"
    var tkey = "title-" + t
    if (appSeen[tkey] && now - appSeen[tkey] < 1800000) return ""
    appSeen[tkey] = now
    if (!chance(Number(cfg.chances.title) * weightFor("title"))) return ""
    ctx.title = t
    return say("title-change", T["title-change"], ctx)
  }

  return ""
}

// Number of toplevels, set from QML so ambient lines can count windows.
var currentWindowCount = 0
function setWindowCount(n) { currentWindowCount = Number(n) || 0 }

// ------------------------------------------------------------------ ambient

// Next ambient delay in ms, random inside [min, max]. If a high-priority
// message just landed, push the next one out further.
function nextAmbientMs() {
  var min = Number(cfg.minIntervalSec) * 1000
  var max = Number(cfg.maxIntervalSec) * 1000
  if (max < min) max = min
  return min + Math.floor(Math.random() * (max - min))
}

// ------------------------------------------------------------------ idle

function lastActivity() { return lastActivityAt }

// ------------------------------------------------------------------ LLM

// Context handed to bin/ghost-llm (and to anyone else who asks).
function llmContext(ev) {
  return {
    time: new Date().toLocaleTimeString(),
    hour: hourNow(),
    app: friendlyAppName(ev.class, lastApp),
    title: titleText(ev.title),
    workspace: ev.workspace !== undefined ? ev.workspace : -1,
    windows: currentWindowCount,
    openedToday: windowsOpened,
    closedToday: windowsClosed,
    sessionMinutes: minutesBetween(nowMs(), sessionStart),
    messagesToday: messagesSent,
    theme: lastTheme,
    idle: idle
  }
}

function llmAllowed() {
  var mode = String(cfg.brain || "templates")
  if (mode === "templates") return false
  if (mode === "llm") return true
  return false // "auto" currently means templates; flip via ghost.json
}

function llmRateLimited() {
  return nowMs() - llmLastTry < 60000
}

function markLlmAttempt() { llmLastTry = nowMs() }

// ---------------------------------------------------------------- memory

// Ghost's long-term memory, persisted by Ghost.qml to
// ~/.local/state/omarchy/ghost/state.json. Ninety days of what you did,
// used for weekly/monthly recaps, habit deviations, and the daily recap.

var DAYS_KEEP = 90
var STALE_MS = 90 * 60 * 1000
var COMPANION_MS = 3 * 60 * 60 * 1000
var MONTHS = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"]

var memory = null

function freshMemory() {
  return {
    today: dateString(new Date()),
    firstActivityHour: -1,
    lastActivityHour: -1,
    todayMinutes: {},        // category -> minutes today
    byPart: {},              // today's focus-event counts per day-part
    windowsOpened: 0,        // today
    // usage metrics
    activeMinutes: 0,        // total focused minutes today
    hourCounts: {},          // hour -> active minutes today
    currentSession: null,    // { app, startMs } while one app holds focus
    sessions: [],            // today's closed focus sessions (>= 1 min)
    switchCount: 0,          // focus switches today
    insightsToday: 0,        // metric insights emitted today (budget)
    announcedStretch: 0,     // last announced longest-stretch (minutes)
    announcedDeep: 0,        // last announced deep-work hour
    announcedRhythmDate: "",
    announcedPeakDate: "",
    days: {},                // "YYYY-MM-DD" -> daily record
    dismissals: {},
    weights: {},
    lastDigestFor: "",
    lastWeeklyFor: "",
    lastMonthlyFor: "",
    lastCompanionAt: 0,
    workspaces: {}           // id -> { name, lastMs, windows }
  }
}

function dateString(d) {
  var y = d.getFullYear()
  var m = String(d.getMonth() + 1).padStart(2, "0")
  var day = String(d.getDate()).padStart(2, "0")
  return y + "-" + m + "-" + day
}

function dayPart(h) {
  if (h >= 5 && h < 11) return "morning"
  if (h >= 11 && h < 17) return "afternoon"
  if (h >= 17 && h < 22) return "evening"
  return "night"
}

function loadState(raw) {
  var parsed = {}
  try { parsed = JSON.parse(String(raw || "{}")) } catch (e) { parsed = {} }
  var m = freshMemory()
  for (var k in parsed) {
    if (k === "today" || k === "todayMinutes" || k === "byPart" || k === "days"
        || k === "dismissals" || k === "weights" || k === "windowsOpened"
        || k === "lastDigestFor" || k === "activeMinutes" || k === "hourCounts"
        || k === "sessions" || k === "switchCount" || k === "insightsToday"
        || k === "announcedStretch" || k === "announcedDeep"
        || k === "announcedRhythmDate" || k === "announcedPeakDate"
        || k === "lastWeeklyFor" || k === "lastMonthlyFor"
        || k === "lastCompanionAt" || k === "workspaces") {
      m[k] = parsed[k]
    }
  }
  if (Number(parsed.firstActivityHour) >= 0) m.firstActivityHour = Number(parsed.firstActivityHour)
  if (Number(parsed.lastActivityHour) >= 0) m.lastActivityHour = Number(parsed.lastActivityHour)
  memory = m
  return m
}

function snapshotState() {
  if (!memory) memory = freshMemory()
  return memory
}

function today() { return dateString(new Date()) }

// Accumulate time + focus-event counts. Minutes are approximate (heartbeat
// granularity); that's fine for a ghost.
function noteFocus(appClass, msElapsed) {
  if (!memory) memory = freshMemory()
  if (memory.today !== today()) return // heartbeat owns the day rollover
  var now = new Date()
  var cat = appCategory(appClass)
  // fractional minutes — the heartbeat ticks every 30 s, so whole-minute
  // rounding would never accumulate anything
  var mins = msElapsed > 0 ? msElapsed / 60000 : 0
  var h = now.getHours()
  if (mins > 0) {
    memory.activeMinutes += mins
    memory.hourCounts[h] = (memory.hourCounts[h] || 0) + mins
  }
  if (cat && mins > 0) {
    memory.todayMinutes[cat] = (memory.todayMinutes[cat] || 0) + mins
  }
  if (memory.firstActivityHour < 0) memory.firstActivityHour = h
  memory.lastActivityHour = h
  if (cat) {
    var part = dayPart(h)
    if (!memory.byPart[part]) memory.byPart[part] = {}
    memory.byPart[part][cat] = (memory.byPart[part][cat] || 0) + 1
  }
}

// The focused app changed: close the previous focus session (if it lasted
// at least a minute) and start a new one. Sessions feed the metric insights.
function focusSwitched(appClass) {
  if (!memory) memory = freshMemory()
  if (memory.today !== today()) return
  var cat = appCategory(appClass)
  if (cat === "") return // compositor plumbing, not a real focus
  if (memory.currentSession && memory.currentSession.app) {
    var dur = nowMs() - memory.currentSession.startMs
    if (dur >= 60000) {
      memory.sessions.push({ app: memory.currentSession.app, durationMs: dur })
      if (memory.sessions.length > 200) memory.sessions = memory.sessions.slice(-200)
    }
  }
  memory.currentSession = { app: cat, startMs: nowMs() }
  memory.switchCount++
}

function noteWindowOpened(count) {
  if (!memory) memory = freshMemory()
  memory.windowsOpened += Number(count || 1)
}

// Ship yesterday into memory.days and reset today. Returns the digest line
// (already cooldown-registered) or "".
function rolloverIfNeeded() {
  if (!memory) memory = freshMemory()
  var t = today()
  if (memory.today === t) return ""
  var yesterday = memory.today
  if (yesterday !== "") {
    memory.days[yesterday] = {
      minutes: clone(memory.todayMinutes),
      byPart: clone(memory.byPart),
      firstActivityHour: memory.firstActivityHour,
      lastActivityHour: memory.lastActivityHour,
      windowsOpened: memory.windowsOpened,
      activeMinutes: memory.activeMinutes,
      peakHour: peakHourOf(memory.hourCounts),
      sessionCount: memory.sessions.length,
      avgSessionMin: memory.sessions.length > 0
        ? Math.round(sumSessions(memory.sessions) / memory.sessions.length / 60000)
        : 0,
      longestSessionMin: memory.sessions.length > 0
        ? Math.round(longestSession(memory.sessions) / 60000)
        : 0,
      switchCount: memory.switchCount
    }
    var keys = Object.keys(memory.days).sort()
    var excess = keys.length - DAYS_KEEP
    for (var i = 0; i < excess; i++) delete memory.days[keys[i]]
  }
  memory.today = t
  memory.firstActivityHour = -1
  memory.lastActivityHour = -1
  memory.todayMinutes = {}
  memory.byPart = {}
  memory.windowsOpened = 0
  memory.activeMinutes = 0
  memory.hourCounts = {}
  memory.currentSession = null
  memory.sessions = []
  memory.switchCount = 0
  memory.insightsToday = 0
  memory.announcedStretch = 0
  memory.announcedDeep = 0
  return digestMessage(yesterday)
}

function peakHourOf(hourCounts) {
  var best = -1
  var bestN = 0
  for (var h in hourCounts) {
    if (hourCounts[h] > bestN) { best = Number(h); bestN = hourCounts[h] }
  }
  return best
}

function sumSessions(sessions) {
  var total = 0
  for (var i = 0; i < sessions.length; i++) total += sessions[i].durationMs
  return total
}

function longestSession(sessions) {
  var longest = 0
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].durationMs > longest) longest = sessions[i].durationMs
  }
  return longest
}

function digestMessage(yesterday) {
  if (!memory || !memory.days[yesterday]) return ""
  if (memory.lastDigestFor === yesterday) return ""
  var rec = memory.days[yesterday]
  var summary = summarizeMinutes(rec.minutes)
  if (summary === "") return ""
  memory.lastDigestFor = yesterday
  var ctx = { summary: summary, opens: String(rec.windowsOpened || 0) }
  return say("digest", T.digest, ctx)
}

function summarizeMinutes(minutes) {
  var cats = []
  for (var cat in minutes) cats.push({ cat: cat, mins: Math.round(minutes[cat]) })
  if (cats.length === 0) return ""
  cats.sort(function(a, b) { return b.mins - a.mins })
  var parts = []
  for (var i = 0; i < Math.min(3, cats.length); i++) {
    var m = cats[i].mins
    var h = Math.floor(m / 60)
    var rem = m % 60
    var dur = h > 0 ? (h + "h" + (rem > 0 ? " " + rem + "m" : "")) : rem + "m"
    parts.push(dur + " in " + cats[i].cat)
  }
  return parts.join(", ")
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n
}

function isoWeekKey(d) {
  var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  var yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  var weekNo = Math.ceil((((t - yearStart) / 86400000) + 1) / 7)
  return t.getUTCFullYear() + "-W" + pad2(weekNo)
}

function monthKey(y, m) {
  return y + "-" + pad2(m + 1)
}

function lastNDateKeys(n, now) {
  now = now || new Date()
  var keys = []
  var i
  for (i = 0; i < n; i++) {
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    keys.push(dateString(d))
  }
  return keys
}

function dateKeysInMonth(y, m) {
  var keys = []
  var d = new Date(y, m, 1)
  while (d.getMonth() === m) {
    keys.push(dateString(d))
    d.setDate(d.getDate() + 1)
  }
  return keys
}

function sumMinutesMaps(maps) {
  var out = {}
  var i, cat
  for (i = 0; i < maps.length; i++) {
    var map = maps[i] || {}
    for (cat in map) out[cat] = (out[cat] || 0) + Number(map[cat] || 0)
  }
  return out
}

function minutesForKeys(keys, includeToday) {
  if (!memory) return {}
  var maps = []
  var i
  for (i = 0; i < keys.length; i++) {
    if (includeToday && keys[i] === memory.today) maps.push(memory.todayMinutes)
    else if (memory.days[keys[i]] && memory.days[keys[i]].minutes) maps.push(memory.days[keys[i]].minutes)
  }
  return sumMinutesMaps(maps)
}

function countKeysWithData(keys, includeToday) {
  if (!memory) return 0
  var n = 0
  var i
  for (i = 0; i < keys.length; i++) {
    if (includeToday && keys[i] === memory.today && memory.todayMinutes && Object.keys(memory.todayMinutes).length) n++
    else if (memory.days[keys[i]] && memory.days[keys[i]].minutes) n++
  }
  return n
}

function weekMessage(opts) {
  opts = opts || {}
  if (!memory) memory = freshMemory()
  var keys = lastNDateKeys(7)
  var summary = summarizeMinutes(minutesForKeys(keys, true))
  if (summary === "") return ""
  if (!opts.force) {
    var wk = isoWeekKey(new Date())
    if (memory.lastWeeklyFor === wk) return ""
    if (countKeysWithData(keys, true) < 2) return ""
    memory.lastWeeklyFor = wk
  }
  return say("week", T.week, { summary: summary, days: String(countKeysWithData(keys, true)) })
}

function monthMessage(opts) {
  opts = opts || {}
  if (!memory) memory = freshMemory()
  var now = new Date()
  var y = now.getFullYear()
  var m = now.getMonth()
  if (!opts.current) {
    m -= 1
    if (m < 0) { m = 11; y -= 1 }
  }
  var keys = dateKeysInMonth(y, m)
  var includeToday = (y === now.getFullYear() && m === now.getMonth())
  var summary = summarizeMinutes(minutesForKeys(keys, includeToday))
  if (summary === "") return ""
  if (!opts.force) {
    var stamp = monthKey(y, m)
    if (memory.lastMonthlyFor === stamp) return ""
    memory.lastMonthlyFor = stamp
  }
  return say("month", T.month, { summary: summary, month: MONTHS[m] })
}

function periodRecap() {
  if (!cfg.enabled) return ""
  if (!cooldownOk(1.5)) return ""
  var month = monthMessage({})
  if (month) return month
  return weekMessage({})
}

function noteWorkspaces(list, now) {
  if (!memory) memory = freshMemory()
  now = now !== undefined ? now : nowMs()
  if (!memory.workspaces) memory.workspaces = {}
  var seen = {}
  var i
  for (i = 0; i < list.length; i++) {
    var w = list[i] || {}
    var id = String(w.id)
    if (id === "" || id === "undefined" || id === "NaN") continue
    seen[id] = true
    var rec = memory.workspaces[id]
    if (!rec) {
      rec = {
        name: "",
        lastMs: w.focused ? now : now - STALE_MS,
        windows: 0
      }
    }
    rec.name = betterWorkspaceName(w.name, w.title, rec.name)
    rec.windows = Number(w.windows || 0)
    if (w.focused) rec.lastMs = now
    memory.workspaces[id] = rec
  }
  for (var k in memory.workspaces) {
    if (!seen[k]) delete memory.workspaces[k]
  }
}

function nameScore(s) {
  s = String(s || "").trim()
  if (s === "") return 0
  if (/^[0-9]+$/.test(s)) return 1
  return 2 + Math.min(s.length, 24)
}

function cleanWorkspaceTitle(raw) {
  var t = String(raw || "").trim()
  if (t === "") return ""
  t = t.replace(/^omarchy:\s*/i, "")
  t = t.replace(/^\[\d+\]\s*/, "")
  t = t.replace(/\s+[—–|\-]\s+.*$/, "")
  t = t.replace(/\s+\/\s+.*$/, "")
  t = t.trim()
  if (t === "" || /^content$/i.test(t) || /^(~|\/)/.test(t)) return ""
  if (t.length > 24) t = t.slice(0, 21) + "…"
  return t
}

function betterWorkspaceName(hyprName, title, existing) {
  var candidates = [
    String(existing || ""),
    String(hyprName || ""),
    cleanWorkspaceTitle(title)
  ]
  var best = ""
  var bestN = 0
  var i
  for (i = 0; i < candidates.length; i++) {
    var n = nameScore(candidates[i])
    if (n > bestN) {
      bestN = n
      best = candidates[i]
    }
  }
  return best
}

function workspaceLabel(rec, id) {
  var name = String((rec && rec.name) || "")
  if (name === "" || name === String(id) || /^[0-9]+$/.test(name)) return "workspace " + id
  if (name.length > 24) return name.slice(0, 21) + "…"
  return name
}

function companion(now, opts) {
  opts = opts || {}
  if (!cfg.enabled) return ""
  now = now !== undefined && now !== null ? now : nowMs()
  if (!opts.force) {
    if (idle) return ""
    if (inQuietHours()) return ""
    if (!cooldownOk(0.4)) return ""
    if (now - Number(memory.lastCompanionAt || 0) < COMPANION_MS) return ""
  }
  if (!memory || !memory.workspaces) return ""

  var occupied = []
  var id
  for (id in memory.workspaces) {
    var rec = memory.workspaces[id]
    if (!rec || Number(rec.windows || 0) < 1) continue
    occupied.push({ id: id, rec: rec, age: now - Number(rec.lastMs || 0) })
  }
  if (occupied.length < 3) return ""

  var stale = []
  var i
  for (i = 0; i < occupied.length; i++) {
    if (occupied[i].age >= STALE_MS) stale.push(occupied[i])
  }
  if (stale.length < 2) return ""

  stale.sort(function(a, b) { return b.age - a.age })
  memory.lastCompanionAt = now
  return say("stale", T.stale, {
    n: String(occupied.length),
    stale: String(stale.length),
    name: workspaceLabel(stale[0].rec, stale[0].id)
  })
}

// Most-used category for a day-part across the last 14 days, excluding the
// category we're currently judging against.
function usualFor(part, currentCat) {
  if (!memory) return ""
  var counts = {}
  var daysWithData = 0
  for (var date in memory.days) {
    var rec = memory.days[date]
    var p = rec && rec.byPart ? rec.byPart[part] : null
    if (!p) continue
    daysWithData++
    for (var cat in p) counts[cat] = (counts[cat] || 0) + p[cat]
  }
  if (daysWithData < 2) return ""
  var best = ""
  var bestN = 0
  for (var c in counts) {
    if (c === currentCat) continue
    if (counts[c] > bestN) { best = c; bestN = counts[c] }
  }
  return best
}

function friendlyCategory(cat) {
  var map = {
    browser: "the browser", terminal: "the terminal", editor: "the editor",
    vim: "vim", music: "some music", chat: "a chat app", games: "a game",
    video: "a video", design: "a design tool", files: "the file manager"
  }
  return map[cat] || cat
}

// Dismissal feedback: shooing the bubble away teaches Ghost to talk less
// about that subject; letting it sit teaches it to talk more.
function weightKeyFor(kind) {
  if (kind.indexOf("focus-") === 0) return kind.slice(6)
  if (kind === "window-open" || kind === "window-close") return "window"
  if (kind.indexOf("workspace") === 0) return "workspace"
  if (kind === "fullscreen") return "fullscreen"
  if (kind === "unexpected") return "unexpected"
  if (kind === "ambient") return "ambient"
  if (kind === "title-change") return "title"
  if (kind === "stale" || kind === "week" || kind === "month") return kind
  return "misc"
}

function noteDismissal(kind) {
  if (!memory) memory = freshMemory()
  var key = weightKeyFor(kind)
  var w = memory.weights[key] || 1
  memory.weights[key] = Math.max(0.3, w - 0.15)
  memory.dismissals[kind] = (memory.dismissals[kind] || 0) + 1
}

function noteKept(kind) {
  if (!memory) memory = freshMemory()
  var key = weightKeyFor(kind)
  var w = memory.weights[key] || 1
  memory.weights[key] = Math.min(1.5, w + 0.05)
}

function weightFor(key) {
  return memory && memory.weights[key] ? memory.weights[key] : 1
}

// ---------------------------------------------------------------- insights

// Metric-based nudges: the "watches everything" payoff. Checked every few
// minutes from QML, but every candidate is gated by cooldown + a daily
// budget, so it nudges without becoming the thing you keep shooing away.

T.stretch = [
  "{minutes} minutes in {app}.",
  "{minutes} minutes. {app}.",
  "{app}. {minutes} minutes.",
  "{minutes} dakika {app}.",
  "{app}. {minutes} dakika. kalk."
]

T.rhythm = [
  "{a} → {b} → {a} → {b}. every {minutes} minutes.",
  "{a} and {b}. every {minutes} minutes.",
  "{a} ↔ {b}. {minutes} dakikada bir.",
  "ritim: {a} {b} {a} {b}. {minutes} dk."
]

T.deep = [
  "{hours} hours.",
  "{hours} hours in.",
  "deep. {hours} saat.",
  "{hours} saat. derin mi?"
]

T.peak = [
  "{time}.",
  "this hour. {time}.",
  "en aktif saatin. {time}."
]

function insight() {
  if (!cfg.enabled) return ""
  if (!memory) return ""
  if (nowMs() - LOADED_AT < Number(cfg.graceSec || 0) * 1000) return ""
  if (idle) return ""
  if (inQuietHours()) return ""
  if (!cooldownOk(0.9)) return ""
  if (!chance(Number(cfg.chances.insight || 0.6))) return ""
  if (memory.insightsToday >= Number(cfg.insightDailyCap || 6)) return ""

  var candidates = []
  var s = insightStretch()
  if (s) candidates.push(s)
  var r = insightRhythm()
  if (r) candidates.push(r)
  var d = insightDeep()
  if (d) candidates.push(d)
  var p = insightPeak()
  if (p) candidates.push(p)

  if (candidates.length === 0) return ""
  memory.insightsToday++
  var c = pickOne(candidates)
  return say(c.id, c.vars, c.ctx)
}

// Today's longest focus stretch (open or closed session) breaking the
// previous record by at least 10 minutes, from 30 minutes up.
function insightStretch() {
  var longest = 0
  var app = ""
  var i
  for (i = 0; i < memory.sessions.length; i++) {
    if (memory.sessions[i].durationMs > longest) {
      longest = memory.sessions[i].durationMs
      app = memory.sessions[i].app
    }
  }
  if (memory.currentSession && memory.currentSession.app) {
    var cur = nowMs() - memory.currentSession.startMs
    if (cur > longest) { longest = cur; app = memory.currentSession.app }
  }
  var min = Math.round(longest / 60000)
  if (min < 30 || min - memory.announcedStretch < 10) return null
  memory.announcedStretch = min
  return { id: "insight-stretch", vars: T.stretch, ctx: { minutes: String(min), app: friendlyCategory(app) } }
}

// Rapid back-and-forth between the same two app categories, all day.
function insightRhythm() {
  if (memory.announcedRhythmDate === today()) return null
  if (memory.sessions.length < 6) return null
  var byCat = {}
  var total = 0
  var durSum = 0
  for (var i = 0; i < memory.sessions.length; i++) {
    var s = memory.sessions[i]
    if (!s.app) continue
    byCat[s.app] = (byCat[s.app] || 0) + 1
    durSum += s.durationMs
    total++
  }
  if (total < 6) return null
  var avgMin = Math.round(durSum / total / 60000)
  if (avgMin > 8) return null
  var top = []
  for (var c in byCat) top.push({ cat: c, n: byCat[c] })
  top.sort(function(a, b) { return b.n - a.n })
  if (top.length < 2) return null
  var topShare = (top[0].n + top[1].n) / total
  if (topShare < 0.6) return null
  memory.announcedRhythmDate = today()
  return {
    id: "insight-rhythm",
    vars: T.rhythm,
    ctx: { a: friendlyCategory(top[0].cat), b: friendlyCategory(top[1].cat), minutes: String(avgMin) }
  }
}

// Total focused minutes crossing a new full hour.
function insightDeep() {
  var hours = Math.floor(memory.activeMinutes / 60)
  if (hours < 1 || hours <= memory.announcedDeep) return null
  memory.announcedDeep = hours
  return { id: "insight-deep", vars: T.deep, ctx: { hours: String(hours) } }
}

// The hour of day you've historically been most active, when it rolls around.
function insightPeak() {
  if (memory.announcedPeakDate === today()) return null
  var counts = {}
  var daysWithData = 0
  for (var date in memory.days) {
    var rec = memory.days[date]
    if (rec && rec.peakHour >= 0) {
      counts[rec.peakHour] = (counts[rec.peakHour] || 0) + 1
      daysWithData++
    }
  }
  if (daysWithData < 2) return null
  var best = -1
  var bestN = 0
  for (var h in counts) {
    if (counts[h] > bestN) { best = Number(h); bestN = counts[h] }
  }
  if (best < 0 || hourNow() !== best) return null
  memory.announcedPeakDate = today()
  var h12 = best % 12
  if (h12 === 0) h12 = 12
  return { id: "insight-peak", vars: T.peak, ctx: { time: String(h12) + (best >= 12 ? " PM" : " AM") } }
}

// ------------------------------------------------------------------ exports

// QML imports this file as a library (top-level functions and vars become
// the module's API). The guard below additionally feeds Node's require() so
// the same file can be unit-tested with `node test/brain.test.js` — same
// convention as omarchy-stocks / agent-watcher's Model.js.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULTS: DEFAULTS,
    parseConfig: parseConfig,
    getCfg: getCfg,
    feed: feed,
    activity: activity,
    markIdle: markIdle,
    isIdle: isIdle,
    lastActivity: lastActivity,
    nextAmbientMs: nextAmbientMs,
    setWindowCount: setWindowCount,
    llmContext: llmContext,
    llmAllowed: llmAllowed,
    llmRateLimited: llmRateLimited,
    markLlmAttempt: markLlmAttempt,
    resetMemory: resetMemory,
    lastKind: lastKind,
    // long-term memory
    loadState: loadState,
    snapshotState: snapshotState,
    noteFocus: noteFocus,
    focusSwitched: focusSwitched,
    noteWindowOpened: noteWindowOpened,
    rolloverIfNeeded: rolloverIfNeeded,
    digestMessage: digestMessage,
    weekMessage: weekMessage,
    monthMessage: monthMessage,
    periodRecap: periodRecap,
    noteWorkspaces: noteWorkspaces,
    companion: companion,
    usualFor: usualFor,
    noteDismissal: noteDismissal,
    noteKept: noteKept,
    weightFor: weightFor,
    // metric insights
    insight: insight,
    insightStretch: insightStretch,
    insightRhythm: insightRhythm,
    insightDeep: insightDeep,
    insightPeak: insightPeak,
    // test hooks
    _setConfig: function(overrides) { cfg = clone(DEFAULTS); for (var k in overrides) cfg[k] = overrides[k]; return cfg },
    _lastMessageAt: function() { return lastMessageAt },
    _state: function() { return { messagesSent: messagesSent, windowsOpened: windowsOpened, wsSwitches: wsSwitches, lastApp: lastApp } },
    _resetMemory: function() { memory = null },
    _memory: function() { return memory }
  }
}
