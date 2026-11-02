# ADR 0002 — Baselines per commit, per machine, never committed

**Status:** Accepted
**Date:** 2026-10-27

## Context

A timing is a property of the code and the machine together. A laptop, a CI runner and a cloud VM give different numbers for the same commit, and committing timings to git would mix them.

## Decision

Every clean run of a commit is that commit's baseline on that machine. The index `runs/baselines.json` is append-only, keyed by sha and machine fingerprint. A comparison with a baseline uses only baselines of the same machine. `runs/` is git-ignored; the definitions that produce the data (`speedpatrol.yml`, `instructions.md`, `benchmarks.json`) are committed. `SPEEDPATROL_MACHINE` lets identical runners share one fingerprint.

## Consequences

A fresh machine starts with no history and builds one as it patrols; the first cycle only records. An A/B comparison does not need a history at all, so CI works on a fresh runner.
