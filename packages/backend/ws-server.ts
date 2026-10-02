import { WebSocketServer } from "ws";
import { FlowEvent } from "@wyntn/common/src/t-flow/flow-observer";

export function startWsServer(port = 4000) {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });

  const log = (evt: FlowEvent) => {
    const msg = JSON.stringify(evt);
    for (const ws of clients) ws.readyState === ws.OPEN && ws.send(msg);
  };
  return Object.assign(log, {
    close: () => new Promise<void>((resolve, reject) => {
      for (const client of wss.clients) client.terminate();
      wss.close(error => error ? reject(error) : resolve());
    }),
  });
}
