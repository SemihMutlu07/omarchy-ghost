// Unit tests for Brain.js — the deterministic part of Casper.
// Run: node --test test/brain.test.js   (or: node test/brain.test.js)
const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const path = require("node:path")
const Brain = require("../Brain.js")

const event = (overrides = {}) =>
  Object.assign({ family: "git", subcommand: "status", code: 1, durationMs: 400, session: "s1" }, overrides)

function fresh(overrides = {}) {
  Brain.resetMemory()
  Brain.setConfig(Object.assign({}, Brain.DEFAULTS, { cooldownSec: 0, budgetPerHour: 50, minDurationMs: 0 }, overrides))
}

test("accepts only allowlisted families and subcommands", () => {
  fresh()
  assert.equal(Brain.validEvent(event()), true)
  assert.equal(Brain.validEvent(event({ subcommand: "" })), true)
  assert.equal(Brain.validEvent(event({ family: "git status" })), false, "raw args are not a family")
  assert.equal(Brain.validEvent(event({ family: "rm" })), false, "non-allowlisted binary")
  assert.equal(Brain.validEvent(event({ subcommand: "--porcelain" })), false, "unknown subcommand")
  assert.equal(Brain.validEvent(event({ subcommand: "commit" })), true)
  assert.equal(Brain.validEvent(event({ session: "../../etc/passwd" })), false)
  assert.equal(Brain.validEvent(event({ code: "1; rm -rf /" })), false)
  assert.equal(Brain.validEvent(event({ durationMs: "9999999999" })), false)
  assert.equal(Brain.finish(event({ family: "rm", subcommand: "", code: 1 })), "")
})

test("a failure speaks, then only a same-session, same-family success recovers", () => {
  fresh({ minDurationMs: 60000 })
  assert.match(Brain.finish(event()), /git status/)
  assert.equal(Brain.state().lastKind, "failure")
  assert.equal(Brain.finish(event({ code: 0, session: "other" })), "", "another session is not a recovery")
  assert.ok(Brain.finish(event({ code: 0 })), "same session + family recovers")
  assert.equal(Brain.state().lastKind, "recovery")
})

test("three failures in a row escalate to the repeat line", () => {
  fresh()
  Brain.finish(event())
  Brain.finish(event())
  Brain.finish(event())
  assert.equal(Brain.state().lastKind, "repeat")
  assert.match(Brain.state().lastMessage, /yine|tekrar|again|bir daha/)
})

test("Ctrl-C and signal-like exits are never failures and leave no memory", () => {
  fresh()
  assert.equal(Brain.finish(event({ code: 130 })), "")
  assert.equal(Brain.finish(event({ code: 143 })), "")
  assert.equal(Brain.state().trackedFamilies, 0)
})

test("long commands are 'slow', short ones stay quiet", () => {
  fresh({ minDurationMs: 2000 })
  assert.equal(Brain.finish(event({ code: 0, durationMs: 500 })), "")
  const slow = Brain.finish(event({ code: 0, durationMs: 3400 }))
  assert.equal(Brain.state().lastKind, "slow")
  assert.match(slow, /3s/)
})

test("an old failure does not turn a later success into a recovery", () => {
  fresh({ failureWindowMs: 1000, minDurationMs: 60000 })
  let now = 1_000_000
  Brain._setNow(() => now)
  Brain.finish(event())
  now += 5000
  assert.equal(Brain.finish(event({ code: 0 })), "", "outside the window this is just a silent success")
  Brain._setNow(() => Date.now())
})

test("cooldown, hourly budget, dedup, silence and triggers gate the output", () => {
  fresh({ cooldownSec: 60 })
  assert.ok(Brain.finish(event()))
  assert.equal(Brain.finish(event({ family: "make", subcommand: "" })), "", "cooldown")

  fresh({ cooldownSec: 0, budgetPerHour: 1 })
  assert.ok(Brain.finish(event()))
  assert.equal(Brain.finish(event({ family: "make", subcommand: "" })), "", "hourly budget")

  fresh({ cooldownSec: 0, triggers: { failure: false, recovery: true, slow: true } })
  assert.equal(Brain.finish(event()), "", "trigger switched off")

  fresh({ cooldownSec: 0, silenceUntil: Date.now() + 3600000 })
  assert.equal(Brain.finish(event()), "", "silenced")

  fresh({ cooldownSec: 0, enabled: false })
  assert.equal(Brain.finish(event()), "", "disabled")

  fresh({ cooldownSec: 0, rates: { failure: 0, recovery: 0, slow: 0 } })
  assert.equal(Brain.finish(event()), "", "zero rate")
})

