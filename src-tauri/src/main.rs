// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    if matches!(args.next().as_deref(), Some("--hook")) {
        let event = args.next().unwrap_or_else(|| "Unknown".to_string());
        std::process::exit(noobmux_lib::hook_cli(&event));
    }
    noobmux_lib::run()
}
