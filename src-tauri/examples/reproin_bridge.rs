//! Test harness for the reproin bridge minus the Tauri trust gate (used by
//! `scripts/reproin-e2e.ts`).
//!   reproin_bridge plan <root> <options-json> [exclude-top-level...]
//!   reproin_bridge drop <path> <i,j,...>
use std::path::Path;

use bidsvue_lib::reproin::{drop_volumes_to_temp, plan_tree, ReproinOptions};

fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    match a.first().map(String::as_str) {
        Some("plan") if a.len() >= 3 => {
            let opts: ReproinOptions = serde_json::from_str(&a[2]).map_err(|e| e.to_string())?;
            println!("{}", plan_tree(Path::new(&a[1]), &a[3..], &opts)?);
        }
        Some("drop") if a.len() == 3 => {
            let idx = a[2]
                .split(',')
                .map(|s| s.parse().map_err(|_| format!("bad index {s}")))
                .collect::<Result<Vec<usize>, _>>()?;
            println!(
                "{}",
                drop_volumes_to_temp(Path::new(&a[1]), &idx)?.display()
            );
        }
        _ => {
            return Err("usage: plan <root> <options-json> [exclude...] | drop <path> <i,j>".into())
        }
    }
    Ok(())
}
