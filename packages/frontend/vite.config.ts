import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/what-you-need-to-know/",
  plugins: [react()],
});
