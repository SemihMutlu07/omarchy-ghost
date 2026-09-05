// Ghost brain unit tests — run with: node --test test/brain.test.js

const assert = require("node:assert/strict")
const { test } = require("node:test")

const Brain = require("../Brain.js")

function freshConfig(overrides) {
  const cfg = Object.assign({
    graceSec: 0,
    minIntervalSec: 0,
    maxIntervalSec: 600,
    variantCooldownSec: 0,
    quietHoursStart: 12,
    quietHoursEnd: 12, // disabled
    idleSeconds: 600,
    chances: { focus: 1, window: 1, workspace: 1, fullscreen: 1, longSession: 1, lateNight: 1, title: 1, unexpected: 1, insight: 1 }
  }, overrides || {})
  Brain.resetMemory()
  return Brain._setConfig(cfg)
}

test("theme change always produces a message", () => {
  freshConfig()
  const msg = Brain.feed({ type: "theme", theme: "catppuccin" })
  assert.ok(msg && msg.length > 0, "theme message should be non-empty")
  assert.ok(
    msg.includes("catppuccin") || msg.includes("colours") || msg.includes("theme"),
    "theme message should mention the change"
  )
})

test("focus on a known app category uses its templates", () => {
  freshConfig()
  const msg = Brain.feed({ type: "focus", class: "nvim" })
  assert.ok(msg && msg.length > 0)
})

test("unknown apps get the fallback", () => {
  freshConfig()
  const msg = Brain.feed({ type: "focus", class: "some-weird-app" })
  assert.ok(msg && msg.length > 0)
  assert.match(msg, /weird/i)
})

test("focus remembers the app for later ambient lines", () => {
  freshConfig()
  Brain.feed({ type: "focus", class: "firefox" })
  assert.equal(Brain._state().lastApp, "firefox")
})

test("min interval gates low-priority events", () => {
  freshConfig({ minIntervalSec: 3600 })
  const first = Brain.feed({ type: "focus", class: "firefox" })
  const second = Brain.feed({ type: "focus", class: "code" })
  assert.ok(first, "first focus should pass")
  assert.equal(second, "", "second focus within cooldown should be silent")
  // high priority cuts through the cooldown
  const theme = Brain.feed({ type: "theme", theme: "gruvbox" })
  assert.ok(theme, "theme should bypass cooldown")
})

test("quiet hours suppress ambient and focus", () => {
  freshConfig({ quietHoursStart: 0, quietHoursEnd: 24 })
  assert.equal(Brain.feed({ type: "ambient" }), "")
  assert.equal(Brain.feed({ type: "focus", class: "code" }), "")
  // but theme still gets through
  assert.ok(Brain.feed({ type: "theme", theme: "solarized" }))
})

test("idle blocks low-priority chatter, welcome-back cuts through", () => {
  freshConfig()
  Brain.markIdle()
  assert.equal(Brain.feed({ type: "window-open", count: 1 }), "")
  assert.equal(Brain.feed({ type: "ambient" }), "")
  const msg = Brain.feed({ type: "welcome-back" })
  assert.ok(msg && msg.length > 0)
  // coming back is an activity event
  assert.equal(Brain.activity(), true)
})

test("workspace messages only for interesting workspaces", () => {
  freshConfig()
  assert.equal(Brain.feed({ type: "workspace", workspace: 2, windows: 1 }), "")
  const msg = Brain.feed({ type: "workspace", workspace: 3, windows: 7 })
  assert.ok(msg && msg.length > 0)
  assert.match(msg, /3/)
})

test("long-session skips under one hour", () => {
  freshConfig()
  assert.equal(Brain.feed({ type: "long-session" }), "")
})

test("pluralization: one vs many", () => {
  freshConfig()
  Brain.setWindowCount(1)
  const one = Brain.feed({ type: "ambient" })
  assert.ok(!/1 windows/.test(one || ""), "should not say '1 windows'")
  Brain.setWindowCount(4)
  const many = Brain.feed({ type: "ambient" })
  assert.ok(!/4 window /.test(many || ""), "should say '4 windows'")
})

