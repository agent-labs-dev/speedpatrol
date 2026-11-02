# ADR 0004 — A/B rounds for changes

**Status:** Accepted
**Date:** 2026-10-27

## Context

Comparing a change with a baseline measured an hour earlier also compares the machine of an hour ago with the machine now. On shared runners, that difference can be larger than the regression.

## Decision

A change — a PR, a worktree, an experiment, the confirmation of a suspected regression — is measured A/B: both checkouts on the same machine, in alternating rounds (A B, B A, ...), with the samples of each side pooled. Each checkout is prepared (installed, built) once, outside the timed rounds. A ref that is not a directory is checked out as a detached worktree under `runs/checkouts/`.

## Consequences

An A/B comparison takes about twice as long as one run per round. In exchange, drift falls on both sides, and the patrol's baseline comparison serves as the cheap first screen that A/B confirms.
