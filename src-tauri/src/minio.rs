// ─────────────────────────────────────────────
// MinIO / S3 兼容对象存储 API 封装
// ─────────────────────────────────────────────
//
// 通过 ngrok 隧道访问自建 MinIO 服务。
// 使用 MinIO HTTP API（S3 兼容）：
//   PUT  /{bucket}/{key}             — 上传对象（需要签名或预签名）
//   GET  /{bucket}/{key}             — 下载对象（公开 bucket 无需签名）
//   HEAD /{bucket}/{key}             — 检查对象是否存在
//   DELETE /{bucket}/{key}           — 删除对象
//
// 认证：AWS Signature V4（HMAC-SHA256）
//
// 注意：ngrok 免费版 URL 可能带有浏览器警告页，使用 API 时需加请求头
//   ngrok-skip-browser-warning: true

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use chrono::Utc;

// ==========================================
// 数据结构
// ==========================================

/// MinIO 连接配置
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MinioConfig {
    /// MinIO 服务 URL（例如 https://pedometer-dweller-encounter.ngrok-free.dev）
    pub endpoint: String,
    /// 存储桶名称（例如 noteflow-images）
    pub bucket: String,
    /// Access Key（MinIO 用户名）
    pub access_key: String,
    /// Secret Key（MinIO 密码）
    pub secret_key: String,
    /// 是否启用 MinIO 存储（false 时退回到本地附件存储）
    #[serde(default)]
    pub enabled: bool,
    /// 区域（S3 必须，MinIO 通常用 us-east-1）
    #[serde(default = "default_region")]
    pub region: String,
}

fn default_region() -> String {
    "us-east-1".to_string()
}

impl Default for MinioConfig {
    fn default() -> Self {
        MinioConfig {
            endpoint: "https://pedometer-dweller-encounter.ngrok-free.dev".to_string(),
            bucket: "noteflow-images".to_string(),
            access_key: "admin_minio".to_string(),
            secret_key: "admin_minio".to_string(),
            enabled: true,
            region: "us-east-1".to_string(),
        }
    }
}

impl MinioConfig {
    pub fn is_valid(&self) -> bool {
        self.enabled
            && !self.endpoint.is_empty()
            && !self.bucket.is_empty()
            && !self.access_key.is_empty()
            && !self.secret_key.is_empty()
    }

    /// 获取对象的公开访问 URL（不含签名，适用于公开 bucket）
    pub fn public_url(&self, key: &str) -> String {
        let endpoint = self.endpoint.trim_end_matches('/');
        format!("{}/{}/{}", endpoint, self.bucket, key)
    }
}

// ==========================================
// AWS Signature V4 实现（用于 PUT 请求）
// ==========================================

/// HMAC-SHA256
fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    // 使用自实现的 HMAC-SHA256（避免引入额外依赖）
    // RFC 2104: HMAC(K, text) = H((K XOR opad) || H((K XOR ipad) || text))
    const BLOCK_SIZE: usize = 64;
    const HASH_SIZE: usize = 32;

    // 规范化 key
    let mut key_buf = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let h = sha256(key);
        key_buf[..HASH_SIZE].copy_from_slice(&h);
    } else {
        key_buf[..key.len()].copy_from_slice(key);
    }

    // ipad = 0x36 xor key
    let mut ipad_key: Vec<u8> = key_buf.iter().map(|b| b ^ 0x36).collect();
    ipad_key.extend_from_slice(data);

    // opad = 0x5c xor key
    let mut opad_key: Vec<u8> = key_buf.iter().map(|b| b ^ 0x5c).collect();
    opad_key.extend_from_slice(&sha256(&ipad_key));

    sha256(&opad_key)
}

/// SHA-256 哈希
fn sha256(data: &[u8]) -> Vec<u8> {
    // SHA-256 实现（RFC 6234）
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    // 预处理：填充
    let bit_len = data.len() as u64 * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    // 处理每个 512-bit 块
    for block in padded.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[i*4], block[i*4+1], block[i*4+2], block[i*4+3]]);
        }
        for i in 16..64 {
            let s0 = w[i-15].rotate_right(7) ^ w[i-15].rotate_right(18) ^ (w[i-15] >> 3);
            let s1 = w[i-2].rotate_right(17) ^ w[i-2].rotate_right(19) ^ (w[i-2] >> 10);
            w[i] = w[i-16].wrapping_add(s0).wrapping_add(w[i-7]).wrapping_add(s1);
        }

        let mut a = h[0]; let mut b = h[1]; let mut c = h[2]; let mut d = h[3];
        let mut e = h[4]; let mut f = h[5]; let mut g = h[6]; let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g; g = f; f = e;
            e = d.wrapping_add(temp1);
            d = c; c = b; b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c); h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e); h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g); h[7] = h[7].wrapping_add(hh);
    }

    let mut out = Vec::with_capacity(32);
    for word in h.iter() {
        out.extend_from_slice(&word.to_be_bytes());
    }
    out
}

/// 字节数组转十六进制字符串
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// RFC 3986 URI 编码（AWS V4 要求）
fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut result = String::with_capacity(input.len() * 3);
    for b in input.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                result.push(b as char);
            }
            b'/' => {
                if encode_slash {
                    result.push_str("%2F");
                } else {
                    result.push('/');
                }
            }
            _ => {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}

