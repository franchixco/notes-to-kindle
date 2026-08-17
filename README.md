# Notes to Kindle

Send your Obsidian notes to your Kindle as EPUB, straight from the Obsidian desktop app.

> **Unofficial integration.** This app was not created or endorsed by Amazon. It is not sponsored, approved, or otherwise affiliated with Amazon, and it makes no claim of official status. **Kindle** and **Send to Kindle** are trademarks of Amazon.com, Inc. or its affiliates.

## What it does

Notes to Kindle takes the current note, converts it to an EPUB, and delivers it to your Kindle over Wi-Fi as a personal document. It uses the note title and the default author configured in the plugin settings.

## What's new in 0.1.6

- Detects HTTPS images in Markdown inline and reference-style image tokens, including images inside expanded embedded notes. Raw HTML, code spans, and fenced code are never treated as image requests.
- Asks before making any remote image request. Approval applies only to the current send and is never saved; choosing **Skip remote images** keeps the safe alt-text fallback.
- Downloads at most 20 unique remote URLs through an SSRF-hardened transport: public IPs only, pinned DNS answers, isolated sockets, strict TLS hostname verification, same-origin redirects only, a 15-second deadline for the whole remote-image phase, and bounded identity-encoded responses.
- Sends no cookies, Amazon credentials, or authorization headers to image hosts. Those hosts still receive your IP address and the requested URL, including any path or query string already present in the note.
- Validates remote bytes through the same bounded image pipeline as local files. JPEG, opaque PNG, and static GIF are packaged directly. Remote transparent PNG and WebP are omitted because their browser conversion cannot be cancelled safely within the remote-phase deadline; failures degrade to alt text without aborting the send.
- SVG remains disabled for the planned 0.1.7 work.

## What's new in 0.1.5

- Converts vault-local **transparent PNG** and **static WebP** images to JPEG entirely inside Obsidian before building the EPUB.
- Flattens transparency onto a white background and rejects APNG or animated WebP before browser decoding.
- Hashes, deduplicates, budgets, and revalidates the converted JPEG bytes using the existing image security pipeline.
- Converted PNG/WebP metadata is not intentionally copied; local images included without conversion may still retain EXIF, GPS, thumbnails, or color profiles.
- Remote images remain disabled in this release, and SVG remains disabled for the planned 0.1.7 work.

## What's new in 0.1.4

- Includes validated vault-local **JPEG**, **opaque PNG**, and **static GIF** images in the EPUB.
- Resolves images relative to both the current note and embedded notes, with SHA-256 deduplication and bounded resource limits.
- Shows a privacy preflight with image count and total size before original bytes — which may retain EXIF or GPS metadata — are sent to Amazon.
- Keeps SVG, WebP, transparent images, animated GIFs, and remote images out of the EPUB; they degrade to visible omission markers or safe alt text and remote images are never downloaded.
- Supports Amazon's exact current CAPS upload endpoint (`zme-caps.amazon.com`) without broadening trust to arbitrary `amazon.com` hosts.
- Verified with 201 automated tests, EPUBCheck 5.3.0, and end-to-end delivery on a physical Kindle.

