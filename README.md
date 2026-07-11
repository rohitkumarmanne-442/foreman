# 🧑‍🏭 Foreman

**The review inbox for your AI workforce.**

You let AI agents write your code. Foreman makes sure you can actually check their work — before it hurts you.

```bash
npm install -g foremanjs
foreman demo && foreman ui     # see it working in 30 seconds
```

Works with **Claude Code**, **Cursor**, and — through universal watch mode — **any IDE or agent that edits files** (Windsurf, Copilot, JetBrains AI, Codex, …). 100% local. No account. No telemetry. MIT.

---

## The problem

AI agents produce more change than humans can responsibly review. So we skim. We rubber-stamp. And sometimes an agent rewrites an 869-line production app down to 97 lines, says *"everything works!"*, and merges it while we're looking the other way. (That happened to me. That's why Foreman exists.)

Agents also **claim** things. *"All tests pass."* Did it run a single test? You'd have to scroll the whole transcript to know. Nobody does.

## What Foreman does

Foreman quietly records what your agents *actually did* — files touched, commands run, what they claimed at the end — and turns every session into a **review card** in a local inbox, **ranked by risk**:

| On the card | What it tells you |
|---|---|
| 🎯 **Risk score 0–100** | Spend 10 minutes on the dangerous session, 10 seconds on the README fix |
| ⚠️ **Claims vs evidence** | The agent said *"it works"* — Foreman checked whether it ever ran anything that could prove it. If not: **UNVERIFIED** |
| 📁 **Files + diffs** | Before → after line counts, click any file for the red/green diff |
| 🔍 **Findings** | Destructive commands, mass rewrites, hardcoded secrets, sensitive paths — each with a plain-English "why this matters" |
| 🧾 **Terminal history** | Every command, pass/fail, with verification commands (tests, builds) badged |

You work the inbox like email: **✓ Approve** what's safe, **⚑ Flag** what isn't. Inbox zero = every AI change had human eyes on it.

## Install & connect your agent

**Step 1 — install** (needs Node 18+):

```bash
npm install -g foremanjs
```

**Step 2 — connect the agent you use:**

<details>
<summary><b>Claude Code</b></summary>

```bash
cd your-project
foreman init
```

That's it. This adds Foreman hooks to `.claude/settings.json`. Every *new* Claude Code session in this project now files a review card (richest data: diffs, commands, claims). Use `foreman init --global` to cover every project at once.
</details>

<details>
<summary><b>Cursor</b></summary>

```bash
cd your-project
foreman init
```

This adds Foreman to `.cursor/hooks.json` (Cursor 1.7+). Shell commands, file edits, MCP calls, and session ends are all captured. Use `--global` for all projects, or `foreman init --agent cursor` to install for Cursor only.
</details>

<details>
<summary><b>Windsurf, Copilot, JetBrains AI, Codex, or anything else</b></summary>

```bash
cd your-project
foreman watch
```

Universal mode doesn't need hooks: it watches your git working tree and journals every change any tool makes — mass rewrites, secrets, and sensitive paths are all caught. Press `Ctrl+C` when the agent is done to close the card. (Needs the project to be a git repo.)
</details>

**Step 3 — open your inbox:**

```bash
foreman ui        # → http://127.0.0.1:4517
```

Keep it open while you work — cards appear and update live. Keyboard: `j`/`k` navigate, `a` approve, `f` flag, `/` search, `?` help.

## MCP attestation: make tool calls provable

MCP's `tool_call → tool_result` cycle runs on an honor system: nothing proves a server did what it claims, and nothing notices when a server quietly *changes what its tools say they do* (the classic rug pull that smuggles prompt injections into your agent).

Wrap any stdio MCP server — in your agent's MCP config, prefix the command:

```jsonc
// before
{ "command": "npx", "args": ["@someone/github-mcp"] }
// after
{ "command": "foreman", "args": ["wrap", "--name", "github", "--", "npx", "@someone/github-mcp"] }
```

You get:

- **Signed receipts** — every `tools/call` is journaled with SHA-256 hashes of params and result, latency and outcome, **ed25519-signed** by a key that never leaves your machine. `foreman verify` re-checks every signature; tamper with one byte and it breaks.
- **Rug-pull detection** — tool definitions are fingerprinted on first use. If a server's tool descriptions ever change (*"adds two numbers"* → *"adds two numbers. IGNORE PREVIOUS INSTRUCTIONS…"*), a finding lands in your inbox. Re-accept intentional updates with `foreman trust <server>`.

