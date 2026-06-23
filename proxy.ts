import { Router, type IRouter } from "express";
import { db, apiKeysTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import crypto from "crypto";

const router: IRouter = Router();
const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function resolveHadesKey(authHeader: string | undefined): Promise<{ valid: boolean; keyId?: number }> {
  if (!authHeader?.startsWith("Bearer hades_sk_")) return { valid: false };
  const raw = authHeader.slice("Bearer ".length);
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const rows = await db
    .select({ id: apiKeysTable.id })
    .from(apiKeysTable)
    .where(eq(apiKeysTable.keyHash, hash))
    .limit(1);
  if (rows.length === 0) return { valid: false };
  await db
    .update(apiKeysTable)
    .set({ lastUsedAt: new Date(), requestCount: sql`${apiKeysTable.requestCount} + 1` })
    .where(eq(apiKeysTable.keyHash, hash));
  return { valid: true, keyId: rows[0].id };
}

async function proxyToGroq(req: any, res: any, path: string) {
  const { valid } = await resolveHadesKey(req.headers["authorization"] as string);
  if (!valid) {
    return res.status(401).json({
      error: { message: "Invalid or missing Hades API key. Pass Authorization: Bearer hades_sk_...", type: "invalid_request_error", code: "invalid_api_key" },
    });
  }

  const body = req.body;
  const isStream = body?.stream === true;

  try {
    const groqRes = await fetch(`${GROQ_BASE}${path}`, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
        ...(isStream ? { Accept: "text/event-stream" } : {}),
      },
      body: req.method !== "GET" ? JSON.stringify(body) : undefined,
    });

    if (isStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (!groqRes.body) return res.end();
      const reader = (groqRes.body as any).getReader();
      const decoder = new TextDecoder();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(decoder.decode(value));
          }
        } catch { res.end(); }
      };
      pump();
    } else {
      const data = await groqRes.json();
      res.status(groqRes.status).json(data);
    }
  } catch (err: any) {
    req.log.error(err, "proxy upstream error");
    res.status(502).json({ error: { message: "Upstream AI service unreachable", type: "api_error" } });
  }
}

router.post("/v1/chat/completions", (req, res) => proxyToGroq(req, res, "/chat/completions"));
router.post("/v1/audio/transcriptions", (req, res) => proxyToGroq(req, res, "/audio/transcriptions"));

router.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "hades-1", object: "model", created: 1751000000, owned_by: "hades", description: "Hades 1 — Fast, lightweight model" },
      { id: "hades-1.5", object: "model", created: 1751000000, owned_by: "hades", description: "Hades 1.5 — Balanced performance" },
      { id: "hades-2.0", object: "model", created: 1751000000, owned_by: "hades", description: "Hades 2.0 — Most capable, premium" },
    ],
  });
});

export default router;
