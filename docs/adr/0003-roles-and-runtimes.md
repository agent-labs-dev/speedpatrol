# ADR 0003 — Roles with tools, on any runtime

**Status:** Accepted
**Date:** 2026-10-27

## Context

Teams use different agents: Claude Code, Codex, opencode, or an API key. Bugpatrol (ADR 0005 there) showed that a role defined by its tools, not by its runtime, lets a team switch runtimes without other changes.

## Decision

Speedpatrol has three model roles — scout, analyst, optimizer — and two code roles — runner and publisher. Each model role is a system prompt plus a set of tools. The `cli` runtime starts a command and serves the tools over a local, stateless MCP server, with the step budget held on the server side; the `model` runtime runs its own tool-use loop over the same tool objects. `use: claude | codex | opencode` expands to a preset command per role: the scout and the analyst get read-only access plus the Speedpatrol tools, the optimizer gets edit access in its own worktree.

## Consequences

The same e2e test drives every role with a scripted MCP client, so the contract is tested without a model. A new runtime is a command line.
