# Casper

A small, characterful, **controllable** terminal companion for Omarchy.

Casper lives in the bottom-right corner and occasionally says one short line
when a command finishes. It is deterministic and local: no model, no network,
no telemetry. Its most important feature is knowing when to shut up.

```
Ghostty (interactive Bash)
        │  PS0 + PROMPT_COMMAND
        ▼
bin/casper-hook          allowlist → family, subcommand, exit status, duration
        │  omarchy-shell -q semihmutlu.ghost commandFinished '<json>'
        ▼
Ghost.qml (overlay)  ──►  Brain.js   classify → dosage → tone → one line
        │
        ▼
bottom-right bubble  ·  👻 bar icon opens the settings panel
```

Casper does not observe your desktop. No window titles, workspaces, themes,
clipboard, cwd, git state, or command output. It only reacts to finished
commands.

## What it talks about

| Event | When it can speak |
|---|---|
| `failure` | a command exits non-zero (Ctrl-C and signal exits stay silent) |
| `recovery` | the same command family finally succeeds again in the same shell, within 15 min |
| `slow` | a success that took longer than `minDurationMs` (default 2.5s) |

Three failures in a row in the same family sharpen into a "this is a pattern"
line. Everything else is deliberately silent: `git status` succeeding twenty
times is not interesting and Casper never comments on it.

## Install

```sh
# 1. the plugin (overlay bubble + bar icon + settings panel)
cp Ghost.qml BarWidget.qml Panel.qml Brain.js manifest.json \
   ~/.config/omarchy/plugins/semihmutlu.ghost/
cp bin/casper-hook ~/.config/omarchy/plugins/semihmutlu.ghost/bin/ && chmod +x ~/.config/omarchy/plugins/semihmutlu.ghost/bin/casper-hook

# 2. place the bar icon
#    A plugin that was previously registered only as an overlay lives in
#    shell.json's plugins[]; that entry makes the widget placement a no-op.
#    Disable and re-enable it once so the bar entry is created.
omarchy plugin disable semihmutlu.ghost
omarchy plugin enable  semihmutlu.ghost --section right

# 3. the shell hook, sourced from ~/.bashrc in real terminals only
printf '\n# Casper companion\n[ -r "$HOME/.config/omarchy/plugins/semihmutlu.ghost/bin/casper-hook" ] && source "$HOME/.config/omarchy/plugins/semihmutlu.ghost/bin/casper-hook"\n' >> ~/.bashrc

# 4. a keep-loaded overlay is NOT re-created by rescanPlugins: restart the shell
omarchy restart shell
```

Then open a **new** terminal window (or `source ~/.bashrc` in an existing one).

`omarchy-shell shell rescanPlugins` alone reloads panels and bar widgets but
leaves an already-running overlay on its old code — restart the shell after
touching `Ghost.qml` or `Brain.js`. Editing `casper.json` needs no restart.

## Uninstall / rollback

```sh
# remove the two lines the installer appended to ~/.bashrc, then
git -C ~/.config/omarchy/plugins/semihmutlu.ghost checkout -- .   # or delete the folder
omarchy-shell shell rescanPlugins
```

Nothing else is touched: no systemd unit, no daemon, no system config, and no
second process. The overlay and the panel run inside the shell you already have.

## Configure

The panel is the interface: click 👻 in the bar. It edits
`~/.config/omarchy/casper.json`, which the overlay watches — changes apply to
the next command, no restart.

```jsonc
{
  "enabled": true,
  "mode": "Balanced",        // Quiet | Balanced | Chatty — sets cooldown, hourly cap, rates
  "silenceUntil": 0,         // epoch ms; the panel sets it to now + 1h
  "cooldownSec": 90,         // floor between two comments
  "budgetPerHour": 8,        // hard hourly ceiling
  "minDurationMs": 2500,     // "long command" threshold
  "failureWindowMs": 900000, // how long a failure stays "recoverable"
  "maxSessions": 24,         // bounded number of tracked shells
  "triggers": { "failure": true, "recovery": true, "slow": true },
  "rates": { "failure": 1, "recovery": 0.8, "slow": 0.5 }, // 0–1 chance per event
  "sarcasm": 0.55,
  "technical": 0.5,
  "verbosity": 0.45,
  "profanity": false
}
```

