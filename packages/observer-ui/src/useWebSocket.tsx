import { useEffect } from "react";

export function useWebSocket(url: string,
                      onMsg: (data: any)=>void,
                      { maxRetries = Infinity } = {}) {

  const baseDelay = 1500;        // 1.5 s feels less jittery
  const jitter    = () => Math.random()*300; // ±300 ms

  useEffect(() => {
    let ws: WebSocket|null = null;
    let retries = 0, alive = true;

    const open = () => {
      if (!alive || retries > maxRetries) return;

      ws = new WebSocket(url);

      ws.onopen    = () => { retries = 0; };
      ws.onmessage = e => onMsg(JSON.parse(e.data));
      ws.onclose   = () => scheduleReconnect();
      ws.onerror   = () => ws?.close();
    };

    const scheduleReconnect = () => {
      ws = null;
      if (!alive || retries >= maxRetries) return;
      const delay = baseDelay * 2**retries + jitter();
      retries++;
      setTimeout(() => document.hidden ? scheduleReconnect() : open(), delay);
    };

    open();
    // resume immediately when tab becomes visible
    const vis = () => { if (!ws && !document.hidden) open(); };
    document.addEventListener("visibilitychange", vis);

    return () => { alive = false; ws?.close(); document.removeEventListener("visibilitychange", vis); };
  }, [url, onMsg, maxRetries]);
}
