const { Plugin, ItemView, Menu, Notice, Keymap, Scope, setIcon, requestUrl, prepareFuzzySearch } = require('obsidian');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIEW_TYPE_VAULT_REACT_APP = 'vault-react-app-view';
const IGNORED_DIRS = new Set(['.obsidian', '.git', 'node_modules', 'dist', 'build', '.trash']);

class VaultReactAppView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.appPath = '';
    this.iframeEl = null;
    this.blobUrls = [];
    this.keymapCleanup = null;
    this.scope = new Scope(this.app.scope);
  }

  getViewType() {
    return VIEW_TYPE_VAULT_REACT_APP;
  }

  getDisplayText() {
    return this.appPath ? path.posix.basename(this.appPath) : 'Vault App';
  }

  getIcon() {
    return 'app-window';
  }

  updateViewHeaderTitle() {
    const titleText = this.getDisplayText();
    const parentText = this.appPath ? path.posix.dirname(this.appPath) : '';
    if (this.titleEl) {
      this.titleEl.setText(titleText);
    }
    if (this.titleParentEl) {
      this.titleParentEl.setText(parentText && parentText !== '.' ? `${parentText} / ` : '');
    }
    if (this.leaf && typeof this.leaf.updateHeader === 'function') {
      this.leaf.updateHeader();
    }
  }

  getState() {
    return { appPath: this.appPath };
  }

  async setState(state, result) {
    if (state && state.appPath) {
      this.appPath = state.appPath;
    }
    await super.setState(state, result);
    this.updateViewHeaderTitle();
    await this.loadApp();
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('vault-react-app-view-content');

    this.contentEl.addEventListener('pointerdown', () => {
      if (this.leaf && this.app.workspace && this.app.workspace.activeLeaf !== this.leaf) {
        this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
      }
    }, true);

    this.addAction('refresh-cw', 'Reload App', () => {
      this.loadApp();
      new Notice(`Reloaded ${this.getDisplayText()}`);
    });

    this.updateViewHeaderTitle();
    if (this.appPath) {
      await this.loadApp();
    }
  }

  revokeBlobs() {
    for (const url of this.blobUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    this.blobUrls = [];
  }

  async onClose() {
    if (this.keymapCleanup) {
      try {
        this.keymapCleanup();
      } catch {}
      this.keymapCleanup = null;
    }
    this.revokeBlobs();
    this.contentEl.empty();
  }

  collectMarkdownFiles() {
    const basePath = this.app.vault.adapter.getBasePath();
    const absAppDir = path.join(basePath, this.appPath);
    const parentDir = path.dirname(absAppDir);
    const filesMap = {};

    const walkMd = (dir, relPrefix) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (fullPath === absAppDir) continue;
        const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkMd(fullPath, nextRel);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          try {
            filesMap[`../../${nextRel}`] = fs.readFileSync(fullPath, 'utf8');
          } catch {}
        }
      }
    };

    walkMd(parentDir, '');
    return filesMap;
  }

  pushLiveVaultFiles() {
    if (!this.iframeEl || !this.iframeEl.contentWindow) return;
    const files = this.collectMarkdownFiles();
    this.iframeEl.contentWindow.postMessage(
      {
        type: 'OBSIDIAN_JOURNAL_FILES',
        files
      },
      '*'
    );
  }

  async loadApp() {
    if (!this.appPath) return;
    const basePath = this.app.vault.adapter.getBasePath();
    const absAppDir = path.join(basePath, this.appPath);

    if (!fs.existsSync(absAppDir)) {
      this.contentEl.empty();
      const errEl = this.contentEl.createDiv({ cls: 'vault-react-app-status' });
      errEl.createEl('div', { text: `App folder not found: ${this.appPath}` });
      return;
    }

    const distDir = path.join(absAppDir, 'dist');
    const distIndex = path.join(distDir, 'index.html');
    if (!fs.existsSync(distIndex)) {
      this.contentEl.empty();
      const errEl = this.contentEl.createDiv({ cls: 'vault-react-app-status' });
      errEl.createEl('strong', { text: `No build found for ${this.getDisplayText()}` });
      errEl.createEl('div', { text: `Please run 'npm run build' inside "${this.appPath}" in your terminal to build the app.` });
      return;
    }

    this.revokeBlobs();

    let html = fs.readFileSync(distIndex, 'utf8');

    // Extract live Obsidian CSS theme variables from document.body so the app matches Obsidian's exact theme
    const computed = getComputedStyle(document.body);
    const themeVars = [
      '--background-primary',
      '--background-primary-alt',
      '--background-secondary',
      '--background-secondary-alt',
      '--background-modifier-hover',
      '--background-modifier-border',
      '--background-modifier-border-hover',
      '--text-normal',
      '--text-muted',
      '--text-faint',
      '--interactive-accent',
      '--interactive-accent-hover',
      '--text-accent',
      '--text-on-accent',
      '--font-interface',
      '--color-green',
      '--color-blue',
      '--color-orange',
      '--color-red',
      '--color-pink',
      '--color-cyan'
    ]
      .map(v => {
        const val = computed.getPropertyValue(v).trim();
        return val ? `  ${v}: ${val};` : '';
      })
      .filter(Boolean)
      .join('\n');
    const themeStyleBlock = `<style id="obsidian-theme-vars">\n:root {\n${themeVars}\n}\n</style>`;

    // Inline CSS <link> tags directly as <style> blocks so styles always apply inside srcdoc
    html = html.replace(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/gi, (fullMatch, href) => {
      const cleanRel = href.replace(/^\.?\//, '');
      const cssFile = path.join(distDir, cleanRel);
      if (!fs.existsSync(cssFile)) return fullMatch;
      const cssContent = fs.readFileSync(cssFile, 'utf8');
      return `${themeStyleBlock}\n<style>\n${cssContent}\n</style>`;
    });

    // Replace JS <script> tags with Blob URLs
    html = html.replace(/<script\b[^>]*src=["']([^"']+\.js)["'][^>]*><\/script>/gi, (fullMatch, src) => {
      const cleanRel = src.replace(/^\.?\//, '');
      const jsFile = path.join(distDir, cleanRel);
      if (!fs.existsSync(jsFile)) return fullMatch;
      const jsContent = fs.readFileSync(jsFile, 'utf8');
      const blobUrl = URL.createObjectURL(new Blob([jsContent], { type: 'text/javascript' }));
      this.blobUrls.push(blobUrl);
      return `<script type="module" src="${blobUrl}"></script>`;
    });

    // Inject live vault markdown files + app-local data.json + transactions-cache.json before the app script executes
    const rawFilesMap = this.collectMarkdownFiles();
    let appLocalData = null;
    const appDataFile = path.join(absAppDir, 'data.json');
    if (fs.existsSync(appDataFile)) {
      try {
        appLocalData = JSON.parse(fs.readFileSync(appDataFile, 'utf8'));
      } catch {}
    }
    let appTransactionsCache = null;
    const txCacheFile = path.join(absAppDir, 'transactions-cache.json');
    if (fs.existsSync(txCacheFile)) {
      try {
        appTransactionsCache = JSON.parse(fs.readFileSync(txCacheFile, 'utf8'));
      } catch {}
    }
    const dataBlobUrl = URL.createObjectURL(
      new Blob(
        [
          `window.__OBSIDIAN_RAW_FILES__ = ${JSON.stringify(rawFilesMap)};\n` +
          `window.__OBSIDIAN_APP_PATH__ = ${JSON.stringify(this.appPath)};\n` +
          `window.__OBSIDIAN_APP_DATA__ = ${JSON.stringify(appLocalData)};\n` +
          `window.__OBSIDIAN_TRANSACTIONS_CACHE__ = ${JSON.stringify(appTransactionsCache)};`
        ],
        {
          type: 'text/javascript'
        }
      )
    );
    this.blobUrls.push(dataBlobUrl);

    const bridgeScript = `
(function() {
  function syncFocus() {
    try {
      if (window.parent) {
        window.parent.postMessage({ type: 'OBSIDIAN_REACT_APP_FOCUS', appPath: window.__OBSIDIAN_APP_PATH__ }, '*');
      }
    } catch (e) {}
  }

  ['pointerdown', 'mousedown', 'focusin'].forEach(function(evtName) {
    window.addEventListener(evtName, syncFocus, true);
  });

  window.addEventListener('keydown', function(evt) {
    var activeEl = document.activeElement;
    var isInput = activeEl && (
      activeEl.tagName === 'INPUT' ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.tagName === 'SELECT' ||
      activeEl.isContentEditable
    );

    if (isInput) {
      var hasMod = evt.ctrlKey || evt.metaKey || evt.altKey;
      if (!hasMod) return;
      var keyLower = evt.key ? evt.key.toLowerCase() : '';
      if ((evt.ctrlKey || evt.metaKey) && !evt.altKey && (keyLower === 'a' || keyLower === 'c' || keyLower === 'v' || keyLower === 'x' || keyLower === 'z' || keyLower === 'y')) {
        return;
      }
    }

    syncFocus();

    var handled = false;
    try {
      if (window.parent && window.parent.app && window.parent.app.keymap && typeof window.parent.app.keymap.onKeyEvent === 'function') {
        var res = window.parent.app.keymap.onKeyEvent(evt);
        if (res === false || evt.defaultPrevented) {
          handled = true;
        }
      }
    } catch (err) {}

    if (handled) {
      evt.preventDefault();
      evt.stopPropagation();
      if (typeof evt.stopImmediatePropagation === 'function') {
        evt.stopImmediatePropagation();
      }
      return;
    }

    try {
      if (window.parent && window.parent !== window && window.parent.document) {
        var parentEvt = new window.parent.KeyboardEvent(evt.type, {
          key: evt.key,
          code: evt.code,
          keyCode: evt.keyCode,
          which: evt.which,
          charCode: evt.charCode,
          location: evt.location,
          ctrlKey: evt.ctrlKey,
          shiftKey: evt.shiftKey,
          altKey: evt.altKey,
          metaKey: evt.metaKey,
          repeat: evt.repeat,
          bubbles: true,
          cancelable: true,
          composed: true
        });
        window.parent.document.dispatchEvent(parentEvt);
      }
    } catch (err) {}
  }, true);
})();
`;
    const bridgeBlobUrl = URL.createObjectURL(new Blob([bridgeScript], { type: 'text/javascript' }));
    this.blobUrls.push(bridgeBlobUrl);

    html = html.replace('<head>', `<head>\n    <script src="${dataBlobUrl}"></script>\n    <script src="${bridgeBlobUrl}"></script>`);

    this.contentEl.empty();
    const iframe = document.createElement('iframe');
    iframe.className = 'vault-react-app-iframe';
    iframe.srcdoc = html;

    if (this.keymapCleanup) {
      try {
        this.keymapCleanup();
      } catch {}
      this.keymapCleanup = null;
    }

    iframe.addEventListener('load', () => {
      try {
        const win = iframe.contentWindow;
        if (!win) return;
        const onFocus = () => {
          if (this.leaf && this.app.workspace && this.app.workspace.activeLeaf !== this.leaf) {
            this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
          }
        };
        win.addEventListener('focus', onFocus, true);
        win.addEventListener('pointerdown', onFocus, true);
        win.addEventListener('mousedown', onFocus, true);

        if (this.app && this.app.keymap && typeof this.app.keymap.registerWindow === 'function') {
          this.keymapCleanup = this.app.keymap.registerWindow(win);
        }
      } catch (e) {}
    });

    this.contentEl.appendChild(iframe);
    this.iframeEl = iframe;
  }
}

module.exports = class VaultReactAppsPlugin extends Plugin {
  async onload() {
    this.appFolders = new Set();
    this.expandedFolders = new Set();
    this.observer = null;

    this.registerView(VIEW_TYPE_VAULT_REACT_APP, leaf => new VaultReactAppView(leaf, this));

    this.scanVaultApps();
    this.setupFileExplorerObserver();
    this.setupDOMInterceptors();
    this.setupWindowMessageBridge();
    this.app.workspace.onLayoutReady(() => this.patchQuickSwitcher());

    this.app.workspace.onLayoutReady(() => {
      this.scanVaultApps();
      this.decorateFileExplorer();
      this.setupFileExplorerObserver();
    });

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.decorateFileExplorer();
      })
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updateActiveNavHighlight();
      })
    );

    const onVaultChange = file => {
      if (!file || !file.path) return;
      if (file.name === 'package.json' || file.name === 'index.html') {
        this.scanVaultApps();
        this.decorateFileExplorer();
      }
      if (file.path.toLowerCase().endsWith('.md')) {
        this.notifyOpenAppViews();
      }
    };

    this.registerEvent(this.app.vault.on('modify', onVaultChange));
    this.registerEvent(this.app.vault.on('create', onVaultChange));
    this.registerEvent(this.app.vault.on('delete', onVaultChange));
    this.registerEvent(this.app.vault.on('rename', onVaultChange));
  }

  isInsideApp(p) {
    for (const a of this.appFolders) {
      if (p === a || p.startsWith(a + '/')) return true;
    }
    return false;
  }

  patchQuickSwitcher() {
    if (this._switcherPatched) return;
    const sw = this.app.internalPlugins?.getPluginById?.('switcher');
    const Modal = sw?.instance?.QuickSwitcherModal;
    const proto = Modal && Modal.prototype;
    if (!proto) return;
    this._switcherPatched = true;
    const plugin = this;
    const origGet = proto.getSuggestions;
    const origRender = proto.renderSuggestion;
    const origChoose = proto.onChooseSuggestion;

    proto.getSuggestions = function (query) {
      const res = origGet.call(this, query) || [];
      const out = res.filter(it => !(it && it.file && (plugin.isInsideApp(it.file.path) || it.file.path === '_fit' || it.file.path.startsWith('_fit/'))));
      const q = (query || '').trim();
      const fuzzy = q ? prepareFuzzySearch(q) : null;
      const apps = [];
      for (const appPath of plugin.appFolders) {
        if (appPath === '_fit' || appPath.startsWith('_fit/')) continue;
        const name = path.posix.basename(appPath);
        if (!fuzzy) { apps.push({ type: 'vault-react-app', appPath, match: { score: -100, matches: [] } }); continue; }
        const m = fuzzy(name) || fuzzy(appPath);
        if (m) apps.push({ type: 'vault-react-app', appPath, match: m });
      }
      if (!apps.length) return out;
      return apps.concat(out).sort((a, b) => (b.match?.score ?? -1000) - (a.match?.score ?? -1000));
    };
    proto.renderSuggestion = function (item, el) {
      if (item && item.type === 'vault-react-app') {
        el.addClass('mod-complex');
        const content = el.createDiv({ cls: 'suggestion-content' });
        const icon = content.createSpan({ cls: 'suggestion-flair' });
        setIcon(icon, 'app-window');
        content.createDiv({ cls: 'suggestion-title', text: path.posix.basename(item.appPath) });
        content.createDiv({ cls: 'suggestion-note', text: item.appPath });
        return;
      }
      return origRender.call(this, item, el);
    };
    proto.onChooseSuggestion = function (item, evt) {
      if (item && item.type === 'vault-react-app') {
        plugin.openApp(item.appPath, Keymap.isModEvent(evt) || false);
        return;
      }
      return origChoose.call(this, item, evt);
    };
    this._restoreSwitcher = () => {
      proto.getSuggestions = origGet;
      proto.renderSuggestion = origRender;
      proto.onChooseSuggestion = origChoose;
    };
  }

  onunload() {
    if (this._restoreSwitcher) { this._restoreSwitcher(); this._switcherPatched = false; }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    document.querySelectorAll('.nav-folder.is-vault-app').forEach(folderEl => {
      folderEl.classList.remove('is-vault-app', 'is-vault-app-expanded');
      const iconEl = folderEl.querySelector(':scope > .nav-folder-title .collapse-icon');
      if (iconEl) {
        delete iconEl.dataset.vaultAppIcon;
        setIcon(iconEl, 'right-triangle');
      }
    });
  }

  scanVaultApps() {
    const basePath = this.app.vault.adapter.getBasePath();
    const detected = new Set();

    const walk = (absDir, relDir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      const names = new Set(entries.map(e => e.name));
      if (relDir && names.has('package.json') && names.has('index.html')) {
        detected.add(relDir);
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        const nextAbs = path.join(absDir, entry.name);
        const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name;
        walk(nextAbs, nextRel);
      }
    };

    walk(basePath, '');
    this.appFolders = detected;
  }

  setupFileExplorerObserver() {
    if (this.observer) {
      this.observer.disconnect();
    }
    this.observer = new MutationObserver(() => {
      this.decorateFileExplorer();
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    this.decorateFileExplorer();
  }

  decorateFileExplorer() {
    const folderTitles = document.querySelectorAll('.nav-folder-title[data-path]');
    for (const titleEl of folderTitles) {
      const folderPath = titleEl.getAttribute('data-path');
      const folderEl = titleEl.parentElement;
      if (!folderEl || !folderEl.classList.contains('nav-folder')) continue;

      if (this.appFolders.has(folderPath)) {
        folderEl.classList.add('is-vault-app');
        const isExpandedMode = this.expandedFolders.has(folderPath);
        folderEl.classList.toggle('is-vault-app-expanded', isExpandedMode);

        const iconEl = titleEl.querySelector('.collapse-icon');
        if (iconEl) {
          const desiredIcon = isExpandedMode ? 'right-triangle' : 'app-window';
          if (iconEl.dataset.vaultAppIcon !== desiredIcon) {
            iconEl.dataset.vaultAppIcon = desiredIcon;
            setIcon(iconEl, desiredIcon);
          }
        }
      } else if (folderEl.classList.contains('is-vault-app')) {
        folderEl.classList.remove('is-vault-app', 'is-vault-app-expanded');
        const iconEl = titleEl.querySelector('.collapse-icon');
        if (iconEl && iconEl.dataset.vaultAppIcon) {
          delete iconEl.dataset.vaultAppIcon;
          setIcon(iconEl, 'right-triangle');
        }
      }
    }
    this.updateActiveNavHighlight();
  }

  updateActiveNavHighlight() {
    const activeView = this.app.workspace.getActiveViewOfType(VaultReactAppView);
    const activeAppPath = activeView ? activeView.appPath : null;
    document.querySelectorAll('.nav-folder.is-vault-app > .nav-folder-title[data-path]').forEach(titleEl => {
      const p = titleEl.getAttribute('data-path');
      titleEl.classList.toggle('is-active', p === activeAppPath && !this.expandedFolders.has(p));
    });
  }

  setupDOMInterceptors() {
    const handlePointerOpen = e => {
      if (e.type === 'auxclick' && e.button !== 1) return;
      if (e.type === 'click' && e.button !== 0) return;

      const titleEl = e.target.closest && e.target.closest('.nav-folder-title[data-path]');
      if (!titleEl) return;
      const appPath = titleEl.getAttribute('data-path');
      if (!this.appFolders.has(appPath)) return;
      if (this.expandedFolders.has(appPath)) return;

      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }

      const paneType = Keymap.isModEvent(e);
      this.openApp(appPath, paneType);
    };

    const handleContextMenu = e => {
      const titleEl = e.target.closest && e.target.closest('.nav-folder-title[data-path]');
      if (!titleEl) return;
      const appPath = titleEl.getAttribute('data-path');
      if (!this.appFolders.has(appPath)) return;

      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }

      const menu = new Menu();

      menu.addItem(item =>
        item
          .setTitle('Open App')
          .setIcon('app-window')
          .onClick(() => this.openApp(appPath, false))
      );

      menu.addItem(item =>
        item
          .setTitle('Open in new tab')
          .setIcon('file-plus')
          .onClick(() => this.openApp(appPath, 'tab'))
      );

      menu.addItem(item =>
        item
          .setTitle('Open to the right')
          .setIcon('separator-vertical')
          .onClick(() => this.openApp(appPath, 'split'))
      );

      menu.addSeparator();

      menu.addItem(item =>
        item
          .setTitle('Reload App')
          .setIcon('refresh-cw')
          .onClick(() => this.reloadAppViews(appPath))
      );

      menu.addSeparator();

      const isExpanded = this.expandedFolders.has(appPath);
      menu.addItem(item =>
        item
          .setTitle(isExpanded ? 'Collapse to App Item (Hide Source Files)' : 'Toggle Folder Expand (Inspect Source Files)')
          .setIcon(isExpanded ? 'app-window' : 'folder-open')
          .onClick(() => {
            if (isExpanded) {
              this.expandedFolders.delete(appPath);
            } else {
              this.expandedFolders.add(appPath);
              const folderEl = titleEl.parentElement;
              if (folderEl && folderEl.classList.contains('is-collapsed')) {
                titleEl.click();
              }
            }
            this.decorateFileExplorer();
          })
      );

      menu.showAtMouseEvent(e);
    };

    this.registerDomEvent(document, 'click', handlePointerOpen, true);
    this.registerDomEvent(document, 'auxclick', handlePointerOpen, true);
    this.registerDomEvent(document, 'contextmenu', handleContextMenu, true);
  }

  setupWindowMessageBridge() {
    this.registerDomEvent(window, 'message', async e => {
      const data = e.data;
      if (!data) return;
      if (data.type === 'OBSIDIAN_REACT_APP_FOCUS' && data.appPath) {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_REACT_APP);
        for (const leaf of leaves) {
          if (leaf.view instanceof VaultReactAppView && leaf.view.appPath === data.appPath) {
            if (this.app.workspace.activeLeaf !== leaf) {
              this.app.workspace.setActiveLeaf(leaf, { focus: false });
            }
            break;
          }
        }
      } else if (data.type === 'OBSIDIAN_OPEN_FILE' && data.path) {
        const linktext = `${data.path}${data.subpath || ''}`;
        const newLeaf = data.newLeaf ? 'tab' : false;
        await this.app.workspace.openLinkText(linktext, '', newLeaf);
      } else if (data.type === 'OBSIDIAN_SAVE_APP_DATA' && data.appPath && data.payload !== undefined) {
        const basePath = this.app.vault.adapter.getBasePath();
        const absAppDir = path.join(basePath, data.appPath);
        if (fs.existsSync(absAppDir)) {
          const appDataFile = path.join(absAppDir, 'data.json');
          try {
            fs.writeFileSync(appDataFile, JSON.stringify(data.payload, null, 2), 'utf8');
          } catch {}
        }
      } else if (data.type === 'OBSIDIAN_SAVE_TRANSACTIONS_CACHE' && data.appPath && data.payload !== undefined) {
        const basePath = this.app.vault.adapter.getBasePath();
        const absAppDir = path.join(basePath, data.appPath);
        if (fs.existsSync(absAppDir)) {
          const txCacheFile = path.join(absAppDir, 'transactions-cache.json');
          try {
            fs.writeFileSync(txCacheFile, JSON.stringify(data.payload), 'utf8');
          } catch {}
        }
      } else if (data.type === 'OBSIDIAN_FETCH_URL' && data.requestId && data.url) {
        const reply = payload => {
          try {
            if (e.source && typeof e.source.postMessage === 'function') {
              e.source.postMessage({ type: 'OBSIDIAN_FETCH_URL_RESULT', requestId: data.requestId, ...payload }, '*');
            }
          } catch {}
        };
        try {
          const res = await requestUrl({
            url: data.url,
            method: 'GET',
            headers: data.headers || {}
          });
          reply({ ok: res.status >= 200 && res.status < 300, status: res.status, text: res.text || '' });
        } catch (err) {
          reply({ ok: false, error: String(err.message || err) });
        }
      } else if (
        data.type === 'OBSIDIAN_FETCH_SERVICE_ACCOUNT' &&
        data.requestId &&
        data.url &&
        data.clientEmail &&
        data.privateKey
      ) {
        const reply = payload => {
          try {
            if (e.source && typeof e.source.postMessage === 'function') {
              e.source.postMessage({ type: 'OBSIDIAN_FETCH_URL_RESULT', requestId: data.requestId, ...payload }, '*');
            }
          } catch {}
        };
        try {
          const now = Math.floor(Date.now() / 1000);
          const b64url = str =>
            Buffer.from(str)
              .toString('base64')
              .replace(/=/g, '')
              .replace(/\+/g, '-')
              .replace(/\//g, '_');
          const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
          const claim = b64url(
            JSON.stringify({
              iss: data.clientEmail.trim(),
              scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly',
              aud: 'https://oauth2.googleapis.com/token',
              exp: now + 3600,
              iat: now
            })
          );
          const unsignedJwt = `${header}.${claim}`;
          const formattedKey = String(data.privateKey).replace(/\\n/g, '\n');
          const signer = crypto.createSign('RSA-SHA256');
          signer.update(unsignedJwt);
          signer.end();
          const signature = signer
            .sign(formattedKey)
            .toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
          const assertion = `${unsignedJwt}.${signature}`;

          const tokenRes = await requestUrl({
            url: 'https://oauth2.googleapis.com/token',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`
          });
          const tokenJson = JSON.parse(tokenRes.text || '{}');
          if (!tokenJson.access_token) {
            throw new Error(tokenJson.error_description || tokenJson.error || 'Failed to obtain Service Account access token');
          }

          const csvRes = await requestUrl({
            url: data.url,
            method: 'GET',
            headers: { Authorization: `Bearer ${tokenJson.access_token}` }
          });
          reply({ ok: csvRes.status >= 200 && csvRes.status < 300, status: csvRes.status, text: csvRes.text || '' });
        } catch (err) {
          reply({ ok: false, error: String(err.message || err) });
        }
      }
    });
  }

  async openApp(appPath, paneType = false) {
    // Behave like standard Obsidian file clicks:
    // - If paneType is false (regular left-click), use the active unpinned leaf (or create one if pinned)
    // - If paneType is 'tab' / 'split' / 'window' (Ctrl/Cmd/Middle-click), open in a new leaf
    const leaf = this.app.workspace.getLeaf(paneType);
    await leaf.setViewState({
      type: VIEW_TYPE_VAULT_REACT_APP,
      active: true,
      state: { appPath }
    });
    this.app.workspace.revealLeaf(leaf);
    this.updateActiveNavHighlight();
  }

  async reloadAppViews(appPath) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_REACT_APP);
    let found = false;
    for (const leaf of leaves) {
      if (leaf.view instanceof VaultReactAppView && leaf.view.appPath === appPath) {
        found = true;
        await leaf.view.loadApp();
      }
    }
    if (!found) {
      await this.openApp(appPath, false);
    } else {
      new Notice(`Reloaded ${path.posix.basename(appPath)}`);
    }
  }

  notifyOpenAppViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_REACT_APP);
    for (const leaf of leaves) {
      if (leaf.view instanceof VaultReactAppView) {
        leaf.view.pushLiveVaultFiles();
      }
    }
  }
};
