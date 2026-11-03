import { randomBytes } from "node:crypto";
import { ulid } from "ulid";

export type IdPrefix = "scn" | "itm" | "snp" | "chk" | "evt" | "fnd";

export const newId = (prefix: IdPrefix) => `${prefix}_${ulid().toLowerCase()}`;

export const newSecret = () => randomBytes(24).toString("base64url");

export const nowIso = () => new Date().toISOString();
