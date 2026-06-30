// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // AI is now compiled into every build (the renderer `VITE_BIDSVUE_ENABLE_AI`
    // env gate decides whether the UI is exposed). Dispatch
    // `bidsvue --mcp-server <config>` to the MCP server instead of booting the
    // Tauri shell. The MCP subprocess is only ever spawned BY the AI flow, so a
    // renderer-disabled build never reaches this in practice — but the
    // subcommand is always present.
    //
    // Argv parsing is intentionally manual + minimal: one boolean + one
    // positional doesn't justify a clap dep (Locked decision 17 dep-weight
    // discipline).
    {
        let mut argv = std::env::args().skip(1);
        while let Some(arg) = argv.next() {
            if arg == "--mcp-server" {
                if bidsvue_lib::ai::ai_disabled_at_build() {
                    eprintln!("bidsvue: AI is disabled in this build (compiled with BIDSVUE_DISABLE_AI=1)");
                    std::process::exit(3);
                }
                let session_config = argv.next().unwrap_or_else(|| {
                    eprintln!("bidsvue: --mcp-server requires a session-config path");
                    std::process::exit(3);
                });
                bidsvue_lib::ai::run_server(&session_config);
                // `run_server` is `-> !`; control never reaches here.
            }
        }
    }
    bidsvue_lib::run()
}
