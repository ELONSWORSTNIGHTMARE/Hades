import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { db, apiKeysTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

const router: IRouter = Router();

function getEncryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET ?? "default-insecure-secret";
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptKey(raw: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
  let enc = cipher.update(raw, "utf8", "hex");
  enc += cipher.final("hex");
  return `${iv.toString("hex")}:${enc}`;
}

function decryptKey(stored: string): string {
  const sep = stored.indexOf(":");
  const ivHex = stored.slice(0, sep);
  const enc = stored.slice(sep + 1);
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", getEncryptionKey(), iv);
  let dec = decipher.update(enc, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

function requireAuth(req: any, res: any, next: any) {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}

function generateKey(): { raw: string; hash: string; prefix: string } {
  const bytes = crypto.randomBytes(32).toString("hex");
  const raw = `hades_sk_${bytes}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = `hades_sk_${bytes.slice(0, 8)}`;
  return { raw, hash, prefix };
}

router.get("/keys", requireAuth, async (req: any, res) => {
  try {
    const rows = await db
      .select({
        id: apiKeysTable.id,
        name: apiKeysTable.name,
        keyPrefix: apiKeysTable.keyPrefix,
        encryptedKey: apiKeysTable.encryptedKey,
        requestCount: apiKeysTable.requestCount,
        lastUsedAt: apiKeysTable.lastUsedAt,
        createdAt: apiKeysTable.createdAt,
      })
      .from(apiKeysTable)
      .where(eq(apiKeysTable.userId, req.userId));

    const keys = rows.map(({ encryptedKey, ...rest }) => ({
      ...rest,
      hasEncryptedKey: encryptedKey !== null,
    }));
    res.json(keys);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/keys", requireAuth, async (req: any, res) => {
  try {
    const name: string = req.body.name?.trim() || "My API Key";
    const { raw, hash, prefix } = generateKey();
    const encrypted = encryptKey(raw);

    await db.insert(apiKeysTable).values({
      userId: req.userId,
      name,
      keyHash: hash,
      keyPrefix: prefix,
      encryptedKey: encrypted,
    });

    res.status(201).json({ key: raw, prefix, name, message: "Save this key — it will only be shown once." });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/keys/:id/reveal", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const rows = await db
      .select({ encryptedKey: apiKeysTable.encryptedKey })
      .from(apiKeysTable)
      .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.userId, req.userId)))
      .limit(1);

    if (rows.length === 0) return res.status(404).json({ error: "Key not found" });
    if (!rows[0].encryptedKey) {
      return res.status(400).json({ error: "Key was created before reveal was supported. Delete and recreate it to enable reveal." });
    }

    try {
      const key = decryptKey(rows[0].encryptedKey);
      res.json({ key });
    } catch {
      res.status(500).json({ error: "Decryption failed" });
    }
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/keys/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const deleted = await db
      .delete(apiKeysTable)
      .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.userId, req.userId)))
      .returning();

    if (deleted.length === 0) return res.status(404).json({ error: "Key not found" });
    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