test("config parse merges and keeps defaults", () => {
  const cfg = Brain.parseConfig('{"minIntervalSec": 123, "chances": {"focus": 0.5}, "unknownKey": true}')
  assert.equal(cfg.minIntervalSec, 123)
  assert.equal(cfg.chances.focus, 0.5)
  assert.equal(cfg.chances.window, 0.4, "untouched chance keeps default")
  assert.equal(cfg.enabled, true)
})

test("disabled ghost stays silent", () => {
  freshConfig({ enabled: false })
  assert.equal(Brain.feed({ type: "theme", theme: "tokyo-night" }), "")
})

// ------------------------------------------------------------ long-term memory

test("noteFocus accumulates minutes and first activity", () => {
  freshConfig()
  Brain._resetMemory()
  Brain.loadState('{}')
  Brain.noteFocus("code", 60 * 60 * 1000) // 1h in editor
  Brain.noteFocus("firefox", 30 * 60 * 1000)
  const m = Brain._memory()
  assert.equal(m.todayMinutes.editor, 60)
  assert.equal(m.todayMinutes.browser, 30)
  assert.ok(m.firstActivityHour >= 0)
})

test("digest summarizes yesterday once", () => {
  freshConfig()
  Brain._resetMemory()
  // yesterday's record, today's date is "now"
  const y = new Date(Date.now() - 86400000)
  const ykey = `${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,"0")}-${String(y.getDate()).padStart(2,"0")}`
  Brain.loadState(JSON.stringify({
    today: ykey,
    todayMinutes: { editor: 200, browser: 65, terminal: 20 },
    windowsOpened: 23,
    days: {},
    byPart: {},
    weights: {},
    dismissals: {},
    lastDigestFor: ""
  }))
  const msg = Brain.rolloverIfNeeded()
  assert.ok(msg && msg.length > 0, "digest should fire after rollover")
  assert.match(msg, /3h 20m in editor/)
  assert.match(msg, /browser/)
  // second call: no duplicate
  assert.equal(Brain.digestMessage(ykey), "")
  // yesterday is now in memory.days
  assert.ok(Brain._memory().days[ykey])
})

test("usualFor finds the common app for a day-part", () => {
  freshConfig()
  Brain._resetMemory()
  const y = new Date(Date.now() - 86400000)
  const ykey = `${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,"0")}-${String(y.getDate()).padStart(2,"0")}`
  const y2 = new Date(Date.now() - 2*86400000)
  const ykey2 = `${y2.getFullYear()}-${String(y2.getMonth()+1).padStart(2,"0")}-${String(y2.getDate()).padStart(2,"0")}`
  Brain.loadState(JSON.stringify({
    today: ykey,
    todayMinutes: {}, byPart: {}, weights: {}, dismissals: {}, windowsOpened: 0, lastDigestFor: "",
    days: {
      [ykey]:  { byPart: { afternoon: { editor: 10, browser: 2 } }, minutes: {}, windowsOpened: 0 },
      [ykey2]: { byPart: { afternoon: { editor: 8 } }, minutes: {}, windowsOpened: 0 }
    }
  }))
  assert.equal(Brain.usualFor("afternoon", "browser"), "editor")
  // not enough data for night
  assert.equal(Brain.usualFor("night", "editor"), "")
})

test("dismissals shrink the category weight, keeping grows it", () => {
  freshConfig()
  Brain._resetMemory()
  Brain.loadState('{}')
  assert.equal(Brain.weightFor("browser"), 1)
  Brain.noteDismissal("focus-browser")
  assert.ok(Brain.weightFor("browser") < 1)
  Brain.noteKept("focus-browser")
  assert.ok(Brain.weightFor("browser") >= 0.9)
  // floor
  for (let i = 0; i < 20; i++) Brain.noteDismissal("focus-browser")
  assert.ok(Brain.weightFor("browser") >= 0.3)
})

test("title changes produce messages, deduped", () => {
  freshConfig()
  Brain._resetMemory()
  const msg = Brain.feed({ type: "title", title: "make test" })
  assert.ok(msg && msg.length > 0)
  assert.match(msg, /make test/)
  assert.equal(Brain.feed({ type: "title", title: "make test" }), "")
  assert.equal(Brain.feed({ type: "title", title: "~/dev/foo" }), "", "path prompts are skipped")
})

