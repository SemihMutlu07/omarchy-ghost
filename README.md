<div align="center">

# 👻 Ghost

**A little ghost that watches what you do on your Omarchy desktop — and
whispers nice little messages. One-way. It never expects a reply.**

![preview](preview.png)

*"[👻] Deep in the editor. I'll guard the door."*

</div>

---

Ghost lives in the bottom-right corner of your screen. It watches which apps
you focus, which windows you open, which workspaces you hop between, what time
it is, and — over time — *your habits*. When something is worth a word, a small
bubble fades in, says its piece, and fades out. There is no reply box, no
buttons. You can only shoo it away — and it *learns from that too*.

Everything runs locally. No account, no cloud, no telemetry. The 14-day memory
lives in `~/.local/state/omarchy/ghost/state.json`.

## Features

| | |
|---|---|
| 👀 **Watches** | app focus, window open/close, workspace switches, fullscreen, theme changes, idle returns, terminal title changes |
| 🧠 **Learns** | per-day-part habits ("Firefox at this hour? You're usually in the editor.") |
| 📊 **Counts** | focus sessions, switch rhythm, deep-work minutes, peak hour, daily recap |
| 🗣️ **Talks** | 60+ hand-written lines, de-duplicated, weighted per category |
| 🤖 **Optional LLM brain** | `claude`/`ollama` generates one-liners from real context; templates as fallback |
| 🤫 **Knows when to shut up** | idle, quiet hours (01–07), cooldowns, noise gates, daily budget |
| 🚪 **Learns your dismissals** | shoo it away → that topic gets quieter |
| 🔒 **100% local** | state file only; nothing leaves your machine |

## Install

```sh
omarchy plugin add https://github.com/SemihMutlu07/omarchy-ghost.git --enable
```

No restart needed — the shell hot-reloads. First run writes
`~/.config/omarchy/ghost.json` with defaults.

## Configure

Edit `~/.config/omarchy/ghost.json` (hot-reloads on save). All keys:

```jsonc
{
  "enabled": true,
  "minIntervalSec": 900,        // floor between messages
  "maxIntervalSec": 3600,       // ambient whispers land in [min, max]
  "variantCooldownSec": 1800,   // don't reuse a line within this window
  "quietHoursStart": 1,         // 01:00 …
  "quietHoursEnd": 7,           // … 07:00: ambient/focus/window/workspace go quiet
  "idleSeconds": 600,           // no activity ⇒ Ghost assumes you're away
  "whisperDurationSec": 6,
  "brain": "templates",         // "templates" | "llm"
  "llmCommand": "",             // optional custom command (prompt appended)
  "maxWidth": 340,
  "insightDailyCap": 6,         // max metric insights per day
  "chances": {                  // per-event likelihood (0–1)
    "focus": 0.12, "window": 0.4, "workspace": 0.4,
    "fullscreen": 0.8, "longSession": 0.5, "lateNight": 1.0,
    "title": 0.5, "unexpected": 0.5, "insight": 0.6
  }
}
```

### LLM brain

With `"brain": "llm"`, Ghost hands the event context to `bin/ghost-llm` and
uses its one-line answer, falling back to templates when the model is slow,
unauthenticated, or missing. Engines tried in order: `$GHOST_LLM_COMMAND`,
`claude -p`, `ollama` (`GHOST_OLLAMA_MODEL`, default `llama3.2`).

## Manual testing

```sh
omarchy-shell semihmutlu.ghost whisper "boo 👻"
omarchy-shell semihmutlu.ghost test      # fake theme-change message
omarchy-shell semihmutlu.ghost digest    # yesterday's recap
omarchy-shell semihmutlu.ghost insight   # a metric insight, right now
omarchy-shell semihmutlu.ghost state     # the long-term memory
omarchy-shell semihmutlu.ghost probe     # live window/workspace state
```

## Architecture

```
Ghost.qml         event wiring + the whisper bubble (Quickshell overlay)
Brain.js          pure logic: cooldowns, quiet hours, templates, memory, insights
bin/ghost-llm     optional LLM brain (stdin context JSON → one line out)
test/brain.test.js  22 unit tests — node --test test/brain.test.js
state.json        long-term memory (~/.local/state/omarchy/ghost/)
```

- **Overlay plugin** (`kinds: ["overlay"]`, `keepLoaded: true`) — mounts at
  shell startup, stays invisible until it whispers.
- **Events** come from `ToplevelManager` (active window, open/close),
  `Hyprland` (workspaces), theme files, and time.
- **Brain** decides *whether* (cooldown, quiet hours, idle, noise gate, daily
  budget, dismissal weights) and *what* (de-duplicated weighted templates).
- **Memory** accumulates minutes per category, focus sessions, per-day-part
  counts, peak hour — shipped into 14 days of history on rollover.

## Customizing messages

The template library lives in `Brain.js` (search for `var T = {}`). Each
category is an array of lines with `{placeholders}` — add your own voice,
remove what you don't like, hot-reload picks it up.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Full design rationale in
[docs/SPEC.md](docs/SPEC.md).

## License

MIT — see [LICENSE](LICENSE).
