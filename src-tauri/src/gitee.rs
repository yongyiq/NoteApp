// ─────────────────────────────────────────────
// Gitee API v5 封装
// ─────────────────────────────────────────────
//
// 用于与 Gitee 仓库交互，实现笔记的云端同步。
// API 文档: https://gitee.com/api/v5/swagger
//
// 核心端点：
//   GET    /repos/{owner}/{repo}/contents/{path}  — 获取文件/目录内容
//   POST   /repos/{owner}/{repo}/contents/{path}  — 创建文件（需要 Base64 编码）
//   PUT    /repos/{owner}/{repo}/contents/{path}  — 更新文件（需要 sha）
//   DELETE /repos/{owner}/{repo}/contents/{path}  — 删除文件（需要 sha）
//   GET    /user                                   — 获取当前用户信息
//
// 认证方式：Personal Access Token（通过 query 参数 access_token）

use serde::{Deserialize, Serialize};

const GITEE_API_BASE: &str = "https://gitee.com/api/v5";

// ==========================================
// 数据结构
// ==========================================

/// 云同步配置（支持 Gitee 和 GitHub）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncConfig {
    /// 同步平台: "gitee" 或 "github"
    #[serde(default = "default_platform")]
    pub platform: String,
    /// Personal Access Token
    pub token: String,
    /// 仓库所有者（用户名或组织名）
    pub owner: String,
    /// 仓库名
    pub repo: String,
    /// 仓库中的目录路径（例如 "noteflow"）
    pub path: String,
    /// 最后同步时间（ISO 8601 格式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<String>,
}

fn default_platform() -> String {
    "gitee".to_string()
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            platform: "gitee".to_string(),
            token: String::new(),
            owner: String::new(),
            repo: String::new(),
            path: String::new(),
            last_sync: None,
        }
    }
}

impl SyncConfig {
    /// 检查配置是否完整可用
    pub fn is_valid(&self) -> bool {
        !self.token.is_empty()
            && !self.owner.is_empty()
            && !self.repo.is_empty()
    }
}

/// Gitee API 返回的文件信息
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct GiteeFile {
    pub name: String,
    pub path: String,
    pub sha: String,
    pub size: i64,
    #[serde(rename = "type")]
    pub file_type: String,
    pub content: Option<String>,
    pub encoding: Option<String>,
}

/// Gitee API 返回的用户信息
#[derive(Debug, Deserialize, Serialize)]
pub struct GiteeUser {
    pub id: i64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

/// 同步结果
#[derive(Debug, Serialize)]
pub struct SyncResult {
    pub success: bool,
    pub message: String,
    /// 同步时间
    pub sync_time: String,
    /// 操作详情
    pub details: Vec<String>,
}

// ==========================================
// API 调用函数
// ==========================================

/// 测试 Gitee Token 是否有效，返回用户信息
pub fn test_connection(token: &str) -> Result<GiteeUser, String> {
    let url = format!("{}/user?access_token={}", GITEE_API_BASE, token);

    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "NoteFlow-App")
        .send()
        .map_err(|e| format!("网络请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Token 验证失败 (HTTP {}): {}",
            resp.status().as_u16(),
            resp.text().unwrap_or_default()
        ));
    }

    resp.json::<GiteeUser>()
        .map_err(|e| format!("解析用户信息失败: {}", e))
}

/// 获取仓库中指定路径的文件内容
/// 返回 (文件内容字符串, sha)
pub fn get_file_content(config: &SyncConfig, path: &str) -> Result<(String, String), String> {
    let full_path = if config.path.is_empty() {
        path.to_string()
    } else {
        format!("{}/{}", config.path, path)
    };

    let url = format!("{}{}?access_token={}", GITEE_API_BASE,
        &format!("/repos/{}/{}/contents/{}", config.owner, config.repo, full_path),
        &config.token,
    );

    println!("[DEBUG] get_file_content URL: {}", url);
    println!("[DEBUG] owner={}, repo={}, full_path={}", config.owner, config.repo, full_path);

    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "NoteFlow-App")
        .send()
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let status = resp.status().as_u16();
    if status == 404 {
        return Err("文件不存在".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("获取文件失败 (HTTP {})", status));
    }

    // 用 Value 容错解析，避免 Gitee 返回格式与 GiteeFile 结构不完全匹配
    let resp_text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;
    let file: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("解析文件信息失败: {} | 响应: {}", e,
            if resp_text.len() > 300 { &resp_text[..300] } else { &resp_text }))?;

    let sha = file.get("sha").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string();

    // Gitee 返回的 content 是 Base64 编码的
    let content = if let Some(encoded) = file.get("content").and_then(|v| v.as_str()) {
        let encoded = encoded.replace('\n', "");
        base64_decode(&encoded)?
    } else {
        String::new()
    };

    Ok((content, sha))
}

