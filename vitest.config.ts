import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this repo's tests — never stray copies (e.g. editor/agent worktrees).
    include: ["test/**/*.test.ts"],
  },
});
