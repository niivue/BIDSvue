// AI feature-gate read — DEFAULT ON.
//
// `aiFeatureEnabled` is true UNLESS the build was compiled with
// `VITE_BIDSVUE_ENABLE_AI=0`. The AI Rust surface is now compiled into
// every binary (no Cargo `ai` feature — see src-tauri/Cargo.toml), so
// this renderer env var is the RENDERER off-switch ONLY: it gates the
// toolbar tile + the `<AIWindow />` mount + the About-dialog AI rows. It
// does NOT disable the Rust AI commands / `--mcp-server` subcommand — a
// TRUE no-AI build also needs `BIDSVUE_DISABLE_AI=1` (the compile-time
// `ai::ai_disabled_at_build()` Rust gate). See the no-AI recipe below.
//
// Vite replaces `import.meta.env.VITE_BIDSVUE_ENABLE_AI` with the literal
// string at build time, so in a `VITE_BIDSVUE_ENABLE_AI=0` build the
// `{#if aiFeatureEnabled}` branches dead-code out entirely. When the var
// is unset (the default), `undefined !== '0'` is true — AI is shown.
//
// To ship a no-AI DMG: `BIDSVUE_DISABLE_AI=1 bun run release:macos`
// (the release script sets `VITE_BIDSVUE_ENABLE_AI=0`). For a no-AI dev
// session: `bun run dev:no-ai`.
//
// Stable export path: every AI module imports from `$lib/ai/featureFlag`.
export const aiFeatureEnabled: boolean =
  import.meta.env.VITE_BIDSVUE_ENABLE_AI !== '0'
