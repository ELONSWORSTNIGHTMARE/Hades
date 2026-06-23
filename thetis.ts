import { Router, type IRouter } from "express";

const router: IRouter = Router();

const GROQ_BASE = "https://api.groq.com/openai/v1";
const AGENT1_KEY = process.env.GROQ_API_KEY;
const AGENT2_KEY = process.env.GROQ_AGENT2_KEY;

const MODEL_MAP: Record<string, string> = {
  "hades-1": "llama-3.1-8b-instant",
  "hades-1.5": "llama-3.3-70b-versatile",
  "hades-2": "deepseek-r1-distill-llama-70b",
};

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRate(key: string, max: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

async function callGroq(
  apiKey: string,
  model: string,
  messages: any[],
  maxTokens = 1024,
  jsonMode = false
): Promise<string> {
  const body: any = { model, messages, max_tokens: maxTokens, temperature: 0.7 };
  if (jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

router.post("/thetis/classify", async (req: any, res): Promise<void> => {
  const ip = String(req.ip ?? "unknown");
  if (!checkRate(`classify:${ip}`, 60)) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  const { message } = req.body;
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const content = await callGroq(
      AGENT2_KEY ?? AGENT1_KEY!,
      "llama-3.1-8b-instant",
      [
        {
          role: "system",
          content: `Classify the user message into one of these types and optionally generate clarifying questions.
Types: "image" (create/generate/draw/make an image or picture), "code" (write/fix/debug code), "research" (research/explain/deep dive), "document" (write/create document), "chat" (everything else).
For image requests ONLY: provide exactly 2 short clarifying questions to improve the prompt.
Return ONLY valid JSON: {"type":"chat","questions":null} or {"type":"image","questions":["Q1?","Q2?"]}`,
        },
        { role: "user", content: message },
      ],
      200,
      true
    );

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { type: "chat", questions: null };
    }

    res.json({ type: parsed.type ?? "chat", questions: parsed.questions ?? null });
  } catch (err) {
    req.log.error(err, "thetis classify error");
    res.json({ type: "chat", questions: null });
  }
});

router.post("/thetis/chat", async (req: any, res): Promise<void> => {
  const ip = String(req.ip ?? "unknown");
  if (!checkRate(`tchat:${ip}`, 30)) {
    res.status(429).json({ error: "Rate limit exceeded. Try again in a moment." });
    return;
  }

  const { messages, model = "hades-1.5", taskType = "chat" } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  const groqModel = MODEL_MAP[model] ?? MODEL_MAP["hades-1.5"];

  const systemPrompts: Record<string, string> = {
    chat: "You are Thetis, a powerful and friendly AI assistant built on the Hades AI platform. Be helpful, clear, and concise. Format code in markdown code blocks.",
    code: "You are Thetis, an expert coding assistant. Write clean, well-commented code. Explain complex logic. Use markdown code blocks with language tags. Be precise and technical.",
    research: "You are Thetis, an expert researcher. Provide comprehensive, accurate, well-structured answers with clear sections. Cite when possible. Be thorough but concise.",
    document: "You are Thetis, an expert document writer. Create well-structured, professional documents with appropriate headings, lists, and formatting in markdown.",
    image: "You are Thetis, a creative AI assistant. Help the user with their creative request.",
  };

  let systemPrompt = systemPrompts[taskType] ?? systemPrompts.chat;

  try {
    if (AGENT2_KEY && taskType !== "chat" && messages.length > 0) {
      try {
        const enhanced = await callGroq(
          AGENT2_KEY,
          "llama-3.1-8b-instant",
          [
            {
              role: "system",
              content: `Write a specialized AI system prompt (under 80 words) for handling a "${taskType}" request. Return ONLY the system prompt text, no quotes, no explanation.`,
            },
            { role: "user", content: messages[messages.length - 1]?.content ?? "" },
          ],
          100
        );
        if (enhanced.trim().length > 10) systemPrompt = enhanced.trim();
      } catch {
        // Use default system prompt
      }
    }

    const content = await callGroq(AGENT1_KEY!, groqModel, [{ role: "system", content: systemPrompt }, ...messages.slice(-20)], 2048);
    res.json({ content });
  } catch (err) {
    req.log.error(err, "thetis chat error");
    res.status(500).json({ error: "Chat failed. Please try again." });
  }
});

router.post("/thetis/generate-image", async (req: any, res): Promise<void> => {
  const ip = String(req.ip ?? "unknown");
  if (!checkRate(`timg:${ip}`, 10)) {
    res.status(429).json({ error: "Rate limit exceeded. Try again in a moment." });
    return;
  }

  const { originalMessage, answers } = req.body;
  if (!originalMessage || typeof originalMessage !== "string") {
    res.status(400).json({ error: "originalMessage is required" });
    return;
  }

  try {
    const answerContext =
      Array.isArray(answers) && answers.length > 0 ? `Additional context from user: ${answers.filter(Boolean).join(". ")}` : "";

    const enhancedPrompt = await callGroq(
      AGENT2_KEY ?? AGENT1_KEY!,
      "llama-3.1-8b-instant",
      [
        {
          role: "system",
          content:
            "You are a professional image prompt engineer. Create a vivid, detailed image generation prompt. Include: subject description, art style, lighting, color palette, composition, mood. Return ONLY the prompt text, no quotes, max 80 words.",
        },
        { role: "user", content: `Request: ${originalMessage}. ${answerContext}` },
      ],
      100
    );

    const prompt = enhancedPrompt.trim() || originalMessage;
    const seed = Math.floor(Math.random() * 999999);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}&enhance=true`;

    res.json({ imageUrl, enhancedPrompt: prompt });
  } catch (err) {
    req.log.error(err, "thetis generate-image error");
    res.status(500).json({ error: "Image generation failed. Please try again." });
  }
});

export default router;
