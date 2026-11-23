import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // ws: the sign-in terminal's WebSocket (/api/logins/ws).
    proxy: { "/api": { target: "http://127.0.0.1:7420", ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
