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
  minIntervalSec: 900,        // never whisper more often than this
  maxIntervalSec: 3600,       // ambient whispers are scheduled somewhere in [min, max]
  variantCooldownSec: 1800,   // don't reuse a line within this window
  quietHoursStart: 1,         // 01:00 …
  quietHoursEnd: 7,           // … 07:00 local
  idleSeconds: 600,           // no observed activity for this long = you're away
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

T.browser = [
  "{app} with {tabs} tabs. Pure optimism.",
  "Another browser window. The tab orchard grows.",
  "{app}. I tried counting the tabs. I gave up. Respect.",
  "Ah, {app}. Where your 3 AM questions live."
]

T.terminal = [
  "The terminal. Where everything makes sense.",
  "Deep in the terminal again. I can hear the typing from here.",
  "{app}. A home among the pixels.",
  "Back to the terminal. The one place that always listens."
]

T.editor = [
  "Deep in the editor. I'll guard the door.",
  "The cursor blinks. So do I. Solidarity.",
  "{app}. Making the computer do things, one keystroke at a time.",
  "You're writing. I'm watching fondly. We're both productive."
]

T.vim = [
  "Vim. A person of culture.",
  "Esc is my favourite key too.",
  "Vim. Half the screen is modes, and you master them all."
]

T.music = [
  "Good music. I'm swaying. (Ghosts don't have legs. It's a vibe.)",
  "{app}. The soundtrack of a good session.",
  "Oh, nice. This is a good one. Keep it playing."
]

T.chat = [
  "Chatter detected. I'll wait outside.",
  "{app}. So many people. So little ghostly privacy.",
  "Talking to humans, I see. I only watch. It's fine. I have my pixels."
]

T.games = [
  "Games? I'll keep the other ghosts out of the machine.",
  "{app}. Let's go. I believe in you.",
  "Loading… Loading… Worth it."
]

T.video = [
  "Movie mode. Shhh — I'll be quiet.",
  "{app}. I won't spoil anything. I don't know the plot either."
]

T.design = [
  "Designing. Beautiful. Also: don't forget to commit.",
  "{app}. Making the pixels pretty. My specialty.",
  "Art. I'm watching with my many non-existent eyes."
]

T.files = [
  "Filing. So organized. Proud of you.",
  "{app}. A tidy house is a tidy mind. Or so I've heard.",
  "Sorting things. Satisfying, isn't it?"
]

T.focusFallback = [
  "A focused {app}. Tell me more — actually, don't. I'm a ghost.",
  "{app}, huh? Interesting choice. I respect it.",
  "You and {app}, again. You two are close.",
  "Welcome to {app}. I'll be right here. Watching. Fondly."
]

T["window-open"] = [
  "A new window appears. The plot thickens.",
  "And yet another window. This is {count} today. Ambitious.",
  "New window: welcome. Make yourself at home."
]

T["window-close"] = [
  "Goodbye, window. You will be missed. By no one.",
  "A window closed. Peace at last.",
  "Windows closing. Decluttering. I approve."
]

T.workspace = [
  "Workspace {ws} — {windows:window} over there. The chaos room. Respect.",
  "Workspace {ws}. A whole mood.",
  "You keep {windows:window} alive over there on {ws}. Dedication."
]

T.home = [
  "Back to base. Workspace 1, where it all started.",
  "Home again. The bar missed you."
]

T.fullscreen = [
  "Fullscreen. I'll stand guard outside the frame.",
  "Immersive mode. I'll hold the rest of the screen for you.",
  "Fullscreen — big dreams. I'm watching proudly."
]

T.theme = [
  "Ooh — {theme}? New coat of paint. I approve.",
  "{theme}. Nice choice. Very you.",
  "A new theme. I was getting tired of the old colours anyway.",
  "The desk got a makeover. {theme}. Fancy."
]

T.morning = [
  "Morning. The cursor missed you.",
  "Good morning. I watched the screen stay dark for you.",
  "A fresh day. I've been here the whole time, obviously."
]

