/**
 * In-process signal fired when an order changes in a way a waiting checkout page cares about
 * (marked paid, merchant notification confirmed). Single-instance deployment, so no broker needed.
 */
type Listener = (orderId: string) => void;

const listeners = new Set<Listener>();

export function onOrderEvent(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitOrderEvent(orderId: string) {
  for (const listener of [...listeners]) {
    try {
      listener(orderId);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "order_event_listener_failed", message: error instanceof Error ? error.message : String(error) }));
    }
  }
}

/**
 * Resolves when `isDone()` holds, re-checked on every event for this order, or when the timeout/abort fires.
 * Subscribes before the first check so an event between the caller's read and the wait is never missed.
 */
export function waitForOrder(orderId: string, isDone: () => boolean, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      unsubscribe();
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const unsubscribe = onOrderEvent((id) => { if (id === orderId && isDone()) finish(); });
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish);
    if (signal?.aborted || isDone()) finish();
  });
}
