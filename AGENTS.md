# Notes to Kindle — Obsidian community plugin

## Project overview

- Display name: **Notes to Kindle**. Plugin id and install folder: **`notes-to-kindle`**. Repo: `https://github.com/franchixco/notes-to-kindle`. The pre-community release 0.1.1 shipped as `send-to-kindle`; that id is deprecated history kept only for migration compatibility (see the migration section below).
- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- What it does: sends Obsidian notes to Kindle as EPUB by talking directly to Amazon's **undocumented/internal Send to Kindle endpoints** (`api.amazon.com`, `firs-ta-g7g.amazon.com`, `stkservice.amazon.com`). This is an **unofficial** integration: not created, sponsored, approved, or endorsed by Amazon; Kindle and Send to Kindle are Amazon marks. There is no public Send to Kindle API. The plugin registers a synthetic device, may stop working without notice, and may carry account/terms risk. Never claim otherwise in docs or copy.
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required Obsidian release artifacts: `main.js` and `manifest.json`; include `styles.css` only when non-empty. Keep `LICENSE` and `THIRD_PARTY_NOTICES.md` in the repository, but do not attach them because the Community directory reports unsupported release files.
- `isDesktopOnly: true` — requires Node APIs (`crypto`) and Electron (sandboxed BrowserWindow for OAuth) not available on Obsidian mobile.
- Privacy posture: no developer server, no telemetry, no analytics. Credentials live in OS keychain via `app.secretStorage`. Each authentication and each send is user initiated; the user accepts the unofficial integration risk (disclosed in README).

## Architecture

```
src/
  main.ts                     Plugin entry: lifecycle, commands, glue, OAuth window
  settings.ts                 Settings tab + interface
  stk/
    client.ts                 Amazon STK API client (registerDevice, listOwnedDevices, sendToKindle)
    credentials.ts            SecretStorage-backed credential handling (RSA key, tokens)
    oauth.ts                  OAuth2 PKCE flow (isolated sandboxed Electron BrowserWindow)
    redirect.ts               Strict OAuth redirect validation (scheme/host/path)
    signer.ts                 RSA PKCS#1 v1.5 request signing (Node crypto)
    upload.ts                 Presigned upload URL validation (HTTPS, amazon.com/amazonaws.com only)
    user-agent.ts             Client identifier handling
  obsidian-extract/
    extract.ts                Resolves embeds and opt-in remote image references → clean markdown
    image-assets.ts           Shared local/remote image validation, conversion, caching, budgets
  images/
    remote-fetch.ts           SSRF-hardened HTTPS transport with DNS pinning and bounded redirects
    preflight.ts              Per-send remote download consent and final image confirmation
  epub/
    builder.ts                Markdown → EPUB (in-memory ArrayBuffer)
    render.ts                 Hardened Markdown → XHTML (escapes raw HTML, safe link schemes)
    temp.ts                   Secure temp dir/file (0700/0600) for the EPUB during upload
```

Credentials (RSA private key, Amazon tokens) are stored via `app.secretStorage` (OS keychain, requires API 1.11.4+). Non-sensitive settings via `loadData()`/`saveData()` as usual.

### OAuth architecture (important)

