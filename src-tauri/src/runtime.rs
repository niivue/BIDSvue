//! Long-running spawn support: per-handle cancellation registry shared
//! across every long-running Rust command (native DataLad fetch / clone
//! / subdataset install, OpenNeuro upload, …). Kept separate from
//! `process.rs` so the argv validators don't grow another dependency.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

/// Per-handle cancellation registry. Native long-running Rust commands
/// (DataLad fetch / clone / subdataset install, OpenNeuro upload)
/// register a `Notify` keyed by a renderer-supplied opaque handle when
/// the operation starts and deregister when it ends. The renderer-
/// facing `cancel_datalad_op` Tauri command fires the registry entry
/// to drive each command's `tokio::select!` arm into its kill path.
///
/// Audit (Round-33 P1 #4) race: the renderer can attach an abort
/// listener BEFORE the corresponding invoke reaches Rust. If the
/// signal fires in that window, `cancel_datalad_op` would previously
/// return `false` and the spawn would proceed uninterrupted. The
/// registry now stores a sticky `PreCancelled` marker for cancels
/// that arrive before registration; `register` observes the marker
/// and fires the new `Notify` immediately so the spawn's `select!`
/// exits before reading any pipes.
///
/// Pre-cancel entries are capped (`PRE_CANCEL_CAP`) so a buggy or
/// hostile renderer spamming cancels with random handles can't grow
/// the map unbounded; FIFO eviction drops the oldest pre-cancel when
/// full.
#[derive(Default)]
pub struct CancellationRegistry {
    handles: Mutex<HashMap<String, Entry>>,
    pre_cancel_order: Mutex<VecDeque<String>>,
}

enum Entry {
    Live(Arc<Notify>),
    PreCancelled,
}

const PRE_CANCEL_CAP: usize = 64;

impl CancellationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `handle` with a fresh `Notify`. Returns the
    /// `Arc<Notify>` so the caller can `select!` on `notified()`.
    ///
    /// If a `cancel_datalad_op` already arrived for this handle
    /// (race window before this register), the returned `Notify` is
    /// fired immediately. The caller's `select!` arm therefore sees
    /// the cancellation on its first poll and starts the kill path
    /// before the child ever produces output.
    ///
    /// Returns `Err` if `handle` is already registered as `Live` —
    /// a fresh registration must not silently shadow an in-flight
    /// op (audit_temp round-33 P2 #8).
    pub fn register(&self, handle: String) -> Result<Arc<Notify>, String> {
        let notify = Arc::new(Notify::new());
        let mut map = self
            .handles
            .lock()
            .expect("cancellation registry mutex poisoned");
        match map.get(&handle) {
            Some(Entry::Live(_)) => {
                return Err(format!(
                    "CancellationRegistry::register: handle {handle} is already registered to a live operation"
                ));
            }
            Some(Entry::PreCancelled) => {
                // Race: cancel arrived first. Drop the marker, store
                // the live entry, and arm a notify PERMIT so the
                // caller's `notified()` returns immediately on its
                // first poll. `notify_one()` (vs notify_waiters)
                // stores a permit when no waiter is registered yet,
                // which is exactly the pre-cancel case.
                map.insert(handle.clone(), Entry::Live(notify.clone()));
                self.drop_from_pre_cancel_order(&handle);
                notify.notify_one();
            }
            None => {
                map.insert(handle, Entry::Live(notify.clone()));
            }
        }
        Ok(notify)
    }

    /// Remove `handle` from the registry. Idempotent. Callers
    /// should `deregister` from a `finally`-style block so a spawn
    /// that completes (success or failure) doesn't leak an entry
    /// the renderer could later cancel into the void. Also drops a
    /// pre-cancel marker if one happens to be present (defensive —
    /// the normal pre-cancel → register path clears it already).
    pub fn deregister(&self, handle: &str) {
        let mut map = self
            .handles
            .lock()
            .expect("cancellation registry mutex poisoned");
        if map.remove(handle).is_some() {
            self.drop_from_pre_cancel_order(handle);
        }
    }

    /// Fire the cancellation notify for `handle`. Returns `true`
    /// in every case the cancel has effect (either a live op was
    /// signalled, or a pre-cancel marker was recorded for an
    /// upcoming register). Returns `false` only when `handle` is
    /// already pre-cancelled (idempotent no-op).
    pub fn cancel(&self, handle: &str) -> bool {
        let mut map = self
            .handles
            .lock()
            .expect("cancellation registry mutex poisoned");
        match map.get(handle) {
            Some(Entry::Live(notify)) => {
                // `notify_one()` wakes a parked waiter OR stores a
                // permit for the next park. Either way, the spawn's
                // `select!` arm sees the cancel.
                notify.notify_one();
                true
            }
            Some(Entry::PreCancelled) => false,
            None => {
                // Record a pre-cancel marker. Cap the queue so a
                // renderer can't grow the map indefinitely.
                let mut order = self
                    .pre_cancel_order
                    .lock()
                    .expect("cancellation pre_cancel_order mutex poisoned");
                if order.len() >= PRE_CANCEL_CAP {
                    if let Some(oldest) = order.pop_front() {
                        map.remove(&oldest);
                    }
                }
                map.insert(handle.to_string(), Entry::PreCancelled);
                order.push_back(handle.to_string());
                true
            }
        }
    }

    fn drop_from_pre_cancel_order(&self, handle: &str) {
        let mut order = self
            .pre_cancel_order
            .lock()
            .expect("cancellation pre_cancel_order mutex poisoned");
        order.retain(|h| h != handle);
    }

    /// Test-only: count of registered handles (live + pre-cancelled).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.handles
            .lock()
            .expect("cancellation registry mutex poisoned")
            .len()
    }
}