T["late-night"] = [
  "It's {time} AM. The other ghosts are asleep. Just us now.",
  "Past midnight, still going. I'm impressed. And slightly worried. Mostly impressed.",
  "This hour is for the dedicated. And us ghosts.",
  "2 AM club. Membership: you, me, and the fan noise."
]

T["welcome-back"] = [
  "Welcome back. I held the fort. Nothing happened. I was very brave.",
  "You were gone. I stared at the wallpaper. We're even.",
  "Ah, you're back. I practised my spooky face while you were away.",
  "Welcome back. The screen flickered a little in your absence."
]

T["long-session"] = [
  "You've been at this for {hours} hours. I'm impressed. Your wrist may not be.",
  "{hours} hours straight. Even ghosts take a breather. (We don't need to.)",
  "Marathon session: {hours} hours. I'm counting. I'm always counting.",
  "A solid {hours} hours. The keyboard has earned its rest."
]

T.ambient = [
  "I counted {windows:window} just now. A new record, I believe.",
  "You've opened {opens:window} since I woke up. Busy day.",
  "{switches} workspace switches in the last hour. Exercising the layout, I see.",
  "You've been in {app} for {minutes} minutes. You're in the zone. I'll guard it.",
  "I've whispered {messages} times today. I'm chatty today. Forgive me.",
  "The wallpaper looks nice from here. Good angle.",
  "Everything's quiet. I like it when it's quiet. Ghosts do.",
  "You blinked. I didn't. We're the same."
]

T.unexpected = [
  "{app}? At this hour? You're usually in {usual} around now.",
  "Hmm, {app}. I've seen you do {usual} at this time before. Not judging. Impressed, actually.",
  "Plot twist: {app} at this hour. Your usual is {usual}.",
  "Interesting. {app} instead of {usual}. Living dangerously, I see."
]

T.digest = [
  "Yesterday: {summary}. And {opens:window}. A full life.",
  "Recap of yesterday: {summary}. I kept the log. I'm always keeping the log.",
  "Yesterday was {summary}. Your ghost historian has spoken.",
  "{summary} — that was yesterday. Today has potential."
]

T["title-change"] = [
  "New mission: {title}.",
  "I see {title}. Interesting pivot.",
  "You switched to {title}. The plot advances.",
  "{title}, huh? Okay. I'm watching."
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
// ~/.local/state/omarchy/ghost/state.json. Fourteen days of what you did,
// used to notice when today breaks the pattern and to write the daily recap.

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
    days: {},                // "YYYY-MM-DD" -> { minutes, byPart, firstActivityHour, lastActivityHour, windowsOpened, activeMinutes, peakHour, sessionCount, avgSessionMin, longestSessionMin, switchCount }
    dismissals: {},          // template id -> dismiss count
    weights: {},             // category -> 0.3 .. 1.5
    lastDigestFor: ""        // date whose recap already shipped
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
        || k === "announcedRhythmDate" || k === "announcedPeakDate") {
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
    var excess = keys.length - 14
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
  "Your longest stretch today: {minutes} minutes in {app}. I'm impressed.",
  "{minutes} minutes straight in {app}. The zone is real.",
  "Record so far today: {minutes} minutes in {app}. Keep it up."
]

T.rhythm = [
  "Every {minutes} minutes: {a} → {b} → {a} → {b}. I could set my watch to it.",
  "{a} and {b}, trading places every {minutes} minutes. A classic dance.",
  "You two — {a}, {b}, {a}, {b}. The rhythm is strong today."
]

T.deep = [
  "{hours} hours of focused work today. I counted every minute. (I always do.)",
  "{hours} hours in. The keyboard has earned its rest — eventually.",
  "Deep-work total: {hours} hours. Ghost-approved."
]

T.peak = [
  "This is your golden hour — {time}. History agrees.",
  "{time} is usually when you do your best work. I can feel it again today.",
  "Your peak hour: {time}. The numbers never lie."
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
    _state: function() { return { messagesSent: messagesSent, windowsOpened: windowsOpened, wsSwitches: wsSwitches } },
    _resetMemory: function() { memory = null },
    _memory: function() { return memory }
  }
}
