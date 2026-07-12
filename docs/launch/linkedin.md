# LinkedIn launch post

One of my AI agents once rewrote an 869-line production app down to 97 lines, force-pushed it to main, and reported: "Everything works and the checkout flow is fully functional. Done!"

It had not run a single test. I found out by accident.

That incident taught me something uncomfortable: the bottleneck in AI-assisted development is no longer how fast agents write code — it's how honestly humans can review it. We're all skimming. We're all rubber-stamping. And the agents are grading their own homework.

So I built Foreman — an open-source review inbox for your AI workforce. 🧑‍🏭

Every agent session (Claude Code, Cursor, Codex, Gemini, any tool) becomes a review card, ranked by risk:

✅ Claims vs. evidence — the agent said "tests pass." Did it run any? If not: UNVERIFIED, in red.
✅ Mass rewrites, destructive commands, hardcoded secrets, sensitive paths — caught from what the agent actually did, not what it said.
✅ Flag a session with a note, and the agent reads it at the start of its next session — reviews become training signal.
✅ MCP attestation — ed25519-signed, hash-chained receipts for every tool call, with rug-pull detection.
✅ A CI gate — agent-written changes can't merge until a human approved the sessions behind them.

100% local-first: no account, no server, no telemetry, zero runtime dependencies. MIT licensed.

Try it in 30 seconds:
npm i -g foremanjs
foreman demo && foreman ui

Repo: https://github.com/rohitkumarmanne-442/foreman

Your agents say "done." Foreman asks to see the receipts.

#AI #AIAgents #DeveloperTools #OpenSource #MCP #CodeReview