The proxy passes every byte through untouched — your agent and the server never know it's there.

## All commands

```text
foreman init [--agent claude|cursor|all] [--global]   install hooks
foreman watch [path] [--interval ms]                  universal mode (any IDE/agent)
foreman ui [--port 4517]                              open the review inbox
foreman status                                        one-screen summary in the terminal
foreman report [--out audit.md]                       markdown audit report of all sessions
foreman demo [--clear]                                seed / remove showcase data
foreman wrap --name <srv> -- <command…>               attest an MCP server
foreman trust <srv>                                   re-baseline a server's tools
foreman verify                                        re-verify every signed receipt
foreman config                                        show config path + active settings
foreman uninstall [--global]                          remove hooks (journal stays)
```

## Tune it to your codebase

Create `~/.foreman/config.json` (see `foreman config` for the path and live values):

```jsonc
{
  "port": 4517,
  "ignore": ["node_modules/", "dist/", "*.lock", "generated/"],   // paths to never track
  "disable_rules": ["untested_change"],                            // rules you don't want
  "mass_rewrite_min_lines": 50,   // smallest file that can count as a mass rewrite
  "mass_rewrite_ratio": 0.4       // flag when new content < 40% of the original
}
```

### The risk rules

| Rule | Severity | Fires when |
|---|---|---|
| `destructive_command` | critical | `rm -rf`, force push, `git reset --hard`, `DROP`/`TRUNCATE`, `DELETE` without `WHERE`, `kubectl delete`, `terraform destroy`, … |
| `mass_rewrite` | critical | a 50+ line file rewritten to <40% of its size (both thresholds configurable) |
| `secret_in_code` | critical | AWS/Anthropic/Stripe/GitHub/GitLab/Google/Slack/SendGrid/npm keys, private keys, JWTs, hardcoded passwords |
| `failed_verification` | critical | the agent claimed success but its own checks failed |
| `unverified_claims` | high | the agent claimed success and never ran anything that could prove it |
| `sensitive_path` | high | `.env`, secrets, auth, migrations, CI workflows, `.ssh`, `.npmrc` touched |
| `mcp_tool_drift` | high | an MCP server changed its tool definitions vs the trusted baseline |
| `untested_change` | medium | code changed, nothing was ever executed |

Claim detection is negation-aware — *"tests fail"* and *"should now work"* are never counted as success claims.

## FAQ

**Does my code leave my machine?** Never. Everything lives in `~/.foreman/` as plain JSONL you can grep. The inbox binds to `127.0.0.1` only. There is no server, no account, no telemetry.

**Will hooks slow down or break my agent?** No. Hooks journal and exit `0` in milliseconds, even on internal failure — an agent can never be blocked by Foreman.

**Why not just read the agent's own summary?** Because the summary is the agent grading its own homework. Foreman's claims-vs-evidence check exists precisely because "all tests pass" and *ran zero tests* routinely appear in the same session.

**How is this different from guardrails (Microsoft AGT, NemoClaw…)?** Guardrails constrain the *machine* before it acts. Foreman makes the *human* faster after it acts — review capacity is the bottleneck guardrails don't touch. Use both.

**Can I audit a whole week?** `foreman report --out audit.md` produces a markdown report of every session, claim, and finding — reviews included.

**How do I get rid of the sample data?** `foreman demo --clear`.

## How it works

```text
Claude Code hooks ─┐
Cursor hooks ──────┤                        ┌─ review cards, risk-ranked ─→ inbox UI (foreman ui)
                   ├─→ ~/.foreman/*.jsonl ──┤
foreman watch ─────┤     (event journal)    └─ audit report (foreman report)
foreman wrap ──────┘
  └─ ed25519-signed receipts + tool-definition fingerprints (rug-pull detection)
```

No daemon, no database. The journal is append-only JSONL; the inbox reads it live; receipts are independently verifiable with `foreman verify`.

## Roadmap

- [x] Claude Code + Cursor adapters, universal watch mode
- [x] Approve/flag review workflow, diff viewer, audit reports
- [ ] Feed review decisions back to the agent (flag → the agent learns why)
- [ ] Copilot CLI / Codex / Gemini CLI native adapters
- [ ] Hash-linked receipt chains (tamper-evident history, not just tamper-evident entries)
- [ ] Team mode: share cards for the changes your teammates' agents made

## License

MIT — do whatever you want, just keep the notice.