// ------------------------------------------------------------ metric insights

function seedSessions(list) {
  const m = Brain._memory()
  m.sessions = list.map((s) => ({ app: s.app, durationMs: s.min * 60000 }))
  m.currentSession = null
  m.switchCount = list.length
  return m
}

test("focusSwitched records sessions and switch count", () => {
  freshConfig()
  Brain._resetMemory()
  Brain.loadState('{}')
  Brain.focusSwitched("code")
  Brain.focusSwitched("firefox")
  Brain.focusSwitched("")
  const m = Brain._memory()
  assert.equal(m.switchCount, 2, "empty app should not count")
  assert.equal(m.currentSession.app, "browser")
})

test("stretch insight fires when a long session appears", () => {
  freshConfig()
  Brain._resetMemory()
  const m = Brain.loadState('{}')
  m.sessions = [{ app: "editor", durationMs: 47 * 60000 }]
  m.currentSession = null
  const s = Brain.insightStretch()
  assert.ok(s, "stretch should fire at 47 min")
  assert.equal(s.ctx.minutes, "47")
  assert.equal(s.ctx.app, "the editor")
  // record broken: needs +10 min
  assert.equal(Brain.insightStretch(), null)
  m.sessions = [{ app: "editor", durationMs: 50 * 60000 }]
  assert.equal(Brain.insightStretch(), null, "50 < 47+10")
  m.sessions = [{ app: "editor", durationMs: 60 * 60000 }]
  assert.ok(Brain.insightStretch())
})

test("rhythm insight catches browser/editor ping-pong", () => {
  freshConfig()
  Brain._resetMemory()
  const m = Brain.loadState('{}')
  const sessions = []
  for (let i = 0; i < 8; i++) {
    sessions.push({ app: i % 2 === 0 ? "browser" : "editor", durationMs: 3 * 60000 })
  }
  m.sessions = sessions
  m.currentSession = null
  const r = Brain.insightRhythm()
  assert.ok(r, "rhythm should fire")
  assert.equal(r.ctx.minutes, "3")
  assert.equal(Brain.insightRhythm(), null, "once per day")
})

test("deep insight announces each new full hour", () => {
  freshConfig()
  Brain._resetMemory()
  const m = Brain.loadState('{}')
  m.activeMinutes = 30
  assert.equal(Brain.insightDeep(), null, "under an hour")
  m.activeMinutes = 70
  const d = Brain.insightDeep()
  assert.ok(d)
  assert.equal(d.ctx.hours, "1")
  m.activeMinutes = 90
  assert.equal(Brain.insightDeep(), null, "same hour, no repeat")
  m.activeMinutes = 130
  assert.equal(Brain.insightDeep().ctx.hours, "2")
})

test("insight respects the daily budget", () => {
  freshConfig({ insightDailyCap: 2 })
  Brain._resetMemory()
  const m = Brain.loadState('{}')
  m.activeMinutes = 130 // qualifies for deep
  const first = Brain.insight()
  const second = Brain.insight()
  const third = Brain.insight()
  assert.ok(first || second, "budget allows a couple")
  assert.equal(third, "", "budget exhausted")
})

