# Security policy

## Supported versions

Security fixes go into the latest release on npm (`speedpatrol@latest`) and the `v0` Action tag. Upgrade to get them; older releases are not patched.

## Report a vulnerability

Do not open a public issue. Report it privately on GitHub: the repo's **Security** tab, then **Report a vulnerability** ([direct link](https://github.com/agent-labs-dev/speedpatrol/security/advisories/new)). Say what an attacker can do, the version, and the steps or config that show it.

We reply within five working days, and we tell you when a fix is released. We credit you in the advisory unless you ask us not to.

## What is in scope

Speedpatrol runs your app's commands, runs agent CLIs or model APIs on your code, and opens issues and PRs with your `gh` credentials. These are in scope:

- A secret (`app.secrets`, a captured value, an API key) that reaches a log, a run file, the dashboard, a published issue or PR, or a model.
- An agent role that gets a tool outside its role ([docs/agents.md](docs/agents.md)), writes outside its worktree, or runs a command it should not.
- The dashboard serving data to anyone but the local machine, or a request to it that changes state.
- The GitHub Action leaking its token, or running untrusted PR code with write permissions.

Out of scope: what your own `app.setup`, `app.prepare` and benchmark commands do. Speedpatrol runs them as you wrote them.
