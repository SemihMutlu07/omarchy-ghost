# Contributing

Thanks for wanting to make Ghost a little more alive. 👻

## Ways to help

- **Message packs** — the template library is `Brain.js`, section `var T = {}`.
  Add categories or variants. Keep lines short (< 16 words), warm, playful,
  never mean. ES5 only (QML JS engine).
- **New signals** — event sources live in `Ghost.qml` (watch section). If you
  want Ghost to notice something new, add the wiring there and a category in
  `Brain.js`.
- **Bugs** — open an issue with `omarchy-shell semihmutlu.ghost state` output
  and any `journalctl --user` warnings mentioning `ghost`.

## Developing

```sh
node --test test/brain.test.js   # run the brain tests
omarchy plugin validate .        # validate the manifest
omarchy restart shell            # reload the plugin after QML changes
```

Note: Quickshell caches compiled QML; after editing `.qml` files a shell
restart is the reliable refresh (hot-reload can serve stale bytecode).

## Conventions

- `Brain.js` is ES5-only and node-testable — no arrow functions, no
  template literals, no `let/const`. New logic ships with tests.
- Keep the cooldown/quiet-hours/budget philosophy: Ghost should *never* nag.
- No telemetry, no cloud. State stays in `~/.local/state/omarchy/ghost/`.

## License

MIT — by contributing you agree your changes are MIT-licensed too.
