/* ==========================================
   NoteFlow — web-storage.js
   Web 环境适配层：使用 IndexedDB + localStorage
   实现所有 Tauri 后端命令的 Web 替代。
   在 app.js 之前加载，定义全局 WebStorage 对象。
========================================== */

window.WebStorage = {
  DB_NAME: 'noteflow_web',
  DB_VERSION: 2,
  db: null,

  async openDB() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('attachments')) {
          db.createObjectStore('attachments', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
      req.onerror = (e) => { reject(e.target.error); };
    });
  },

  // ── Note CRUD ───────────────────────────
  async load_index() {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readonly');
      const store = tx.objectStore('notes');
      const req = store.getAll();
      req.onsuccess = () => {
        const notes = req.result.map(n => ({
          id: n.id, folderId: n.folderId, name: n.name,
          type: n.type, createdAt: n.createdAt, updatedAt: n.updatedAt
        }));
        resolve(JSON.stringify(notes));
      };
      req.onerror = () => reject(req.error);
    });
  },

  async load_note(id) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readonly');
      const store = tx.objectStore('notes');
      const req = store.get(id);
      req.onsuccess = () => {
        const n = req.result;
        resolve(n ? JSON.stringify(n) : null);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async load_note_binary(id) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readonly');
      const store = tx.objectStore('notes');
      const req = store.get(id);
      req.onsuccess = () => {
        const n = req.result;
        resolve(n && n.binaryBase64 ? n.binaryBase64 : '');
      };
      req.onerror = () => reject(req.error);
    });
  },

  async save_note(noteJson, binaryBase64) {
    const note = JSON.parse(noteJson);
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      const req = store.get(note.id);
      req.onsuccess = () => {
        const existing = req.result || {};
        const updated = {
          ...existing,
          ...note,
          binaryBase64: binaryBase64 || existing.binaryBase64 || '',
        };
        store.put(updated);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async delete_note(id) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  // ── Folders & Settings (localStorage) ─────
  async load_folders() {
    return localStorage.getItem('noteflow_folders') || '[]';
  },
  async save_folders(data) {
    localStorage.setItem('noteflow_folders', data);
  },
  async load_settings() {
    return localStorage.getItem('noteflow_settings') || null;
  },
  async save_settings(data) {
    localStorage.setItem('noteflow_settings', data);
  },

  // ── Sync Config (localStorage) ───────────
  async load_sync_config() {
    return localStorage.getItem('noteflow_sync_config') || null;
  },
  async save_sync_config(configJson) {
    localStorage.setItem('noteflow_sync_config', configJson);
  },

  async test_gitee_connection(token) {
    const res = await fetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error('Token 无效或网络错误');
    return JSON.stringify(await res.json());
  },

  // ── Gitee API helper ─────────────────────
  _giteeAuth(cfg) {
    return `?access_token=${encodeURIComponent(cfg.token)}`;
  },
  _giteeApiBase(cfg) {
    return `https://gitee.com/api/v5/repos/${cfg.owner}/${cfg.repo}/contents`;
  },
  // 将路径按 / 分段编码，避免整体 encodeURIComponent 把 / 编成 %2F
  _encodePath(path) {
    return path.split('/').map(s => encodeURIComponent(s)).join('/');
  },
  async _giteeGetSha(cfg, path) {
    const url = `${this._giteeApiBase(cfg)}/${this._encodePath(path)}${this._giteeAuth(cfg)}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const d = await res.json();
        if (d.sha) return d.sha;
      }
    } catch(e) {}
    return null;
  },
  async _giteeUploadFile(cfg, path, contentBase64, message) {
    const sha = await this._giteeGetSha(cfg, path);
    const url = `${this._giteeApiBase(cfg)}/${this._encodePath(path)}${this._giteeAuth(cfg)}`;
    const body = JSON.stringify({
      message: message || `Upload: ${path}`,
      content: contentBase64,
      ...(sha ? { sha } : {}),
    });
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`上传 ${path} 失败: ${res.status} ${errText}`);
    }
  },
  async _giteeListDir(cfg, path) {
    const url = `${this._giteeApiBase(cfg)}/${this._encodePath(path)}${this._giteeAuth(cfg)}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) return data;
      }
    } catch(e) {}
    return [];
  },
  async _giteeDownloadFile(cfg, path) {
    const url = `${this._giteeApiBase(cfg)}/${this._encodePath(path)}${this._giteeAuth(cfg)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载 ${path} 失败: ${res.status}`);
    const d = await res.json();
    return d.content || ''; // base64
  },

  async sync_to_gitee() {
    const configRaw = localStorage.getItem('noteflow_sync_config');
    if (!configRaw) throw new Error('请先配置同步信息');
    const cfg = JSON.parse(configRaw);
    const db = await this.openDB();
    const allNotes = await new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readonly');
      const req = tx.objectStore('notes').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const folders = JSON.parse(localStorage.getItem('noteflow_folders') || '[]');
    const settings = JSON.parse(localStorage.getItem('noteflow_settings') || '{}');
    const rawJson = JSON.stringify({ notes: allNotes, folders, settings });
    // 用 TextEncoder 正确处理中文，避免 btoa(unescape(...)) 废弃警告
    const utf8Bytes = new TextEncoder().encode(rawJson);
    let binaryStr = '';
    utf8Bytes.forEach(b => { binaryStr += String.fromCharCode(b); });
    const payload = btoa(binaryStr);
    const path = cfg.path || 'note-data.json';
    const auth = this._giteeAuth(cfg);
    let sha = '';
    try {
      const getRes = await fetch(`${this._giteeApiBase(cfg)}/${this._encodePath(path)}${auth}`);
      if (getRes.ok) { const d = await getRes.json(); sha = d.sha; }
    } catch(e) {}

    const body = JSON.stringify({
      message: `Sync: ${new Date().toISOString()}`,
      content: payload,
      ...(sha ? { sha } : {}),
    });
    const putRes = await fetch(`${this._giteeApiBase(cfg)}/${this._encodePath(path)}${auth}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!putRes.ok) throw new Error('笔记数据上传失败');

    // ── 附件同步上传 ──
    const details = [];
    const allAttachments = await new Promise((resolve, reject) => {
      const tx = db.transaction('attachments', 'readonly');
      const req = tx.objectStore('attachments').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    let uploadCount = 0;
    for (const att of allAttachments) {
      const remotePath = `attachments/${att.noteId}/${att.filename}`;
      try {
        await this._giteeUploadFile(cfg, remotePath, att.data, `Attachment: ${remotePath}`);
        uploadCount++;
        details.push(`✅ ${remotePath}`);
      } catch(e) {
        details.push(`❌ ${remotePath}: ${e.message}`);
      }
      // Gitee API 限流保护
      if (uploadCount % 5 === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const msg = uploadCount > 0
      ? `同步成功（${allNotes.length} 篇笔记，${uploadCount} 个附件）`
      : `同步成功（${allNotes.length} 篇笔记）`;
    return JSON.stringify({
      success: true,
      message: msg,
      details,
      sync_time: Date.now(),
    });
  },

  async sync_from_gitee() {
    const configRaw = localStorage.getItem('noteflow_sync_config');
    if (!configRaw) throw new Error('请先配置同步信息');
    const cfg = JSON.parse(configRaw);
    const path = cfg.path || 'note-data.json';
    const url = `${this._giteeApiBase(cfg)}/${this._encodePath(path)}${this._giteeAuth(cfg)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('下载失败');
    const d = await res.json();
    // 用 TextDecoder 正确处理中文（escape/unescape 已废弃）
    const rawBytes = Uint8Array.from(atob(d.content), c => c.charCodeAt(0));
    const content = JSON.parse(new TextDecoder('utf-8').decode(rawBytes));
    const db = await this.openDB();
    const tx = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    for (const note of (content.notes || [])) {
      store.put(note);
    }
    await new Promise(r => tx.oncomplete = r);
    if (content.folders) localStorage.setItem('noteflow_folders', JSON.stringify(content.folders));
    if (content.settings) localStorage.setItem('noteflow_settings', JSON.stringify(content.settings));

    // ── 附件同步下载 ──
    const details = [];
    // 先全量下载所有附件内容（网络请求不能在 IndexedDB 事务内执行）
    const noteIds = (content.notes || []).map(n => n.id);
    const toWrite = []; // { key, noteId, filename, data }
    let downloadCount = 0;
    let reqCount = 0;
    for (const noteId of noteIds) {
      const dirPath = `attachments/${noteId}`;
      try {
        const files = await this._giteeListDir(cfg, dirPath);
        for (const file of files) {
          if (file.type !== 'file') continue;
          const filename = decodeURIComponent(file.name);
          try {
            const fileData = await this._giteeDownloadFile(cfg, `attachments/${noteId}/${filename}`);
            toWrite.push({ key: `${noteId}/${filename}`, noteId, filename, data: fileData });
            downloadCount++;
            details.push(`✅ ${noteId}/${filename}`);
          } catch(e) {
            details.push(`❌ ${noteId}/${filename}: ${e.message}`);
          }
          reqCount++;
          // Gitee API 限流保护
          if (reqCount % 5 === 0) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      } catch(e) {
        // 附件目录不存在，跳过
      }
    }
    // 批量写入 IndexedDB（单次事务）
    if (toWrite.length > 0) {
      const tx2 = db.transaction('attachments', 'readwrite');
      const attStore = tx2.objectStore('attachments');
      for (const record of toWrite) {
        attStore.put(record);
      }
      await new Promise((resolve, reject) => {
        tx2.oncomplete = resolve;
        tx2.onerror = () => reject(tx2.error);
      });
    }

    const msg = downloadCount > 0
      ? `下载成功（${(content.notes || []).length} 篇笔记，${downloadCount} 个附件）`
      : `下载成功（${(content.notes || []).length} 篇笔记）`;
    return JSON.stringify({
      success: true,
      message: msg,
      details,
      sync_time: Date.now(),
    });
  },

  // ── Import/Export ────────────────────────
  async export_all_data() {
    const db = await this.openDB();
    const allNotes = await new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readonly');
      const req = tx.objectStore('notes').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const allAttachments = await new Promise((resolve, reject) => {
      const tx = db.transaction('attachments', 'readonly');
      const req = tx.objectStore('attachments').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const folders = JSON.parse(localStorage.getItem('noteflow_folders') || '[]');
    const settings = JSON.parse(localStorage.getItem('noteflow_settings') || '{}');
    return JSON.stringify({ notes: allNotes, attachments: allAttachments, folders, settings });
  },

  async import_all_data(dataJson) {
    const data = JSON.parse(dataJson);
    const db = await this.openDB();
    const tx = db.transaction(['notes', 'attachments'], 'readwrite');
    const noteStore = tx.objectStore('notes');
    const attStore = tx.objectStore('attachments');
    for (const note of (data.notes || [])) {
      noteStore.put(note);
    }
    for (const att of (data.attachments || [])) {
      attStore.put(att);
    }
    await new Promise(r => tx.oncomplete = r);
    if (data.folders) localStorage.setItem('noteflow_folders', JSON.stringify(data.folders));
    if (data.settings) localStorage.setItem('noteflow_settings', JSON.stringify(data.settings));
  },

  async export_file(content, defaultName) {
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName || 'export';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // ── Storage path (not applicable in Web) ───
  async get_data_directory() { return 'Browser Local Storage (IndexedDB)'; },
  async get_default_data_directory() { return 'Browser Local Storage (IndexedDB)'; },
  async select_data_directory() { return null; },
  async set_data_directory() { return; },

  // ── Attachment directory (not applicable in Web) ──
  async get_attachment_directory() { return 'Browser IndexedDB'; },
  async get_default_attachment_directory() { return 'Browser IndexedDB'; },
  async select_attachment_directory() { return null; },
  async set_attachment_directory() { return; },

  // ── Attachments (IndexedDB) ──────────────
  async save_attachment(noteId, filename, binaryBase64) {
    const db = await this.openDB();
    const key = `${noteId}/${filename}`;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('attachments', 'readwrite');
      const store = tx.objectStore('attachments');
      store.put({ key, noteId, filename, data: binaryBase64 });
      tx.oncomplete = () => resolve(filename);
      tx.onerror = () => reject(tx.error);
    });
  },

  async get_attachment(noteId, filename) {
    const db = await this.openDB();
    const key = `${noteId}/${filename}`;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('attachments', 'readonly');
      const store = tx.objectStore('attachments');
      const req = store.get(key);
      req.onsuccess = () => {
        const record = req.result;
        resolve(record ? record.data : '');
      };
      req.onerror = () => reject(req.error);
    });
  },

  async delete_attachment(noteId, filename) {
    const db = await this.openDB();
    const key = `${noteId}/${filename}`;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('attachments', 'readwrite');
      const store = tx.objectStore('attachments');
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async list_attachments(noteId) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('attachments', 'readonly');
      const store = tx.objectStore('attachments');
      const req = store.getAll();
      req.onsuccess = () => {
        const files = (req.result || [])
          .filter(r => r.noteId === noteId)
          .map(r => r.filename);
        resolve(files);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async delete_note_attachments(noteId) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('attachments', 'readwrite');
      const store = tx.objectStore('attachments');
      const req = store.getAll();
      req.onsuccess = () => {
        for (const record of (req.result || [])) {
          if (record.noteId === noteId) {
            store.delete(record.key);
          }
        }
        tx.oncomplete = () => resolve();
      };
      req.onerror = () => reject(req.error);
    });
  },

  // ── Legacy API ───────────────────────────
  async load_notes() { return this.load_index(); },
  async save_notes(dataJson) { return this.import_all_data(dataJson); },

  // ── MinIO 配置（localStorage） ────────────
  async load_minio_config() {
    const raw = localStorage.getItem('noteflow_minio_config');
    if (!raw) {
      // 返回默认配置（endpoint 预填 ngrok 地址）
      return JSON.stringify({
        enabled: false,
        endpoint: 'https://pedometer-dweller-encounter.ngrok-free.dev',
        bucket: 'noteflow-images',
        accessKey: '',
        secretKey: '',
        region: 'us-east-1',
      });
    }
    return raw;
  },

  async save_minio_config(configJson) {
    localStorage.setItem('noteflow_minio_config', configJson);
  },

  async test_minio_connection(configJson) {
    const cfg = JSON.parse(configJson);
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKey || !cfg.secretKey) {
      throw new Error('请填写完整的 MinIO 配置');
    }
    // Web 端：尝试上传一个测试对象来验证连通性
    const testData = new TextEncoder().encode('noteflow-test');
    const testKey = '.noteflow-test';
    const endpoint = cfg.endpoint.replace(/\/$/, '');
    const url = `${endpoint}/${cfg.bucket}/${testKey}`;

    const now = new Date();
    const dateStr = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '') + 'Z';
    const dateOnly = dateStr.slice(0, 8);
    const region = cfg.region || 'us-east-1';

    const bodyHash = await this._sha256Hex(testData);
    const host = endpoint.replace(/^https?:\/\//, '');

    const canonicalHeaders = [
      `content-type:text/plain`,
      `host:${host}`,
      `x-amz-content-sha256:${bodyHash}`,
      `x-amz-date:${dateStr}`,
    ].join('\n') + '\n';
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = ['PUT', `/${cfg.bucket}/${testKey}`, '', canonicalHeaders, signedHeaders, bodyHash].join('\n');

    const credentialScope = `${dateOnly}/${region}/s3/aws4_request`;
    const crHash = await this._sha256Hex(new TextEncoder().encode(canonicalRequest));
    const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${credentialScope}\n${crHash}`;

    const signingKey = await this._deriveSigningKey(cfg.secretKey, dateOnly, region);
    const signature = await this._hmacHex(signingKey, stringToSign);
    const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${signature}`;

    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': authorization,
        'x-amz-date': dateStr,
        'x-amz-content-sha256': bodyHash,
        'Content-Type': 'text/plain',
        'ngrok-skip-browser-warning': 'true',
      },
      body: testData,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`连接测试失败 (${resp.status}): ${errText.slice(0, 200)}`);
    }

    // 清理测试对象（忽略错误）
    fetch(`${endpoint}/${cfg.bucket}/${testKey}`, { method: 'DELETE' }).catch(() => {});

    return `连接成功！Endpoint: ${cfg.endpoint}, Bucket: ${cfg.bucket}`;
  },

  // upload_to_minio 和 delete_from_minio 在 Web 端由 app.js 中的 _webUploadToMinio 直接处理
  // 这里只做存根，防止 invoke 路由报错
  async upload_to_minio(noteId, filename, binaryBase64, contentType) {
    throw new Error('upload_to_minio 应由 app.js handleImageInsert 直接调用，不走 WebStorage');
  },
  async delete_from_minio() { return; },

  // ── AWS Crypto 工具（复用 app.js 中的实现，Web 端 WebStorage 测试时用） ──
  async _sha256Hex(data) {
    const buf = await crypto.subtle.digest('SHA-256', data instanceof Uint8Array ? data : new TextEncoder().encode(data));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  },
  async _hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key instanceof ArrayBuffer ? key : key,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  },
  async _hmacHex(key, data) {
    const buf = await this._hmacSha256(key, data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  },
  async _deriveSigningKey(secretKey, dateOnly, region) {
    const kDate = await this._hmacSha256(new TextEncoder().encode('AWS4' + secretKey), dateOnly);
    const kRegion = await this._hmacSha256(kDate, region);
    const kService = await this._hmacSha256(kRegion, 's3');
    return this._hmacSha256(kService, 'aws4_request');
  },
};
