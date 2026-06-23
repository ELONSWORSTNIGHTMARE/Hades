import { Router, type IRouter } from "express";

const router: IRouter = Router();

const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRate(ip: string, max: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

router.post("/chat/demo", async (req: any, res) => {
  const ip = String(req.ip ?? "unknown");
  if (!checkRate(`chat:${ip}`, 40)) {
    return res.status(429).json({ error: "Rate limit exceeded. Please wait a minute." });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  try {
    const response = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content:
              "You are Hades AI, a helpful assistant powered by the Hades API platform. Be concise, clear, and friendly. You can help with code, questions, and anything else.",
          },
          ...messages.slice(-12),
        ],
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      req.log.error({ status: response.status }, "Groq upstream error in demo chat");
      return res.status(502).json({ error: "AI service temporarily unavailable" });
    }

    const data = await response.json() as any;
    res.json({ content: data.choices?.[0]?.message?.content ?? "" });
  } catch (err) {
    req.log.error(err, "demo chat error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/generate", async (req: any, res) => {
  const ip = String(req.ip ?? "unknown");
  if (!checkRate(`gen:${ip}`, 8)) {
    return res.status(429).json({ error: "Rate limit exceeded. Please wait a minute." });
  }

  const { prompt, existingFiles } = req.body;
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return res.status(400).json({ error: "prompt is required" });
  }

  const systemPrompt = `You are an expert full-stack web developer. Generate a complete, beautiful, working website.

CRITICAL RULES:
1. Return ONLY a raw JSON object — NO markdown, NO code fences, NO prose before or after.
2. The JSON must strictly follow this structure:
{
  "title": "Project Name",
  "description": "One-line description",
  "files": [
    { "name": "index.html", "content": "...complete HTML..." },
    { "name": "styles.css", "content": "...complete CSS..." },
    { "name": "script.js", "content": "...complete JS..." }
  ]
}
3. Use vanilla HTML/CSS/JavaScript — no build tools, no npm, no frameworks (CDN links to libraries like Chart.js, Three.js, GSAP are allowed).
4. The HTML file must use <link rel="stylesheet" href="styles.css"> and <script src="script.js"></script>.
5. Make the design stunning: dark themes, gradients, smooth animations, glassmorphism, modern typography.
6. Make it FULLY FUNCTIONAL — all buttons work, all features work, no placeholder content.
7. Write at least 80+ lines of meaningful CSS with transitions and animations.
8. Include at least 3 files minimum.`;

  const userContent = existingFiles
    ? `Current files:\n${JSON.stringify(existingFiles)}\n\nModification request: ${prompt.trim()}`
    : prompt.trim();

  try {
    const response = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: 8000,
        temperature: 0.8,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      req.log.error({ status: response.status }, "Groq upstream error in generate");
      return res.status(502).json({ error: "AI service temporarily unavailable" });
    }

    const data = await response.json() as any;
    const content: string = data.choices?.[0]?.message?.content ?? "{}";

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      req.log.error({ content: content.slice(0, 200) }, "Failed to parse AI JSON");
      return res.status(500).json({ error: "AI returned an unexpected format. Please try again." });
    }

    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      return res.status(500).json({ error: "AI returned unexpected format. Please try again." });
    }

    res.json({
      title: parsed.title ?? "Untitled Project",
      description: parsed.description ?? "",
      files: parsed.files,
    });
  } catch (err) {
    req.log.error(err, "generate error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
