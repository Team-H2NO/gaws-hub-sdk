// renderPrompt — the blessed way to keep LLM prompts as files (agents-interface §16),
// not string literals in code. An agent that spawns a sub-LLM reads its prompts from
// a top-level `prompts/` dir; `{{var}}` placeholders are filled from `vars`. Keeping
// the prompt surface in diffable files (not inline strings) keeps the injectable
// prompt auditable — the `prompts-as-files` compliance rule enforces it statically.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Load `prompts/<name>.md`, substituting `{{var}}` from `vars` (missing → ""). */
export const renderPrompt = (name: string, vars: Record<string, unknown> = {}): string =>
  readFileSync(join("prompts", name + ".md"), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k) =>
    vars[k] != null ? String(vars[k]) : "",
  );