/// 创建或更新仓库中的文件
/// 如果 sha 为 None 则创建新文件，否则更新已有文件
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

    let api_path = format!("/repos/{}/{}/contents/{}", config.owner, config.repo, full_path);
    let url = format!("{}{}", GITEE_API_BASE, api_path);

    println!("[DEBUG] put_file_content URL: {}", url);
    println!("[DEBUG] owner={}, repo={}, full_path={}", config.owner, config.repo, full_path);

    let encoded = base64_encode(content);

    let mut body = serde_json::json!({
        "access_token": config.token,
        "content": encoded,
        "message": commit_message,
    });
    if let Some(s) = sha {
        body["sha"] = serde_json::json!(s);
    }

    let client = reqwest::blocking::Client::new();
    // Gitee API: POST 创建文件，PUT 更新文件（有 sha 时）
    let resp = if sha.is_some() {
        client.put(&url).header("User-Agent", "NoteFlow-App").json(&body).send()
    } else {
        client.post(&url).header("User-Agent", "NoteFlow-App").json(&body).send()
    }.map_err(|e| format!("网络请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let error_text = resp.text().unwrap_or_default();
        // 只显示 URL 路径部分，避免泄露 token
        let safe_url = format!("/repos/{}/{}/contents/{}", config.owner, config.repo, full_path);
        return Err(format!(
            "上传文件失败 (HTTP {})\n请求路径: {}\n用户名: {}\n仓库名: {}\n完整路径: {}\nGitee响应: {}",
            status, safe_url, config.owner, config.repo, full_path,
            if error_text.len() > 200 { &error_text[..200] } else { &error_text }
        ));
    }

    // Gitee 返回格式可能不完全匹配 GiteeFile 结构，用 JSON Value 容错处理
    let resp_text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;
    let resp_json: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("解析响应 JSON 失败: {} | 原始响应: {}", e,
            if resp_text.len() > 300 { &resp_text[..300] } else { &resp_text }))?;

    // Gitee POST 响应结构：{ "content": { "sha": "..." } } 或 { "sha": "..." }
    let sha = resp_json.get("content")
        .and_then(|c| c.get("sha"))
        .or_else(|| resp_json.get("sha"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("响应中缺少 sha 字段 | 响应: {}",
            if resp_text.len() > 300 { &resp_text[..300] } else { &resp_text }))?
        .to_string();

    Ok(sha)
}

/// 检查仓库中指定路径的文件是否存在
/// 返回 Option<(sha, content)> 如果存在
pub fn check_file_exists(config: &SyncConfig, path: &str) -> Result<Option<(String, String)>, String> {
    match get_file_content(config, path) {
        Ok((content, sha)) => Ok(Some((sha, content))),
        Err(e) if e == "文件不存在" => Ok(None),
        Err(e) => Err(e),
    }
}

