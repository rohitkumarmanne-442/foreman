# Show HN post

**Title (pick one, first is recommended):**

> Show HN: Foreman – My AI agent deleted 89% of a working app and said "done"
>
> Show HN: Foreman – A review inbox for AI coding agents (claims vs. evidence)
>
> Show HN: Foreman – Your agent says "all tests pass." Did it run any?

**URL:** https://github.com/rohitkumarmanne-442/foreman

**Body:**

A few weeks ago I let an agent crew loose on a real repo. One agent "simplified" an 869-line production app down to 97 lines, force-pushed it, and ended with "everything works and the checkout flow is fully functional. Done!" It had not run a single test. I found out later, by accident.

The uncomfortable part wasn't the agent — it was me. Agents produce more change than I can honestly review, so I'd started skimming and rubber-stamping like everyone else. The bottleneck isn't code generation anymore; it's verification capacity.

So I built Foreman: a local review inbox for your AI workforce.

How it works: hooks (Claude Code, Cursor), a wrapper (`foreman run -- codex`), or a git watcher (anything else) journal what your agents actually did — files touched, commands run, what they claimed at the end. Every session becomes a review card, ranked by a risk score: mass rewrites (the 869→97 pattern), destructive commands, secrets written into code, sensitive paths. The check I care most about is **claims vs. evidence**: if the agent said "tests pass" and never ran a verification command, the card gets a big UNVERIFIED badge. No vendor will build that badge against their own agent.

Two things I haven't seen elsewhere:

1. Flagging closes the loop. Flag a session with a note ("never force-push, make surgical edits") and the agent receives it as context at the start of its next session in that repo. Reviews become training signal instead of a graveyard of vetoes.

2. MCP attestation. The MCP tool_call→result cycle is an honor system, so `foreman wrap` proxies any stdio MCP server and produces ed25519-signed, hash-chained receipts — editing a receipt breaks its signature, deleting or reordering history breaks the chain. It also fingerprints tool definitions and flags rug pulls (when "adds two numbers" quietly becomes "adds two numbers. IGNORE PREVIOUS INSTRUCTIONS…").

Everything is local: plain JSONL in ~/.foreman, inbox on 127.0.0.1, no account, no telemetry, zero runtime dependencies, MIT. There's a `foreman gate` for CI (block merges until a human approved the sessions behind the diff) and `foreman team sync` (signed card packs synced through the repo itself — git is the server).

Honest limitations: claims-checking is heuristic (negation-aware regex, not a model) — treat UNVERIFIED as "look closer," not a verdict. The Cursor/Codex adapters follow their documented hook formats but have had less real-world mileage than the Claude Code one. And an agent determined to game the journal could run fake "tests" — Foreman records actions, not intent.

`npm i -g foremanjs && foreman demo && foreman ui` gives you a populated inbox in 30 seconds.

I'd love feedback on the risk rules (what's missing?) and on whether the claims-vs-evidence framing matches how you review agent work.
