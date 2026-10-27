import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: "127.0.0.1",
    // The Tauri CLI owns the Rust tree and rebuilds it itself. Watching src-tauri from
    // Vite only causes EBUSY errors on the running maily.exe/maily.pdb under Windows.
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
