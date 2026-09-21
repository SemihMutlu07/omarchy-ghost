import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Brain.js" as Brain

Panel {
  id: root
  moduleName: "semihmutlu.ghost"
  ipcTarget: "semihmutlu.ghost.panel"
  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  readonly property string label: "👻"
  property var cfg: Brain.parseConfig("{}")

  FileView {
    id: configFile
    path: Brain.configPath(Quickshell.env("HOME") || "")
    watchChanges: true
    printErrors: false
    onLoaded: root.cfg = Brain.parseConfig(text())
    onFileChanged: reload()
  }
  function save(next) {
    root.cfg = next
    configFile.setText(JSON.stringify(next, null, 2) + "\n")
  }
  function setEnabled(value) {
    var next = JSON.parse(JSON.stringify(root.cfg))
    next.enabled = value
    next.silenceUntil = 0
    save(next)
  }
  function setMode(value) {
    var next = JSON.parse(JSON.stringify(root.cfg))
    next.mode = value
    // Parsed config contains explicit values: replace them with the new preset.
    var preset = Brain.MODES[value]
    next.cooldownSec = preset.cooldownSec
    next.budgetPerHour = preset.budgetPerHour
    next.rates = preset.rates
    save(next)
  }
  Process {
    id: previewProcess
    command: ["omarchy-shell", "semihmutlu.ghost", "whisper", "Buradayım. Bu bir görüntü testi; terminal bağlantısını doğrulamaz."]
  }
  KeyboardPanel {
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: false
    focusTarget: keyCatcher
    contentWidth: Style.space(340)
    contentHeight: fittedContentHeight(column.implicitHeight)
    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
    }
    Column {
      id: column
      anchors.fill: parent
      spacing: Style.spacing.md
      Text {
        text: "Casper"
        color: Color.menu.text
        font.family: Style.font.menuFamily
        font.pixelSize: Style.font.title
        font.bold: true
      }
      Toggle {
        width: parent.width
        label: "Açık"
        checked: root.cfg.enabled !== false
        onClicked: root.setEnabled(!root.cfg.enabled)
      }
      ButtonGroup {
        width: parent.width
        options: [{label: "Az", value: "Quiet"}, {label: "Normal", value: "Balanced"}, {label: "Çok", value: "Chatty"}]
        value: root.cfg.mode
        onChanged: function(value) { root.setMode(value) }
      }
      Button {
        text: "Test mesajı göster"
        bordered: true
        onClicked: previewProcess.running = true
      }
      Text {
        width: parent.width
        text: "Oturumla açılır. Hata veren veya uzun süren desteklenen komutlar bittikten sonra yorum yapar. Her komutta konuşmaz."
        wrapMode: Text.WordWrap
        color: Color.menu.text
        font.family: Style.font.menuFamily
        font.pixelSize: Style.font.caption
      }
    }
  }
}
