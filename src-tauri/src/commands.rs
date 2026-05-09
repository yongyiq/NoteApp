use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::config;
use crate::gitee;
use crate::github;
use crate::minio;

// ==========================================
// 数据结构定义
// ==========================================

/// 笔记完整结构（用于笔记文件 notes/{id}.json 和 Gitee 同步）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String,
    #[serde(rename = "folderId", skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub note_type: String,
    pub content: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
}

/// 笔记元数据（用于 index.json，无 content，轻量）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteMetadata {
    pub id: String,
    #[serde(rename = "folderId", skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub note_type: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
}

impl NoteMetadata {
    fn from_note(note: &Note) -> Self {
        NoteMetadata {
            id: note.id.clone(),
            folder_id: note.folder_id.clone(),
            name: note.name.clone(),
            note_type: note.note_type.clone(),
            created_at: note.created_at,
            updated_at: note.updated_at,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(rename = "open")]
    pub is_open: bool,
}

/// 整个应用的持久化数据（用于 Gitee 同步格式兼容）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppData {
    pub notes: Vec<Note>,
    pub folders: Vec<Folder>,
    pub theme: String,
}

/// 设置数据（settings.json）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub theme: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            theme: "light".to_string(),
        }
    }
}

// ==========================================
// 内部辅助函数
// ==========================================

/// 获取应用数据目录（优先使用用户自定义路径）
fn get_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    config::get_effective_data_dir(app)
}

/// 获取 notes 子目录
fn get_notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_data_dir(app)?;
    let notes_dir = dir.join("notes");
    fs::create_dir_all(&notes_dir).map_err(|e| e.to_string())?;
    Ok(notes_dir)
}

/// 旧版数据文件路径
fn get_legacy_data_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_data_dir(app)?.join("noteflow_data.json"))
}

/// 索引文件路径
fn get_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_data_dir(app)?.join("index.json"))
}

/// 文件夹数据路径
fn get_folders_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_data_dir(app)?.join("folders.json"))
}

/// 设置数据路径
fn get_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_data_dir(app)?.join("settings.json"))
}

