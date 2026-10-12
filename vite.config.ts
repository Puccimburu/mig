// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

const API_PORT = 8000;

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Starts the Python backend (backend/app.py) with the dev server, so `npm run dev` is
 * enough. Skipped when something already serves the port (e.g. `npm run dev:api` in
 * another terminal) or when SKIP_API=1.
 */
function pythonBackend(): Plugin {
  let child: ChildProcess | undefined;
  const stop = () => {
    if (!child || child.exitCode !== null || !child.pid) return;
    // uvicorn --reload runs the server in a child process; stop the whole tree.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else child.kill();
    child = undefined;
  };
  return {
    name: "python-backend",
    apply: "serve",
    async configureServer(server) {
      if (process.env["SKIP_API"] === "1") return;
      // After a config change Vite restarts; give the previous backend a moment to exit.
      for (let i = 0; i < 10 && (await portInUse(API_PORT)); i++)
        await new Promise((r) => setTimeout(r, 300));
      if (await portInUse(API_PORT)) {
        server.config.logger.info(`[api] using the backend already running on port ${API_PORT}`);
        return;
      }
      child = spawn(
        process.env["PYTHON"] ?? "python",
        ["-m", "uvicorn", "app:app", "--port", String(API_PORT), "--reload"],
        { cwd: fileURLToPath(new URL("./backend", import.meta.url)), stdio: "inherit" },
      );
      child.on("error", (e) =>
        server.config.logger.error(
          `[api] could not start the Python backend (${e.message}). Install Python, then run: python -m pip install -r backend/requirements.txt`,
        ),
      );
      server.httpServer?.once("close", stop);
      process.once("exit", stop);
      process.once("SIGINT", () => {
        stop();
        process.exit();
      });
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [pythonBackend()],
    server: {
      // The Python backend serves /api (started by the plugin above, or `npm run dev:api`).
      proxy: { "/api": `http://127.0.0.1:${API_PORT}` },
    },
  },
});