/// AWS Signature V4 签名生成
/// 返回 Authorization 请求头值
pub fn sign_v4(
    config: &MinioConfig,
    method: &str,       // "PUT", "GET", "DELETE"
    key: &str,           // 对象路径（不含 bucket）
    content_hash: &str, // SHA-256(body) hex，空体用 "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    content_type: &str, // "image/jpeg" 等，空体传 ""
    content_length: usize,
    date_str: &str,     // "20240101T120000Z"
) -> (BTreeMap<String, String>, String) {
    let date_only = &date_str[..8]; // "20240101"
    let endpoint = config.endpoint.trim_end_matches('/');

    // 解析 host（去掉协议前缀）
    let host = endpoint
        .trim_start_matches("https://")
        .trim_start_matches("http://");

    let raw_uri = if key.is_empty() {
        format!("/{}", config.bucket)
    } else {
        format!("/{}/{}", config.bucket, key)
    };
    let canonical_uri = uri_encode(&raw_uri, false);
    let canonical_querystring = "";
    let canonical_headers = format!(
        "content-length:{}\ncontent-type:{}\nhost:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        content_length, content_type, host, content_hash, date_str
    );
    let signed_headers = "content-length;content-type;host;x-amz-content-sha256;x-amz-date";

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method, canonical_uri, canonical_querystring,
        canonical_headers, signed_headers, content_hash
    );

    let credential_scope = format!("{}/{}/s3/aws4_request", date_only, config.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        date_str, credential_scope, hex(&sha256(canonical_request.as_bytes()))
    );

    // 派生签名 key
    let signing_key = {
        let k_date = hmac_sha256(
            format!("AWS4{}", config.secret_key).as_bytes(),
            date_only.as_bytes(),
        );
        let k_region = hmac_sha256(&k_date, config.region.as_bytes());
        let k_service = hmac_sha256(&k_region, b"s3");
        hmac_sha256(&k_service, b"aws4_request")
    };

    let signature = hex(&hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{},SignedHeaders={},Signature={}",
        config.access_key, credential_scope, signed_headers, signature
    );

    // 返回需要手动设置的头
    // 注意：content-length 和 host 参与签名计算，但不在此返回（由 reqwest 自动处理）
    // 但 reqwest 的 .body() 设置后自动加 Content-Length，必须确保值一致
    let mut headers = BTreeMap::new();
    headers.insert("Authorization".to_string(), authorization);
    headers.insert("x-amz-date".to_string(), date_str.to_string());
    headers.insert("x-amz-content-sha256".to_string(), content_hash.to_string());
    headers.insert("content-type".to_string(), content_type.to_string());
    headers.insert("content-length".to_string(), content_length.to_string());
    headers.insert("host".to_string(), host.to_string());
    headers.insert("ngrok-skip-browser-warning".to_string(), "true".to_string());
    (headers, canonical_uri)
}

// ==========================================
// MinIO API 操作
// ==========================================

/// 上传对象到 MinIO
/// binary_data: 原始字节
/// key: 对象路径（例如 "attachments/noteId/filename.jpg"）
/// content_type: MIME 类型
/// 返回对象的公开 URL
pub fn upload_object(
    config: &MinioConfig,
    key: &str,
    binary_data: &[u8],
    content_type: &str,
) -> Result<String, String> {
    let now = Utc::now();
    let date_str = now.format("%Y%m%dT%H%M%SZ").to_string();

    let body_hash = hex(&sha256(binary_data));
    let (headers, canonical_uri) = sign_v4(
        config, "PUT", key, &body_hash, content_type,
        binary_data.len(), &date_str,
    );

    let endpoint = config.endpoint.trim_end_matches('/');
    let url = format!("{}{}", endpoint, canonical_uri);

    let client = reqwest::blocking::Client::new();
    let mut req = client.put(&url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req = req.body(binary_data.to_vec());

    let resp = req.send().map_err(|e| format!("网络请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().unwrap_or_default();
        return Err(format!("上传失败 (HTTP {}): {}", status,
            if body.len() > 300 { &body[..300] } else { &body }));
    }

    Ok(config.public_url(key))
}

/// 删除 MinIO 对象
pub fn delete_object(config: &MinioConfig, key: &str) -> Result<(), String> {
    let now = Utc::now();
    let date_str = now.format("%Y%m%dT%H%M%SZ").to_string();

    // 空体哈希
    let body_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let (headers, canonical_uri) = sign_v4(config, "DELETE", key, body_hash, "", 0, &date_str);

    let endpoint = config.endpoint.trim_end_matches('/');
    let url = format!("{}{}", endpoint, canonical_uri);

    let client = reqwest::blocking::Client::new();
    let mut req = client.delete(&url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let resp = req.send().map_err(|e| format!("网络请求失败: {}", e))?;

    if !resp.status().is_success() && resp.status().as_u16() != 204 {
        let status = resp.status().as_u16();
        return Err(format!("删除失败 (HTTP {})", status));
    }

    Ok(())
}

/// 测试 MinIO 连接（尝试上传一个极小的测试文件）
pub fn test_connection(config: &MinioConfig) -> Result<String, String> {
    let test_data = b"noteflow-minio-test";
    let test_key = ".noteflow-test";
    upload_object(config, test_key, test_data, "text/plain")?;
    // 清理测试文件（忽略错误）
    let _ = delete_object(config, test_key);
    Ok(format!("连接成功！Endpoint: {}, Bucket: {}", config.endpoint, config.bucket))
}