/// 读取 index.json
fn read_index(app: &AppHandle) -> Result<Vec<NoteMetadata>, String> {
    let path = get_index_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// 写入 index.json
fn write_index(app: &AppHandle, index: &[NoteMetadata]) -> Result<(), String> {
    let path = get_index_path(app)?;
    let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// 更新 index 中某条笔记的元数据（存在则更新，不存在则插入）
fn upsert_index_entry(app: &AppHandle, note: &Note) -> Result<(), String> {
    let mut index = read_index(app)?;
    let meta = NoteMetadata::from_note(note);

    if let Some(pos) = index.iter().position(|n| n.id == note.id) {
        index[pos] = meta;
    } else {
        index.push(meta);
    }

    write_index(app, &index)
}

/// 从 index 中移除某条笔记
fn remove_index_entry(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut index = read_index(app)?;
    index.retain(|n| n.id != id);
    write_index(app, &index)
}

/// 读取单篇笔记文件
fn read_note_file(app: &AppHandle, id: &str) -> Result<Note, String> {
    let path = get_notes_dir(app)?.join(format!("{}.json", id));
    let content = fs::read_to_string(&path).map_err(|e| format!("读取笔记 {} 失败: {}", id, e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析笔记 {} 失败: {}", id, e))
}

/// 写入单篇笔记文件
fn write_note_file(app: &AppHandle, note: &Note) -> Result<(), String> {
    let path = get_notes_dir(app)?.join(format!("{}.json", note.id));
    let json = serde_json::to_string_pretty(note).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// 删除笔记文件（.json + 可选的 .bin）
fn delete_note_files(app: &AppHandle, id: &str) -> Result<(), String> {
    let notes_dir = get_notes_dir(app)?;
    let json_path = notes_dir.join(format!("{}.json", id));
    let bin_path = notes_dir.join(format!("{}.bin", id));

    if json_path.exists() {
        fs::remove_file(&json_path).map_err(|e| e.to_string())?;
    }
    if bin_path.exists() {
        fs::remove_file(&bin_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 判断笔记类型是否为文本
fn is_text_type(note_type: &str) -> bool {
    matches!(note_type, "md" | "txt")
}

/// 从旧版 noteflow_data.json 迁移到分文件格式
fn migrate_from_legacy(app: &AppHandle) -> Result<(), String> {
    let legacy_path = get_legacy_data_path(app)?;
    let notes_dir = get_notes_dir(app)?;

    // 如果 notes 目录已经有文件，说明已迁移过
    if notes_dir.read_dir().map_or(false, |mut d| d.next().is_some()) {
        return Ok(());
    }

    // 如果旧文件不存在，无需迁移
    if !legacy_path.exists() {
        return Ok(());
    }

    println!("[NoteFlow] 检测到旧版数据文件，开始迁移...");

    let content = fs::read_to_string(&legacy_path).map_err(|e| e.to_string())?;
    let app_data: AppData = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // 创建 index
    let mut index: Vec<NoteMetadata> = Vec::new();

    // 逐篇保存笔记
    for note in &app_data.notes {
        write_note_file(app, note)?;

        // 如果是 PDF/图片类型，尝试从 content_base64 写入 .bin 文件
        if !is_text_type(&note.note_type) && !note.content.is_empty() {
            let bin_path = notes_dir.join(format!("{}.bin", note.id));
            match decode_base64(&note.content) {
                Ok(bytes) => {
                    // 写入原始二进制
                    fs::write(&bin_path, &bytes).ok();
                    // 清空 JSON 中的 content（二进制已存到 .bin）
                    let mut clean_note = note.clone();
                    clean_note.content = String::new();
                    write_note_file(app, &clean_note)?;
                }
                Err(_) => {
                    // content 不是有效的 base64，保持原样
                }
            }
        }

        index.push(NoteMetadata::from_note(note));
    }

    // 写入 index.json
    write_index(app, &index)?;

    // 写入 folders.json
    let folders_path = get_folders_path(app)?;
    let folders_json = serde_json::to_string_pretty(&app_data.folders).map_err(|e| e.to_string())?;
    fs::write(&folders_path, folders_json).map_err(|e| e.to_string())?;

    // 写入 settings.json
    let settings = AppSettings { theme: app_data.theme };
    let settings_path = get_settings_path(app)?;
    let settings_json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, settings_json).map_err(|e| e.to_string())?;

    // 备份旧文件
    let bak_path = get_data_dir(app)?.join("noteflow_data.json.bak");
    fs::rename(&legacy_path, &bak_path).map_err(|e| e.to_string())?;

    println!("[NoteFlow] 迁移完成！已备份旧文件为 noteflow_data.json.bak");
    Ok(())
}

// ==========================================
// Tauri 命令 — 分文件存储 API
// ==========================================

/// 加载笔记索引（元数据，无 content）
/// 前端调用: invoke('load_index')
#[tauri::command]
pub fn load_index(app: AppHandle) -> Result<String, String> {
    // 自动迁移旧数据
    migrate_from_legacy(&app)?;

    let index = read_index(&app)?;
    serde_json::to_string(&index).map_err(|e| e.to_string())
}

/// 加载单篇笔记（含 content）
/// 前端调用: invoke('load_note', { id: 'n123' })
#[tauri::command]
pub fn load_note(app: AppHandle, id: String) -> Result<String, String> {
    let note = read_note_file(&app, &id)?;
    serde_json::to_string(&note).map_err(|e| e.to_string())
}

/// 加载笔记的二进制数据（PDF/图片）
/// 前端调用: invoke('load_note_binary', { id: 'n123' })
/// 返回 base64 编码的字符串
#[tauri::command]
pub fn load_note_binary(app: AppHandle, id: String) -> Result<String, String> {
    let bin_path = get_notes_dir(&app)?.join(format!("{}.bin", id));
    if !bin_path.exists() {
        return Ok(String::new());
    }
    let bytes = fs::read(&bin_path).map_err(|e| e.to_string())?;
    Ok(encode_base64(&bytes))
}

/// 保存单篇笔记（增量保存）
/// 前端调用: invoke('save_note', { noteJson: '...', binaryBase64: '...' })
/// binaryBase64 仅 PDF/图片需要，md/txt 传空字符串
#[tauri::command]
pub fn save_note(app: AppHandle, note_json: String, binary_base64: String) -> Result<(), String> {
    let note: Note = serde_json::from_str(&note_json).map_err(|e| e.to_string())?;

    // 如果有二进制数据，写入 .bin 文件
    if !binary_base64.is_empty() {
        let bin_path = get_notes_dir(&app)?.join(format!("{}.bin", note.id));
        let bytes = decode_base64(&binary_base64).map_err(|e| format!("Base64 解码失败: {}", e))?;
        fs::write(&bin_path, &bytes).map_err(|e| e.to_string())?;
    }

    // 写入笔记 JSON 文件
    write_note_file(&app, &note)?;

    // 更新索引
    upsert_index_entry(&app, &note)?;

    Ok(())
}

/// 删除笔记
/// 前端调用: invoke('delete_note', { id: 'n123' })
#[tauri::command]
pub fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    delete_note_files(&app, &id)?;
    remove_index_entry(&app, &id)?;
    Ok(())
}

/// 保存文件夹结构
/// 前端调用: invoke('save_folders', { data: '[...]' })
#[tauri::command]
pub fn save_folders(app: AppHandle, data: String) -> Result<(), String> {
    let path = get_folders_path(&app)?;
    // 验证 JSON 格式
    let _folders: Vec<Folder> = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

/// 加载文件夹结构
/// 前端调用: invoke('load_folders')
#[tauri::command]
pub fn load_folders(app: AppHandle) -> Result<String, String> {
    let path = get_folders_path(&app)?;
    if !path.exists() {
        return Ok("[]".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 保存设置
/// 前端调用: invoke('save_settings', { data: '{"theme":"dark"}' })
#[tauri::command]
pub fn save_settings(app: AppHandle, data: String) -> Result<(), String> {
    let path = get_settings_path(&app)?;
    let _settings: AppSettings = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

/// 加载设置
/// 前端调用: invoke('load_settings')
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<String, String> {
    let path = get_settings_path(&app)?;
    if !path.exists() {
        let default = AppSettings::default();
        return serde_json::to_string(&default).map_err(|e| e.to_string());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 导出全部数据（汇总为 AppData JSON，供 Gitee 同步上传用）
/// 前端调用: invoke('export_all_data')
#[tauri::command]
pub fn export_all_data(app: AppHandle) -> Result<String, String> {
    let index = read_index(&app)?;
    let folders_str = load_folders(app.clone())?;
    let settings_str = load_settings(app.clone())?;

    let folders: Vec<Folder> = serde_json::from_str(&folders_str).unwrap_or_default();
    let settings: AppSettings = serde_json::from_str(&settings_str).unwrap_or_default();

    // 加载 MinIO 配置，用于自动迁移旧二进制数据
    let minio_config = config::load_minio_config(&app);
    let minio_available = minio_config.is_valid();

    let mut notes: Vec<Note> = Vec::new();
    let notes_dir = get_notes_dir(&app)?;

    for meta in &index {
        let json_path = notes_dir.join(format!("{}.json", meta.id));
        if !json_path.exists() {
            continue;
        }
        let mut note: Note = match fs::read_to_string(&json_path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| Note {
                id: meta.id.clone(),
                folder_id: meta.folder_id.clone(),
                name: meta.name.clone(),
                note_type: meta.note_type.clone(),
                content: String::new(),
                created_at: meta.created_at,
                updated_at: meta.updated_at,
            }),
            Err(_) => continue,
        };

        // PDF/图片：如果 content 已经是 MinIO URL，直接保留
        // 如果有 .bin 文件且 MinIO 可用，自动上传到 MinIO 并替换 content 为 URL
        // 否则读取 .bin 文件的 base64 作为 content（兜底）
        if !is_text_type(&note.note_type) {
            if note.content.starts_with("http") {
                // 已经是 MinIO URL，直接保留
            } else {
                let bin_path = notes_dir.join(format!("{}.bin", meta.id));
                if bin_path.exists() {
                    if let Ok(bytes) = fs::read(&bin_path) {
                        if minio_available {
                            // 自动迁移：上传 .bin 到 MinIO，content 存 URL
                            let ext = meta.name.rsplit('.').next().unwrap_or("bin");
                            let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
                            let safe_name = format!("{}_{}.{}", timestamp, &meta.id[..meta.id.len().min(8)], ext);
                            let content_type = match ext {
                                "pdf" => "application/pdf",
                                "png" => "image/png",
                                "jpg" | "jpeg" => "image/jpeg",
                                "gif" => "image/gif",
                                "webp" => "image/webp",
                                "svg" => "image/svg+xml",
                                _ => "application/octet-stream",
                            };
                            // 按类型分目录：pdfs/ 或 images/
                            let folder = if ext == "pdf" { "pdfs" } else { "images" };
                            let key = format!("{}/{}", folder, safe_name);
                            match minio::upload_object(&minio_config, &key, &bytes, content_type) {
                                Ok(url) => {
                                    note.content = url;
                                    // 同时更新本地 JSON 文件，后续不再需要迁移
                                    let _ = write_note_file(&app, &note);
                                }
                                Err(_) => {
                                    // MinIO 上传失败，回退到 base64
                                    note.content = encode_base64(&bytes);
                                }
                            }
                        } else {
                            // MinIO 不可用，使用 base64（兜底）
                            note.content = encode_base64(&bytes);
                        }
                    }
                }
            }
        }

        notes.push(note);
    }

    let app_data = AppData {
        notes,
        folders,
        theme: settings.theme,
    };

    serde_json::to_string(&app_data).map_err(|e| e.to_string())
}

/// 导入全部数据（接收 AppData JSON，拆分为分文件，供 Gitee 同步下载用）
/// 前端调用: invoke('import_all_data', { data: '...' })
#[tauri::command]
pub fn import_all_data(app: AppHandle, data: String) -> Result<(), String> {
    let app_data: AppData = serde_json::from_str(&data).map_err(|e| format!("JSON 解析失败: {}", e))?;

    // 清空现有数据
    let notes_dir = get_notes_dir(&app)?;
    if notes_dir.exists() {
        for entry in fs::read_dir(&notes_dir).map_err(|e| e.to_string())? {
            if let Ok(entry) = entry {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    // 重建 index
    let mut index: Vec<NoteMetadata> = Vec::new();

    for note in &app_data.notes {
        // PDF/图片：
        // - 如果 content 是 MinIO URL（http 开头），直接保留到 JSON
        // - 如果 content 是 base64，解码写入 .bin，JSON 中 content 置空
        let mut file_note = note.clone();
        if !is_text_type(&note.note_type) && !note.content.is_empty() {
            if note.content.starts_with("http") {
                // MinIO URL，直接保留在 JSON 中，不写 .bin
            } else {
                let bin_path = notes_dir.join(format!("{}.bin", note.id));
                match decode_base64(&note.content) {
                    Ok(bytes) => {
                        fs::write(&bin_path, &bytes).map_err(|e| e.to_string())?;
                        file_note.content = String::new();
                    }
                    Err(_) => {}
                }
            }
        }

        write_note_file(&app, &file_note)?;
        index.push(NoteMetadata::from_note(note));
    }

    write_index(&app, &index)?;
    save_folders(app.clone(), serde_json::to_string(&app_data.folders).map_err(|e| e.to_string())?)?;
    save_settings(app.clone(), serde_json::to_string(&AppSettings { theme: app_data.theme }).map_err(|e| e.to_string())?)?;

    Ok(())
}

// ==========================================
// 兼容旧前端 API（逐步废弃）
// ==========================================

/// 读取笔记数据（兼容旧前端）
#[tauri::command]
pub fn load_notes(app: AppHandle) -> Result<String, String> {
    migrate_from_legacy(&app)?;
    let index = read_index(&app)?;
    let folders_str = load_folders(app.clone())?;
    let settings_str = load_settings(app.clone())?;

    let folders: Vec<Folder> = serde_json::from_str(&folders_str).unwrap_or_default();
    let settings: AppSettings = serde_json::from_str(&settings_str).unwrap_or_default();

    let mut notes: Vec<Note> = Vec::new();
    let notes_dir = get_notes_dir(&app)?;

    for meta in &index {
        let json_path = notes_dir.join(format!("{}.json", meta.id));
        if !json_path.exists() {
            continue;
        }
        let mut note: Note = match fs::read_to_string(&json_path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| Note {
                id: meta.id.clone(),
                folder_id: meta.folder_id.clone(),
                name: meta.name.clone(),
                note_type: meta.note_type.clone(),
                content: String::new(),
                created_at: meta.created_at,
                updated_at: meta.updated_at,
            }),
            Err(_) => continue,
        };

        // PDF/图片：读取 .bin 文件
        if !is_text_type(&note.note_type) {
            let bin_path = notes_dir.join(format!("{}.bin", meta.id));
            if bin_path.exists() {
                if let Ok(bytes) = fs::read(&bin_path) {
                    note.content = encode_base64(&bytes);
                }
            }
        }

        notes.push(note);
    }

    let app_data = AppData {
        notes,
        folders,
        theme: settings.theme,
    };

    serde_json::to_string(&app_data).map_err(|e| e.to_string())
}

/// 保存笔记数据（兼容旧前端，内部拆分保存）
#[tauri::command]
pub fn save_notes(app: AppHandle, data: String) -> Result<(), String> {
    let app_data: AppData = serde_json::from_str(&data).map_err(|e| format!("JSON 解析失败: {}", e))?;

    // 保存 folders
    save_folders(app.clone(), serde_json::to_string(&app_data.folders).map_err(|e| e.to_string())?)?;

    // 保存 settings
    save_settings(app.clone(), serde_json::to_string(&AppSettings { theme: app_data.theme }).map_err(|e| e.to_string())?)?;

    // 保存每篇笔记
    let notes_dir = get_notes_dir(&app)?;
    let mut index: Vec<NoteMetadata> = Vec::new();

    for note in &app_data.notes {
        let mut file_note = note.clone();

        // PDF/图片：content 含 base64，写入 .bin，JSON 中 content 置空
        if !is_text_type(&note.note_type) && !note.content.is_empty() {
            let bin_path = notes_dir.join(format!("{}.bin", note.id));
            match decode_base64(&note.content) {
                Ok(bytes) => {
                    fs::write(&bin_path, &bytes).map_err(|e| e.to_string())?;
                    file_note.content = String::new();
                }
                Err(_) => {}
            }
        }

        write_note_file(&app, &file_note)?;
        index.push(NoteMetadata::from_note(note));
    }

    write_index(&app, &index)?;
    Ok(())
}

// ==========================================
// 导入/导出文件命令
// ==========================================

/// 获取应用数据目录路径
#[tauri::command]
pub fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    let dir = get_data_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    pub name: String,
    #[serde(rename = "contentBase64")]
    pub content_base64: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

/// 导入外部文件
#[tauri::command]
pub fn import_file(app: AppHandle) -> Result<ImportedFile, String> {
    let file_path = app
        .dialog()
        .file()
        .set_title("选择要导入的文件")
        .add_filter("笔记文件", &["md", "txt"])
        .add_filter("PDF 文件", &["pdf"])
        .add_filter("图片文件", &["png", "jpg", "jpeg", "gif", "webp", "svg"])
        .add_filter("所有文件", &["*"])
        .blocking_pick_file()
        .ok_or("用户取消了文件选择")?;

    let file_path = file_path.as_path().ok_or("不支持的文件路径类型")?;

    let file_name = file_path
        .file_name()
        .ok_or("无法获取文件名")?
        .to_string_lossy()
        .to_string();

    let bytes = fs::read(&file_path).map_err(|e| e.to_string())?;
    let mime_type = guess_mime_type(&file_name);
    let content_base64 = encode_base64(&bytes);

    Ok(ImportedFile {
        name: file_name,
        content_base64,
        mime_type,
    })
}

/// 导出文件到用户选择的位置
#[tauri::command]
pub fn export_file(app: AppHandle, content: String, default_name: String) -> Result<(), String> {
    let ext = default_name.split('.').last().unwrap_or("txt");

    let file_path = app
        .dialog()
        .file()
        .set_title("保存文件")
        .set_file_name(&default_name)
        .add_filter("文件", &[ext])
        .blocking_save_file()
        .ok_or("用户取消了保存")?;

    let file_path = file_path.as_path().ok_or("不支持的文件路径类型")?;
    fs::write(&file_path, &content).map_err(|e| e.to_string())?;
    Ok(())
}

// ==========================================
// Base64 编解码
// ==========================================

fn encode_base64(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };

        let n = (b0 << 16) | (b1 << 8) | b2;

        result.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((n >> 6) & 0x3F) as usize] as char);
        }
        if chunk.len() > 2 {
            result.push(CHARS[(n & 0x3F) as usize] as char);
        }
    }

    while result.len() % 4 != 0 {
        result.push('=');
    }

    result
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    // 清理输入：去除空白和换行
    let input: String = input.chars().filter(|c| !c.is_whitespace()).collect();

    if input.is_empty() {
        return Ok(Vec::new());
    }

    let mut result = Vec::with_capacity(input.len() * 3 / 4);

    // 构建 base64 查找表
    fn char_to_val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            b'=' => Some(0), // padding
            _ => None,
        }
    }

    let bytes = input.as_bytes();
    let chunks = bytes.chunks(4);

    for chunk in chunks {
        if chunk.len() < 2 {
            break;
        }

        let v0 = char_to_val(chunk[0]).ok_or("无效的 Base64 字符")?;
        let v1 = char_to_val(chunk[1]).ok_or("无效的 Base64 字符")?;
        let v2 = if chunk.len() > 2 { char_to_val(chunk[2]).unwrap_or(0) } else { 0 };
        let v3 = if chunk.len() > 3 { char_to_val(chunk[3]).unwrap_or(0) } else { 0 };

        let n = ((v0 as u32) << 18) | ((v1 as u32) << 12) | ((v2 as u32) << 6) | (v3 as u32);

        result.push(((n >> 16) & 0xFF) as u8);
        if chunk.len() > 2 && chunk[2] != b'=' {
            result.push(((n >> 8) & 0xFF) as u8);
        }
        if chunk.len() > 3 && chunk[3] != b'=' {
            result.push((n & 0xFF) as u8);
        }
    }

    Ok(result)
}

fn guess_mime_type(filename: &str) -> String {
    match filename.split('.').last().unwrap_or("") {
        "md" | "txt"  => "text/plain".to_string(),
        "pdf"         => "application/pdf".to_string(),
        "png"         => "image/png".to_string(),
        "jpg" | "jpeg"=> "image/jpeg".to_string(),
        "gif"         => "image/gif".to_string(),
        "webp"        => "image/webp".to_string(),
        "svg"         => "image/svg+xml".to_string(),
        _             => "application/octet-stream".to_string(),
    }
}

// ==========================================
// 数据目录管理命令
// ==========================================

/// 获取当前有效的数据目录路径
#[tauri::command]
pub fn get_data_directory(app: AppHandle) -> Result<String, String> {
    let dir = config::get_effective_data_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

/// 获取默认 AppData 目录路径（用于显示）
#[tauri::command]
pub fn get_default_data_directory(app: AppHandle) -> Result<String, String> {
    let dir = config::get_default_app_data_dir(&app).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 打开目录选择对话框，让用户选择新的数据目录
#[tauri::command]
pub fn select_data_directory(app: AppHandle) -> Result<Option<String>, String> {
    // Tauri v2 dialog: 使用 blocking_pick_folder 选择目录
    let folder = app
        .dialog()
        .file()
        .set_title("选择笔记数据存储目录")
        .blocking_pick_folder();

    match folder {
        Some(path_buf) => {
            let path = path_buf.as_path().ok_or("无法获取选中路径")?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None), // 用户取消了选择
    }
}

/// 设置自定义数据目录
/// 如果 new_dir 为 None，则清除自定义设置（使用默认目录）
#[tauri::command]
pub fn set_data_directory(app: AppHandle, new_dir: Option<String>) -> Result<(), String> {
    let mut config = config::load_app_config(&app);
    config.data_dir = new_dir;
    config::save_app_config(&app, &config)?;
    Ok(())
}

// ==========================================
// 附件目录命令
// ==========================================

/// 获取当前附件目录路径
#[tauri::command]
pub fn get_attachment_directory(app: AppHandle) -> Result<String, String> {
    let dir = config::get_effective_attachment_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

/// 获取默认附件目录路径（跟随数据目录下的 attachments/）
#[tauri::command]
pub fn get_default_attachment_directory(app: AppHandle) -> Result<String, String> {
    let data_dir = config::get_effective_data_dir(&app)?;
    let dir = data_dir.join("attachments");
    Ok(dir.to_string_lossy().to_string())
}

/// 打开目录选择对话框，让用户选择新的附件目录
#[tauri::command]
pub fn select_attachment_directory(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("选择附件存储目录")
        .blocking_pick_folder();

    match folder {
        Some(path_buf) => {
            let path = path_buf.as_path().ok_or("无法获取选中路径")?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

/// 设置自定义附件目录
/// 如果 new_dir 为 None，则清除自定义设置（跟随数据目录）
#[tauri::command]
pub fn set_attachment_directory(app: AppHandle, new_dir: Option<String>) -> Result<(), String> {
    let mut config = config::load_app_config(&app);
    config.attachment_dir = new_dir;
    config::save_app_config(&app, &config)?;
    Ok(())
}

// ==========================================
// 云同步命令 — Gitee / GitHub 同步
// ==========================================

#[tauri::command]
pub fn load_sync_config(app: AppHandle) -> Result<String, String> {
    let config = config::load_sync_config(&app)?;
    serde_json::to_string(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_sync_config(app: AppHandle, config_json: String) -> Result<(), String> {
    let sync_config: gitee::SyncConfig =
        serde_json::from_str(&config_json).map_err(|e| e.to_string())?;
    config::save_sync_config(&app, &sync_config)
}

#[tauri::command]
pub fn test_gitee_connection(token: String, platform: Option<String>) -> Result<String, String> {
    let plat = platform.unwrap_or_else(|| "gitee".to_string());
    if plat == "github" {
        let user = github::test_connection(&token)?;
        serde_json::to_string(&user).map_err(|e| e.to_string())
    } else {
        let user = gitee::test_connection(&token)?;
        serde_json::to_string(&user).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn sync_to_gitee(app: AppHandle) -> Result<String, String> {
    let sync_config = config::load_sync_config(&app)?;
    if !sync_config.is_valid() {
        return Err("同步配置不完整，请先完成设置".to_string());
    }

    // 从分文件汇总数据
    let all_data = export_all_data(app.clone())?;

    // 根据平台分发
    let is_github = sync_config.platform == "github";
    let mut result = if is_github {
        github::sync_upload(&sync_config, &all_data)?
    } else {
        gitee::sync_upload(&sync_config, &all_data)?
    };

    // 同步附件目录（仅 Gitee，GitHub 附件已通过 MinIO 处理）
    if !is_github {
        let attach_root = config::get_effective_attachment_dir(&app)?;
        println!("[sync_to_gitee] 附件根目录: {}", attach_root.display());
        if attach_root.exists() {
            result.details.push(format!("扫描附件目录: {}", attach_root.display()));
            let mut upload_count = 0u32;
            let mut upload_errors = 0u32;
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

            for note_dir_entry in fs::read_dir(&attach_root).map_err(|e| e.to_string())? {
                let note_dir_entry = note_dir_entry.map_err(|e| e.to_string())?;
                if !note_dir_entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    continue;
                }
                let note_id = note_dir_entry.file_name().to_string_lossy().to_string();

                for file_entry in fs::read_dir(note_dir_entry.path()).map_err(|e| e.to_string())? {
                    let file_entry = file_entry.map_err(|e| e.to_string())?;
                    if !file_entry.file_type().map_err(|e| e.to_string())?.is_file() {
                        continue;
                    }
                    let filename = file_entry.file_name().to_string_lossy().to_string();
                    let remote_path = format!("attachments/{}/{}", note_id, filename);

                    let bytes = fs::read(file_entry.path()).map_err(|e| e.to_string())?;
                    let binary_base64 = encode_base64(&bytes);

                    let sha = match gitee::check_file_exists(&sync_config, &remote_path) {
                        Ok(Some((sha, _))) if !sha.is_empty() => Some(sha),
                        _ => None,
                    };

                    let commit_msg = format!("[NoteFlow] 同步附件 {} @ {}", remote_path, now);
                    match gitee::upload_attachment(&sync_config, &remote_path, &binary_base64, sha.as_deref(), &commit_msg) {
                        Ok(_) => { upload_count += 1; }
                        Err(e) => {
                            upload_errors += 1;
                            result.details.push(format!("附件上传失败 {}: {}", remote_path, e));
                        }
                    }

                    if upload_count % 30 == 0 {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
            }

            result.details.push(format!("附件上传: {} 成功, {} 失败", upload_count, upload_errors));
        } else {
            result.details.push("本地无附件目录，跳过附件同步".to_string());
        }
    }

    let mut updated_config = sync_config;
    updated_config.last_sync = Some(result.sync_time.clone());
    config::save_sync_config(&app, &updated_config)?;

    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_from_gitee(app: AppHandle) -> Result<String, String> {
    let sync_config = config::load_sync_config(&app)?;
    if !sync_config.is_valid() {
        return Err("同步配置不完整，请先完成设置".to_string());
    }

    let is_github = sync_config.platform == "github";
    let mut result = if is_github {
        github::sync_download(&sync_config)?
    } else {
        gitee::sync_download(&sync_config)?
    };

    // 下载附件（仅 Gitee）
    if !is_github {
        let attach_root = config::get_effective_attachment_dir(&app)?;
        let mut download_count = 0u32;
        let mut download_errors = 0u32;

        match gitee::list_repo_files(&sync_config, "attachments") {
            Ok(files) => {
                for remote_path in &files {
                    let relative_path = remote_path.strip_prefix("attachments/")
                        .unwrap_or(remote_path);
                    let local_path = attach_root.join(relative_path);

                    match gitee::download_attachment(&sync_config, remote_path) {
                        Ok(base64_content) => {
                            match decode_base64(&base64_content) {
                                Ok(bytes) => {
                                    if let Some(parent) = local_path.parent() {
                                        let _ = fs::create_dir_all(parent);
                                    }
                                    if let Err(_e) = fs::write(&local_path, &bytes) {
                                        download_errors += 1;
                                    } else {
                                        download_count += 1;
                                    }
                                }
                                Err(_) => { download_errors += 1; }
                            }
                        }
                        Err(e) => {
                            download_errors += 1;
                            let _ = e;
                        }
                    }

                    if download_count % 30 == 0 {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }

                if !files.is_empty() {
                    result.details.push(format!("附件下载: {} 成功, {} 失败", download_count, download_errors));
                }
            }
            Err(e) => {
                result.details.push(format!("列出远程附件目录失败: {}", e));
            }
        }
    }

    let mut updated_config = sync_config;
    updated_config.last_sync = Some(result.sync_time.clone());
    config::save_sync_config(&app, &updated_config)?;

    serde_json::to_string(&result).map_err(|e| e.to_string())
}

// ==========================================
// 附件管理命令
// ==========================================

/// 清理文件名（移除非法字符）
fn sanitize_filename(name: &str) -> String {
    let invalid: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let cleaned: String = name.chars().filter(|c| !invalid.contains(c)).collect();
    if cleaned.is_empty() {
        return "file".to_string();
    }
    // 限制长度（留空间给序号后缀）
    if cleaned.len() > 180 {
        let truncated: String = cleaned.chars().take(180).collect();
        return truncated;
    }
    cleaned
}

/// 获取附件存储目录（自动创建）
fn get_attachments_dir(app: &AppHandle, note_id: &str) -> Result<PathBuf, String> {
    let dir = config::get_effective_attachment_dir(app)?;
    let attach_dir = dir.join(note_id);
    fs::create_dir_all(&attach_dir).map_err(|e| e.to_string())?;
    Ok(attach_dir)
}

/// 保存附件到本地存储，返回实际使用的文件名
#[tauri::command]
pub fn save_attachment(app: AppHandle, note_id: String, filename: String, binary_base64: String) -> Result<String, String> {
    let attach_dir = get_attachments_dir(&app, &note_id)?;
    let safe_name = sanitize_filename(&filename);
    let mut actual_name = safe_name.clone();
    let mut file_path = attach_dir.join(&actual_name);

    // 文件名冲突时添加序号后缀
    if file_path.exists() {
        let path_buf = std::path::Path::new(&safe_name);
        let stem = path_buf.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = path_buf.extension().unwrap_or_default().to_string_lossy().to_string();
        let mut counter = 1;
        loop {
            let new_name = if ext.is_empty() {
                format!("{}_{}", stem, counter)
            } else {
                format!("{}_{}.{}", stem, counter, ext)
            };
            let new_path = attach_dir.join(&new_name);
            if !new_path.exists() {
                actual_name = new_name;
                file_path = new_path;
                break;
            }
            counter += 1;
        }
    }

    let bytes = decode_base64(&binary_base64)?;
    fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
    Ok(actual_name)
}

/// 读取附件，返回 base64 字符串
/// 如果文件不存在，尝试查找带序号后缀的文件（兼容旧数据）
#[tauri::command]
pub fn get_attachment(app: AppHandle, note_id: String, filename: String) -> Result<String, String> {
    let attach_dir = get_attachments_dir(&app, &note_id)?;
    let safe_name = sanitize_filename(&filename);
    let mut file_path = attach_dir.join(&safe_name);

    // 如果文件不存在，尝试查找带序号后缀的文件（如 _1, _2）
    if !file_path.exists() {
        let path_buf = std::path::Path::new(&safe_name);
        let stem = path_buf.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = path_buf.extension().unwrap_or_default().to_string_lossy().to_string();
        for counter in 1..=10 {
            let candidate = if ext.is_empty() {
                format!("{}_{}", stem, counter)
            } else {
                format!("{}_{}.{}", stem, counter, ext)
            };
            let candidate_path = attach_dir.join(&candidate);
            if candidate_path.exists() {
                file_path = candidate_path;
                break;
            }
        }
    }

    if !file_path.exists() {
        return Err(format!("附件不存在: {}", filename));
    }

    let bytes = fs::read(&file_path).map_err(|e| e.to_string())?;
    Ok(encode_base64(&bytes))
}

/// 删除单个附件
#[tauri::command]
pub fn delete_attachment(app: AppHandle, note_id: String, filename: String) -> Result<(), String> {
    let attach_dir = get_attachments_dir(&app, &note_id)?;
    let safe_name = sanitize_filename(&filename);
    let file_path = attach_dir.join(&safe_name);

    if file_path.exists() {
        fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// 列出笔记的所有附件
#[tauri::command]
pub fn list_attachments(app: AppHandle, note_id: String) -> Result<Vec<String>, String> {
    let attach_dir = get_attachments_dir(&app, &note_id)?;

    if !attach_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files: Vec<String> = Vec::new();
    for entry in fs::read_dir(&attach_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_file() {
            if let Some(name) = entry.file_name().to_str() {
                files.push(name.to_string());
            }
        }
    }

    Ok(files)
}

/// 删除笔记的所有附件目录
#[tauri::command]
pub fn delete_note_attachments(app: AppHandle, note_id: String) -> Result<(), String> {
    let attach_dir = get_attachments_dir(&app, &note_id)?;

    if attach_dir.exists() {
        fs::remove_dir_all(&attach_dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ==========================================
// MinIO 对象存储命令
// ==========================================

/// 加载 MinIO 配置
#[tauri::command]
pub fn load_minio_config(app: AppHandle) -> Result<String, String> {
    let config = config::load_minio_config(&app);
    serde_json::to_string(&config).map_err(|e| e.to_string())
}

/// 保存 MinIO 配置
#[tauri::command]
pub fn save_minio_config(app: AppHandle, config_json: String) -> Result<(), String> {
    let minio_config: minio::MinioConfig =
        serde_json::from_str(&config_json).map_err(|e| e.to_string())?;
    config::save_minio_config(&app, &minio_config)
}

/// 测试 MinIO 连接
#[tauri::command]
pub fn test_minio_connection(config_json: String) -> Result<String, String> {
    let minio_config: minio::MinioConfig =
        serde_json::from_str(&config_json).map_err(|e| e.to_string())?;
    minio::test_connection(&minio_config)
}

/// 上传图片/文件到 MinIO，返回公开访问 URL
/// note_id: 笔记 ID（用于组织对象 key）
/// filename: 文件名
/// binary_base64: base64 编码的文件内容
/// content_type: MIME 类型（如 "image/jpeg"）
#[tauri::command]
pub fn upload_to_minio(
    app: AppHandle,
    _note_id: String,
    filename: String,
    binary_base64: String,
    content_type: String,
) -> Result<String, String> {
    let minio_config = config::load_minio_config(&app);
    if !minio_config.is_valid() {
        return Err("MinIO 未配置或未启用，请先在存储设置中配置 MinIO".to_string());
    }

    // 按内容类型分目录：pdfs/ 或 images/，文件名用时间戳
    let folder = if content_type.contains("pdf") { "pdfs" } else { "images" };
    let safe_name = sanitize_filename(&filename);
    let key = format!("{}/{}", folder, safe_name);

    // 解码 base64
    let bytes = decode_base64(&binary_base64)?;

    // 上传
    let url = minio::upload_object(&minio_config, &key, &bytes, &content_type)?;
    Ok(url)
}

/// 从 MinIO 删除对象
#[tauri::command]
pub fn delete_from_minio(
    app: AppHandle,
    note_id: String,
    filename: String,
) -> Result<(), String> {
    let minio_config = config::load_minio_config(&app);
    if !minio_config.is_valid() {
        return Ok(()); // MinIO 未启用，静默跳过
    }
    let safe_name = sanitize_filename(&filename);
    let key = format!("attachments/{}/{}", note_id, safe_name);
    minio::delete_object(&minio_config, &key)
}

/// 获取 Ngrok 图片（绕过免费版浏览器警告）
/// 前端调用: invoke('fetch_ngrok_image', { url: '...' })
#[tauri::command]
pub fn fetch_ngrok_image(url: String) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("ngrok-skip-browser-warning", "true")
        .send()
        .map_err(|e| format!("Ngrok Fetch Error: {}", e))?;

    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    let b64 = encode_base64(&bytes);

    let lower_url = url.to_lowercase();
    let mime_type = if lower_url.ends_with(".png") {
        "image/png"
    } else if lower_url.ends_with(".jpg") || lower_url.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower_url.ends_with(".gif") {
        "image/gif"
    } else if lower_url.ends_with(".svg") {
        "image/svg+xml"
    } else if lower_url.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };

    Ok(format!("data:{};base64,{}", mime_type, b64))
}