test("peak insight needs 2+ days of history", () => {
  freshConfig()
  Brain._resetMemory()
  const m = Brain.loadState('{}')
  const nowH = new Date().getHours()
  const mk = (offset, peak) => {
    const d = new Date(Date.now() - offset * 86400000)
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`
  }
  // one day only -> not enough
  m.days = { [mk(1, nowH)]: { peakHour: nowH } }
  assert.equal(Brain.insightPeak(), null)
  // two days agreeing on the current hour
  m.days = {
    [mk(1, nowH)]: { peakHour: nowH },
    [mk(2, nowH)]: { peakHour: nowH }
  }
  const p = Brain.insightPeak()
  assert.ok(p, "peak fires at the historical golden hour")
  assert.equal(Brain.insightPeak(), null, "once per day")
})

// ------------------------------------------------------------ recaps + companion

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`
}

test("week recap sums last 7 days including today", () => {
  freshConfig()
  Brain._resetMemory()
  const today = new Date()
  const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  Brain.loadState(JSON.stringify({
    today: dateKey(today),
    todayMinutes: { terminal: 120 },
    days: { [dateKey(y)]: { minutes: { terminal: 180, browser: 60 } } },
    lastWeeklyFor: ""
  }))
  const msg = Brain.weekMessage({ force: true })
  assert.ok(msg)
  assert.match(msg, /5h in terminal/)
  assert.match(msg, /browser/)
})

test("automatic week recap fires once per iso week", () => {
  freshConfig()
  Brain._resetMemory()
  const today = new Date()
  const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  Brain.loadState(JSON.stringify({
    today: dateKey(today),
    todayMinutes: { terminal: 60 },
    days: { [dateKey(y)]: { minutes: { terminal: 60 } } },
    lastWeeklyFor: ""
  }))
  const first = Brain.weekMessage({})
  assert.ok(first)
  assert.equal(Brain.weekMessage({}), "", "second automatic week recap is silent")
})

test("automatic week recap waits for two days of data", () => {
  freshConfig()
  Brain._resetMemory()
  const today = new Date()
  Brain.loadState(JSON.stringify({
    today: dateKey(today),
    todayMinutes: { terminal: 180 },
    days: {},
    lastWeeklyFor: ""
  }))
  assert.equal(Brain.weekMessage({}), "")
  const forced = Brain.weekMessage({ force: true })
  assert.ok(forced)
  assert.match(forced, /terminal/)
})

test("month recap reads the previous month", () => {
  freshConfig()
  Brain._resetMemory()
  const today = new Date()
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 15)
  Brain.loadState(JSON.stringify({
    today: dateKey(today),
    todayMinutes: {},
    days: { [dateKey(prev)]: { minutes: { terminal: 600 } } },
    lastMonthlyFor: ""
  }))
  const msg = Brain.monthMessage({})
  assert.ok(msg)
  assert.match(msg, /10h in terminal/)
  assert.equal(Brain.monthMessage({}), "", "second monthly recap is silent")
})

test("companion pokes when several workspaces sit untouched", () => {
  freshConfig()
  Brain._resetMemory()
  Brain.loadState("{}")
  const now = Date.now()
  Brain.noteWorkspaces([
    { id: 1, name: "main", windows: 2, focused: true },
    { id: 4, name: "movieswrapped", windows: 3, focused: false },
    { id: 5, name: "clipzi", windows: 1, focused: false },
    { id: 6, name: "mistakes", windows: 2, focused: false }
  ], now)
  const msg = Brain.companion(now)
  assert.ok(msg && msg.length > 0)
  assert.match(msg, /movieswrapped|clipzi|mistakes|sitting|open/i)
  assert.equal(Brain.companion(now), "", "companion has a long gap")
})

test("companion stays quiet with only two occupied workspaces", () => {
  freshConfig()
  Brain._resetMemory()
  Brain.loadState("{}")
  const now = Date.now()
  Brain.noteWorkspaces([
    { id: 1, name: "main", windows: 2, focused: true },
    { id: 2, name: "other", windows: 1, focused: false }
  ], now)
  assert.equal(Brain.companion(now), "")
})

test("workspace names prefer window titles over hypr numbers", () => {
  freshConfig()
  Brain._resetMemory()
  Brain.loadState("{}")
  const now = Date.now()
  Brain.noteWorkspaces([
    { id: 1, name: "1", title: "Main", windows: 2, focused: true },
    { id: 4, name: "4", title: "omarchy: [4] movieswrapped-scraper", windows: 3, focused: false },
    { id: 5, name: "5", title: "Clipzi.app", windows: 1, focused: false },
    { id: 6, name: "6", title: "Mistakes", windows: 2, focused: false }
  ], now)
  const named = Brain._memory().workspaces["4"].name
  assert.match(named, /movieswrapped/i)
  const msg = Brain.companion(now)
  assert.ok(msg)
  assert.match(msg, /movieswrapped|Clipzi|Mistakes|open|sitting/i)
})