Every value is optional; anything absent falls back to the mode preset and
then to the defaults above. The panel writes the whole object back, so editing
by hand is fine too.

## Privacy

The hook is an allowlist, not a logger.

* It looks at the command line **locally** only to extract one allowlisted
  family and one allowlisted subcommand, then throws the line away.
* The only thing that leaves the hook is
  `{family, subcommand, code, durationMs, session}` — no arguments, no
  output, no cwd, no secrets, no history file.
* Commands with pipes, redirections, quotes, substitutions or more than two
  words are rejected outright.
* `session` is an ephemeral `casper_<pid>_<random>` id, valid for that shell
  only. It is never written to disk.
* Memory lives inside the running shell process and is bounded by
  `maxSessions` + `failureWindowMs`. Nothing is persisted but your config.
* The overlay never reads windows, titles, workspaces, themes or the clipboard.
* `bin/ghost-llm` from the previous ScreenBuddy version is still in the repo and
  deliberately unreachable: no code path calls it. LLM support is a later step
  with an explicit, minimal, user-inspectable context.

## Coexisting with the rest of your shell

The hook is written to be invisible to other tools:

| Owned by | Treatment |
|---|---|
| `PS0` (Starship) | **appended** — `${ __casper_preexec; }` is added, nothing replaced |
| `PROMPT_COMMAND` (Starship + Herdr rename) | one entry **prepended**, original entries untouched, `$?` preserved |
| `trap DEBUG` (Herdr rename) | **never touched** — Casper installs no trap at all |
| Bash < 5.3 | the hook refuses to install (current-shell `${ }` in `PS0` needs 5.3) |

Sourcing it twice is a no-op. It activates in an interactive shell inside a
recognised terminal emulator — Ghostty and kitty (the terminal in daily use on
this machine), plus foot/wezterm/alacritty — and never in scripts or
non-interactive shells. `CASPER_FORCE=1` installs anywhere, `CASPER_FORCE=0`
never installs.

## Manual testing

```sh
omarchy-shell semihmutlu.ghost whisper "merhaba"        # say something now
omarchy-shell semihmutlu.ghost commandFinished '{"family":"cargo","subcommand":"test","code":1,"durationMs":400,"session":"manual1"}'
omarchy-shell semihmutlu.ghost state                    # what it remembers

CASPER_DEBUG=1                 # in ~/.bashrc before the source line
cat /tmp/casper-hook.log       # why it spoke, or why it stayed quiet
```

## Tests

```sh
node test/brain.test.js     # classifier, dosage, tone, allowlist parity with the hook
bash test/hook.test.sh      # real interactive Bash through a pty: events, silence, no clobbering
/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell Ghost.qml Panel.qml BarWidget.qml
omarchy plugin validate .
```

## Files

| File | Role |
|---|---|
| `Brain.js` | pure logic: validation, classification, dosage, tone, phrases. Runs in Quickshell and Node |
| `bin/casper-hook` | Bash hook: allowlist + one IPC call per interesting command |
| `Ghost.qml` | overlay: the bottom-right bubble, one IPC handler |
| `BarWidget.qml` | the 👻 bar icon |
| `Panel.qml` | settings panel (dosage, triggers, tone, preview) |
| `manifest.json` | plugin manifest — id stays `semihmutlu.ghost` so this replaces ScreenBuddy |

## Known limits (v0)

* Only "simple" commands are tracked: one or two words, no shell operators.
  `git commit -m "..."` is therefore invisible — deliberate, and the first
  thing to revisit if it feels too narrow.
* No history, so no session summary and no "explain the last failure" yet.
  Both need the LLM step and a context you approve case by case.
* No idle/late-night/ambient comments. Those belonged to ScreenBuddy and were
  removed on purpose.
* Linux/Bash first. zsh is not installed on this machine; the hook detects the
  shell and does not install under zsh.

## License

MIT
