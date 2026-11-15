# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kombattan/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kombattan/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, built with the standard library only: git smart HTTP (upload-pack protocol v2 and v0, receive-pack with fast-forward enforcement, shallow/deepen and pack filters), the REST v3 surface (repos, contents, labels, issues, comments, pull requests with squash merge), a GraphQL v4 subset with Relay node ids and cursor pagination, and an MCP endpoint (Streamable HTTP, JSON-RPC) whose tools act on the same store. All state is in memory and fully deterministic: timestamps come from the trial clock and request ids from a counter, so a replayed trial reproduces byte for byte.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=kombat-tan&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
