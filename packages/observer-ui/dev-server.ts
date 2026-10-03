import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export async function startObserverDashboard() {
  const server = await createServer({
    root: fileURLToPath(new URL("./", import.meta.url)),
    server: { host: "127.0.0.1", port: 5174, strictPort: false, open: true },
  });
  try {
    await server.listen();
    return { url: server.resolvedUrls!.local[0], close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}
