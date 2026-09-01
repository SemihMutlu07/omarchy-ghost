# Ghost — Full Spec

Design document for the Ghost Omarchy plugin. Version 0.1.0.

## 1. Concept

A one-way desktop pet. Ghost sits in the bottom-right corner and occasionally
says a short, deadpan line — usually `boo.` You cannot reply. You can only
dismiss it.

**North star:** present, never helpful, never trying to be funny.

## 2. Non-goals

- No two-way chat / command execution. (One-way is the point.)
- No cloud, accounts, or telemetry.
- No screenshots, no keystroke logging, no content capture beyond window
  titles/classes needed to name an app.
- No deep-learning model by default; the LLM brain is optional and local-first.

## 3. Platform

- **Target:** Omarchy (Arch + Hyprland + Quickshell shell).
- **Plugin type:** Quickshell overlay, `keepLoaded: true`.
- **Language:** QML (UI + wiring) + ES5 JS (logic, node-testable) + Bash (LLM
  bridge).
- **Runtime deps:** none beyond the Omarchy shell. Optional: `claude` or
  `ollama` for the LLM brain.

## 4. Event sources

| source | signal | produces |
|---|---|---|
| `ToplevelManager.activeToplevel` | `activeToplevelChanged` | focus, fullscreen, session switch |
| `ToplevelManager.toplevels` | model `valuesChanged` | window open/close |
| `Hyprland.focusedWorkspace` | `focusedWorkspaceChanged` | workspace switch |
| theme file (`Color.currentThemePath/colors.toml`) | `FileView` reload | theme change |
| heartbeat (30 s) | `Timer` | idle, day rollover, digest, title change, long-session, late-night |
| insight tick (5 min) | `Timer` | metric insights |

> Note: `Hyprland.activeToplevel` is a null trap on some Quickshell builds;
> the Wayland-level `ToplevelManager` is the supported path (matches
> first-party Omarchy code).

## 5. Brain

`Brain.js` is pure logic, ES5, unit-tested with Node.

### 5.1 Gating (whether to speak)

- **Cooldown:** `minIntervalSec` between messages (default 180 s). Priority ≥ 2
  events (theme, welcome-back, late-night, digest) bypass.
- **Quiet hours:** `quietHoursStart..End` (default 01:00–07:00). Ambient,
  focus, window, workspace, title, insights are suppressed.
- **Idle:** no focused window for `idleSeconds` (default 600 s) → silent until
  a window is focused again (welcome-back). Sitting still in an app is presence.
- **Noise gate:** > 5 focus events in 60 s → stay quiet (app-switching frenzy).
- **App dedupe:** same category not re-commented within 2 h.
- **Variant dedupe:** no template line reused within `variantCooldownSec`.
- **Daily budget:** `insightDailyCap` (default 6) for metric insights.
- **Dismissal weights:** category weights (0.3–1.5) learned from bubble
  dismissals (`-0.15`) vs. letting it sit (`+0.05`).

### 5.2 Message categories

| id | trigger | example |
|---|---|---|
| `focus-*` | app switch (chance 0.12) | "The terminal. Where everything makes sense." |
| `window-open/close` | toplevel diff (0.4) | "Goodbye, window. You will be missed. By no one." |
| `workspace` | switch, ≥ 4 windows (0.4) | "Workspace 3 — 9 windows. The chaos room. Respect." |
| `fullscreen` | fullscreen enter (0.8) | "I'll stand guard outside the frame." |
| `theme` | theme change (always) | "Ooh — catppuccin? New coat of paint. I approve." |
| `welcome-back` | idle return (always) | "I held the fort. Nothing happened. I was very brave." |
| `late-night` | 00:00–02:59, once/night | "The other ghosts are asleep. Just us now." |
| `long-session` | each new full hour (0.5) | "You've been at this for 3 hours." |
| `title-change` | focused title change (0.5) | "New mission: make test." |
| `unexpected` | habit deviation (0.5, once/day-part) | "Firefox? At this hour? You're usually in the editor." |
| `digest` | midnight rollover (once) | "yesterday: 3h 20m in editor." |
| `week` | once per ISO week | "this week: 18h in terminal, 6h in browser." |
| `month` | once per month (previous month) | "august: 80h in terminal." |
| `stale` | ≥3 occupied workspaces, ≥2 untouched ≥90 min, once/3h | "6 open. most of them just sitting there." |
| `ambient` | random in [min,max] (default 3–12 min) | "boo." |
| `insight-*` | metric tick (0.6, budget) | "Every 3 minutes: browser → editor. A classic dance." |

### 5.3 Metrics

Tracked per day, shipped to 90 days of history on rollover:

- `todayMinutes` — minutes per app category (fractional; 30 s heartbeat)
- `hourCounts` — active minutes per hour → `peakHour`
- `sessions` — focus sessions ≥ 1 min `{app, durationMs}`
- `switchCount`, `activeMinutes`, `firstActivityHour`, `lastActivityHour`
- `byPart` — focus-event counts per day-part (morning/afternoon/evening/night)
- `windowsOpened`

### 5.4 Insights (metric messages)

| insight | condition | example |
|---|---|---|
| stretch | longest session ≥ 30 min, beats record by 10 min | "Your longest stretch today: 47 minutes in the editor." |
| rhythm | ≥ 6 sessions, avg ≤ 8 min, top-2 cats ≥ 60 % | "Every 3 minutes: browser → editor → browser → editor." |
| deep | active minutes cross a new full hour | "2 hours of focused work today." |
| peak | current hour == historical peak (≥ 2 days data) | "This is your golden hour — 3 PM. History agrees." |

## 6. Memory & persistence

`~/.local/state/omarchy/ghost/state.json` — written by the heartbeat via
`FileView.setText`, reloaded on change. Contains today's partials + up to 90
`days` records, workspace last-seen times, and dismissal weights.

## 7. UI

- `PanelWindow`, bottom-right, `ExclusionMode.Ignore`, `focusable: false`
  (never steals input).
- Card: themed `Color.menu.*`, `Style.cornerRadius`, `👻` glyph, wrapped text.
- Animations: slide-in + fade (350 ms), hold `whisperDurationSec`, fade out.
- Click = dismiss (feeds `noteDismissal`).

## 8. LLM brain

`bin/ghost-llm` reads a context JSON on stdin, prints one line. Engines:
`$GHOST_LLM_COMMAND` → `claude -p` → `ollama`. Wrapped in `timeout 10`. On
failure/empty → template fallback. Rate-limited (60 s) and disabled by default
(`brain: "templates"`).

## 9. Testing

- `node --test test/brain.test.js` — 22 tests (gating, templates, memory,
  insights, dismissal weights).
- `omarchy plugin validate .` — manifest/entry-point checks.
- Manual IPC: `whisper | test | digest | insight | state | probe`.

## 10. Roadmap

- [ ] More app categories + user-contributed message packs
- [ ] Night-owl / early-bird rhythm detection ("3 nights in a row past 2 AM…")
- [ ] Ollama-powered personality presets (sassy / wholesome / cryptic)
- [ ] Hooks integration (post-boot, battery-low, post-update)
- [ ] Wallpaper-aware color picking for the bubble
