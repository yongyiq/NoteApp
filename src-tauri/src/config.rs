#![allow(unused)]

// ─────────────────────────────────────────────
// 应用配置管理
// ─────────────────────────────────────────────
//
// 管理应用级别的配置，包括自定义数据目录路径。
// 配置文件存储在: {default_app_data_dir}/app_config.json
// （之所以存在默认目录而非自定义目录，是为了避免鸡生蛋问题）
//
// 同时管理 Gitee 同步配置（向后兼容，仍在原路径）。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;

use crate::gitee::SyncConfig;
use crate::minio::MinioConfig;

// ==========================================
// 应用配置（自定义数据目录等）
// ==========================================

/// 应用配置，存储在默认 AppData 目录中
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    /// 用户自定义的数据存储目录（None 时使用默认 AppData 目录）
    #[serde(rename = "dataDir", skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    /// 用户自定义的附件存储目录（None 时跟随数据目录下的 attachments/）
    #[serde(rename = "attachmentDir", skip_serializing_if = "Option::is_none")]
    pub attachment_dir: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig { data_dir: None, attachment_dir: None }
    }
}

/// 获取默认 AppData 目录（不受自定义配置影响）
pub fn get_default_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// 获取应用配置文件路径（始终在默认 AppData 目录中）
fn get_app_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_default_app_data_dir(app)?;
    // 确保目录存在
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("app_config.json"))
}

/// 加载应用配置
pub fn load_app_config(app: &AppHandle) -> AppConfig {
    let path = match get_app_config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };
    if !path.exists() {
        return AppConfig::default();
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return AppConfig::default(),
    };
    match serde_json::from_str::<AppConfig>(&content) {
        Ok(cfg) => cfg,
        Err(_) => AppConfig::default(),
    }
}

/// 保存应用配置
pub fn save_app_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = get_app_config_path(app)?;
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取数据目录路径（考虑用户自定义配置）
/// 如果配置了自定义目录，返回该目录；否则返回默认 AppData 目录
pub fn get_effective_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let config = load_app_config(app);
    if let Some(ref custom_dir) = config.data_dir {
        let p = PathBuf::from(custom_dir);
        fs::create_dir_all(&p).map_err(|e| format!("无法创建数据目录 {}: {}", custom_dir, e))?;
        return Ok(p);
    }
    // 使用默认目录
    let dir = get_default_app_data_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 获取附件目录路径
/// 如果配置了自定义附件目录，返回该目录；否则返回数据目录下的 attachments/
pub fn get_effective_attachment_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let config = load_app_config(app);
    if let Some(ref custom_dir) = config.attachment_dir {
        let p = PathBuf::from(custom_dir);
        fs::create_dir_all(&p).map_err(|e| format!("无法创建附件目录 {}: {}", custom_dir, e))?;
        return Ok(p);
    }
    // 跟随数据目录
    let dir = get_effective_data_dir(app)?;
    Ok(dir.join("attachments"))
}

// ==========================================
// 同步配置管理（原 config.rs 内容，向下兼容）
// ==========================================

/// 持久化的同步配置文件
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SyncConfigFile {
    #[serde(flatten)]
    pub config: SyncConfig,
}

impl From<SyncConfig> for SyncConfigFile {
    fn from(config: SyncConfig) -> Self {
        Self { config }
    }
}

/// 获取同步配置文件路径（在有效数据目录中）
fn get_sync_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_effective_data_dir(app)?;
    Ok(dir.join("noteflow_sync.json"))
}

/// 加载同步配置
pub fn load_sync_config(app: &AppHandle) -> Result<SyncConfig, String> {
    let path = get_sync_config_path(app)?;
    if !path.exists() {
        return Ok(SyncConfig::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: SyncConfigFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(file.config)
}

/// 保存同步配置
pub fn save_sync_config(app: &AppHandle, config: &SyncConfig) -> Result<(), String> {
    let path = get_sync_config_path(app)?;
    let file = SyncConfigFile::from(config.clone());
    let content = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

// ==========================================
// MinIO 配置管理
// ==========================================

/// 获取 MinIO 配置文件路径（存在默认 AppData 目录中）
fn get_minio_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_default_app_data_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("minio_config.json"))
}

/// 加载 MinIO 配置
pub fn load_minio_config(app: &AppHandle) -> MinioConfig {
    let path = match get_minio_config_path(app) {
        Ok(p) => p,
        Err(_) => return MinioConfig::default(),
    };
    if !path.exists() {
        return MinioConfig::default();
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return MinioConfig::default(),
    };
    serde_json::from_str::<MinioConfig>(&content).unwrap_or_default()
}

/// 保存 MinIO 配置
pub fn save_minio_config(app: &AppHandle, config: &MinioConfig) -> Result<(), String> {
    let path = get_minio_config_path(app)?;
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}
