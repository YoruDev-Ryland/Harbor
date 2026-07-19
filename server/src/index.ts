import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./db.js";
import { startMonitor } from "./monitor.js";

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  const stopMonitor = startMonitor();
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "graceful shutdown started");
    stopMonitor();
    const forced = setTimeout(() => process.exit(1), 10_000);
    forced.unref?.();
    await app.close();
    closeDatabase();
    clearTimeout(forced);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