/// 同步笔记数据到 Gitee
/// 将 AppData JSON 上传到 note-data.json
pub fn sync_upload(config: &SyncConfig, app_data: &str) -> Result<SyncResult, String> {
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut details = Vec::new();

    // 1. 检查远程是否已有文件（获取 sha 以便更新）
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

    // 2. 上传/更新 note-data.json
    let commit_msg = format!("[NoteFlow] 同步笔记数据 @ {}", now);
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

/// 从 Gitee 同步笔记数据
/// 下载 note-data.json
pub fn sync_download(config: &SyncConfig) -> Result<SyncResult, String> {
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut details = Vec::new();

    let (content, sha) = get_file_content(config, "note-data.json")?;
    details.push(format!("文件大小: {} 字节", content.len()));
    details.push(format!("远程 SHA: {}...", &sha[..8.min(sha.len())]));

    // 验证 JSON 格式
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

/// Base64 编码（标准，无换行）
fn base64_encode(data: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data.as_bytes())
}

/// Base64 解码
fn base64_decode(data: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    String::from_utf8(bytes).map_err(|e| format!("UTF-8 解码失败: {}", e))
}

// ==========================================
// 附件同步辅助函数
// ==========================================

/// 列出远程仓库中指定目录下的所有文件路径（递归）
/// 返回格式：["attachments/n1/img.png", "attachments/n2/doc.pdf"]
pub fn list_repo_files(config: &SyncConfig, dir_path: &str) -> Result<Vec<String>, String> {
    let full_path = if config.path.is_empty() {
        dir_path.to_string()
    } else {
        format!("{}/{}", config.path, dir_path)
    };

    let url = format!("{}{}?access_token={}&ref=master", GITEE_API_BASE,
        &format!("/repos/{}/{}/contents/{}", config.owner, config.repo, full_path),
        &config.token,
    );

    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "NoteFlow-App")
        .send()
        .map_err(|e| format!("网络请求失败: {}", e))?;

    if resp.status().as_u16() == 404 {
        return Ok(Vec::new()); // 目录不存在，无附件
    }
    if !resp.status().is_success() {
        return Err(format!("列出目录失败 (HTTP {})", resp.status().as_u16()));
    }

    let resp_text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;
    let items: Vec<serde_json::Value> = serde_json::from_str(&resp_text)
        .map_err(|e| format!("解析目录列表失败: {}", e))?;

    let mut files = Vec::new();
    for item in &items {
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let item_path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");

        if item_type == "file" {
            // 去掉仓库根路径前缀，只保留相对路径
            let relative = item_path.strip_prefix(&format!("{}/", config.path))
                .unwrap_or(item_path);
            files.push(relative.to_string());
        } else if item_type == "dir" {
            // 递归遍历子目录
            let sub_relative = item_path.strip_prefix(&format!("{}/", config.path))
                .unwrap_or(item_path);
            let sub_files = list_repo_files(config, sub_relative)?;
            files.extend(sub_files);
        }
    }

    Ok(files)
}

/// 上传二进制附件（以 base64 字符串形式）
pub fn upload_attachment(
    config: &SyncConfig,
    path: &str,
    binary_base64: &str,
    sha: Option<&str>,
    commit_message: &str,
) -> Result<String, String> {
    // binary_base64 已经是 base64 编码，直接作为 Gitee API 的 content 字段
    // 不要再次 base64 编码（put_file_content 会对 content 再做一次 base64_encode，导致双重编码）
    let full_path = if config.path.is_empty() {
        path.to_string()
    } else {
        format!("{}/{}", config.path, path)
    };

    let api_path = format!("/repos/{}/{}/contents/{}", config.owner, config.repo, full_path);
    let url = format!("{}{}", GITEE_API_BASE, api_path);

    let mut body = serde_json::json!({
        "access_token": config.token,
        "content": binary_base64,  // 已经是 base64，直接使用
        "message": commit_message,
    });
    if let Some(s) = sha {
        body["sha"] = serde_json::json!(s);
    }

    let client = reqwest::blocking::Client::new();
    let resp = if sha.is_some() {
        client.put(&url).header("User-Agent", "NoteFlow-App").json(&body).send()
    } else {
        client.post(&url).header("User-Agent", "NoteFlow-App").json(&body).send()
    }.map_err(|e| format!("网络请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let error_text = resp.text().unwrap_or_default();
        let safe_url = format!("/repos/{}/{}/contents/{}", config.owner, config.repo, full_path);
        return Err(format!(
            "上传附件失败 (HTTP {})\n请求路径: {}\nGitee响应: {}",
            status, safe_url,
            if error_text.len() > 300 { &error_text[..300] } else { &error_text }
        ));
    }

    let resp_text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;
    let result: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let new_sha = result.get("content")
        .and_then(|c| c.get("sha"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    Ok(new_sha)
}

/// 下载二进制附件，返回 base64 字符串
pub fn download_attachment(config: &SyncConfig, path: &str) -> Result<String, String> {
    let full_path = if config.path.is_empty() {
        path.to_string()
    } else {
        format!("{}/{}", config.path, path)
    };

    let url = format!("{}{}?access_token={}", GITEE_API_BASE,
        &format!("/repos/{}/{}/contents/{}", config.owner, config.repo, full_path),
        &config.token,
    );

    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "NoteFlow-App")
        .send()
        .map_err(|e| format!("网络请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("下载附件失败 (HTTP {})", resp.status().as_u16()));
    }

    let resp_text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;
    let file: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("解析附件信息失败: {}", e))?;

    // Gitee 返回的 content 字段本身就是 base64 编码，直接返回
    let content = file.get("content").and_then(|v| v.as_str())
        .ok_or("响应中缺少 content 字段")?
        .replace('\n', ""); // Gitee 可能会在 base64 中插入换行

    Ok(content)
}
