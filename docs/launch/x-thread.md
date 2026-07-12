# X / Twitter launch thread

**1/**
My AI agent deleted 89% of a working app, force-pushed it, and said:

"Everything works. Done!"

It had run zero tests.

So I built Foreman — a review inbox for your AI workforce. Its whole personality fits in one thought cloud: "Prove it." 🧵

*(attach: assets/brand/banner.png or the demo GIF)*

**2/**
Every agent session becomes a review card, ranked by risk:

🟥 869→97 line rewrite? flagged.
🟥 git push --force? flagged.
🟥 API key written into code? flagged.
❓ "all tests pass" + zero tests run? UNVERIFIED.

You work it like email. Inbox zero = every AI change had human eyes on it.

*(attach: assets/inbox.png)*

**3/**
The part I'm proudest of: flagging teaches the agent.

Flag a session with a note — "never force-push, make surgical edits" — and the agent gets it as context at the start of its NEXT session in that repo.

Your reviews stop being vetoes and become training signal.

**4/**
MCP tool calls run on an honor system. Nothing proves a server did what it claims.

`foreman wrap` fixes that: ed25519-signed, hash-chained receipts for every tool call. Edit one → signature breaks. Delete or reorder history → chain breaks.

It also catches tool-description rug pulls.

**5/**
Works with everything:
· Claude Code + Cursor → hooks
· Codex, Gemini CLI, Copilot CLI, aider → `foreman run -- <agent>`
· Anything that edits files → `foreman watch`
· CI → `foreman gate` blocks merges until a human approved the sessions

100% local. No account. No telemetry. MIT.

**6/**
Try it in 30 seconds:

npm i -g foremanjs
foreman demo && foreman ui

Repo: https://github.com/rohitkumarmanne-442/foreman

Your agents say "done." Foreman asks to see the receipts. 🧑‍🏭
