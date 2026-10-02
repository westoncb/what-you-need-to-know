import { WebSocket, WebSocketServer } from "ws";
import type { FlowEvent } from "@wyntn/common/src/t-flow/flow-observer";

export async function startWsServer(port = 4000) {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  // Report a busy port before starting paid generation, rather than crashing later.
  await new Promise<void>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.off("error", reject);
      resolve();
    });
  });
  wss.on("error", error => console.error("Observer server error:", error.message));
  wss.on("connection", ws => ws.on("error", error => console.warn("Observer client error:", error.message)));

  const log = (evt: FlowEvent) => {
    const msg = JSON.stringify(evt);
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  };
  return Object.assign(log, {
    close: () => new Promise<void>((resolve, reject) => {
      for (const client of wss.clients) client.terminate();
      wss.close(error => error ? reject(error) : resolve());
    }),
  });
}
