fn main() {
    // `ai::ai_disabled_at_build()` reads this via `option_env!`; force a
    // rebuild when the operator toggles the no-AI flag.
    println!("cargo:rerun-if-env-changed=BIDSVUE_DISABLE_AI");
    tauri_build::build()
}