Authentication opens an **isolated sandboxed Electron `BrowserWindow`** (via `window.require('electron').remote` fallback to the app window's `remote`): `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, with a per-flow ephemeral `partition`. It does **not** use the system browser and does **not** use a local HTTP callback. The redirect is captured and strictly validated against the exact expected URL (`https://www.amazon.com/gp/sendtokindle`) in `src/stk/redirect.ts`. Keep this architecture; do not switch to a localhost loopback listener.

## Environment & tooling

- **Package manager: bun** (global rule). Use `bun install`, `bun run <script>`. Never use npm/yarn/pnpm commands.
- **Bundler: esbuild** (configured in `esbuild.config.mjs`). The bundle banner names the repo URL and `legalComments: 'eof'` keeps dependency legal comments in `main.js`.
- Types: `obsidian` type definitions.

### Install

```bash
bun install
```

### Dev (watch)

```bash
bun run dev
```

### Production build

```bash
bun run build
```

## Linting

- ESLint is preconfigured with `eslint-plugin-obsidianmd` for Obsidian-specific rules.
- Run `bun run lint` to lint the project.
- A GitHub Action automatically lints every commit on all branches.

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
    ```
    src/
      main.ts           # Plugin entry point, lifecycle management
      settings.ts       # Settings interface and defaults
      commands/         # Command implementations
        command1.ts
        command2.ts
      ui/              # UI components, modals, views
        modal.ts
        view.ts
      utils/           # Utility functions, helpers
        helpers.ts
        constants.ts
      types.ts         # TypeScript interfaces and types
    ```
- **Do not commit build artifacts**: Never commit `node_modules/`, generated `main.js`, or other generated files. CI builds `main.js` from the tagged source and attaches it to the GitHub release.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, and optional `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):
    - `id` (plugin ID; for local dev it should match the folder name — here `notes-to-kindle`)
    - `name` (here `Notes to Kindle`; keep the display name in sync with README and the plugin settings copy)
    - `version` (Semantic Versioning `x.y.z`)
    - `minAppVersion`
    - `description`
    - `isDesktopOnly` (boolean)
    - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Treat `notes-to-kindle` as the current stable plugin id. The pre-community release `0.1.1` shipped under `send-to-kindle`; tag `0.1.0` used the earlier development id `obsidian-kindle-stk`. Both remain immutable history, and release workflows map each tag to its original id. Existing installs must migrate to the `notes-to-kindle` plugin folder. See the migration section below.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Identity migration (`send-to-kindle` → `notes-to-kindle`)

Since 0.1.2 the plugin id is `notes-to-kindle`; the deprecated `send-to-kindle` id remains only as migration compatibility for the 0.1.1 release. Do not erase or rename it — it is load-bearing for the historical release tag mapping, the preserved SecretStorage keys, and user migration. Migration steps for users upgrading from 0.1.1:

1. Close Obsidian.
2. Rename the plugin folder `<Vault>/.obsidian/plugins/send-to-kindle/` → `<Vault>/.obsidian/plugins/notes-to-kindle/`. Plugin `data.json` (settings) lives inside the plugin folder, so this preserves settings.
3. Reopen Obsidian and enable "Notes to Kindle"; remove the stale `send-to-kindle` entry if Obsidian still lists it.
4. Hotkeys are namespaced by plugin id in Obsidian (`<plugin-id>:<command-id>`). Command IDs `send-note` and `authenticate-amazon` are unchanged, but users must re-bind hotkeys from `send-to-kindle:send-note` / `send-to-kindle:authenticate-amazon` to `notes-to-kindle:send-note` / `notes-to-kindle:authenticate-amazon`.
5. No reauthentication is required. `src/stk/credentials.ts` keeps the exact historical SecretStorage keys `send-to-kindle-credentials` and `stk-credentials`; existing credentials load as before and `Disconnect` clears both keys.

Constraints (enforced by `test/metadata.test.ts`):

- No remnant of the previously rejected ereader identity anywhere.
- Lowercase `send-to-kindle` only in: `src/stk/credentials.ts` (historical keys), `test/credentials.test.ts` (historical-key tests), `test/user-agent.test.ts` (negative UA test), `README.md`/`AGENTS.md` (migration docs), `.github/workflows/release.yml` (0.1.1 tag mapping). The capitalized product phrase **Send to Kindle** stays wherever it refers to Amazon's product.

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
    ```
    <Vault>/.obsidian/plugins/notes-to-kindle/
    ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- The release workflow creates a **draft** after building, testing, attesting, and attaching assets. Verify the draft assets, then publish it manually; Obsidian's community review cannot consume a draft release.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

### Remote-service disclosure (this plugin)

- This is an **unofficial** Amazon integration. Never claim Amazon authorized, approved, or endorsed it, and never imply the disclaimer removes risk.
- There is **no public Send to Kindle API**. The plugin uses undocumented/internal Amazon STK endpoints and protocol identifiers compatible with the official desktop client, and registers a **synthetic device**.
- Per send, the following leaves the machine: note title, configured author, the full note content (including expanded embedded-note text up to depth 3), approved local or remotely downloaded JPEG/opaque PNG/static GIF image bytes, locally generated JPEG bytes converted from transparent PNG/static WebP, and the generated EPUB. Images included without conversion can retain EXIF, GPS, thumbnails, camera details, and color profiles; converted inputs do not intentionally copy source metadata. The plugin confirms image count and total size before sending.
- Destinations: `api.amazon.com` (OAuth token exchange), `firs-ta-g7g.amazon.com` (device registration), `stkservice.amazon.com` (delivery request), and a validated HTTPS presigned upload host on `amazon.com`/`amazonaws.com` (exact host or subdomain, no userinfo/IP literal/non-default port; see `src/stk/upload.ts`).
- What stays local: no developer server, no telemetry/analytics; credentials in OS keychain (`app.secretStorage`); temp EPUB in a `0700` dir with `0600` file, cleaned after upload (`src/epub/temp.ts`).
- **Disconnect** in settings only blanks local credentials. Server-side revocation requires the user to remove the synthetic device in Amazon **Content & Devices**. Document this; do not claim Disconnect revokes Amazon-side access.
- Remote image privacy: only Markdown image tokens are candidates; raw HTML and code are excluded. Before any request, the user must approve the discovered hosts for that send. The choice is not persisted. Requests use HTTPS without cookies, credentials, authorization, or referrer, but the remote host sees the user's IP address and requested path/query.
- Remote image security: keep DNS answers pinned to isolated, non-pooled connections; reject the whole answer set if any A/AAAA address is private, local, special-purpose, or otherwise non-public; preserve the original hostname for TLS verification; disable automatic redirects, allow same-origin redirects only, and revalidate every hop; accept identity encoding only; enforce a 15-second deadline for the complete remote-image phase, 10 MiB response cap, 50 MiB aggregate budget, and 20-URL cap. Never replace this with a normal fetch after DNS preflight because that reintroduces DNS rebinding.
- Capabilities (keep accurate): embedded Markdown notes expand up to depth 3; validated vault-local and approved HTTPS JPEG, opaque PNG, and static GIF images are included; vault-local transparent PNG and static WebP are converted locally to JPEG after animation checks; remote inputs that require browser conversion are omitted so the remote-phase deadline remains enforceable; remote downloads require per-send consent and all image sends require a final preflight; SVG and other unsupported resources render as alt text or omission markers; raw HTML is escaped; only safe link schemes (`http:`, `https:`, `mailto:`) survive.
- Keep README.md, LICENSE, and THIRD_PARTY_NOTICES.md accurate. `THIRD_PARTY_NOTICES.md` carries required notices (stkclient MIT © 2022 Max Johnson, marked, fflate) and acknowledgements (stkclient-swift, obsidian-sample-plugin).

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**

- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**

- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks

### Organize code across multiple files

**main.ts** (minimal, lifecycle only):

```ts
import { Plugin } from 'obsidian';
import { MySettings, DEFAULT_SETTINGS } from './settings';
import { registerCommands } from './commands';

export default class MyPlugin extends Plugin {
	settings!: MySettings;

	async onload() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MySettings>,
		);
		registerCommands(this);
	}
}
```

**settings.ts**:

```ts
export interface MySettings {
	enabled: boolean;
	apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
	enabled: true,
	apiKey: '',
};
```

**commands/index.ts**:

```ts
import { Plugin } from 'obsidian';
import { doSomething } from './my-command';

export function registerCommands(plugin: Plugin) {
	plugin.addCommand({
		id: 'do-something',
		name: 'Do something',
		callback: () => doSomething(plugin),
	});
}
```

### Add a command

```ts
this.addCommand({
	id: 'your-command-id',
	name: 'Do the thing',
	callback: () => this.doTheThing(),
});
```

### Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MySettings>);
  await this.saveData(this.settings);
}
```

### Register listeners safely

```ts
this.registerEvent(
	this.app.workspace.on('file-open', (f) => {
		/* ... */
	}),
);
this.registerDomEvent(activeWindow, 'resize', () => {
	/* ... */
});
this.registerInterval(
	window.setInterval(() => {
		/* ... */
	}, 1000),
);
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js`, `manifest.json`, and optional `styles.css` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/notes-to-kindle/`.
- Build issues: if `main.js` is missing or stale, run `bun run build` (or `bun run dev` for watch) to compile the TypeScript source. Do not use npm.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and you re-render the UI after changes.
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.
- OAuth window won't open: the sandboxed BrowserWindow requires the Electron `remote` module; on newer Obsidian/Electron, `window.require('electron').remote` may be absent and the fallback path in `src/main.ts` is used. Do not fall back to a system browser or localhost HTTP callback.
- `Disconnect` seems to do nothing about delivery: it only clears local credentials. Removing the synthetic device in Amazon Content & Devices is the server-side revocation step.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
- stkclient (Python reference impl this TypeScript port adapts, MIT): https://github.com/maxdjohnson/stkclient
- stkclient-swift (Swift reference consulted; MIT declared in README only): https://github.com/mrowlinson/stkclient-swift
- Amazon STK endpoints: `stkservice.amazon.com`, `firs-ta-g7g.amazon.com`, `api.amazon.com`
- Bundled deps: `marked` (MIT) and `fflate` (MIT). Notices live in `THIRD_PARTY_NOTICES.md`.
