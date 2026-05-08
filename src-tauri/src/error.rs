// 错误处理模块
// 这个文件目前为空，预留给未来扩展自定义错误类型

// Rust 的错误处理有两种方式：
// 1. 用 String 作为错误（简单场景，我们目前用这种）
// 2. 定义自定义 Error 枚举（生产项目推荐）
//
// 如果将来需要更规范的错误处理，可以这样定义：
//
// use thiserror::Error;
//
// #[derive(Error, Debug)]
// pub enum AppError {
//     #[error("文件读取失败: {0}")]
//     FileRead(#[from] std::io::Error),
//
//     #[error("JSON 解析失败: {0}")]
//     JsonParse(#[from] serde_json::Error),
//
//     #[error("路径错误: {0}")]
//     PathError(String),
// }
