# obsidian-kindle-stk

Send your Obsidian notes to your Kindle as EPUB. 100% local — no server, no SMTP, no middleman.

Uses Amazon's Send to Kindle API directly (the same one used by the official macOS/Windows apps). Your notes never pass through a third-party server.

## Features

- One-click send of any Obsidian note to your Kindle
- Automatic EPUB generation
- Embeds (`![[image]]`, `![[other note]]`) and wikilinks are resolved and merged
- Title and author metadata controlled by you
- Authenticate once with Amazon, then forget
- No self-hosted server, no SMTP credentials to manage

## How it works

1. The note's markdown is preprocessed (embeds resolved, callouts flattened, wikilinks normalized)
2. A local converter builds an EPUB in memory
3. The EPUB is uploaded directly to Amazon via the Send to Kindle API (stkservice.amazon.com)
4. Amazon delivers it to your Kindle over Wi-Fi as a regular Personal Document

## Requirements

- Obsidian **desktop** (not mobile — uses Node.js APIs for crypto and local OAuth callback)
- Obsidian 1.11.4 or newer (for `app.secretStorage`)
- An Amazon account with at least one Kindle device or the Kindle app installed

## Install

```bash
bun install
bun run dev
```

Copy `main.js`, `manifest.json`, and `styles.css` to `<Vault>/.obsidian/plugins/obsidian-kindle-stk/`.

## Usage

1. Open **Settings → Community plugins**, enable "Send to Kindle (local)"
2. Go to the plugin settings, click **Authenticate** — your browser opens for Amazon login
3. Open any note, run the command **Send current note to Kindle**

That's it. Your RSA private key and Amazon tokens are stored in the OS keychain via Obsidian's `secretStorage`, never in plaintext.

## Architecture

| Module | Responsibility |
|---|---|
| `src/main.ts` | Plugin entry, command registration, lifecycle |
| `src/settings.ts` | Settings UI |
| `src/stk/client.ts` | Amazon STK API client (device registration, uploads, delivery) |
| `src/stk/signer.ts` | RSA PKCS#1 v1.5 request signing |
| `src/stk/oauth.ts` | OAuth2 PKCE flow (local http server + system browser) |
| `src/obsidian-extract/extract.ts` | Markdown preprocessing for Kindle |
| `src/epub/builder.ts` | EPUB generation |

## License

MIT
