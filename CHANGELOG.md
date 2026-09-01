# Changelog

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
