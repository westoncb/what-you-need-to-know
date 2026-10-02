import { useEffect, useRef } from "react";

export function useWebSocket(
  url: string,
  onMsg: (data: any) => void,
  { maxRetries = Infinity } = {},
) {
  const onMessage = useRef(onMsg);
  useEffect(() => { onMessage.current = onMsg; }, [onMsg]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    let alive = true;

    const clearRetry = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const open = (reconnect = false) => {
      if (!alive || ws || (reconnect && retries >= maxRetries)) return;
      clearRetry();
      if (reconnect) retries++;
      const socket = new WebSocket(url);
      ws = socket;
      socket.onopen = () => { retries = 0; };
      socket.onmessage = event => {
        let data: unknown;
        try { data = JSON.parse(event.data); }
        catch { console.warn("Ignoring an invalid observer message."); return; }
        onMessage.current(data);
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (!alive || ws !== socket) return;
        ws = null;
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (!alive || ws || retryTimer !== null || retries >= maxRetries) return;
      // Capping the delay also avoids timer overflow after repeated failures.
      const delay = Math.min(30_000, 1500 * 2 ** Math.min(retries, 5) + Math.random() * 300);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!document.hidden) open(true);
        // A hidden tab resumes via visibilitychange, without accumulating timers.
      }, delay);
    };

    const onVisibility = () => {
      if (!document.hidden && !ws) open(true);
    };
    open();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      clearRetry();
      document.removeEventListener("visibilitychange", onVisibility);
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
        ws = null;
      }
    };
  }, [url, maxRetries]);
}
