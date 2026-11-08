# Vault React Apps for Obsidian

Embed and run full React (and web) applications stored directly inside your Obsidian vault as seamless native tabs and clean single-item file tree entries.

## Features

- **Clean File Tree Integration**: Collapses React project directories into clean single app entries with a custom app icon in Obsidian's file explorer.
- **Native Obsidian Tabs**: Opens React apps in seamless, full-bleed tabs with proper header titles and path breadcrumbs.
- **Bi-directional Bridge**:
  - Live vault markdown file sync to the embedded app (`postMessage` events).
  - Secure requests proxying with Obsidian's native `requestUrl` to bypass CORS.
  - Google Service Account token generation and JWT signing for secure Sheets/Drive integrations.
- **Hot-Reloading**: Reload app views on file change or via the header action button.
- **Inspect Source Files**: Right-click toggle to reveal or collapse underlying project files and `node_modules`.

## Development

```bash
# Inside your vault app directory:
npm install
npm run build
```

## Installation

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Place them into your vault at `<vault>/.obsidian/plugins/obsidian-vault-react-apps/`.
3. Reload Obsidian and enable the plugin in **Community plugins**.

## License

MIT © [Dan](https://github.com/DoozyDan)
