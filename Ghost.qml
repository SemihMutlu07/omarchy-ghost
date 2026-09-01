// Ghost — a little ghost that watches what you do on Omarchy and whispers
// nice little messages. One-way: it never expects a reply.
//
// This is a keepLoaded "overlay" plugin: it mounts at shell startup, stays
// invisible, watches Hyprland + theme + time of day, and occasionally shows
// a small bubble in the bottom-right corner. All decisions (what to say,
// whether to say anything at all) live in Brain.js; this file only wires
// events and renders the bubble.

import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import "Brain.js" as Brain

Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string configPath: home + "/.config/omarchy/ghost.json"
  readonly property string statePath: home + "/.local/state/omarchy/ghost/state.json"

  property var cfg: Brain.DEFAULTS
  property string lastApp: ""
  property var windowMap: ({})
  property int lastWorkspace: -1
  property bool lastFullscreen: false
  property string lastTheme: ""
  property string lateNightDate: ""
  property int lastLongSessionHour: -1
  property double sessionStartMs: Date.now()

  // bubble state
  property string bubbleText: ""
  property bool bubbleVisible: false
  property real bubbleOpacity: 0
  property real slideY: 0

  // llm brain state
  property string llmPendingFallback: ""
  property var llmPendingJson: ({})
  property string llmOutput: ""

  // memory + feedback state
  property string lastWhisperKind: ""
  property double lastTickAt: Date.now()
  property string lastTitle: ""

  readonly property int bubblePad: 14
  readonly property int bubbleWidth: Math.min(360, Math.max(240, Number(root.cfg.maxWidth || 340)))

  // ----------------------------------------------------------------- config

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.cfg = Brain.parseConfig(text())
    onLoadFailed: {
      root.cfg = Brain.parseConfig("")
      writeDefaults()
    }
  }

  function writeDefaults() {
    configFile.setText(JSON.stringify(Brain.DEFAULTS, null, 2) + "\n")
  }

  // -------------------------------------------------------------- memory

  // Ghost's long-term memory: ~/.local/state/omarchy/ghost/state.json.
  // Read at startup, rewritten on every heartbeat. Fourteen days of habits.
  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.onStateLoaded(text())
    onLoadFailed: { /* first run: fresh memory */ }
  }

  function onStateLoaded(raw) {
    Brain.loadState(raw)
  }

  function persistState() {
    stateFile.setText(JSON.stringify(Brain.snapshotState(), null, 2) + "\n")
  }

  // ------------------------------------------------------------------ theme

  // Bound to the active theme's colors.toml; when the path changes (theme
  // swap) this reloads and Ghost notices the new slug.
  FileView {
    id: themeFile
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.onThemeLoaded()
    onLoadFailed: { /* theme dir not ready yet — heartbeat picks it up */ }
  }

  function themeSlug() {
    var p = String(Color.currentThemePath || "").replace(/\/+$/, "")
    var i = p.lastIndexOf("/")
    return i >= 0 ? p.slice(i + 1) : p
  }

  function onThemeLoaded() {
    var slug = root.themeSlug()
    if (slug === "") return
    if (root.lastTheme !== "" && slug !== root.lastTheme)
      root.consider({ type: "theme", theme: slug })
    root.lastTheme = slug
  }

  // ---------------------------------------------------------------- events

  // The active window comes from ToplevelManager (the generic Wayland API
  // first-party Omarchy code uses); Hyprland.activeToplevel is a null trap on
  // some Quickshell builds. Hyprland still supplies workspace info.
  Connections {
    target: ToplevelManager
    function onActiveToplevelChanged() { root.onActiveToplevelChanged() }
  }

  Connections {
    target: Hyprland
    function onFocusedWorkspaceChanged() { root.onWorkspaceChanged() }
  }

  Connections {
    target: ToplevelManager.toplevels
    function onValuesChanged() { root.onToplevelsChanged() }
  }

  function activeWin() {
    try { return ToplevelManager.activeToplevel } catch (e) { return null }
  }

  function onActiveToplevelChanged() {
    var t = root.activeWin()
    var app = t ? String(t.appId || "") : ""
    var title = t ? String(t.title || "") : ""
    var fullscreenNow = t ? (t.fullscreen === true) : false

    // accurate time accounting for the habit memory: attribute the elapsed
    // time to the app that just lost focus, then start a new session
    root.tickFocus(root.lastApp)
    Brain.focusSwitched(app)

    if (fullscreenNow && !root.lastFullscreen)
      root.consider({ type: "fullscreen" })
    root.lastFullscreen = fullscreenNow

    var wasIdle = Brain.activity()
    if (wasIdle) {
      root.consider({ type: "welcome-back", class: app, title: title })
    } else if (app !== "" && app !== root.lastApp) {
      root.lastApp = app
      root.consider({ type: "focus", class: app, title: title })
    }
  }

  function tickFocus(app) {
    var now = Date.now()
    Brain.noteFocus(app, now - root.lastTickAt)
    root.lastTickAt = now
  }

  // Toplevel objects have no stable string key, so diff by reference: keep
  // the observed list and compare with indexOf (reference equality).
  property var windowRefs: []

  function onToplevelsChanged() {
    var vals = []
    try { vals = ToplevelManager.toplevels.values } catch (e) { vals = [] }
    var opened = 0
    var closed = 0
    for (var i = 0; i < vals.length; i++) {
      var t = vals[i]
      if (!t) continue
      if (root.windowRefs.indexOf(t) === -1) opened++
    }
    for (var j = 0; j < root.windowRefs.length; j++) {
      if (vals.indexOf(root.windowRefs[j]) === -1) closed++
    }
    root.windowRefs = vals
    Brain.setWindowCount(vals.length)
    if (opened === 0 && closed === 0) return
    Brain.activity()
    if (opened > 0) {
      Brain.noteWindowOpened(opened)
      root.consider({ type: "window-open", count: opened })
    }
    if (closed > 0) root.consider({ type: "window-close", count: closed })
  }

  function onWorkspaceChanged() {
    var ws = Hyprland.focusedWorkspace
    if (!ws) return
    var id = Number(ws.id)
    if (id === root.lastWorkspace) return
    root.lastWorkspace = id
    Brain.activity()
    var count = 0
    var vals = Hyprland.toplevels ? Hyprland.toplevels.values : []
    for (var i = 0; i < vals.length; i++) {
      var t = vals[i]
      if (t && t.workspace && Number(t.workspace.id) === id) count++
    }
    root.consider({ type: "workspace", workspace: id, windows: count })
  }

  // -------------------------------------------------------------- heartbeat

  Timer {
    id: heartbeat
    interval: 30000
    repeat: true
    running: true
    onTriggered: root.onHeartbeat()
  }

  function onHeartbeat() {
    var now = Date.now()

    // Time accounting + day rollover (the daily recap comes from here).
    var t = root.activeWin()
    root.tickFocus(t ? String(t.appId || "") : "")
    var digest = Brain.rolloverIfNeeded()
    if (digest !== "") root.maybeWhisper(digest)

    // Focused window title changed? Ghost notices (vim -> make test, etc.).
    var title = t ? String(t.title || "") : ""
    if (title !== "" && title !== root.lastTitle) {
      var app = t ? String(t.appId || "") : ""
      root.lastTitle = title
      root.consider({ type: "title", class: app, title: title })
    }

    // Idle detection — Ghost goes quiet when you are away.
    if (now - Brain.lastActivity() > Number(root.cfg.idleSeconds || 600) * 1000)
      Brain.markIdle()

    // Theme fallback: if the FileView path-change missed the swap.
    var slug = root.themeSlug()
    if (slug !== "" && root.lastTheme !== "" && slug !== root.lastTheme) {
      root.lastTheme = slug
      root.consider({ type: "theme", theme: slug })
    } else if (slug !== "") {
      root.lastTheme = slug
    }

    // Late-night greeting, once per night.
    var d = new Date()
    var h = d.getHours()
    if ((h === 0 || h === 1 || h === 2) && d.toDateString() !== root.lateNightDate) {
      root.lateNightDate = d.toDateString()
      root.consider({ type: "late-night" })
    }

    // Long-session nudge, once per full hour of activity.
    var hours = Math.floor((now - root.sessionStartMs) / 3600000)
    if (hours >= 1 && hours !== root.lastLongSessionHour) {
      root.lastLongSessionHour = hours
      root.consider({ type: "long-session" })
    }

    // Persist the memory every heartbeat.
    root.persistState()
  }

  // ---------------------------------------------------------------- ambient

  Timer {
    id: ambientTimer
    interval: 600000
    repeat: false
    onTriggered: {
      root.consider({ type: "ambient" })
      root.scheduleAmbient()
    }
  }

  function scheduleAmbient() {
    var next = Math.max(60000, Brain.nextAmbientMs())
    ambientTimer.interval = next
    ambientTimer.start()
  }

  // -------------------------------------------------------------- insights

  // Metric nudges: every 5 minutes, Ghost checks whether the numbers are
  // worth mentioning. Brain.insight() applies its own budget + cooldown, so
  // this stays a gentle nudge, never a nag.
  Timer {
    id: insightTimer
    interval: 300000
    repeat: true
    running: true
    onTriggered: root.maybeWhisper(Brain.insight())
  }

  // ------------------------------------------------------------------ brain

  // Route an event through the brain; with an LLM brain configured, the LLM
  // gets first crack and the template line becomes the fallback.
  function consider(ev) {
    var msg = Brain.feed(ev)
    var mode = String((root.cfg && root.cfg.brain) || "templates")
    if (mode !== "templates" && Brain.llmAllowed() && !Brain.llmRateLimited() && !llmProc.running) {
      root.llmPendingFallback = msg
      root.llmPendingJson = Brain.llmContext(ev)
      root.runLlm()
      return
    }
    root.maybeWhisper(msg)
  }

  function maybeWhisper(msg) {
    if (msg && msg !== "") {
      root.lastWhisperKind = Brain.lastKind()
      root.showWhisper(msg)
    }
  }

  // ------------------------------------------------------------ LLM brain

  function ghostLlmPath() {
    var s = String(Qt.resolvedUrl("bin/ghost-llm") || "")
    if (s.indexOf("file://") === 0) {
      s = s.slice(7)
      try { s = decodeURIComponent(s) } catch (e) { /* keep */ }
    }
    return s
  }

  function runLlm() {
    Brain.markLlmAttempt()
    var custom = String((root.cfg && root.cfg.llmCommand) || "").trim()
    llmProc.command = custom !== "" ? ["bash", "-c", custom] : [root.ghostLlmPath()]
    llmProc.running = true
    llmWatchdog.restart()
  }

  Process {
    id: llmProc
    stdinEnabled: true

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.llmOutput = String(text || "").trim()
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: function(t) {
        var s = String(t || "").trim()
        if (s !== "") console.warn("ghost/llm:", s)
      }
    }

    onStarted: llmProc.write(JSON.stringify(root.llmPendingJson || {}))

    onExited: function(exitCode) {
      llmWatchdog.stop()
      if (exitCode === 0 && root.llmOutput !== "") {
        root.maybeWhisper(root.llmOutput.split("\n")[0])
      } else {
        root.maybeWhisper(root.llmPendingFallback)
      }
    }
  }

  Timer {
    id: llmWatchdog
    interval: 15000
    repeat: false
    onTriggered: {
      if (llmProc.running) {
        try { llmProc.signal(9) } catch (e) { /* fallback fires on exit */ }
      }
    }
  }

  // ----------------------------------------------------------------- bubble

  // The whisper bubble: a small floating card, bottom-right. No reply box,
  // no buttons — a ghost talks, you listen (clicking it shoos it away).
  PanelWindow {
    id: bubble
    visible: root.bubbleVisible
    color: "transparent"
    anchors { bottom: true; right: true }
    margins { bottom: 24; right: 16 }
    implicitWidth: card.width
    implicitHeight: card.height
    WlrLayershell.namespace: "semihmutlu-ghost"
    WlrLayershell.layer: WlrLayer.Overlay
    exclusionMode: ExclusionMode.Ignore
    focusable: false

    Rectangle {
      id: card
      width: root.bubbleWidth
      height: row.implicitHeight + root.bubblePad * 2
      radius: Style.cornerRadius
      color: Util.alpha(Color.menu.background, 0.95)
      border.color: Util.alpha(Color.menu.border, 0.85)
      border.width: 1
      opacity: root.bubbleOpacity
      y: root.slideY

      Behavior on opacity { NumberAnimation { duration: 350; easing.type: Easing.OutCubic } }
      Behavior on y { NumberAnimation { duration: 350; easing.type: Easing.OutCubic } }

      MouseArea {
        anchors.fill: parent
        onClicked: root.dismissWhisper()
      }

      Row {
        id: row
        anchors.fill: parent
        anchors.margins: root.bubblePad
        spacing: 12

        Text {
          id: glyph
          text: "👻"
          width: 26
          font.pixelSize: 22
          verticalAlignment: Text.AlignVCenter
          horizontalAlignment: Text.AlignHCenter
        }

        Text {
          id: message
          text: root.bubbleText
          width: parent.width - glyph.width - parent.spacing
          wrapMode: Text.WordWrap
          font.family: Style.font.menuFamily
          font.pixelSize: Style.font.body
          lineHeight: 1.25
          color: Color.menu.text
          verticalAlignment: Text.AlignVCenter
        }
      }
    }
  }

  function showWhisper(text) {
    root.bubbleText = text
    root.bubbleVisible = true
    root.slideY = 12
    root.bubbleOpacity = 0
    Qt.callLater(function() {
      root.slideY = 0
      root.bubbleOpacity = 1
    })
    holdTimer.interval = Math.max(2000, Number(root.cfg.whisperDurationSec || 6) * 1000)
    holdTimer.restart()
    root.scheduleAmbient()
  }

  function dismissWhisper() {
    holdTimer.stop()
    Brain.noteDismissal(root.lastWhisperKind)
    root.hideWhisper()
  }

  function expireWhisper() {
    Brain.noteKept(root.lastWhisperKind)
    root.hideWhisper()
  }

  function hideWhisper() {
    root.slideY = -8
    root.bubbleOpacity = 0
    hideTimer.restart()
  }

  Timer {
    id: holdTimer
    interval: 6000
    repeat: false
    onTriggered: root.expireWhisper()
  }

  Timer {
    id: hideTimer
    interval: 400
    repeat: false
    onTriggered: root.bubbleVisible = false
  }

  // -------------------------------------------------------------- IPC test

  IpcHandler {
    target: "semihmutlu.ghost"

    function whisper(text: string): void { root.showWhisper(String(text || "boo")) }
    function test(): void { root.consider({ type: "theme", theme: "test" }) }
    function digest(): void {
      var msg = Brain.digestMessage(root.yesterdayDate())
      if (msg !== "") root.showWhisper(msg)
    }
    function insight(): void {
      var msg = Brain.insight()
      if (msg !== "") root.showWhisper(msg)
    }
    function state(): string { return JSON.stringify(Brain.snapshotState()) }
    function probe(): string {
      var t = root.activeWin()
      return JSON.stringify({
        activeAppId: t ? String(t.appId || "") : "(null)",
        activeTitle: t ? String(t.title || "") : "",
        toplevels: ToplevelManager.toplevels ? ToplevelManager.toplevels.values.length : -1,
        focusedWorkspace: Hyprland.focusedWorkspace ? Hyprland.focusedWorkspace.id : -1,
        switchCount: Brain.snapshotState().switchCount
      })
    }
  }

  function yesterdayDate() {
    var d = new Date(Date.now() - 86400000)
    var y = d.getFullYear()
    var m = String(d.getMonth() + 1).padStart(2, "0")
    var day = String(d.getDate()).padStart(2, "0")
    return y + "-" + m + "-" + day
  }

  // ------------------------------------------------------------------ init

  Component.onCompleted: {
    Brain.resetMemory()
    root.sessionStartMs = Date.now()
    root.lastTickAt = Date.now()
    // make sure the state dir exists before the first persist
    mkdirProc.command = ["mkdir", "-p", root.home + "/.local/state/omarchy/ghost"]
    mkdirProc.running = true
    root.scheduleAmbient()
    var slug = root.themeSlug()
    if (slug !== "") root.lastTheme = slug
  }

  Process {
    id: mkdirProc
    running: false
    onExited: function() {
      root.persistState()
      stateFile.reload()
    }
  }
}
