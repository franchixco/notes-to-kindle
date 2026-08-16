# Notes to Kindle

Send your Obsidian notes to your Kindle as EPUB, straight from the Obsidian desktop app.

> **Unofficial integration.** This plugin is not created, sponsored, approved, or endorsed by Amazon. **Kindle** and **Send to Kindle** are trademarks of Amazon.com, Inc. or its affiliates.

## What it does

Notes to Kindle takes the current note, converts it to an EPUB in memory, and delivers it to your Kindle over Wi-Fi as a personal document. You control the title and author metadata before you send.

## Important: how the send works

There is **no public Send to Kindle API**. This plugin talks to Amazon's undocumented, internal Send to Kindle endpoints and reuses protocol and client identifiers associated with Amazon's official desktop client. It registers a synthetic device in your Amazon account so documents can be delivered to it.

What that means in practice:

- The integration can stop working without notice if Amazon changes, restricts, or removes those endpoints.
- Using an unofficial integration against internal Amazon services may carry risk to your Amazon account and may conflict with Amazon's terms of service.
- Nothing here is legal advice, and this disclaimer does not remove or reduce any risk you take on.

You stay in control. Authentication only happens when you click **Authenticate**, and each note is sent only when you run the send command. Every request is initiated by you, from your machine. By authenticating and by sending notes, you accept the risk of this unofficial integration.

## Data and privacy

**What leaves your machine on each send:**

- The note's title and the author name you configured.
- The complete note content, including the expanded text of embedded notes up to a nesting depth of 3.
- The generated EPUB built from that content.

**Where it goes:**

- `api.amazon.com`: OAuth token exchange.
- `firs-ta-g7g.amazon.com`: synthetic device registration.
- `stkservice.amazon.com`: the send-to-Kindle delivery request.
- A presigned upload URL on an Amazon/AWS host. The plugin only follows HTTPS URLs whose host is exactly `amazon.com` or `amazonaws.com`, or a subdomain of either, with no userinfo, no IP literal, and no non-default port.

**What stays local:**

- Nothing is routed through a developer-operated server. There is no backend, no telemetry, and no analytics.
- Your Amazon tokens and the plugin's RSA private key are stored in your OS keychain via Obsidian's `secretStorage`, never in plaintext files.
- The EPUB is written to a private temp directory (mode `0700`, file mode `0600`) and removed after the upload completes.

**Disconnect.** `Disconnect` in settings only clears the locally stored credentials. It does not deregister the synthetic device. To revoke access server-side, remove the device from Amazon's **Content & Devices** page.

## Capabilities

- Converts the current Markdown note to EPUB with a clean stylesheet.
- Expands embedded notes (`![[other note]]`) up to a nesting depth of 3.
- Flattens callouts and normalizes wikilinks.
- Renders checkboxes, highlights (`==text==`), and safe links.
- **Not included:** embedded images and remote images. They render as their alt text, not as pictures.
- **Escaping:** raw HTML is escaped rather than executed. Links only keep safe schemes (`http:`, `https:`, `mailto:`); everything else is neutralized.

## Requirements

- Obsidian **desktop** (this plugin uses Node and Electron APIs, so it does not run on mobile).
- Obsidian 1.11.4 or newer (for `app.secretStorage`).
- An Amazon account with at least one Kindle device or the Kindle app installed.

## Install

1. Copy the release artifacts into `<Vault>/.obsidian/plugins/send-to-kindle/`. Only `main.js` and `manifest.json` are required; `styles.css` is optional (it is currently empty and may be omitted).
2. In Obsidian, open **Settings → Community plugins**, enable "Notes to Kindle", and allow third-party plugins if prompted.

For development:

```bash
bun install
bun run dev      # watch mode
bun run build    # production build
```

## Usage

1. Open **Settings → Community plugins**, enable "Notes to Kindle".
2. In the plugin settings, click **Authenticate**. An isolated, sandboxed Electron window opens for the Amazon login. The plugin does not open your system browser and does not use a local HTTP callback.
3. Open any note and run the command **Send current note to Kindle**.

## Architecture

| Module | Responsibility |
|---|---|
| `src/main.ts` | Plugin entry, command registration, lifecycle, OAuth window |
| `src/settings.ts` | Settings UI |
| `src/stk/client.ts` | STK client: device registration, delivery |
| `src/stk/credentials.ts` | SecretStorage-backed credential handling |
| `src/stk/oauth.ts` | OAuth2 PKCE flow (sandboxed Electron BrowserWindow) |
| `src/stk/redirect.ts` | Strict validation of the Amazon OAuth redirect |
| `src/stk/signer.ts` | RSA PKCS#1 v1.5 request signing |
| `src/stk/upload.ts` | Presigned upload URL validation and upload |
| `src/stk/user-agent.ts` | Client identifier handling |
| `src/obsidian-extract/extract.ts` | Markdown preprocessing for Kindle |
| `src/epub/builder.ts` | EPUB generation |
| `src/epub/render.ts` | Hardened Markdown rendering |
| `src/epub/temp.ts` | Secure temp file handling |

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
