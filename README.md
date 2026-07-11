# 🧑‍🏭 Foreman

**The review inbox for your AI workforce.**

You hired five AI agents. Foreman makes sure you can actually check their work.

```
npm i -g foremanjs
foreman init      # wire up your agent (Claude Code first, more coming)
foreman ui        # open your review inbox
```

---

## Why

The bottleneck of 2026 isn't code generation — it's **verification capacity**. Agents produce more change than humans can responsibly review, so we skim, we rubber-stamp, and sometimes an agent rewrites an 869-line production app down to 97 lines and merges it while we're looking the other way. (That happened to me. That's why this exists.)

Every existing tool attacks the machine side of that problem — evals, traces, benchmarks. Foreman attacks the human side: **make the reviewer faster, not the agent slower.**

## What it does

Every agent session becomes a **review card**, ranked by risk — so you spend ten minutes on the dangerous change and ten seconds on the README fix.

Each card shows:

- **Files touched** — with before → after line counts and a **click-to-expand diff** for every change. A 200-line file rewritten to 20 lines glows red.
- **Commands run** — with pass/fail, and which of them actually *verify* anything (tests, builds, lint, a curl against localhost).
- **Claims vs evidence** — the agent said *"all tests pass, everything works"*. Did it run a single test? If not: **⚠️ UNVERIFIED**. No agent vendor will build this badge against themselves.
- **Findings** — destructive commands (`rm -rf`, force push, `DROP TABLE`, `DELETE` without `WHERE`), mass rewrites, secrets written into code, sensitive paths (auth, migrations, `.env`, CI workflows) touched.

Work the inbox like email: **✓ Approve** sinks a card, **⚑ Flag** pins it. The "Needs review" filter is your queue; inbox zero means every agent change had human eyes on it.

Want to see it populated before wiring up an agent? `foreman demo` seeds three showcase sessions (including a replica of the 869→97 incident); `foreman demo --clear` removes them.

### Risk rules (v0.1)

| Rule | Severity | Trigger |
|---|---|---|
| `destructive_command` | critical | `rm -rf`, force push, `git reset --hard`, `DROP`/`TRUNCATE`, `DELETE` without `WHERE`, … |
| `mass_rewrite` | critical | an existing 50+ line file rewritten to <40% of its size |
| `secret_in_code` | critical | AWS keys, private keys, `sk-…`/`ghp_…` tokens, JWTs written into files |
| `failed_verification` | critical | agent claimed success, its verification commands failed |
| `unverified_claims` | high | agent claimed success, ran zero verification commands |
| `sensitive_path` | high | `.env`, secrets, auth, migrations, CI workflows touched |
| `mcp_tool_drift` | high | an MCP server changed its tool definitions (see below) |
| `untested_change` | medium | code changed, nothing was ever executed |

## MCP attestation: signed receipts for tool calls

The MCP `tool_call → tool_result` cycle runs on an honor system — nothing proves a server did what it claims, and nothing notices when a server quietly changes what its tools *say they do*.

Foreman ships a transparent attestation proxy:

```
foreman wrap --name github -- npx @your/mcp-server
```

- Every `tools/call` produces a **receipt**: SHA-256 of params and result, latency, outcome — **ed25519-signed** by a key that never leaves your machine. `foreman verify` re-checks every signature; tamper with one byte of the journal and it breaks.
- Every `tools/list` is **fingerprinted against a trusted baseline** (trust-on-first-use). If a server's tool descriptions change — the classic MCP rug pull, where `"adds two numbers"` becomes `"adds two numbers. IGNORE PREVIOUS INSTRUCTIONS…"` — Foreman journals a drift finding and flags it in your inbox. Re-accept intentional updates with `foreman trust <server>`.

The proxy passes every byte through untouched. Your agent and server never know it's there.

## Local-first, by design

- Everything lives in `~/.foreman/` as plain JSONL — greppable, diffable, yours.
- The inbox binds to `127.0.0.1` only. No accounts, no telemetry, no cloud, no exceptions.
- Hooks never block your agent: they journal and exit 0, even on failure.

## Commands

```
foreman init [--global]    install Claude Code hooks (this repo, or all repos)
foreman ui [--port 4517]   open the review inbox
foreman status             one-screen summary in the terminal
foreman demo [--clear]     seed (or remove) showcase data
foreman wrap --name <s> -- <cmd…>   attest an MCP server
foreman trust <s>          re-baseline an MCP server's tools
foreman verify             re-verify every signed receipt
```

## Roadmap

- [x] Approve / flag actions on cards
- [x] Diff view per file touch
- [ ] Adapters: Cursor, Copilot CLI, Codex, Gemini CLI, OpenCode
- [ ] Feed review decisions back to the agent (flag → the agent sees why)
- [ ] Receipt chains (hash-linked journal → tamper-evident history, not just tamper-evident entries)
- [ ] Team mode: share cards for the changes your teammates' agents made

## License

MIT