test("the same line is never said twice in a row", () => {
  fresh({ cooldownSec: 0 })
  const first = Brain.finish(event({ family: "make", subcommand: "" }))
  assert.ok(first)
  Brain.resetMemory()
  Brain.setConfig(Object.assign({}, Brain.DEFAULTS, { cooldownSec: 0, budgetPerHour: 50, minDurationMs: 0 }))
  const again = Brain.finish(event({ family: "make", subcommand: "" }))
  assert.equal(first, again, "same input, same deterministic line")
})

test("mode presets set dosage and explicit config keys win", () => {
  const quiet = Brain.parseConfig('{"mode":"Quiet"}')
  const balanced = Brain.parseConfig('{}')
  const chatty = Brain.parseConfig('{"mode":"Chatty"}')
  assert.ok(quiet.budgetPerHour < balanced.budgetPerHour, "quiet is stingier than balanced")
  assert.ok(chatty.budgetPerHour > balanced.budgetPerHour, "chatty is looser than balanced")
  assert.ok(quiet.cooldownSec > chatty.cooldownSec)
  assert.equal(balanced.mode, "Balanced", "default mode")
  assert.equal(Brain.parseConfig('{"mode":"nope"}').mode, "Balanced", "unknown mode falls back")
  assert.equal(Brain.parseConfig('{"mode":"Quiet","budgetPerHour":42}').budgetPerHour, 42, "explicit key wins")
  assert.equal(Brain.parseConfig('{"sarcasm":5}').sarcasm, 1, "tone values are clamped")
  assert.equal(Brain.parseConfig("not json").mode, "Balanced")
})

test("memory stays bounded by maxSessions", () => {
  fresh({ maxSessions: 2 })
  Brain.finish(event({ session: "a", code: 1 }))
  Brain.finish(event({ session: "b", code: 1 }))
  Brain.finish(event({ session: "c", code: 1 }))
  assert.equal(Brain.state().trackedFamilies, 2, "oldest session is evicted")
})

test("tone knobs change the line deterministically", () => {
  const base = { family: "make", subcommand: "", code: 2, durationMs: 100, session: "s1" }

  Brain.resetMemory()
  Brain.setConfig(Object.assign({}, Brain.DEFAULTS, { cooldownSec: 0, budgetPerHour: 50, sarcasm: 0.1, profanity: false }))
  const gentle = Brain.finish(base)

  Brain.resetMemory()
  Brain.setConfig(Object.assign({}, Brain.DEFAULTS, { cooldownSec: 0, budgetPerHour: 50, sarcasm: 0.9, profanity: true }))
  const rude = Brain.finish(base)

  assert.notEqual(gentle, rude, "sarcasm/profanity must be visible in the output")
  assert.match(gentle, /tamam/, "low sarcasm replaces the barbed clause")

  const preview = Brain.preview(Object.assign({}, Brain.DEFAULTS, { technical: 0.9 }))
  assert.match(preview, /exit \d+/, "high technical appends the exit code")
  const terse = Brain.preview(Object.assign({}, Brain.DEFAULTS, { verbosity: 0.1 }))
  assert.ok(terse.length < preview.length, "low verbosity shortens the line")
  assert.equal(Brain.preview(Brain.DEFAULTS), Brain.preview(Brain.DEFAULTS), "preview is deterministic")
})

test("bin/casper-hook allowlist stays in sync with Brain.FAMILIES", () => {
  const hook = fs.readFileSync(path.join(__dirname, "..", "bin", "casper-hook"), "utf8")
  const start = hook.indexOf('case "$family:$sub" in')
  assert.ok(start > 0, "could not find the hook's family allowlist")
  const block = hook.slice(start, hook.indexOf("esac", start))
  const seen = {}
  for (const match of block.matchAll(/([a-z0-9_+:|-]+)\)\s*;;/g)) {
    for (const token of match[1].split("|")) {
      const [family, sub] = token.split(":")
      assert.ok(family, `unparsable allowlist token: ${token}`)
      seen[family] = seen[family] || []
      seen[family].push(sub)
    }
  }
  const expected = Object.keys(Brain.FAMILIES).sort()
  assert.deepEqual(Object.keys(seen).sort(), expected, "hook and Brain must allowlist the same families")
  for (const family of expected) {
    assert.deepEqual(seen[family].slice().sort(), Brain.FAMILIES[family].slice().sort(), `subcommands differ for ${family}`)
  }
})
