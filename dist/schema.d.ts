import { z } from "zod";
export { z };
/** Emit JSON Schema for a zod schema (zod 4 `z.toJSONSchema`). Best-effort. */
export declare function toJsonSchema(schema: unknown): unknown;