See the [Notes to Kindle 0.1.4 release](https://github.com/franchixco/notes-to-kindle/releases/tag/0.1.4) for downloadable artifacts and release notes.

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
- Approved local and remotely downloaded JPEG, opaque PNG, and static GIF image bytes referenced by those notes, plus JPEG output produced locally from transparent PNG and static WebP inputs. Images included without conversion can retain embedded metadata such as EXIF, camera details, thumbnails, ICC profiles, or GPS location; converted inputs do not intentionally copy source metadata. The plugin confirms the count and total size before sending them.
- The generated EPUB built from that content.
- The EPUB file size and the serial numbers of the selected destination devices.
- Protocol metadata required by Amazon's internal service, including the synthetic device identifier, access/authentication tokens, and cryptographic request signatures. The RSA private key itself is not sent back to Amazon.

**Where it goes:**

- `api.amazon.com`: OAuth token exchange.
- `firs-ta-g7g.amazon.com`: synthetic device registration.
- `stkservice.amazon.com`: the send-to-Kindle delivery request.
- A presigned HTTPS upload URL on an AWS S3 endpoint (`s3.amazonaws.com` or a supported regional, virtual-hosted, dual-stack, or legacy S3 form) or Amazon's exact CAPS upload host (`zme-caps.amazon.com`). Arbitrary Amazon/AWS subdomains, userinfo, IP literals, redirects, and non-default ports are rejected.
- If you approve remote images for a send, each HTTPS image host shown in the confirmation receives a direct request from your machine. The host sees your IP address, the requested path/query, and the plugin user agent. The plugin sends no cookies, Amazon credentials, referrer, or authorization header. DNS answers are pinned to isolated connections, any private, local, special-purpose, or mixed public/private answer is rejected, and redirects to another origin are blocked.

**What stays local:**

- Nothing is routed through a developer-operated server. There is no backend, no telemetry, and no analytics.
- Your Amazon tokens and the plugin's RSA private key are stored in your OS keychain via Obsidian's `secretStorage`, never in plaintext files.
- The EPUB is written to a private temp directory (mode `0700`, file mode `0600`) and removed in the normal send cleanup path. An abrupt process or system crash can leave that private temporary file behind until the operating system or user removes it.

**Disconnect.** `Disconnect` in settings only clears the locally stored credentials. It does not deregister the synthetic device. To revoke access server-side, remove the device from Amazon's **Content & Devices** page.

## Capabilities

- Converts the current Markdown note to EPUB with a clean stylesheet.
- Expands embedded notes (`![[other note]]`) up to a nesting depth of 3.
- Flattens callouts and normalizes wikilinks.
- Renders checkboxes, highlights (`==text==`), and safe links.
- Includes vault-local JPEG, opaque PNG, and single-frame GIF images referenced with Obsidian embeds or Markdown image syntax. Transparent PNG and static WebP inputs are flattened onto white and converted locally to JPEG. Images are resolved relative to the note that contains them, validated, deduplicated, and confirmed before sending.
- With per-send approval, includes HTTPS JPEG, opaque PNG, and static GIF resources referenced by Markdown inline or reference-style image tokens. Remote resources share the local image limits: 10 MiB per response, 50 MiB total, 100 unique packaged assets, and 20 unique remote URLs.
- **Not included:** HTTP or non-public remote resources, remote transparent PNG or WebP, APNG, animated WebP/GIF, SVG, BMP, TIFF, HEIC, AVIF, raw HTML images, CSS backgrounds, Canvas/PDF pages, or plugin-rendered diagrams. Unsupported resources degrade to alt text or an omission marker.
- **Escaping:** raw HTML is escaped rather than executed. Links only keep safe schemes (`http:`, `https:`, `mailto:`); everything else is neutralized.

## Requirements

- Obsidian **desktop** (this plugin uses Node and Electron APIs, so it does not run on mobile).
- Obsidian 1.11.4 or newer (for `app.secretStorage`).
- An Amazon account with at least one Kindle device or the Kindle app installed.

## Install

1. Copy the release artifacts into `<Vault>/.obsidian/plugins/notes-to-kindle/`. Only `main.js` and `manifest.json` are required; `styles.css` is optional and is currently omitted.
2. In Obsidian, open **Settings → Community plugins**, enable "Notes to Kindle", and allow third-party plugins if prompted.

> Installing over the deprecated `send-to-kindle` (0.1.1) folder? See [Migrating from send-to-kindle (0.1.1)](#migrating-from-send-to-kindle-011).

For development:

```bash
bun install
bun run dev      # watch mode
bun run build    # production build
```

## Migrating from `send-to-kindle` (0.1.1)

Releases before 0.1.2 shipped under the plugin id and install folder `send-to-kindle`. The plugin id is now `notes-to-kindle`; `send-to-kindle` is deprecated history and is kept only for migration compatibility. Upgrading from 0.1.1:

1. Close Obsidian.
2. Rename the plugin folder from `<Vault>/.obsidian/plugins/send-to-kindle/` to `<Vault>/.obsidian/plugins/notes-to-kindle/`. This preserves your settings (`data.json`), because Obsidian stores plugin data inside the plugin folder.
3. Reopen Obsidian and enable "Notes to Kindle" if it shows as disabled. If Obsidian still lists the old `send-to-kindle` entry, remove it — the new folder replaces it.
4. Reassign any hotkeys bound to the old command namespace. The command IDs themselves (`send-note`, `authenticate-amazon`) are unchanged, but Obsidian prefixes them with the plugin id, so they are now `notes-to-kindle:send-note` and `notes-to-kindle:authenticate-amazon` instead of `send-to-kindle:...`. Rebind them in **Settings → Hotkeys**.
5. **No reauthentication is needed.** The plugin keeps reading the exact SecretStorage keys `send-to-kindle-credentials` and the legacy `stk-credentials`, so credentials saved by 0.1.1 load as before, and `Disconnect` still clears both keys.

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
| `src/stk/upload.ts` | Presigned S3 URL validation |
| `src/stk/presign-upload.ts` | Bounded, timeout-aware presigned upload transport |
| `src/stk/user-agent.ts` | Client identifier handling |
| `src/obsidian-extract/extract.ts` | Markdown preprocessing for Kindle |
| `src/images/validate.ts` | Bounded JPEG, PNG, and GIF structural validation |
| `src/images/webp.ts` | Bounded static WebP container inspection |
| `src/images/convert.ts` | Local Chromium raster conversion to opaque JPEG |
| `src/images/remote-fetch.ts` | Consent-gated, SSRF-hardened HTTPS image transport |
| `src/images/preflight.ts` | Remote-download consent and final image-send confirmation |
| `src/epub/builder.ts` | EPUB generation |
| `src/epub/render.ts` | Hardened Markdown rendering |
| `src/epub/temp.ts` | Secure temp file handling |

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
