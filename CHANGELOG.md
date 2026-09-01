# Changelog

## 0.1.2 — 2026-09-01

- Keep 90 days of usage. Weekly and monthly recaps from that file.
- Poke when several occupied workspaces haven't been looked at (uses window titles).
- `omarchy-shell semihmutlu.ghost week` / `month` / `poke`

## 0.1.1 — 2026-09-01

- Presence ping: sitting in one window is not idle. Idle is no focused window.
- Ambient boo every 3–12 minutes (was 15–60). First peek 15–45s after load.
- Lines are short and deadpan. The ghost is not a motivational speaker.

## 0.1.0 — 2026-09-01

Initial open-source release.

- One-way whisper bubble (bottom-right, theme-aware, click-to-dismiss)
- Event watchers: app focus, window open/close, workspace switches,
  fullscreen, theme changes, idle returns, terminal title changes
- Template brain: 60+ lines across 13 categories, de-duplicated + weighted
- Long-term memory (14 days): habits, minutes per category, focus sessions,
  peak hour, dismissals — `~/.local/state/omarchy/ghost/state.json`
- Metric insights: longest stretch, switch rhythm, deep-work hours, golden
  hour — with a daily budget so it never nags
- Daily recap (midnight rollover)
- Dismissal feedback (shoo a topic away and it gets quieter)
- Optional LLM brain via `bin/ghost-llm` (`claude` / `ollama`)
- 22 unit tests (`node --test test/brain.test.js`)
