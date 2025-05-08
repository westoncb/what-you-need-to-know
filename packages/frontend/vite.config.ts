import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Optional: put the build out one folder higher so GitHub Pages
  // sees "dist" next to /public.  Comment out if you prefer default.
  // build: { outDir: "../../dist-frontend" }
});
