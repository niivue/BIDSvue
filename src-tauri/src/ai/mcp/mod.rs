// M-AI4 hand-rolled MCP server.
//
// The MCP server is the BIDSvue binary invoked as
// `bidsvue --mcp-server <session-config-path>`. It speaks JSON-RPC
// 2.0 over stdio to its parent (the spawned AI CLI). The parent CLI
// dispatches tool calls to our tools and forwards results back to
// its LLM provider.
//
// MCP protocol surface (v1):
//   - initialize        → returns capabilities + serverInfo
//   - notifications/initialized (one-way, from client)
//   - tools/list        → returns the tool registry
//   - tools/call        → dispatch to a tool handler
//
// Why hand-rolled (not `rmcp`): per Locked decision 19, the M-AI4
// spike picks between `rmcp` and hand-rolled after evaluating
// license / MSRV / dep weight / API stability. `rmcp` is pre-1.0
// and the protocol surface for our needs is small (< 500 LOC), so
// the spike picks hand-rolled. This decision is reversible — when
// `rmcp` reaches 1.0 + a 12-month stability statement, swap.
//
// Read tools (Locked decision 17 caps applied):
//   read_file({path, offset?, length?, binary?})
//     — 64 KiB text / 1 MiB binary default ceilings
//   list_files({path?, recursive?, page?, pageSize?})
//     — pageSize default 200, max 1000
//   get_dataset_summary({}) / run_validator({}) /
//     get_validator_issues({severity?, code?, limit?}) — read-via-bridge
//     (M-AI13): relay to the main app, resolved from datasetStore /
//     diagnosticsStore (the live validator results, NOT a fresh run), no
//     approval gate. run_validator truncates at 128 KiB; get_validator_issues
//     paginates (limit max 1000).
//
// Write tools (M-AI5): save_text_file / save_sidecar / delete_file /
// rename_entity. Surfaced in tools/list and routed through the control
// bridge (Unix socket) to the main BIDSvue process, which holds the
// per-mutation approval gate + MutationLease and drives the TS engines.

pub mod jsonrpc;
pub mod server;
pub mod tools;

pub use server::run_server;
