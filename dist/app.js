/* ==========================================
   NoteFlow — app.js
   Main application logic (Tauri Edition)
   Wrapped in IIFE to avoid global scope pollution.
========================================== */

(function() {
  'use strict';

  console.log('[NoteFlow] app.js loaded, version: 2026-05-04-web');

  // ─────────────────────────────────────────
  // Tauri 检测 — 自动适配 Web / Tauri 环境
  // ─────────────────────────────────────────
  // 所有逻辑放在 IIFE 内，避免与 Tauri 注入的全局属性冲突。
  function isTauri() {
    return !!(window.__TAURI__ && window.__TAURI__.core);
  }

  function invoke(cmd, args) {
    if (isTauri()) {
      return window.__TAURI__.core.invoke(cmd, args || {});
    }
    // Web 环境：路由到 WebStorage 适配层
    if (window.WebStorage && window.WebStorage[cmd]) {
      const params = args ? Object.values(args) : [];
      return Promise.resolve(window.WebStorage[cmd](...params));
    }
    console.warn('[NoteFlow] Unhandled invoke:', cmd);
    return Promise.resolve(null);
  }

  // 带重试的 invoke（等待 Tauri API 完全就绪）
  function invokeSafe(cmd, args, retries) {
    if (retries === void 0) retries = 5;
    return new Promise(function(resolve, reject) {
      function tryInvoke(remaining) {
        if (isTauri()) {
          window.__TAURI__.core.invoke(cmd, args || {}).then(resolve).catch(reject);
        } else if (remaining > 0) {
          setTimeout(function() { tryInvoke(remaining - 1); }, 100);
        } else {
          reject(new Error('Tauri API not ready'));
        }
      }
      tryInvoke(retries);
    });
  }

  // ─────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────
  const State = {
    notes: [],          // 元数据列表（无 content），用于侧边栏渲染
    folders: [],
    currentId: null,
    theme: 'light',
    viewMode: 'edit',
    pdfDoc: null,
    pdfPage: 1,
    pdfScale: 1.0,
    imgScale: 1.0,
    unsaved: false,
    searchQuery: '',
    // 按需加载的 content 缓存
    noteContents: {},   // { [noteId]: content 字符串 }
    noteBinaries: {},  // { [noteId]: base64 字符串 }
    blobUrls: {},      // { [noteId]: blobUrl }
    minioConfig: null,  // { endpoint, bucket, accessKey, secretKey, enabled, region }
    attachmentCache: {}, // { "noteId/filename": base64 }
  };

  // ─────────────────────────────────────────
  // DOM REFS
  // ─────────────────────────────────────────
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const dom = {
    sidebar:       $('#sidebar'),
    fileList:      $('#file-list'),
    sidebarEmpty:  $('#sidebar-empty'),
    welcomeScreen: $('#welcome-screen'),
    editorToolbar: $('#editor-toolbar'),
    mdContainer:   $('#md-container'),
    mdEditor:      $('#md-editor'),
    mdPreview:     $('#md-preview'),
    mdEditorWrap:  $('#md-editor-wrap'),
    mdPreviewWrap: $('#md-preview-wrap'),
    pdfContainer:  $('#pdf-container'),
    imgContainer:  $('#img-container'),
    imgViewer:     $('#img-viewer'),
    fileInput:     $('#file-input'),
    currentName:   $('#current-file-name'),
    saveStatus:    $('#save-status'),
    wordCount:     $('#word-count'),
    cursorPos:     $('#cursor-pos'),
    insertImageBtn: $('#btn-insert-image'),
    insertImageInput: $('#insert-image-input'),
    pdfCanvas:     $('#pdf-canvas'),
    pdfTotal:      $('#pdf-total'),
    pdfPageInput:  $('#pdf-page-input'),
    pdfZoomLevel:  $('#pdf-zoom-level'),
    imgZoomLevel:  $('#img-zoom-level'),
    searchInput:   $('#search-input'),
    modalOverlay:  $('#modal-overlay'),
    modalTitle:    $('#modal-title'),
    modalBody:     $('#modal-body'),
    modalFooter:   $('#modal-footer'),
    contextMenu:   $('#context-menu'),
    contextList:   $('#context-list'),
  };

  // ─────────────────────────────────────────
  // PERSISTENCE — 数据持久化层
  // ─────────────────────────────────────────
  // STORAGE — 分文件存储 API
  // ─────────────────────────────────────────
  const STORAGE_KEY = 'noteflow_data_v2';

  // 保存当前笔记到后端（增量保存，只保存当前编辑的笔记）
  async function _writeNoteFile(noteId) {
    const targetId = noteId || State.currentId;
    if (!targetId) return;
    const note = State.notes.find(n => n.id === targetId);
    if (!note) return;

    const noteObj = {
      id: note.id,
      folderId: note.folderId,
      name: note.name,
      type: note.type,
      content: (note.type === 'md' || note.type === 'txt')
        ? (State.noteContents[note.id] || (targetId === State.currentId ? dom.mdEditor.value : '') || '')
        : '',
      createdAt: note.createdAt,
      updatedAt: Date.now(),
    };
    note.updatedAt = noteObj.updatedAt;

    // 缓存 content
    if (note.type === 'md' || note.type === 'txt') {
      State.noteContents[note.id] = noteObj.content;
    }

    try {
      await invoke('save_note', { noteJson: JSON.stringify(noteObj), binaryBase64: State.noteBinaries[note.id] || '' });
    } catch(e) {
      console.error('save_note failed:', e);
    }
  }

  // 保存文件夹结构
  async function saveFolders() {
    try {
      await invoke('save_folders', { data: JSON.stringify(State.folders) });
    } catch(e) {
      console.error('save_folders failed:', e);
    }
  }

  // 保存设置（theme 等）
  async function saveSettings() {
    try {
      await invoke('save_settings', { data: JSON.stringify({ theme: State.theme }) });
    } catch(e) {
      console.error('save_settings failed:', e);
    }
  }

  // 兼容旧前端：全量保存（内部已改为分文件）
  function saveToStorage() {
    const data = {
      notes: State.notes.map(n => ({
        ...n,
        content: State.noteContents[n.id] || n.content || '',
      })),
      folders: State.folders,
      theme: State.theme,
    };
    invoke('save_notes', { data: JSON.stringify(data) })
      .catch(e => console.error('save_notes failed:', e));
  }

  async function loadFromStorage() {
    try {
      State.noteContents = {}; // Clear cache so openNote re-fetches updated content
      // 加载笔记索引（元数据，无 content）
      const indexRaw = await invoke('load_index');
      if (indexRaw && indexRaw !== '[]' && indexRaw !== '') {
        const metadata = JSON.parse(indexRaw);
        State.notes = metadata.map(n => ({
          id: n.id,
          folderId: n.folderId || null,
          name: n.name,
          type: n.type,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
        }));
      } else {
        State.notes = [];
      }

      // 加载文件夹
      try {
        const foldersRaw = await invoke('load_folders');
        State.folders = foldersRaw ? JSON.parse(foldersRaw) : [];
      } catch(e) { State.folders = []; }

      // 加载设置
      try {
        const settingsRaw = await invoke('load_settings');
        if (settingsRaw) {
          const settings = JSON.parse(settingsRaw);
          State.theme = settings.theme || 'light';
        }
      } catch(e) { State.theme = 'light'; }

      if (State.notes.length === 0) {
        seedDefaultNotes();
      }
    } catch(e) {
      console.error('load failed:', e);
      seedDefaultNotes();
    }
  }

  async function seedDefaultNotes() {
    const now = Date.now();
    State.folders = [{ id: 'f1', name: '快速开始', open: true }];
    State.notes = [
      {
        id: 'n1', folderId: 'f1', name: '欢迎使用 NoteFlow.md', type: 'md',
        content: welcomeMd, createdAt: now, updatedAt: now,
      },
      {
        id: 'n2', folderId: null, name: '我的第一篇笔记.md', type: 'md',
        content: '# 我的笔记\n\n在这里开始书写...\n\n- [ ] 任务一\n- [ ] 任务二\n',
        createdAt: now - 60000, updatedAt: now - 60000,
      },
    ];
      // 保存每篇默认笔记到后端
      for (const note of State.notes) {
        await invoke('save_note', { noteJson: JSON.stringify(note), binaryBase64: '' });
      }
      saveFolders();
      saveSettings();
    }

  // ─────────────────────────────────────────
  // DEFAULT CONTENT
  // ─────────────────────────────────────────
  const welcomeMd = `# 欢迎使用 NoteFlow

NoteFlow 是一款支持 **Markdown 渲染**、**PDF 查看**和**图片预览**的智能笔记软件。

## 功能特色

| 功能 | 说明 |
|------|------|
| Markdown 编辑 | 实时编辑，支持语法高亮 |
| 分屏预览 | 左侧编辑，右侧实时渲染 |
| PDF 查看 | 内置 PDF 阅读器，支持缩放翻页 |
| 图片预览 | 支持 PNG / JPG / GIF / WebP / SVG |
| 深色模式 | 一键切换，护眼阅读 |
| 文件夹管理 | 笔记分组整理 |

## Markdown 示例

### 代码块

\`\`\`javascript
function greet(name) {
  return \`Hello, ${name}!\`;
}
console.log(greet('NoteFlow'));
\`\`\`

### 引用

> 好的工具让思维更自由。

### 任务列表

- [x] 创建新笔记
- [x] 切换深色模式
- [ ] 导入 PDF 文件
- [ ] 整理笔记文件夹

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| \`Ctrl+S\` | 保存笔记 |
| \`Ctrl+B\` | 粗体 |
| \`Ctrl+I\` | 斜体 |
| \`Ctrl+/\` | 切换预览 |
| \`Ctrl+D\` | 删除当前行 |

---

*开始创作你的第一篇笔记吧！*
`;

  // ─────────────────────────────────────────
  // THEME
  // ─────────────────────────────────────────
  function applyTheme(theme) {
    State.theme = theme;
    document.documentElement.dataset.theme = theme;
    const isDark = theme === 'dark';
    $('#icon-sun').style.display  = isDark ? 'none' : '';
    $('#icon-moon').style.display = isDark ? '' : 'none';
    const hlTheme = $('#hljs-theme');
    if (hlTheme) {
      hlTheme.href = isDark
        ? 'lib/highlight/github-dark.min.css'
      : 'lib/highlight/github.min.css';
  }
  saveSettings();
}

  $('#btn-theme').addEventListener('click', () => {
    applyTheme(State.theme === 'light' ? 'dark' : 'light');
  });

  // ─────────────────────────────────────────
  // SIDEBAR TOGGLE
  // ─────────────────────────────────────────
  $('#btn-toggle-sidebar').addEventListener('click', () => {
    dom.sidebar.classList.toggle('collapsed');
  });

  // 移动端：点击侧边栏遮罩时关闭
  document.addEventListener('click', (e) => {
    if (window.innerWidth > 768) return;
    const sidebar = dom.sidebar;
    if (sidebar.classList.contains('collapsed')) return;
    // 点击在侧边栏外部（遮罩区域）则关闭
    if (!sidebar.contains(e.target) && e.target.id !== 'btn-toggle-sidebar' && !e.target.closest('#btn-toggle-sidebar')) {
      sidebar.classList.add('collapsed');
    }
  });

  // 移动端辅助函数：选笔记后自动关闭侧边栏
  function mobileCloseSidebar() {
    if (window.innerWidth <= 768 && dom.sidebar && !dom.sidebar.classList.contains('collapsed')) {
      dom.sidebar.classList.add('collapsed');
    }
  }

  // ─────────────────────────────────────────
  // SIDEBAR RENDERING
  // ─────────────────────────────────────────
  function getFileIcon(type) {
    const icons = {
      md:  `<svg class="file-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="1" width="12" height="14" rx="2"/><line x1="5" y1="5" x2="11" y2="5"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="11" x2="8" y2="11"/></svg>`,
      txt: `<svg class="file-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="1" width="12" height="14" rx="2"/><line x1="5" y1="5" x2="11" y2="5"/><line x1="5" y1="8" x2="9" y2="8"/></svg>`,
      pdf: `<svg class="file-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="1" width="12" height="14" rx="2"/><path d="M5 7h2a1 1 0 0 1 0 2H5V7z"/><line x1="5" y1="11" x2="9" y2="11"/></svg>`,
      img: `<svg class="file-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="3" width="14" height="10" rx="2"/><circle cx="5.5" cy="6.5" r="1.2"/><polyline points="1,12 5,8 8,11 11,8 15,12"/></svg>`,
    };
    return icons[type] || icons.txt;
  }

  function escHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000)   return '刚刚';
    if (diff < 3600000) return Math.floor(diff/60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff/3600000) + ' 小时前';
    return `${d.getMonth()+1}/${d.getDate()}`;
  }

  function renderSidebar() {
    const query = State.searchQuery.trim().toLowerCase();
    dom.fileList.innerHTML = '';

  const visibleNotes = State.notes.filter(n => {
    if (!query) return true;
    return n.name.toLowerCase().includes(query);
  });

    const totalVisible = visibleNotes.length;
    dom.sidebarEmpty.style.display = totalVisible === 0 ? '' : 'none';
    if (totalVisible === 0) { dom.fileList.appendChild(dom.sidebarEmpty); return; }

    State.folders.forEach(folder => {
      const folderNotes = visibleNotes.filter(n => n.folderId === folder.id);
      if (folderNotes.length === 0 && query) return;

      const group = document.createElement('div');
      group.className = 'folder-group';

      const header = document.createElement('div');
      header.className = 'folder-item';
      header.dataset.folderId = folder.id;
      header.innerHTML = `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" width="14" height="14">
          <path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H14a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z"/>
        </svg>
        <span>${escHtml(folder.name)}</span>
        <svg class="folder-toggle ${folder.open ? 'open' : ''}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
          <polyline points="6,4 10,8 6,12"/>
        </svg>
      `;
      header.addEventListener('click', () => toggleFolder(folder.id));
      header.addEventListener('contextmenu', (e) => showFolderCtx(e, folder.id));

      group.appendChild(header);

      // 拖拽笔记到文件夹逻辑
      group.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      group.addEventListener('dragenter', (e) => {
        e.preventDefault();
        header.classList.add('drag-over');
      });
      group.addEventListener('dragleave', (e) => {
        if (!group.contains(e.relatedTarget)) {
          header.classList.remove('drag-over');
        }
      });
      group.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        header.classList.remove('drag-over');
        const noteId = e.dataTransfer.getData('text/plain');
        if (noteId) {
          const note = State.notes.find(n => n.id === noteId);
          if (note && note.folderId !== folder.id) {
            note.folderId = folder.id;
            note.updatedAt = Date.now();
            await _writeNoteFile(noteId);
            renderSidebar();
            toast(`已移动到 ${folder.name}`, 'success');
          }
        }
      });

      const children = document.createElement('div');
      children.className = 'folder-children';
      children.style.display = folder.open ? '' : 'none';

      folderNotes.forEach(note => {
        children.appendChild(buildNoteItem(note, query));
      });

      group.appendChild(children);
      dom.fileList.appendChild(group);
    });

    const unfoldered = visibleNotes.filter(n => !n.folderId);
    unfoldered.forEach(note => {
      dom.fileList.appendChild(buildNoteItem(note, query));
    });
  }

  function buildNoteItem(note, query) {
    const el = document.createElement('div');
    el.className = `file-item file-type-${note.type === 'pdf' ? 'pdf' : (note.type === 'md' || note.type === 'txt') ? note.type : 'img'} ${State.currentId === note.id ? 'active' : ''}`;
    el.dataset.noteId = note.id;
    el.draggable = true;

    let displayName = escHtml(note.name);
    if (query) {
      const idx = note.name.toLowerCase().indexOf(query);
      if (idx !== -1) {
        displayName = escHtml(note.name.slice(0, idx))
          + `<mark class="highlight">${escHtml(note.name.slice(idx, idx+query.length))}</mark>`
          + escHtml(note.name.slice(idx+query.length));
      }
    }

    el.innerHTML = `
      ${getFileIcon(note.type === 'jpg' || note.type === 'png' || note.type === 'gif' || note.type === 'webp' || note.type === 'svg' ? 'img' : note.type)}
      <span class="file-item-name">${displayName}</span>
      <span class="file-item-date">${formatDate(note.updatedAt)}</span>
    `;

    el.addEventListener('click', () => openNote(note.id));
    el.addEventListener('contextmenu', (e) => showNoteCtx(e, note.id));

    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', note.id);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
    });

    return el;
  }

  function toggleFolder(folderId) {
    const f = State.folders.find(x => x.id === folderId);
    if (f) { f.open = !f.open; saveFolders(); renderSidebar(); }
  }

  // ─────────────────────────────────────────
  // OPEN / DISPLAY NOTE
  // ─────────────────────────────────────────
