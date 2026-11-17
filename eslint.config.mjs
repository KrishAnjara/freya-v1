import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const eslintConfig = [
  {
    ignores: [".next/**", ".next-freya-dev/**", ".next-freya-build/**", "node_modules/**", "out/**", "build/**", "next-env.d.ts", ".pytest_cache/**", ".venv/**", "training/outputs/**", "training/freya-gguf/**", "data/**", "backups/**"],
  },
  ...compat.extends("next/core-web-vitals"),
];

export default eslintConfig;
