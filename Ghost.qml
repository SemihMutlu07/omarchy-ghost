// Casper — the bottom-right bubble.
//
// Keep-loaded "overlay" plugin. It observes nothing on the desktop: no windows,
// no titles, no workspaces, no themes, no idle time. It only answers to
// commandFinished events pushed by bin/casper-hook, and every decision about
// whether to speak lives in Brain.js.
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import "Brain.js" as Brain

Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string configPath: Brain.configPath(home)
  property var cfg: Brain.DEFAULTS
  property string bubbleText: ""
  property bool bubbleVisible: false
  property real bubbleOpacity: 0
  property real slideY: 0

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onLoaded: root.cfg = Brain.parseConfig(text())
    onFileChanged: reload()
    onLoadFailed: {
      root.cfg = Brain.parseConfig("{}")
      configFile.setText(JSON.stringify(root.cfg, null, 2) + "\n")
    }
  }

  // Called by the shell hook. Returns the line it decided to say, or "".
  function finish(payload) {
    var raw = String(payload || "")
    if (raw.length > 512) return ""
    var ev = {}
    try { ev = JSON.parse(raw) } catch (e) { return "" }
    var msg = Brain.finish(ev)
    if (msg !== "") root.show(msg)
    return msg
  }

  function show(text) {
    root.bubbleText = text
    root.bubbleVisible = true
    root.slideY = 10
    root.bubbleOpacity = 0
    Qt.callLater(function() { root.slideY = 0; root.bubbleOpacity = 1 })
    hold.interval = Math.max(2500, Number(root.cfg.verbosity) > 0.7 ? 7000 : 5000)
    hold.restart()
  }

  function hide() {
    hold.stop()
    root.slideY = -6
    root.bubbleOpacity = 0
    hideTimer.restart()
  }

  PanelWindow {
    id: bubble
    visible: root.bubbleVisible
    color: "transparent"
    anchors { bottom: true; right: true }
    margins { bottom: 24; right: 16 }
    implicitWidth: card.width
    implicitHeight: card.height
    WlrLayershell.namespace: "semihmutlu-casper"
    WlrLayershell.layer: WlrLayer.Overlay
    exclusionMode: ExclusionMode.Ignore
    focusable: false

    Rectangle {
      id: card
      width: 340
      height: row.implicitHeight + 28
      radius: Style.cornerRadius
      color: Util.alpha(Color.menu.background, 0.95)
      border.color: Util.alpha(Color.menu.border, 0.85)
      border.width: 1
      opacity: root.bubbleOpacity
      y: root.slideY

      Behavior on opacity { NumberAnimation { duration: 300; easing.type: Easing.OutCubic } }
      Behavior on y { NumberAnimation { duration: 300; easing.type: Easing.OutCubic } }

      MouseArea { anchors.fill: parent; onClicked: root.hide() }

      Row {
        id: row
        anchors.fill: parent
        anchors.margins: 14
        spacing: 10

        Text {
          id: glyph
          text: "👻"
          width: 22
          font.pixelSize: 18
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

  Timer { id: hold; repeat: false; onTriggered: root.hide() }
  Timer { id: hideTimer; interval: 300; repeat: false; onTriggered: root.bubbleVisible = false }

  IpcHandler {
    target: "semihmutlu.ghost"

    // The shell hook's entry point.
    function commandFinished(payload: string): string { return root.finish(payload) }
    // Manual test: omarchy-shell semihmutlu.ghost whisper "merhaba"
    function whisper(text: string): void { root.show(String(text || "boo")) }
    function state(): string {
      var out = Brain.state()
      out.bubbleVisible = root.bubbleVisible
      out.windowVisible = bubble.visible
      out.backingWindowVisible = bubble.backingWindowVisible
      out.width = bubble.implicitWidth
      out.height = bubble.implicitHeight
      out.screen = bubble.screen ? String(bubble.screen.name) : ""
      return JSON.stringify(out)
    }
  }
}
