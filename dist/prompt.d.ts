/** Load `prompts/<name>.md`, substituting `{{var}}` from `vars` (missing → ""). */
export declare const renderPrompt: (name: string, vars?: Record<string, unknown>) => string;
