use tauri::Manager;

#[tauri::command]
fn get_visited_districts(app: tauri::AppHandle) -> Vec<String> {
    let data_dir = app.path().app_data_dir().unwrap();
    let file = data_dir.join("visited.json");
    if file.exists() {
        let content = std::fs::read_to_string(file).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    }
}

#[tauri::command]
fn save_visited_districts(app: tauri::AppHandle, districts: Vec<String>) -> bool {
    let data_dir = app.path().app_data_dir().unwrap();
    std::fs::create_dir_all(&data_dir).ok();
    let file = data_dir.join("visited.json");
    let content = serde_json::to_string(&districts).unwrap_or_default();
    std::fs::write(file, content).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_visited_districts,
            save_visited_districts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
