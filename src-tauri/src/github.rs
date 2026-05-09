// ─────────────────────────────────────────────
// GitHub API 封装
// ─────────────────────────────────────────────
//
// 与 gitee.rs 对称，用于与 GitHub 仓库交互。
// API 文档: https://docs.github.com/en/rest/repos/contents
//
// 核心差异：
//   认证方式：Authorization: Bearer <token>（header）
//   创建/更新文件都用 PUT
//   响应格式与 Gitee 基本一致

use serde::{Deserialize, Serialize};
use crate::gitee::{SyncConfig, SyncResult};

const GITHUB_API_BASE: &str = "https://api.github.com";

/// GitHub 用户信息
#[derive(Debug, Deserialize, Serialize)]
pub struct GithubUser {
    pub id: i64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

// ==========================================
// API 调用函数
// ==========================================

/// 测试 GitHub Token 是否有效
pub fn test_connection(token: &str) -> Result<GithubUser, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(&format!("{}/user", GITHUB_API_BASE))
        .header("User-Agent", "NoteFlow-App")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .map_err(|e| format!("网络请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Token 验证失败 (HTTP {}): {}",
            resp.status().as_u16(),
            resp.text().unwrap_or_default()
        ));
    }

    resp.json::<GithubUser>()
        .map_err(|e| format!("解析用户信息失败: {}", e))
}

/// 获取文件内容，返回 (content, sha)
pub fn get_file_content(config: &SyncConfig, path: &str) -> Result<(String, String), String> {
    let full_path = if config.path.is_empty() {
        path.to_string()
    } else {
        format!("{}/{}", config.path, path)
    };

    let url = format!(
        "{}/repos/{}/{}/contents/{}",
        GITHUB_API_BASE, config.owner, config.repo, full_path
    );

    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "NoteFlow-App")
        .header("Authorization", format!("Bearer {}", config.token))
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let status = resp.status().as_u16();
    if status == 404 {
        return Err("文件不存在".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("获取文件失败 (HTTP {})", status));
    }

    let resp_text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;
    let file: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("解析文件信息失败: {}", e))?;

    let sha = file.get("sha").and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let content = if let Some(encoded) = file.get("content").and_then(|v| v.as_str()) {
        let encoded = encoded.replace('\n', "").replace('\r', "");
        base64_decode(&encoded)?
    } else {
        String::new()
    };

    Ok((content, sha))
}

/// 创建或更新文件（GitHub 统一使用 PUT）
pub fn put_file_content(
    config: &SyncConfig,
    path: &str,
    content: &str,
    sha: Option<&str>,
    commit_message: &str,
) -> Result<String, String> {
    let full_path = if config.path.is_empty() {
        path.to_string()
    } else {
        format!("{}/{}", config.path, path)
    };

    let url = format!(
        "{}/repos/{}/{}/contents/{}",
        GITHUB_API_BASE, config.owner, config.repo, full_path
    );

    let encoded = base64_encode(content);

    let mut body = serde_json::json!({
        "message": commit_message,
        "content": encoded,
    });
    if let Some(s) = sha {
        body["sha"] = serde_json::json!(s);
    }

    let client = reqwest::blocking::Client::new();
    // GitHub 创建和更新都用 PUT
    let resp = client
        .put(&url)
        .header("User-Agent", "NoteFlow-App")
        .header("Authorization", format!("Bearer {}", config.token))
        .header("Accept", "application/vnd.github.v3+json")
        .json(&body)
        .send()
        .map_err(|e| format!("网络请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let error_text = resp.text().unwrap_or_default();
        return Err(format!(
            "上传文件失败 (HTTP {})\\nGitHub 响应: {}",
            status,
            if error_text.len() > 200 { &error_text[..200] } else { &error_text }
        ));
    }

    let resp_text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;
    let resp_json: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let sha = resp_json.get("content")
        .and_then(|c| c.get("sha"))
        .or_else(|| resp_json.get("sha"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(sha)
}

/// 检查文件是否存在
pub fn check_file_exists(config: &SyncConfig, path: &str) -> Result<Option<(String, String)>, String> {
    match get_file_content(config, path) {
        Ok((content, sha)) => Ok(Some((sha, content))),
        Err(e) if e == "文件不存在" => Ok(None),
        Err(e) => Err(e),
    }
}

/// 上传笔记数据到 GitHub
pub fn sync_upload(config: &SyncConfig, app_data: &str) -> Result<SyncResult, String> {
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut details = Vec::new();

    let sha = match check_file_exists(config, "note-data.json")? {
        Some((sha, _)) => {
            details.push("远程文件已存在，执行更新".to_string());
            Some(sha)
        }
        None => {
            details.push("远程文件不存在，执行创建".to_string());
            None
        }
    };

    let commit_msg = format!("[NoteFlow] Sync @ {}", now);
    let new_sha = put_file_content(
        config,
        "note-data.json",
        app_data,
        sha.as_deref(),
        &commit_msg,
    )?;

    details.push(format!("note-data.json 已更新 (sha: {}...)", &new_sha[..8.min(new_sha.len())]));

    Ok(SyncResult {
        success: true,
        message: "上传成功".to_string(),
        sync_time: now,
        details,
    })
}

/// 从 GitHub 下载笔记数据
pub fn sync_download(config: &SyncConfig) -> Result<SyncResult, String> {
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut details = Vec::new();

    let (content, sha) = get_file_content(config, "note-data.json")?;
    details.push(format!("文件大小: {} 字节", content.len()));
    details.push(format!("远程 SHA: {}...", &sha[..8.min(sha.len())]));

    match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(v) => {
            if let Some(notes) = v.get("notes").and_then(|n| n.as_array()) {
                details.push(format!("远程包含 {} 篇笔记", notes.len()));
            }
        }
        Err(e) => {
            return Err(format!("远程数据格式错误: {}", e));
        }
    }

    Ok(SyncResult {
        success: true,
        message: content,
        sync_time: now,
        details,
    })
}

// ==========================================
// 辅助函数
// ==========================================

fn base64_encode(data: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data.as_bytes())
}

fn base64_decode(data: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    String::from_utf8(bytes).map_err(|e| format!("UTF-8 解码失败: {}", e))
}
