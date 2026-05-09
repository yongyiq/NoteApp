#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod error;
mod gitee;
mod minio;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // 分文件存储 API（新）
            commands::load_index,
            commands::load_note,
            commands::load_note_binary,
            commands::save_note,
            commands::delete_note,
            commands::save_folders,
            commands::load_folders,
            commands::save_settings,
            commands::load_settings,
            commands::export_all_data,
            commands::import_all_data,
            // 兼容旧前端 API
            commands::load_notes,
            commands::save_notes,
            // 文件导入/导出
            commands::import_file,
            commands::export_file,
            commands::get_app_data_dir,
            // 数据目录管理
            commands::get_data_directory,
            commands::get_default_data_directory,
            commands::select_data_directory,
            commands::set_data_directory,
            // 云同步
            commands::load_sync_config,
            commands::save_sync_config,
            commands::test_gitee_connection,
            commands::sync_to_gitee,
            commands::sync_from_gitee,
            // 附件管理
            commands::save_attachment,
            commands::get_attachment,
            commands::delete_attachment,
            commands::list_attachments,
            commands::delete_note_attachments,
            // 附件目录管理
            commands::get_attachment_directory,
            commands::get_default_attachment_directory,
            commands::select_attachment_directory,
            commands::set_attachment_directory,
            // MinIO 对象存储
            commands::load_minio_config,
            commands::save_minio_config,
            commands::test_minio_connection,
            commands::upload_to_minio,
            commands::delete_from_minio,
            commands::fetch_ngrok_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