function openNote(id) {
  if (State.unsaved && State.currentId) {
    autoSave();
  }
  State.currentId = id;
  mobileCloseSidebar();
  const note = State.notes.find(n => n.id === id);
  if (!note) return;

  dom.currentName.textContent = note.name;
  setUnsaved(false);

  hideAll();

  if (note.type === 'md' || note.type === 'txt') {
    // 按需加载 content
    if (!State.noteContents[id]) {
      State.noteContents[id] = '';  // 先设空，加载后填充
      invoke('load_note', { id }).then(raw => {
        const noteData = JSON.parse(raw);
        State.noteContents[id] = noteData.content || '';
        dom.mdEditor.value = State.noteContents[id];
        updateWordCount();
        updatePreview();
      }).catch(e => console.error('load_note failed:', e));
    }
    showMarkdownEditor(note);
  } else if (note.type === 'pdf') {
    // 按需加载二进制数据
    if (!State.blobUrls[id] && !State.noteBinaries[id]) {
      // 先检查 note.content 是否是 MinIO URL
      invoke('load_note', { id }).then(async (raw) => {
        const noteData = JSON.parse(raw);
        const content = noteData.content || '';
        if (content.startsWith('http')) {
          // MinIO URL：通过后端下载 PDF 二进制（绕过 Ngrok 拦截）
          try {
            if (isTauri()) {
              const dataUrl = await invoke('fetch_ngrok_image', { url: content });
              // dataUrl 是 data:xxx;base64,... 格式
              const b64Part = dataUrl.split(',')[1] || dataUrl;
              const bytes = base64ToUint8Array(b64Part);
              State.blobUrls[id] = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
            } else {
              const resp = await fetch(content, { headers: { 'ngrok-skip-browser-warning': 'true' } });
              const blob = await resp.blob();
              State.blobUrls[id] = URL.createObjectURL(blob);
            }
            showPdfViewer(note);
          } catch (e) {
            console.error('MinIO PDF 加载失败:', e);
            toast('PDF 加载失败', 'danger');
          }
        } else {
          // 旧格式：从 .bin 文件加载 base64
          const base64 = await invoke('load_note_binary', { id });
          State.noteBinaries[id] = base64 || '';
          showPdfViewer(note);
        }
      }).catch(e => console.error('load_note failed:', e));
    } else {
      showPdfViewer(note);
    }
    dom.pdfContainer.style.display = 'flex';
  } else {
    // 图片
    if (!State.noteBinaries[id]) {
      invoke('load_note_binary', { id }).then(base64 => {
        State.noteBinaries[id] = base64 || '';
        showImageViewer(note);
      }).catch(e => console.error('load_note_binary failed:', e));
    } else {
      showImageViewer(note);
    }
    dom.imgContainer.style.display = 'flex';
  }

  renderSidebar();
}

  function hideAll() {
    dom.welcomeScreen.style.display = 'none';
    dom.mdContainer.style.display = 'none';
    dom.pdfContainer.style.display = 'none';
    dom.imgContainer.style.display = 'none';
    dom.editorToolbar.style.display = 'none';
  }

  // ─────────────────────────────────────────
  // MARKDOWN EDITOR
  // ─────────────────────────────────────────
  // 防抖保存计时器
  let saveTimer = null;
  const DEBOUNCE_MS = 1500;

  function debouncedSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (State.currentId && State.unsaved) {
        const note = State.notes.find(n => n.id === State.currentId);
        if (note && (note.type === 'md' || note.type === 'txt')) {
          State.noteContents[note.id] = dom.mdEditor.value;
          note.updatedAt = Date.now();
        }
        _writeNoteFile();
        setUnsaved(false);
      }
    }, DEBOUNCE_MS);
  }

  function showMarkdownEditor(note) {
    dom.mdContainer.style.display = 'flex';
    dom.editorToolbar.style.display = 'flex';
    dom.mdEditor.value = State.noteContents[note.id] || '';
    updateWordCount();
    updatePreview();
    applyViewMode(State.viewMode);
    dom.mdEditor.focus();
  }

  function applyViewMode(mode) {
    State.viewMode = mode;
    $$('.mode-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`btn-${mode}-mode`)?.classList.add('active');

    switch(mode) {
      case 'edit':
        dom.mdEditorWrap.style.display = 'flex';
        dom.mdEditorWrap.classList.add('full');
        dom.mdPreviewWrap.style.display = 'none';
        break;
      case 'split':
        dom.mdEditorWrap.style.display = 'flex';
        dom.mdEditorWrap.classList.remove('full');
        dom.mdPreviewWrap.style.display = '';
        updatePreview();
        break;
      case 'preview':
        dom.mdEditorWrap.style.display = 'none';
        dom.mdPreviewWrap.style.display = '';
        updatePreview();
        break;
    }
  }

  function guessMimeFromFilename(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain',
    };
    return map[ext] || 'application/octet-stream';
  }

  async function updatePreview() {
    let md = dom.mdEditor.value;

    // Replace attachment references with data URLs
    const attrRefRegex = /!\[.*?\]\((\.\/attachments\/([^/]+)\/([^)]+))\)/g;
    const matches = [...md.matchAll(attrRefRegex)];

    for (const match of matches) {
      const [fullMatch, path, noteId, filename] = match;
      const cacheKey = `${noteId}/${filename}`;

      try {
        let base64 = State.attachmentCache?.[cacheKey];
        if (!base64) {
          base64 = await invoke('get_attachment', { noteId, filename });
          if (!State.attachmentCache) State.attachmentCache = {};
          State.attachmentCache[cacheKey] = base64;
        }
        const mime = guessMimeFromFilename(filename);
        const dataUrl = `data:${mime};base64,${base64}`;
        const escaped = fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        md = md.replace(new RegExp(escaped, 'g'), `![${filename}](${dataUrl})`);
      } catch (err) {
        console.error('加载附件失败:', filename, err);
      }
    }

    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
      });
      dom.mdPreview.innerHTML = marked.parse(md);
      if (typeof hljs !== 'undefined') {
        dom.mdPreview.querySelectorAll('pre code').forEach(el => {
          hljs.highlightElement(el);
        });
      }
      // 修复 ngrok 图片：ngrok 免费版会拦截 <img> 的 GET 请求
      // Tauri 端：通过 Rust 原生 HTTP 请求绕过 CORS 和 ngrok 警告
      // Web 端：通过 fetch + ngrok-skip-browser-warning 头下载，替换为 blob URL
      dom.mdPreview.querySelectorAll('img[src*="ngrok"]').forEach(async (img) => {
        const src = img.getAttribute('src');
        if (!src || img.dataset.bypassed) return;
        img.dataset.bypassed = '1';
        try {
          if (isTauri()) {
            // Tauri 环境：使用 Rust 后端原生请求，完全绕过 CORS 和 OPTIONS 预检拦截
            const dataUrl = await invoke('fetch_ngrok_image', { url: src });
            img.src = dataUrl;
          } else {
            // Web 环境：尝试前端 fetch
            const resp = await fetch(src, { headers: { 'ngrok-skip-browser-warning': 'true' } });
            if (resp.ok) {
              const blob = await resp.blob();
              img.src = URL.createObjectURL(blob);
            }
          }
        } catch (e) {
          console.warn('ngrok 图片加载失败:', e);
        }
      });
    }
  }

  let previewTimer = null;
  function debouncedUpdatePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      updatePreview();
    }, 300);
  }

  dom.mdEditor.addEventListener('input', () => {
    updateWordCount();
    setUnsaved(true);
    debouncedSave();
    if (State.viewMode === 'split') debouncedUpdatePreview();
  });

  dom.mdEditor.addEventListener('keyup', updateCursorPos);
  dom.mdEditor.addEventListener('click', updateCursorPos);

  function updateWordCount() {
    const text = dom.mdEditor.value;
    const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    dom.wordCount.textContent = chinese > 0 ? `${chinese} 字` : `${words} 词`;
  }

  function updateCursorPos() {
    const val = dom.mdEditor.value;
    const pos = dom.mdEditor.selectionStart;
    const lines = val.substring(0, pos).split('\n');
    const line = lines.length;
    const col = lines[lines.length - 1].length + 1;
    dom.cursorPos.textContent = `第 ${line} 行，第 ${col} 列`;
  }

  // ─────────────────────────────────────────
  // VIEW MODE BUTTONS
  // ─────────────────────────────────────────
  $('#btn-edit-mode').addEventListener('click', () => applyViewMode('edit'));
  $('#btn-split-mode').addEventListener('click', () => applyViewMode('split'));
  $('#btn-preview-mode').addEventListener('click', () => {
    applyViewMode('preview');
    updatePreview();
  });

  // ─────────────────────────────────────────
  // TOOLBAR ACTIONS
  // ─────────────────────────────────────────
  $$('.tb-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      insertMarkdown(btn.dataset.action);
    });
  });

  // 使用 execCommand 插入文本，保留浏览器原生 Undo/Redo 栈
  // 这样通过工具栏插入的格式也能用 Ctrl+Z 撤回
  function _insertTextUndoable(ta, text) {
    ta.focus();
    // execCommand('insertText') 会替换当前选区并记录到 undo 栈
    if (document.execCommand) {
      document.execCommand('insertText', false, text);
    } else {
      // 极端 fallback：直接赋值（不支持撤回）
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + text + ta.value.substring(end);
      const newPos = start + text.length;
      ta.setSelectionRange(newPos, newPos);
    }
  }

  function insertMarkdown(action) {
    const ta = dom.mdEditor;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const sel = ta.value.substring(start, end);

    let before = '', after = '', insert = '';

    switch(action) {
      case 'bold':        before = '**'; after = '**'; insert = sel || '粗体文本'; break;
      case 'italic':      before = '*'; after = '*'; insert = sel || '斜体文本'; break;
      case 'strike':      before = '~~'; after = '~~'; insert = sel || '删除文本'; break;
      case 'code':        before = '`'; after = '`'; insert = sel || 'code'; break;
      case 'h1':          before = '\n# '; after = ''; insert = sel || '标题一'; break;
      case 'h2':          before = '\n## '; after = ''; insert = sel || '标题二'; break;
      case 'h3':          before = '\n### '; after = ''; insert = sel || '标题三'; break;
      case 'ul':          before = '\n- '; after = ''; insert = sel || '列表项'; break;
      case 'ol':          before = '\n1. '; after = ''; insert = sel || '列表项'; break;
      case 'quote':       before = '\n> '; after = ''; insert = sel || '引用内容'; break;
      case 'hr':          before = '\n\n---\n\n'; after = ''; insert = ''; break;
      case 'link':        before = '['; after = '](https://)'; insert = sel || '链接文字'; break;
      case 'table':
        insert = '\n| 列1 | 列2 | 列3 |\n|-----|-----|-----|\n| 内容 | 内容 | 内容 |\n';
        before = ''; after = '';
        break;
      case 'codeblock':
        insert = `\n\`\`\`javascript\n${sel || '// 代码'}\n\`\`\`\n`;
        before = ''; after = '';
        break;
      case 'image':
        if (dom.insertImageInput) dom.insertImageInput.click();
        return;
    }

    const replacement = before + insert + after;
    ta.focus();
    // 确保选区正确（选中原文本以便替换）
    ta.setSelectionRange(start, end);
    _insertTextUndoable(ta, replacement);
    setUnsaved(true);
    if (State.viewMode !== 'edit') updatePreview();
  }

  function insertTextAtCursor(text) {
    const ta = dom.mdEditor;
    ta.focus();
    _insertTextUndoable(ta, text);
    setUnsaved(true);
    if (State.viewMode !== 'edit') updatePreview();
  }

  // Insert image: handle file input change (MinIO or local attachment)
  if (dom.insertImageInput) {
    dom.insertImageInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) {
        alert('图片大小不能超过 20MB');
        return;
      }
      const noteId = State.currentId;
      if (!noteId) { alert('请先选择或创建一个笔记'); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = ev.target.result.split(',')[1];
        if (isMinioEnabled()) {
          toast('正在上传图片到 MinIO...', 'info');
          // 使用安全文件名，避免中文/特殊字符导致 S3 签名失败
          const imgExt = (file.name.split('.').pop() || 'png').toLowerCase();
          const safeImgName = Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + imgExt;
          uploadImageToMinio(noteId, safeImgName, base64, file.type)
            .then(url => {
              insertTextAtCursor(`![${file.name}](${url})`);
              toast('图片已上传到 MinIO ✓', 'success');
            })
            .catch(err => { console.error('MinIO 上传失败:', err); toast('MinIO 上传失败: ' + err, 'error'); });
        } else {
          invoke('save_attachment', { noteId, filename: file.name, binaryBase64: base64 })
            .then(() => {
              insertTextAtCursor(`![${file.name}](./attachments/${noteId}/${file.name})`);
            })
            .catch(err => { console.error('保存附件失败:', err); toast('保存图片失败: ' + err, 'error'); });
        }
        dom.insertImageInput.value = '';
      };
      reader.readAsDataURL(file);
    });
  }

  // Paste image from clipboard (MinIO or local attachment)
  dom.mdEditor.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    e.preventDefault();

    const noteId = State.currentId;
    if (!noteId) { alert('请先选择或创建一个笔记'); return; }

    imageFiles.forEach(file => {
      const ext = (file.name?.split('.').pop() || 'png');
      const filename = `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = ev.target.result.split(',')[1];
        if (isMinioEnabled()) {
          toast('正在上传图片到 MinIO...', 'info');
          uploadImageToMinio(noteId, filename, base64, file.type)
            .then(url => {
              insertTextAtCursor(`![${filename}](${url})\n`);
              toast('图片已上传到 MinIO ✓', 'success');
            })
            .catch(err => { console.error('MinIO 上传失败:', err); toast('MinIO 上传失败: ' + err, 'error'); });
        } else {
          invoke('save_attachment', { noteId, filename, binaryBase64: base64 })
            .then(() => {
              insertTextAtCursor(`![${filename}](./attachments/${noteId}/${filename})\n`);
            })
            .catch(err => { console.error('保存粘贴图片失败:', err); });
        }
      };
      reader.readAsDataURL(file);
    });
  });


  // SAVE
  // ─────────────────────────────────────────
  function setUnsaved(v) {
    State.unsaved = v;
    dom.saveStatus.textContent = v ? '未保存' : '已保存';
    dom.saveStatus.className = 'save-status ' + (v ? 'unsaved' : 'saved');
    const saveBtn = $('#btn-save');
    if (saveBtn) saveBtn.classList.toggle('unsaved', v);
  }

  async function persistCurrentNote() {
    const note = State.notes.find(n => n.id === State.currentId);
    if (!note) return;
    if (note.type === 'md' || note.type === 'txt') {
      State.noteContents[note.id] = dom.mdEditor.value;
    }
    note.updatedAt = Date.now();
    await _writeNoteFile();
    setUnsaved(false);
    renderSidebar();
    toast('已保存', 'success');
  }

  function autoSave() {
    const note = State.notes.find(n => n.id === State.currentId);
    if (!note) return;
    if (note.type === 'md' || note.type === 'txt') State.noteContents[note.id] = dom.mdEditor.value;
    note.updatedAt = Date.now();
    _writeNoteFile();
    setUnsaved(false);
  }

  $('#btn-save').addEventListener('click', persistCurrentNote);

  // ─────────────────────────────────────────
  // PDF VIEWER (使用本地 PDF.js)
  // ─────────────────────────────────────────
  let pdfJsLoaded = false;

  function loadPdfJs(cb) {
    if (pdfJsLoaded) { cb(); return; }
    const script = document.createElement('script');
    script.src = 'lib/pdfjs/pdf.min.js';
    script.onload = () => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdfjs/pdf.worker.min.js';
      pdfJsLoaded = true;
      cb();
    };
    script.onerror = () => toast('PDF.js 加载失败', 'danger');
    document.head.appendChild(script);
  }

  function showPdfViewer(note) {
    dom.pdfContainer.style.display = 'flex';
    // 从 State.noteBinaries 加载二进制数据
    if (!State.blobUrls[note.id] && State.noteBinaries[note.id]) {
      const bytes = base64ToUint8Array(State.noteBinaries[note.id]);
      State.blobUrls[note.id] = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    }
    const url = State.blobUrls[note.id];
    if (!url) { toast('PDF 文件数据丢失', 'danger'); return; }

    loadPdfJs(() => {
      pdfjsLib.getDocument(url).promise.then(pdfDoc => {
        State.pdfDoc = pdfDoc;
        State.pdfPage = 1;
        dom.pdfTotal.textContent = pdfDoc.numPages;
        dom.pdfPageInput.max = pdfDoc.numPages;
        renderPdfPage();
      }).catch(() => toast('PDF 加载失败', 'danger'));
    });
  }

  function renderPdfPage() {
    if (!State.pdfDoc) return Promise.resolve();
    return State.pdfDoc.getPage(State.pdfPage).then(page => {
      const vp = page.getViewport({ scale: State.pdfScale });
      const canvas = dom.pdfCanvas;
      const ctx = canvas.getContext('2d');
      canvas.height = vp.height;
      canvas.width  = vp.width;
      
      dom.pdfPageInput.value = State.pdfPage;
      dom.pdfZoomLevel.textContent = Math.round(State.pdfScale * 100) + '%';
      
      return page.render({ canvasContext: ctx, viewport: vp }).promise;
    });
  }

  // 优化 PDF 翻页策略 (滚轮和键盘导航)
  let isPdfRendering = false;
  
  async function turnPdfPage(delta) {
    if (!State.pdfDoc || isPdfRendering) return;
    const newPage = State.pdfPage + delta;
    if (newPage >= 1 && newPage <= State.pdfDoc.numPages) {
      isPdfRendering = true;
      State.pdfPage = newPage;
      const wrap = $('#pdf-viewer-wrap');
      await renderPdfPage();
      wrap.scrollTop = delta > 0 ? 0 : wrap.scrollHeight;
      setTimeout(() => { isPdfRendering = false; }, 500); // 防抖冷却
    }
  }

  $('#pdf-viewer-wrap').addEventListener('wheel', (e) => {
    if (!State.pdfDoc) return;
    const wrap = $('#pdf-viewer-wrap');
    const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 20;
    const atTop = wrap.scrollTop <= 20;

    if (e.deltaY > 0 && atBottom) {
      if (State.pdfPage < State.pdfDoc.numPages) {
        e.preventDefault();
        turnPdfPage(1);
      }
    } else if (e.deltaY < 0 && atTop) {
      if (State.pdfPage > 1) {
        e.preventDefault();
        turnPdfPage(-1);
      }
    }
  });

  // 键盘翻页支持 (左右方向键)
  document.addEventListener('keydown', (e) => {
    if (dom.pdfContainer.style.display !== 'flex') return;
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      turnPdfPage(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      turnPdfPage(-1);
    }
  });

  $('#pdf-prev').addEventListener('click', () => {
    if (State.pdfPage > 1) { State.pdfPage--; renderPdfPage(); }
  });
  $('#pdf-next').addEventListener('click', () => {
    if (State.pdfDoc && State.pdfPage < State.pdfDoc.numPages) { State.pdfPage++; renderPdfPage(); }
  });
  dom.pdfPageInput.addEventListener('change', () => {
    const p = parseInt(dom.pdfPageInput.value, 10);
    if (State.pdfDoc && p >= 1 && p <= State.pdfDoc.numPages) { State.pdfPage = p; renderPdfPage(); }
  });
  $('#pdf-zoom-in').addEventListener('click', () => {
    State.pdfScale = Math.min(4, +(State.pdfScale + 0.25).toFixed(2));
    renderPdfPage();
  });
  $('#pdf-zoom-out').addEventListener('click', () => {
    State.pdfScale = Math.max(0.25, +(State.pdfScale - 0.25).toFixed(2));
    renderPdfPage();
  });
  $('#pdf-fit').addEventListener('click', () => {
    const wrap = $('#pdf-viewer-wrap');
    const wrapW = wrap.clientWidth - 48;
    if (State.pdfDoc) {
      State.pdfDoc.getPage(1).then(page => {
        const vp = page.getViewport({ scale: 1 });
        State.pdfScale = +(wrapW / vp.width).toFixed(2);
        renderPdfPage();
      });
    }
  });

  // ─────────────────────────────────────────
  // IMAGE VIEWER
  // ─────────────────────────────────────────
  function showImageViewer(note) {
    dom.imgContainer.style.display = 'flex';
    // 从 State.noteBinaries 加载二进制数据
    if (!State.blobUrls[note.id] && State.noteBinaries[note.id]) {
      const bytes = base64ToUint8Array(State.noteBinaries[note.id]);
      const mimeType = note.mimeType || guessImageMime(note.type);
      State.blobUrls[note.id] = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    }
    dom.imgViewer.src = State.blobUrls[note.id] || '';
    State.imgScale = 1.0;
    updateImgZoom();
  }

  function updateImgZoom() {
    const pct = Math.round(State.imgScale * 100);
    dom.imgViewer.style.width = (pct <= 100 ? pct + '%' : 'auto') + '';
    if (pct > 100) dom.imgViewer.style.maxWidth = (State.imgScale * 100) + '%';
    dom.imgZoomLevel.textContent = pct + '%';
  }

  function guessImageMime(type) {
    const map = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml' };
    return map[type] || 'image/*';
  }

  $('#img-zoom-in').addEventListener('click', () => {
    State.imgScale = Math.min(5, +(State.imgScale + 0.25).toFixed(2)); updateImgZoom();
  });
  $('#img-zoom-out').addEventListener('click', () => {
    State.imgScale = Math.max(0.1, +(State.imgScale - 0.25).toFixed(2)); updateImgZoom();
  });
  $('#img-fit').addEventListener('click', () => {
    State.imgScale = 1.0; updateImgZoom();
  });

  // ─────────────────────────────────────────
  // CREATE NOTE / FOLDER
  // ─────────────────────────────────────────
  function createNote(name, folderId) {
    const ext = name.split('.').pop().toLowerCase();
    const type = ['md'].includes(ext) ? 'md' : 'txt';
    const finalName = name.includes('.') ? name : name + '.md';
    const id = 'n' + Date.now();
    const now = Date.now();
    const note = { id, folderId: folderId || null, name: finalName, type, content: `# ${name.replace(/\..+$/, '')}\n\n`, createdAt: now, updatedAt: now };
    State.notes.unshift(note);
    _writeNoteFile();
    saveFolders();
    renderSidebar();
    openNote(id);
    return note;
  }

  function createFolder(name) {
    const id = 'f' + Date.now();
    State.folders.push({ id, name, open: true });
    saveFolders();
    renderSidebar();
  }

  function showNewNoteModal(defaultFolder) {
    openModal('新建笔记', `
      <label style="display:block;margin-bottom:6px;font-size:13px;color:var(--text-secondary)">笔记名称</label>
      <input class="modal-input" id="modal-note-name" type="text" placeholder="我的笔记.md" value="">
      <div style="margin-top:12px">
        <label style="display:block;margin-bottom:6px;font-size:13px;color:var(--text-secondary)">保存到文件夹</label>
        <select class="modal-input" id="modal-folder-sel" style="height:36px">
          <option value="">无（根目录）</option>
          ${State.folders.map(f => `<option value="${f.id}"${defaultFolder===f.id?' selected':''}>${escHtml(f.name)}</option>`).join('')}
        </select>
      </div>
    `, [
      { label: '取消', cls: '', action: closeModal },
      { label: '创建', cls: 'primary', action: () => {
        const name = $('#modal-note-name').value.trim();
        if (!name) { toast('请输入笔记名称', 'danger'); return; }
        const folderId = $('#modal-folder-sel').value || null;
        createNote(name, folderId);
        closeModal();
      }},
    ]);
    setTimeout(() => { $('#modal-note-name').focus(); }, 80);
  }

  function showNewFolderModal() {
    openModal('新建文件夹', `
      <label style="display:block;margin-bottom:6px;font-size:13px;color:var(--text-secondary)">文件夹名称</label>
      <input class="modal-input" id="modal-folder-name" type="text" placeholder="我的文件夹" value="">
    `, [
      { label: '取消', cls: '', action: closeModal },
      { label: '创建', cls: 'primary', action: () => {
        const name = $('#modal-folder-name').value.trim();
        if (!name) { toast('请输入文件夹名称', 'danger'); return; }
        createFolder(name);
        closeModal();
      }},
    ]);
    setTimeout(() => { $('#modal-folder-name').focus(); }, 80);
  }

  $('#btn-new-note').addEventListener('click', () => showNewNoteModal(null));
  $('#btn-new-folder').addEventListener('click', showNewFolderModal);

  dom.fileList.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  dom.fileList.addEventListener('drop', async (e) => {
    e.preventDefault();
    const noteId = e.dataTransfer.getData('text/plain');
    if (noteId) {
      const note = State.notes.find(n => n.id === noteId);
      if (note && note.folderId !== null) {
        note.folderId = null;
        note.updatedAt = Date.now();
        await _writeNoteFile(noteId);
        renderSidebar();
        toast('已移动到根目录', 'success');
      }
    }
  });
  $('#btn-welcome-new').addEventListener('click', () => showNewNoteModal(null));
  $('#btn-welcome-import').addEventListener('click', () => {
    dom.fileInput.click();
  });

  // ─────────────────────────────────────────
  // IMPORT — 导入文件（统一使用 file input，非阻塞）
  // ─────────────────────────────────────────
  $('#btn-import').addEventListener('click', () => {
    dom.fileInput.click();
  });

  // 辅助函数：将 Base64 解码为 UTF-8 字符串
  // atob() 返回 Latin-1 编码的二进制字符串，中文等多字节字符会乱码。
  // 需要先用 TextDecoder('utf-8') 正确解码。
  function base64ToUtf8(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // 辅助函数：将 Base64 解码为 Uint8Array
  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }



  // ArrayBuffer → Base64 编码
  function arrayBufferToBase64(ab) {
    let binary = "";
    const bytes = new Uint8Array(ab);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // 文件导入（统一处理所有文件类型，Tauri 和 Web 共用）
  dom.fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      await importFileByType(file);
    }
    dom.fileInput.value = '';
  });

  async function importFileByType(file) {
    const name = file.name;
    const ext  = name.split('.').pop().toLowerCase();
    const id   = 'n' + Date.now() + Math.random().toString(36).slice(2,5);
    const now  = Date.now();

    let note;

    if (ext === 'md' || ext === 'txt') {
      const text = await file.text();
      note = { id, folderId: null, name, type: ext, content: text, createdAt: now, updatedAt: now };
      State.notes.unshift(note);
      State.noteContents[id] = text;
      await invoke('save_note', { noteJson: JSON.stringify({ id, folderId: null, name, type: ext, content: text, createdAt: now, updatedAt: now }), binaryBase64: '' });
    } else if (ext === 'pdf') {
      const ab = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(ab);
      const blob = new Blob([ab], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);

      let pdfContentUrl = ''; // MinIO URL or empty
      if (isMinioEnabled()) {
        // 上传 PDF 到 MinIO，content 存储 URL
        try {
          toast('正在上传 PDF 到 MinIO...', 'info');
         // 使用安全文件名（时间戳+扩展名），避免中文/特殊字符导致 S3 签名失败
          const safeFilename = Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
          pdfContentUrl = await uploadImageToMinio(id, safeFilename, base64, 'application/pdf');
          toast('PDF 已上传到 MinIO', 'success');
        } catch (e) {
          console.error('MinIO PDF 上传失败，回退到本地存储:', e);
          toast('MinIO 上传失败，使用本地存储', 'warning');
          pdfContentUrl = '';
        }
      }

      note = { id, folderId: null, name, type: 'pdf', blobUrl, createdAt: now, updatedAt: now };
      State.notes.unshift(note);
      State.noteBinaries[id] = base64;
      State.blobUrls[id] = blobUrl;
      // MinIO 成功时 content 存 URL（同步时只传 URL），否则 binaryBase64 存本地
      await invoke('save_note', {
        noteJson: JSON.stringify({ id, folderId: null, name, type: 'pdf', content: pdfContentUrl, createdAt: now, updatedAt: now }),
        binaryBase64: pdfContentUrl ? '' : base64
      });
    } else if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) {
      const ab = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(ab);
      const mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml' };
      const blob = new Blob([ab], { type: mimeMap[ext] || 'image/*' });
      const blobUrl = URL.createObjectURL(blob);
      note = { id, folderId: null, name, type: ext, blobUrl, createdAt: now, updatedAt: now };
      State.notes.unshift(note);
      State.noteBinaries[id] = base64;
      State.blobUrls[id] = blobUrl;
      await invoke('save_note', { noteJson: JSON.stringify({ id, folderId: null, name, type: ext, content: '', createdAt: now, updatedAt: now }), binaryBase64: base64 });
    } else {
      toast(`不支持的文件类型: .${ext}`, 'danger');
      return;
    }

    renderSidebar();
    openNote(id);
    toast(`已导入 ${name}`, 'success');
  }

  async function importAndOpenPath(path) {
    try {
      const fileData = await invoke('read_file_by_path', { path });
      const name = fileData.name;
      const ext  = name.split('.').pop().toLowerCase();
      const id   = 'n' + Date.now() + Math.random().toString(36).slice(2,5);
      const now  = Date.now();

      let note;

      if (ext === 'md' || ext === 'txt') {
        const text = base64ToUtf8(fileData.contentBase64);
        note = { id, folderId: null, name, type: ext, content: text, createdAt: now, updatedAt: now };
        State.notes.unshift(note);
        State.noteContents[id] = text;
        await invoke('save_note', { noteJson: JSON.stringify({ id, folderId: null, name, type: ext, content: text, createdAt: now, updatedAt: now }), binaryBase64: '' });
      } else if (ext === 'pdf') {
        const base64 = fileData.contentBase64;
        const bytes = base64ToUint8Array(base64);
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const blobUrl = URL.createObjectURL(blob);

        let pdfContentUrl = '';
        if (isMinioEnabled()) {
          try {
            toast('正在上传 PDF 到 MinIO...', 'info');
            const safeFilename = Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
            pdfContentUrl = await uploadImageToMinio(id, safeFilename, base64, 'application/pdf');
            toast('PDF 已上传到 MinIO', 'success');
          } catch (e) {
            console.error('MinIO PDF 上传失败，回退到本地存储:', e);
            toast('MinIO 上传失败，使用本地存储', 'warning');
            pdfContentUrl = '';
          }
        }

        note = { id, folderId: null, name, type: 'pdf', blobUrl, createdAt: now, updatedAt: now };
        State.notes.unshift(note);
        State.noteBinaries[id] = base64;
        State.blobUrls[id] = blobUrl;
        await invoke('save_note', {
          noteJson: JSON.stringify({ id, folderId: null, name, type: 'pdf', content: pdfContentUrl, createdAt: now, updatedAt: now }),
          binaryBase64: pdfContentUrl ? '' : base64
        });
      } else if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) {
        const base64 = fileData.contentBase64;
        const bytes = base64ToUint8Array(base64);
        const mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml' };
        const blob = new Blob([bytes], { type: mimeMap[ext] || 'image/*' });
        const blobUrl = URL.createObjectURL(blob);
        note = { id, folderId: null, name, type: ext, blobUrl, createdAt: now, updatedAt: now };
        State.notes.unshift(note);
        State.noteBinaries[id] = base64;
        State.blobUrls[id] = blobUrl;
        await invoke('save_note', { noteJson: JSON.stringify({ id, folderId: null, name, type: ext, content: '', createdAt: now, updatedAt: now }), binaryBase64: base64 });
      } else {
        toast(`不支持的文件类型: .${ext}`, 'danger');
        return;
      }

      renderSidebar();
      openNote(id);
      toast(`已导入并打开 ${name}`, 'success');
    } catch (e) {
      console.error('importAndOpenPath failed:', e);
      toast('无法打开该文件: ' + e, 'danger');
    }
  }

  // ─────────────────────────────────────────
  // CONTEXT MENU
  // ─────────────────────────────────────────
  function showNoteCtx(e, noteId) {
    e.preventDefault();
    const note = State.notes.find(n => n.id === noteId);
    if (!note) return;
    const items = [
      {
        icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 11l7-9 4 4-9 7-2 0 0-2z"/></svg>`,
        label: '重命名',
        action: () => showRenameModal(noteId),
      },
      {
        icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 3h4l1.5 1.5H14v8H2V3z"/><path d="M8 6v4M6 8l2 2 2-2"/></svg>`,
        label: '移动到...',
        action: () => showMoveNoteModal(noteId),
      },
      {
        icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 5h8v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5z"/><path d="M2 5h12M7 3h2a1 1 0 0 1 1 1v1H6V4a1 1 0 0 1 1-1z"/></svg>`,
        label: '删除',
        action: () => confirmDeleteNote(noteId),
        danger: true,
      },
    ];
    if (note.type === 'md' || note.type === 'txt') {
      items.unshift({
        icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 5l-3-3H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5z"/></svg>`,
        label: '下载',
        action: () => downloadNote(noteId),
      });
    }
    showCtxMenu(e, items);
  }

  function showMoveNoteModal(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note) return;
    openModal('移动笔记', `
      <div style="margin-top:12px">
        <label style="display:block;margin-bottom:6px;font-size:13px;color:var(--text-secondary)">选择目标文件夹</label>
        <select class="modal-input" id="modal-move-folder-sel" style="height:36px">
          <option value="">无（根目录）</option>
          ${State.folders.map(f => `<option value="${f.id}"${note.folderId===f.id?' selected':''}>${escHtml(f.name)}</option>`).join('')}
        </select>
      </div>
    `, [
      { label: '取消', cls: '', action: closeModal },
      { label: '移动', cls: 'primary', action: async () => {
        const folderId = $('#modal-move-folder-sel').value || null;
        note.folderId = folderId;
        note.updatedAt = Date.now();
        await _writeNoteFile(noteId);
        renderSidebar();
        closeModal();
        toast('笔记已移动', 'success');
      }},
    ]);
  }

  function showFolderCtx(e, folderId) {
    e.preventDefault();
    const folder = State.folders.find(f => f.id === folderId);
    if (!folder) return;
    showCtxMenu(e, [
      {
        icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 11l7-9 4 4-9 7-2 0 0-2z"/></svg>`,
        label: '重命名',
        action: () => showRenameFolderModal(folderId),
      },
      {
        icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="12" height="12" rx="2"/><line x1="9" y1="3" x2="9" y2="13"/></svg>`,
        label: '在此新建笔记',
        action: () => showNewNoteModal(folderId),
      },
      { sep: true },
      {
        icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 5h8v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5z"/></svg>`,
        label: '删除文件夹',
        action: () => confirmDeleteFolder(folderId),
        danger: true,
      },
    ]);
  }

  function showCtxMenu(e, items) {
    const menu = dom.contextMenu;
    dom.contextList.innerHTML = '';
    items.forEach(item => {
      if (item.sep) {
        const sep = document.createElement('li');
        sep.className = 'ctx-sep';
        dom.contextList.appendChild(sep);
        return;
      }
      const li = document.createElement('li');
      li.className = 'ctx-item' + (item.danger ? ' danger' : '');
      li.innerHTML = (item.icon || '') + `<span>${escHtml(item.label)}</span>`;
      li.addEventListener('click', () => { closeCtxMenu(); item.action(); });
      dom.contextList.appendChild(li);
    });

    menu.style.display = '';
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - items.length * 36 - 16);
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
  }

  function closeCtxMenu() { dom.contextMenu.style.display = 'none'; }

  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeCtxMenu(); closeModal(); }
  });

  // ─────────────────────────────────────────
  // RENAME / DELETE
  // ─────────────────────────────────────────
  function showRenameModal(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note) return;
    openModal('重命名笔记', `
      <input class="modal-input" id="modal-rename-input" type="text" value="${escHtml(note.name)}">
    `, [
      { label: '取消', cls: '', action: closeModal },
      { label: '确认', cls: 'primary', action: async () => {
        const name = $('#modal-rename-input').value.trim();
        if (!name) return;
        note.name = name;
        note.updatedAt = Date.now();
        await _writeNoteFile();
        if (State.currentId === noteId) dom.currentName.textContent = name;
        renderSidebar();
        closeModal();
      }},
    ]);
    setTimeout(() => { const i = $('#modal-rename-input'); if(i){ i.focus(); i.select(); } }, 80);
  }

  function showRenameFolderModal(folderId) {
    const folder = State.folders.find(f => f.id === folderId);
    if (!folder) return;
    openModal('重命名文件夹', `
      <input class="modal-input" id="modal-rename-input" type="text" value="${escHtml(folder.name)}">
    `, [
      { label: '取消', cls: '', action: closeModal },
      { label: '确认', cls: 'primary', action: () => {
        const name = $('#modal-rename-input').value.trim();
        if (!name) return;
        folder.name = name;
        saveFolders();
        renderSidebar();
        closeModal();
      }},
    ]);
    setTimeout(() => { const i = $('#modal-rename-input'); if(i){ i.focus(); i.select(); } }, 80);
  }

  function confirmDeleteNote(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note) return;
    openModal('确认删除', `
      <p style="font-size:14px;color:var(--text-secondary);line-height:1.7">
        确定要删除笔记 <strong>${escHtml(note.name)}</strong> 吗？此操作无法撤销。
      </p>
    `, [
      { label: '取消', cls: '', action: closeModal },
      { label: '删除', cls: 'danger', action: async () => {
        // 清理附件目录
        try { await invoke('delete_note_attachments', { noteId }); } catch(e) { console.error('delete_note_attachments failed:', e); }
        // 删除笔记文件（后端处理）
        try { await invoke('delete_note', { id: noteId }); } catch(e) { console.error('delete_note failed:', e); }
        // 清理前端缓存
        State.notes = State.notes.filter(n => n.id !== noteId);
        delete State.noteContents[noteId];
        delete State.noteBinaries[noteId];
        if (State.blobUrls[noteId]) { URL.revokeObjectURL(State.blobUrls[noteId]); delete State.blobUrls[noteId]; }
        if (State.currentId === noteId) {
          State.currentId = null;
          hideAll();
          dom.welcomeScreen.style.display = '';
          dom.currentName.textContent = '未打开文件';
          setUnsaved(false);
        }
        renderSidebar();
        closeModal();
        toast('已删除', 'success');
      }},
    ]);
  }

  function confirmDeleteFolder(folderId) {
    const folder = State.folders.find(f => f.id === folderId);
    if (!folder) return;
    const count = State.notes.filter(n => n.folderId === folderId).length;
    openModal('确认删除文件夹', `
      <p style="font-size:14px;color:var(--text-secondary);line-height:1.7">
        确定要删除文件夹 <strong>${escHtml(folder.name)}</strong> 吗？
        ${count > 0 ? `<br>其中 ${count} 篇笔记将移到根目录。` : ''}
      </p>
    `, [
      { label: '取消', cls: '', action: closeModal },
      { label: '删除', cls: 'danger', action: async () => {
        // 将该文件夹下的笔记移到根目录，并更新后端索引
        const affected = State.notes.filter(n => n.folderId === folderId);
        affected.forEach(n => { n.folderId = null; });
        if (affected.length > 0) {
          for (const n of affected) {
            try { await _writeNoteFile(n.id); } catch(e) { console.error('update note folder failed:', e); }
          }
        }
        State.folders = State.folders.filter(f => f.id !== folderId);
        saveFolders();
        renderSidebar();
        closeModal();
        toast('文件夹已删除', 'success');
      }},
    ]);
  }

  // ─────────────────────────────────────────
  // DOWNLOAD / EXPORT — 导出笔记
  // ─────────────────────────────────────────
  async function downloadNote(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note) return;
    const content = note.type === 'md' || note.type === 'txt'
      ? (State.currentId === noteId ? dom.mdEditor.value : (State.noteContents[noteId] || ''))
      : '';

    if (isTauri()) {
      try {
        await invoke('export_file', { content, defaultName: note.name });
        toast(`已保存 ${note.name}`, 'success');
      } catch(e) {
        if (e !== '用户取消了保存') {
          toast(`保存失败: ${e}`, 'danger');
        }
      }
    } else {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = note.name;
      a.click();
      toast(`下载 ${note.name}`, 'success');
    }
  }

  // ─────────────────────────────────────────
  // SEARCH
  // ─────────────────────────────────────────
  dom.searchInput.addEventListener('input', () => {
    State.searchQuery = dom.searchInput.value;
    renderSidebar();
  });

  // ─────────────────────────────────────────
  // KEYBOARD SHORTCUTS
  // ─────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      switch(e.key.toLowerCase()) {
        case 's':
          e.preventDefault();
          _writeNoteFile();
          break;
        case 'b':
          if (State.currentId && isEditing()) { e.preventDefault(); insertMarkdown('bold'); }
          break;
        case 'i':
          if (State.currentId && isEditing()) { e.preventDefault(); insertMarkdown('italic'); }
          break;
        case '/':
          if (State.currentId) {
            e.preventDefault();
            const next = State.viewMode === 'preview' ? 'edit' : 'preview';
            applyViewMode(next);
          }
          break;
      }
    }
    if (e.ctrlKey && e.key === 'd') {
      if (isEditing()) {
        e.preventDefault();
        deleteCurrentLine();
      }
    }
  });

  function isEditing() {
    const note = State.notes.find(n => n.id === State.currentId);
    return note && (note.type === 'md' || note.type === 'txt') && State.viewMode !== 'preview';
  }

  function deleteCurrentLine() {
    const ta = dom.mdEditor;
    const val = ta.value;
    const start = ta.selectionStart;
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = val.indexOf('\n', start);
    const end = lineEnd === -1 ? val.length : lineEnd + 1;
    const newVal = val.substring(0, lineStart) + val.substring(end);
    ta.value = newVal;
    ta.setSelectionRange(lineStart, lineStart);
    setUnsaved(true);
    if (State.viewMode !== 'edit') updatePreview();
  }

  // Tab key in editor
  dom.mdEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = dom.mdEditor.selectionStart;
      const end   = dom.mdEditor.selectionEnd;
      dom.mdEditor.value = dom.mdEditor.value.substring(0, start) + '  ' + dom.mdEditor.value.substring(end);
      dom.mdEditor.setSelectionRange(start + 2, start + 2);
      setUnsaved(true);
    }
  });

  // ─────────────────────────────────────────
  // MODAL
  // ─────────────────────────────────────────
  function openModal(title, bodyHtml, buttons) {
    dom.modalTitle.textContent = title;
    dom.modalBody.innerHTML = bodyHtml;
    dom.modalFooter.innerHTML = '';
    buttons.forEach(btn => {
      const b = document.createElement('button');
      b.className = `modal-btn ${btn.cls || ''}`;
      b.textContent = btn.label;
      b.addEventListener('click', btn.action);
      dom.modalFooter.appendChild(b);
    });
    dom.modalOverlay.style.display = 'flex';
  }

  function closeModal() { dom.modalOverlay.style.display = 'none'; }

  $('#modal-close').addEventListener('click', closeModal);
  dom.modalOverlay.addEventListener('click', (e) => { if (e.target === dom.modalOverlay) closeModal(); });

  dom.modalOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const primary = dom.modalFooter.querySelector('.primary');
      if (primary) primary.click();
    }
  });

  // ─────────────────────────────────────────
  // TOAST
  // ─────────────────────────────────────────
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = `toast ${type || ''}`;
    el.textContent = msg;
    $('#toast-container').appendChild(el);
    setTimeout(() => {
      el.classList.add('fade-out');
      setTimeout(() => el.remove(), 250);
    }, 2000);
  }

  // ─────────────────────────────────────────
  // DRAG & DROP — 拖拽导入
  // ─────────────────────────────────────────
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) await importFileByType(file);
  });

  // ─────────────────────────────────────────
  // SYNC PANEL — 云同步
  // ─────────────────────────────────────────
  const SyncPanel = {
    panel: null,
    logEl: null,

    init() {
      this.panel = $('#sync-panel');
      this.logEl = $('#sync-log');
      $('#btn-cloud-sync').addEventListener('click', () => this.open());
      $('#sync-panel-close').addEventListener('click', () => this.close());
      $('#btn-test-token').addEventListener('click', () => this.testConnection());
      $('#btn-save-sync').addEventListener('click', () => this.saveConfig());
      $('#btn-sync-upload').addEventListener('click', () => this.upload());
      $('#btn-sync-download').addEventListener('click', () => this.download());
      // 平台切换时更新 placeholder
      $('#sync-platform').addEventListener('change', () => this.updatePlatformLabels());
      this.loadConfig();
    },

    open() {
      this.panel.style.display = 'flex';
      const plat = $('#sync-platform').value === 'github' ? 'GitHub' : 'Gitee';
      this.log(`就绪 — 当前平台：${plat}，请配置令牌和仓库信息`);
    },

    close() {
      this.panel.style.display = 'none';
    },

    log(msg) {
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this.logEl.textContent += `[${time}] ${msg}\n`;
      this.logEl.scrollTop = this.logEl.scrollHeight;
    },

    clearLog() {
      this.logEl.textContent = '';
    },

    updatePlatformLabels() {
      const isGH = $('#sync-platform').value === 'github';
      $('#sync-token').placeholder = isGH ? '输入 GitHub Personal Access Token' : '输入 Gitee Access Token';
      $('#sync-owner').placeholder = isGH ? '你的 GitHub 用户名' : '你的 Gitee 用户名';
    },

    async loadConfig() {
      try {
        const res = await invoke('load_sync_config');
        if (res) {
          const cfg = JSON.parse(res);
          $('#sync-token').value = cfg.token || '';
          $('#sync-owner').value = cfg.owner || '';
          $('#sync-repo').value = cfg.repo || '';
          if (cfg.platform) {
            $('#sync-platform').value = cfg.platform;
          }
          this.updatePlatformLabels();
        }
      } catch (e) { /* 无配置时忽略 */ }
    },

    async testConnection() {
      const token = $('#sync-token').value.trim();
      const platform = $('#sync-platform').value;
      const platName = platform === 'github' ? 'GitHub' : 'Gitee';
      if (!token) { this.log(`❌ 请先输入 ${platName} 令牌`); return; }
      this.log(`🔄 正在测试 ${platName} 连接...`);
      try {
        const res = await invoke('test_gitee_connection', { token, platform });
        const user = JSON.parse(res);
        this.log(`✅ ${platName} 连接成功！用户：${user.name || user.login}`);
      } catch (e) {
        this.log(`❌ 连接失败：${e}`);
      }
    },

    async saveConfig() {
      const token = $('#sync-token').value.trim();
      const owner = $('#sync-owner').value.trim();
      const repo = $('#sync-repo').value.trim();
      const platform = $('#sync-platform').value;
      if (!token || !owner || !repo) {
        this.log('❌ Token、用户名和仓库名均为必填项');
        return;
      }
      this.log('💾 正在保存配置...');
      try {
        await invoke('save_sync_config', {
          configJson: JSON.stringify({ platform, token, owner, repo, path: '' })
        });
        this.log('✅ 配置已保存');
      } catch (e) {
        this.log(`❌ 保存失败：${e}`);
      }
    },

    async upload() {
      this.clearLog();
      const platName = $('#sync-platform').value === 'github' ? 'GitHub' : 'Gitee';
      this.log(`📤 正在推送笔记到 ${platName}...`);
      try {
        if (State.currentId) await _writeNoteFile();
        const res = await invoke('sync_to_gitee');
        const result = JSON.parse(res);
        if (result.success) {
          this.log(`✅ 推送成功！${result.message}`);
        } else {
          this.log(`❌ 推送失败：${result.message}`);
        }
      } catch (e) {
        this.log(`❌ 推送出错：${e}`);
      }
    },

    async download() {
      this.clearLog();
      const platName = $('#sync-platform').value === 'github' ? 'GitHub' : 'Gitee';
      this.log(`📥 正在从 ${platName} 拉取笔记...`);
      try {
        const res = await invoke('sync_from_gitee');
        const result = JSON.parse(res);
        if (result.success) {
          if (isTauri()) {
            // Tauri 端：result.message 包含完整的笔记 JSON 数据，需要 import_all_data 写入文件
            await invoke('import_all_data', { data: result.message });
          }
          // Web 端：sync_from_gitee 已直接写入 IndexedDB，无需二次导入
          // 重新加载所有数据
          await loadFromStorage();
          renderSidebar();
          this.log('✅ 拉取成功！笔记已更新');
          if (State.notes.length > 0) {
            openNote(State.notes[0].id);
          }
        } else {
          this.log(`❌ 拉取失败：${result.message}`);
        }
      } catch (e) {
        this.log(`❌ 拉取出错：${e}`);
      }
    }
  };

  // ─────────────────────────────────────────
  // STORAGE PANEL — 存储位置设置
  // ─────────────────────────────────────────
  const StoragePanel = {
    panel: null,
    logEl: null,

    init() {
      console.log('[NoteFlow] StoragePanel.init() called');
      this.panel = document.getElementById('storage-panel');
      this.logEl = document.getElementById('storage-log');
      const btn = document.getElementById('btn-storage-settings');
      const closeBtn = document.getElementById('storage-panel-close');
      const selectBtn = document.getElementById('btn-select-storage-dir');
      const resetBtn = document.getElementById('btn-reset-storage-dir');

      if (btn) {
        btn.addEventListener('click', () => {
          console.log('[NoteFlow] Storage button clicked');
          this.open();
        });
      } else {
        console.error('[NoteFlow] btn-storage-settings NOT found!');
      }
      if (closeBtn) closeBtn.addEventListener('click', () => this.close());
      if (selectBtn) selectBtn.addEventListener('click', () => this.selectDir());
      if (resetBtn) resetBtn.addEventListener('click', () => this.resetDir());
    },

    open() {
      if (this.panel) this.panel.style.display = 'flex';
      this.refreshPaths();
    },

    close() {
      if (this.panel) this.panel.style.display = 'none';
    },

    log(msg) {
      if (this.logEl) {
        this.logEl.textContent += msg + '\n';
        this.logEl.scrollTop = this.logEl.scrollHeight;
      }
    },

    clearLog() {
      if (this.logEl) this.logEl.textContent = '';
    },

    async refreshPaths() {
      try {
        const current = await invoke('get_data_directory');
        const def = await invoke('get_default_data_directory');
        const currentEl = document.getElementById('storage-current-dir');
        const defaultEl = document.getElementById('storage-default-dir');
        if (currentEl) {
          currentEl.textContent = (current === def) ? current + '  (默认)' : current;
        }
        if (defaultEl) {
          defaultEl.textContent = def;
        }
      } catch(e) {
        const currentEl = document.getElementById('storage-current-dir');
        if (currentEl) currentEl.textContent = '获取失败: ' + e;
        console.error('[NoteFlow] refreshPaths failed:', e);
      }
    },

    async selectDir() {
      this.clearLog();
      this.log('正在打开目录选择器...');
      try {
        const result = await invoke('select_data_directory');
        if (result === null || result === undefined) {
          this.log('已取消选择');
          return;
        }
        const selectedDir = (typeof result === 'string') ? result : '';
        if (!selectedDir) {
          this.log('未选择目录');
          return;
        }
        this.log('已选择: ' + selectedDir);
        this.log('正在保存配置...');
        await invoke('set_data_directory', { newDir: selectedDir });
        this.log('✅ 存储位置已更改！');
        this.log('⚠️ 请重启应用以使更改完全生效');
        await this.refreshPaths();
      } catch(e) {
        this.log('❌ 设置失败: ' + e);
        console.error('[NoteFlow] selectDir failed:', e);
      }
    },

    async resetDir() {
      this.clearLog();
      this.log('正在恢复默认存储位置...');
      try {
        await invoke('set_data_directory', { newDir: null });
        this.log('✅ 已恢复默认目录');
        this.log('⚠️ 请重启应用以使更改完全生效');
        await this.refreshPaths();
      } catch(e) {
        this.log('❌ 恢复失败: ' + e);
        console.error('[NoteFlow] resetDir failed:', e);
      }
    }
  };

  // ─────────────────────────────────────────
  // MINIO 图片存储
  // ─────────────────────────────────────────

  // MinIO 默认配置（硬编码，用户无需手动配置）
  const MINIO_DEFAULTS = {
    endpoint: 'https://pedometer-dweller-encounter.ngrok-free.dev',
    bucket:   'noteflow-images',
    accessKey: 'admin_minio',
    secretKey: 'admin_minio',
    enabled:  true,
    region:   'us-east-1',
  };

  async function loadMinioConfig() {
    try {
      const raw = await invoke('load_minio_config');
      if (raw) {
        const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // Rust 返回下划线字段，统一转驼峰存入 State
        State.minioConfig = {
          endpoint: cfg.endpoint || MINIO_DEFAULTS.endpoint,
          bucket:   cfg.bucket   || MINIO_DEFAULTS.bucket,
          accessKey: cfg.access_key || cfg.accessKey || MINIO_DEFAULTS.accessKey,
          secretKey: cfg.secret_key || cfg.secretKey || MINIO_DEFAULTS.secretKey,
          enabled:  (cfg.enabled !== undefined) ? cfg.enabled : MINIO_DEFAULTS.enabled,
          region:   cfg.region   || MINIO_DEFAULTS.region,
        };
      } else {
        // 无已保存配置时，使用默认值
        State.minioConfig = { ...MINIO_DEFAULTS };
      }
    } catch(e) {
      // 出错时也使用默认值，确保 MinIO 始终可用
      State.minioConfig = { ...MINIO_DEFAULTS };
    }
  }

  function isMinioEnabled() {
    const c = State.minioConfig;
    return !!(c && c.enabled && c.endpoint && c.bucket && c.accessKey && c.secretKey);
  }

  /**
   * 上传文件到 MinIO，返回公开 URL
   * key 格式：images/{filename} 或 pdfs/{filename}（由 contentType 决定）
   * Tauri 端走后端签名，Web 端用浏览器 fetch + AWS V4 签名
   */
  async function uploadImageToMinio(noteId, filename, base64, contentType) {
    if (isTauri()) {
      const url = await invoke('upload_to_minio', {
        noteId: noteId,
        filename: filename,
        binaryBase64: base64,
        contentType: contentType
      });
      return url;
    }
    // Web 端：浏览器端 AWS V4 签名
    const cfg = State.minioConfig;
    // 按类型分目录：pdfs/ 或 images/
    const folder = contentType.includes('pdf') ? 'pdfs' : 'images';
    const objectKey = folder + '/' + filename;
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const url = cfg.endpoint + '/' + cfg.bucket + '/' + objectKey;
    const signed = await signV4('PUT', url, binary, cfg);
    const resp = await fetch(signed.url, {
      method: 'PUT', headers: signed.headers, body: binary
    });
    if (!resp.ok) throw new Error('MinIO 上传失败: ' + resp.status);
    return cfg.endpoint + '/' + cfg.bucket + '/' + objectKey;
  }

  // 浏览器端 AWS Signature V4 签名
  async function signV4(method, url, payload, cfg) {
    const u = new URL(url);
    const region = cfg.region || 'us-east-1';
    const service = 's3';
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const dateDay = dateStamp.substring(0, 8);
    const scope = dateDay + '/' + region + '/' + service + '/aws4_request';

    const hashPayload = await sha256Hex(payload);
    const canonicalUri = encodeURI(u.pathname).replace(/%2F/g, '/');
    const canonicalQuery = u.search || '';
    const canonicalHeaders = 'content-type:' + (payload ? 'application/octet-stream' : '') + '\nhost:' + u.host + '\nx-amz-content-sha256:' + hashPayload + '\nx-amz-date:' + dateStamp + '\n';
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = method + '\n' + canonicalUri + '\n' + canonicalQuery + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + hashPayload;
    const stringToSign = 'AWS4-HMAC-SHA256\n' + dateStamp + '\n' + scope + '\n' + (await sha256Hex(canonicalRequest));

    let kDate = await hmacSha256('AWS4' + cfg.secretKey, dateDay);
    let kRegion = await hmacSha256(kDate, region);
    let kService = await hmacSha256(kRegion, service);
    let kSigning = await hmacSha256(kService, 'aws4_request');
    const sig = await hmacSha256Hex(kSigning, stringToSign);
    const credential = cfg.accessKey + '/' + scope;
    const auth = 'AWS4-HMAC-SHA256 Credential=' + credential + ', SignedHeaders=' + signedHeaders + ', Signature=' + sig;
    return {
      url: url,
      headers: { 'Authorization': auth, 'x-amz-content-sha256': hashPayload, 'x-amz-date': dateStamp, 'Content-Type': 'application/octet-stream' }
    };
  }

  async function sha256Hex(data) {
    const buf = (typeof data === 'string') ? new TextEncoder().encode(data) : data;
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function hmacSha256(key, msg) {
    const k = (typeof key === 'string') ? new TextEncoder().encode(key) : key;
    const m = new TextEncoder().encode(msg);
    const ck = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return await crypto.subtle.sign('HMAC', ck, m);
  }

  async function hmacSha256Hex(key, msg) {
    const sig = await hmacSha256(key, msg);
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // MinIO 设置面板
  const MinioPanel = {
    panel: null,
    logEl: null,

    init() {
      this.panel = document.getElementById('minio-panel');
      this.logEl = document.getElementById('minio-log');
      const btn = document.getElementById('btn-minio-settings');
      const closeBtn = document.getElementById('minio-panel-close');
      const testBtn = document.getElementById('minio-test-btn');
      const saveBtn = document.getElementById('minio-save-btn');

      if (btn) btn.addEventListener('click', () => this.open());
      if (closeBtn) closeBtn.addEventListener('click', () => this.close());
      if (testBtn) testBtn.addEventListener('click', () => this.testConnection());
      if (saveBtn) saveBtn.addEventListener('click', () => this.saveConfig());
    },

    open() {
      if (this.panel) this.panel.style.display = 'flex';
      // 从 State 填充表单
      const cfg = State.minioConfig || {};
      document.getElementById('minio-enabled').checked = !!cfg.enabled;
      document.getElementById('minio-endpoint').value = cfg.endpoint || 'https://pedometer-dweller-encounter.ngrok-free.dev';
      document.getElementById('minio-bucket').value = cfg.bucket || 'noteflow-images';
      document.getElementById('minio-access-key').value = cfg.accessKey || '';
      document.getElementById('minio-secret-key').value = cfg.secretKey || '';
      document.getElementById('minio-region').value = cfg.region || 'us-east-1';
      if (this.logEl) this.logEl.textContent = '';
    },

    close() {
      if (this.panel) this.panel.style.display = 'none';
    },

    log(msg) {
      if (this.logEl) {
        this.logEl.textContent += msg + '\n';
        this.logEl.scrollTop = this.logEl.scrollHeight;
      }
    },

    async testConnection() {
      if (this.logEl) this.logEl.textContent = '';
      this.log('正在测试连接...');
      const endpoint = document.getElementById('minio-endpoint').value.trim();
      const bucket = document.getElementById('minio-bucket').value.trim();
      const accessKey = document.getElementById('minio-access-key').value.trim();
      const secretKey = document.getElementById('minio-secret-key').value.trim();
      const region = document.getElementById('minio-region').value.trim() || 'us-east-1';
      try {
        const ok = await invoke('test_minio_connection', {
          configJson: JSON.stringify({ endpoint, bucket, access_key: accessKey, secret_key: secretKey, enabled: true, region })
        });
        this.log(ok ? '✅ 连接成功！' : '❌ 连接失败');
      } catch(e) {
        this.log('❌ 连接失败: ' + e);
      }
    },

    async saveConfig() {
      if (this.logEl) this.logEl.textContent = '';
      const accessKey = document.getElementById('minio-access-key').value.trim();
      const secretKey = document.getElementById('minio-secret-key').value.trim();
      const config = {
        enabled: document.getElementById('minio-enabled').checked,
        endpoint: document.getElementById('minio-endpoint').value.trim(),
        bucket: document.getElementById('minio-bucket').value.trim(),
        access_key: accessKey,
        secret_key: secretKey,
        region: document.getElementById('minio-region').value.trim() || 'us-east-1'
      };
      try {
        await invoke('save_minio_config', { configJson: JSON.stringify(config) });
        // 内存中 State.minioConfig 仍用驼峰字段，方便前端读取
        State.minioConfig = { ...config, accessKey, secretKey };
        this.log('✅ 配置已保存' + (config.enabled ? '（MinIO 已启用）' : '（MinIO 已禁用）'));
      } catch(e) {
        this.log('❌ 保存失败: ' + e);
      }
    }
  };

  // ─────────────────────────────────────────
  // CLOSE GUARD — 关闭窗口前强制保存未保存内容
  // 策略：不拦截关闭事件（避免窗口关不掉的问题），
  //       改为每次 input 时同步写入 localStorage 作为紧急备份。
  //       下次启动时 loadFromStorage 会优先从 localStorage 恢复。
  // ─────────────────────────────────────────
  function setupCloseGuard() {
    if (isTauri()) {
      let backupWarningShown = false;
      // 同步保存到 localStorage 作为紧急备份（同步操作，不会被关闭打断）
      function emergencySave() {
        try {
          if (State.currentId) {
            const note = State.notes.find(n => n.id === State.currentId);
            if (note && (note.type === 'md' || note.type === 'txt')) {
              // 只备份当前编辑的笔记内容和元数据
              localStorage.setItem('noteflow_emergency', JSON.stringify({
                noteId: State.currentId,
                content: dom.mdEditor.value,
                noteName: note.name,
                noteType: note.type,
                folderId: note.folderId,
                savedAt: Date.now()
              }));
              if (backupWarningShown) backupWarningShown = false;
              return;
            }
          }
        } catch (e) {
          if (!backupWarningShown) {
            console.error('[NoteFlow] 紧急备份失败:', e);
            toast('紧急备份失败，存储空间不足', 'danger');
            backupWarningShown = true;
          }
        }
      }

      // 每次编辑时同步备份到 localStorage
      dom.mdEditor.addEventListener('input', () => {
        emergencySave();
      });

      // 检查是否有紧急备份数据需要恢复
      window._checkEmergencyBackup = async function() {
        const backup = localStorage.getItem('noteflow_emergency');
        if (backup) {
          try {
            const data = JSON.parse(backup);
            if (data.noteId && data.content && data.savedAt) {
              console.log('[NoteFlow] 检测到紧急备份，正在恢复...');
              // 只恢复当前笔记内容到后端分文件存储
              const note = State.notes.find(n => n.id === data.noteId);
              if (note) {
                // 将紧急备份内容写入后端
                try {
                  await invoke('save_note', {
                    noteJson: JSON.stringify({
                      id: data.noteId,
                      name: data.noteName || note.name,
                      type: data.noteType || note.type,
                      folderId: data.folderId || note.folderId,
                      content: data.content || '',
                      createdAt: note.createdAt,
                      updatedAt: data.savedAt,
                    }),
                    binaryBase64: ''
                  });
                  // 同时写入前端缓存
                  State.noteContents[data.noteId] = data.content;
                  console.log('[NoteFlow] 紧急备份恢复成功');
                } catch(e) {
                  console.error('[NoteFlow] 紧急备份恢复失败:', e);
                }
              }
            }
            localStorage.removeItem('noteflow_emergency');
          } catch (e) {
            localStorage.removeItem('noteflow_emergency');
          }
        }
      };
    }
  }

  // ─────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────
  async function init() {
    console.log('[NoteFlow] init() started, JS version: 2026-05-04');
    await loadFromStorage();
    setupCloseGuard();

    // 检查是否有紧急备份需要恢复（上次非正常关闭的自动保存）
    if (window._checkEmergencyBackup) {
      await window._checkEmergencyBackup();
    }

    applyTheme(State.theme);
    renderSidebar();

    // 移动端：默认折叠侧边栏
    if (window.innerWidth <= 768) {
      dom.sidebar.classList.add('collapsed');
    }
    SyncPanel.init();
    StoragePanel.init();
    MinioPanel.init();
    loadMinioConfig().catch(() => {});

    // Web 端：显示顶部工具栏的「下载桌面版」按钮
    if (!isTauri()) {
      const dlBtn = document.getElementById('btn-download-desktop');
      if (dlBtn) dlBtn.style.display = '';
    }

    let launched = false;
    if (isTauri()) {
      try {
        const path = await invoke('get_launch_file');
        if (path) {
          await importAndOpenPath(path);
          launched = true;
        }
      } catch (e) {
        console.error('get_launch_file failed:', e);
      }
    }

    if (!launched && State.notes.length > 0) {
      openNote(State.notes[0].id);
    }

    if (isTauri() && window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('single-instance', (event) => {
        const payload = event.payload; // { args: [...], cwd: "..." }
        if (payload && payload.args && payload.args.length > 1) {
          const path = payload.args[1];
          importAndOpenPath(path);
        }
      });
    }

    // Scroll sync
    dom.mdEditor.addEventListener('scroll', () => {
      if (State.viewMode !== 'split') return;
      const ratio = dom.mdEditor.scrollTop / (dom.mdEditor.scrollHeight - dom.mdEditor.clientHeight);
      const wrap  = dom.mdPreviewWrap;
      wrap.scrollTop = ratio * (wrap.scrollHeight - wrap.clientHeight);
    });
  }

  init();

})();
