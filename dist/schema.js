// Schema helpers — zod re-export + JSON-Schema emission for manifest descriptors.
// One zod definition gives static types (z.infer), runtime validation (in the
// server), and the manifest's request/result JSON Schema (Draft 2020-12).
import { z } from "zod";
export { z };
/** Emit JSON Schema for a zod schema (zod 4 `z.toJSONSchema`). Best-effort. */
export function toJsonSchema(schema) {
    try {
        const fn = z.toJSONSchema;
        return typeof fn === "function" ? fn(schema) : undefined;
    }
    catch {
        return undefined;
    }
}