/// RAII guard around a [`CancellationRegistry`] entry plus an optional
/// watchdog that flips an [`AtomicBool`] when the registry's `Notify`
/// fires.
///
/// Replaces the hand-rolled "register notify → spawn watchdog → run
/// blocking work → abort watchdog → deregister" boilerplate that lived
/// in three native DataLad command handlers. Drop is the single
/// cleanup site so an early `?`-return on a `spawn_blocking` join error
/// (or any other path through the function body) still aborts the
/// watchdog and frees the registry slot. External audit (2026-06-14)
/// found three live leak paths through `?`-returns; this guard closes
/// the whole class.
pub struct CancellationScope<'a> {
    registry: &'a CancellationRegistry,
    handle: Option<String>,
    notify: Option<Arc<Notify>>,
    watchdog: Option<tokio::task::JoinHandle<()>>,
    interrupt: Arc<std::sync::atomic::AtomicBool>,
}

impl<'a> CancellationScope<'a> {
    /// Register `handle` (if `Some`). The returned guard releases the
    /// registry entry on Drop. No watchdog is spawned — callers consume
    /// the `Notify` directly via [`Self::notify`] for `select!`-based
    /// fetch loops.
    pub fn register(
        registry: &'a CancellationRegistry,
        handle: Option<&str>,
    ) -> Result<Self, String> {
        let (handle_owned, notify) = match handle {
            Some(h) => (Some(h.to_string()), Some(registry.register(h.to_string())?)),
            None => (None, None),
        };
        Ok(Self {
            registry,
            handle: handle_owned,
            notify,
            watchdog: None,
            interrupt: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// Like [`Self::register`] but also spawns a watchdog that flips
    /// [`Self::interrupt`] to `true` when the `Notify` fires. For
    /// callers that thread `should_interrupt: &AtomicBool` into a
    /// blocking gix call.
    pub fn register_with_interrupt(
        registry: &'a CancellationRegistry,
        handle: Option<&str>,
    ) -> Result<Self, String> {
        let mut scope = Self::register(registry, handle)?;
        if let Some(notify) = scope.notify.clone() {
            let interrupt = scope.interrupt.clone();
            scope.watchdog = Some(tokio::spawn(async move {
                notify.notified().await;
                interrupt.store(true, std::sync::atomic::Ordering::SeqCst);
            }));
        }
        Ok(scope)
    }

    /// `Some(notify)` while the guard owns a registry entry.
    pub fn notify(&self) -> Option<Arc<Notify>> {
        self.notify.clone()
    }

    /// `AtomicBool` that flips to `true` if a watchdog was spawned and
    /// the cancellation `Notify` has fired. Always present (false by
    /// default) so plumbing through to `should_interrupt` doesn't need
    /// to branch on watchdog presence.
    pub fn interrupt(&self) -> Arc<std::sync::atomic::AtomicBool> {
        self.interrupt.clone()
    }
}

impl Drop for CancellationScope<'_> {
    fn drop(&mut self) {
        // Outer-future-drop semantics (audit 2026-06-14 round 4 P2):
        // when the Tauri command future is dropped (renderer
        // disconnect mid-clone, panic in a sibling future, etc.)
        // tokio drops the `JoinHandle` for `spawn_blocking` but the
        // blocking task keeps running detached. The watchdog
        // ordinarily flips `interrupt` only when the `Notify` fires;
        // an outer-future drop never fires the Notify, so the
        // blocking gix loop would never see the cancel. Set
        // `interrupt = true` AND fire the `Notify` (for fetch loops
        // that poll the registry `Notify` directly) BEFORE aborting
        // the watchdog so the detached work has a uniform signal.
        //
        // When the function completes normally and Drop runs at
        // end-of-scope, the spawn_blocking has already resolved so
        // these stores are observed by nobody — no harm done.
        self.interrupt
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(notify) = self.notify.take() {
            notify.notify_one();
        }
        if let Some(wd) = self.watchdog.take() {
            wd.abort();
        }
        if let Some(h) = self.handle.take() {
            self.registry.deregister(&h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_register_and_cancel_returns_true() {
        let reg = CancellationRegistry::new();
        reg.register("abc".to_string()).unwrap();
        assert!(reg.cancel("abc"));
    }

    #[test]
    fn cancellation_cancel_unknown_records_pre_cancel() {
        // Round-33 P1 #4: cancel arriving before register is sticky.
        // The first cancel returns true (effect: marker stored);
        // the second returns false (idempotent no-op).
        let reg = CancellationRegistry::new();
        assert!(reg.cancel("does-not-exist"));
        assert!(!reg.cancel("does-not-exist"));
    }

    #[test]
    fn cancellation_deregister_removes_entry() {
        let reg = CancellationRegistry::new();
        reg.register("h".to_string()).unwrap();
        assert_eq!(reg.len(), 1);
        reg.deregister("h");
        assert_eq!(reg.len(), 0);
        // After deregister, the handle behaves like a never-registered
        // one — cancel records a fresh pre-cancel marker.
        assert!(reg.cancel("h"));
    }

    #[tokio::test]
    async fn cancellation_scope_drops_registry_entry_on_early_return() {
        let reg = CancellationRegistry::new();
        {
            let _scope = CancellationScope::register(&reg, Some("h1")).unwrap();
            assert_eq!(reg.len(), 1);
            // Simulate an early `?`-return: scope falls out of the
            // block without an explicit cleanup call.
        }
        assert_eq!(reg.len(), 0, "Drop should have released the registry slot");
    }

    #[tokio::test]
    async fn cancellation_scope_with_interrupt_flips_on_cancel() {
        use std::sync::atomic::Ordering;
        let reg = CancellationRegistry::new();
        let scope = CancellationScope::register_with_interrupt(&reg, Some("h2")).unwrap();
        let interrupt = scope.interrupt();
        assert!(!interrupt.load(Ordering::SeqCst));
        assert!(reg.cancel("h2"));
        // Yield until the watchdog observes the notify.
        for _ in 0..50 {
            if interrupt.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(interrupt.load(Ordering::SeqCst));
        drop(scope);
        assert_eq!(reg.len(), 0);
    }

    #[tokio::test]
    async fn cancellation_scope_none_handle_is_noop() {
        let reg = CancellationRegistry::new();
        let scope = CancellationScope::register_with_interrupt(&reg, None).unwrap();
        assert!(scope.notify().is_none());
        assert_eq!(reg.len(), 0);
        drop(scope);
        assert_eq!(reg.len(), 0);
    }

    #[tokio::test]
    async fn cancellation_scope_drop_flips_interrupt_even_without_cancel() {
        // Audit 2026-06-14 round 4 P2 — when the Tauri command future
        // is dropped mid-await (renderer disconnect), the blocking
        // task must see `interrupt = true` so it can poll its way to
        // an exit even though no one fired the registry's `Notify`.
        use std::sync::atomic::Ordering;
        let reg = CancellationRegistry::new();
        let interrupt = {
            let scope = CancellationScope::register_with_interrupt(&reg, Some("drop-flips"))
                .expect("register");
            scope.interrupt()
            // scope drops here — simulates outer-future drop.
        };
        assert!(
            interrupt.load(Ordering::SeqCst),
            "Drop must set interrupt=true so detached spawn_blocking work observes the signal"
        );
        assert_eq!(reg.len(), 0);
    }

    #[tokio::test]
    async fn cancellation_scope_drop_fires_notify_for_select_loops() {
        // Fetch path uses `notify` directly via `select!`. Drop must
        // fire the notify so a fetch loop observing an outer-future
        // drop completes promptly.
        let reg = CancellationRegistry::new();
        let scope = CancellationScope::register(&reg, Some("drop-notifies")).expect("register");
        let notify = scope.notify().expect("notify present");
        drop(scope);
        // notify_one() stored a permit on the Arc<Notify>; a fresh
        // notified() returns immediately.
        tokio::time::timeout(std::time::Duration::from_millis(100), notify.notified())
            .await
            .expect("Drop must arm the Notify for select! fetch loops");
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn cancellation_double_cancel_is_idempotent() {
        let reg = CancellationRegistry::new();
        reg.register("h".to_string()).unwrap();
        assert!(reg.cancel("h"));
        assert!(reg.cancel("h"));
    }

    #[test]
    fn cancellation_deregister_unknown_is_noop() {
        let reg = CancellationRegistry::new();
        reg.deregister("nothing-here"); // does not panic
    }

    #[test]
    fn cancellation_register_rejects_duplicate_live_handle() {
        // Round-33 P2 #8: double-register of a live handle must
        // error rather than silently shadow.
        let reg = CancellationRegistry::new();
        reg.register("h".to_string()).unwrap();
        let err = reg.register("h".to_string()).unwrap_err();
        assert!(err.contains("already registered"), "got: {err}");
    }

    #[tokio::test]
    async fn cancellation_pre_cancel_fires_immediately_on_register() {
        // Round-33 P1 #4 race: cancel arrives before register.
        // Register must return a Notify that is ALREADY signalled.
        let reg = CancellationRegistry::new();
        assert!(reg.cancel("h"));
        let notify = reg.register("h".to_string()).unwrap();
        // The fresh notify was fired by register; a notified()
        // future created AFTER the firing parks. But notify_waiters
        // queues a "permit" only for current waiters, not future
        // ones — by design. So the spawn's select! arm that calls
        // `notified()` AFTER register must still see the wake. To
        // model that, race against a 1s timeout.
        let r =
            tokio::time::timeout(std::time::Duration::from_millis(100), notify.notified()).await;
        assert!(
            r.is_ok(),
            "pre-cancelled register's notify must fire promptly"
        );
    }

    #[test]
    fn cancellation_pre_cancel_cap_evicts_oldest() {
        // Round-33 P1 #4: pre-cancel queue is bounded; renderer
        // can't grow the map indefinitely by spamming cancel.
        let reg = CancellationRegistry::new();
        for i in 0..(PRE_CANCEL_CAP + 5) {
            reg.cancel(&format!("h-{i}"));
        }
        assert!(reg.len() <= PRE_CANCEL_CAP);
        // The very first ones should have been evicted.
        let first = reg.cancel("h-0");
        // After eviction, h-0 is no longer pre-cancelled — cancel
        // returns true (new marker recorded).
        assert!(first);
    }

    #[tokio::test]
    async fn cancellation_notify_wakes_waiter() {
        let reg = CancellationRegistry::new();
        let notify = reg.register("h".to_string()).unwrap();
        // Spawn a waiter that should wake when we cancel.
        let waiter = tokio::spawn(async move {
            notify.notified().await;
        });
        // Brief yield so the waiter parks on notified().
        tokio::task::yield_now().await;
        assert!(reg.cancel("h"));
        // Should resolve promptly; timeout to fail fast if the
        // implementation regresses.
        let r = tokio::time::timeout(std::time::Duration::from_secs(1), waiter).await;
        assert!(r.is_ok(), "waiter did not wake within 1s");
    }
}
