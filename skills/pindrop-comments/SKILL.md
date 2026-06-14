---
name: pindrop-comments
description: Read and respond to the Pindrop review comments left on a deployed preview URL. Use when reviewing a preview deploy and you need to see the human feedback / pins on it, reply to a comment, mark one resolved, or drop a new comment. Triggers include "check the preview comments", "what feedback is on the preview", "reply to the review pins", "resolve that comment".
---

Pindrop review comments on a preview live in a per-preview room reachable over a
WebSocket. Use the `pindrop-comments` CLI to read them and to respond.

```
npx github:alandotcom/pindrop-cloudflare <command> <preview-url> [options]
```

Run with `--help` first; it is the source of truth for commands and flags:

```
npx github:alandotcom/pindrop-cloudflare --help
```

## What you need

- **The preview URL** you are reviewing (e.g. `https://abc-site.acme.workers.dev`).
  Its hostname is the room and its origin is what the access gate checks, so the
  CLI derives both from it.
- **The comments Worker host.** Set `PINDROP_HOST`, or find it in the site's
  source (grep for `initPindropComments` / `pindrop-comments` and read its
  `host`). If neither turns it up, ask the user.

## Common commands

```
# read everything on the preview
PINDROP_HOST=pindrop-comments.acme.workers.dev \
  npx github:alandotcom/pindrop-cloudflare read https://abc-site.acme.workers.dev

# reply to comment #1 from that listing
npx github:alandotcom/pindrop-cloudflare reply https://abc-site.acme.workers.dev \
  --comment 1 --text "fixed in 9e16fe8"

# mark it resolved
npx github:alandotcom/pindrop-cloudflare resolve https://abc-site.acme.workers.dev --comment 1
```

`read --json` prints the raw pin array for parsing. Anything you write is
attributed to the agent (`meta.source = "agent"`).

## Notes

- The board is last-write-wins, so `read` immediately before you write; the CLI
  does this for you within a single write command.
- A rejected connection almost always means the preview's origin is not in the
  Worker's `ALLOWED_ORIGINS`, or the host/room is wrong. The CLI says which.
- This reads and writes the same board reviewers see live; a reply or new
  comment shows up in their browser in real time.
