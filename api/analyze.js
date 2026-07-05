// api/analyze.js — Vercel Serverless Function (빠른/견고 버전)
// 험프리 30-2 결과지 이미지 → GPT-5.5(빠른 모드)로 dB 격자 추출 → JSON 반환.

const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const EFFORT = process.env.OPENAI_EFFORT || "low"; // none|low|medium|high

const INSTRUCTION = `You extract Humphrey 30-2 static perimetry threshold (dB) numbers from one eye's numeric plot image.
Read ONLY the grid of dB numbers divided by the cross axes. Ignore the grayscale map, deviation plots, probability symbols, GHT, VFI, MD, PSD, and any patient identifiers.
The 30-2 numeric grid has 10 rows top-to-bottom; points per row are exactly 4,6,8,10,10,10,10,8,6,4. Read each row left-to-right.
A parenthesized 0, "<0", or unseen point = 0. If unreadable, use 0.
Return ONLY a JSON object, no prose, no markdown fences:
{"grid":[[..4..],[..6..],[..8..],[..10..],[..10..],[..10..],[..10..],[..8..],[..6..],[..4..]]}
Row lengths must be exactly 4,6,8,10,10,10,10,8,6,4. Never include names, dates, or IDs.`;

function extractJSON(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch { return null; }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

async function callChat(apiKey, dataUrl, eyeLabel, withEffort) {
  const payload = {
    model: MODEL,
    messages: [
      { role: "system", content: INSTRUCTION },
      { role: "user", content: [
        { type: "text", text: `This is the ${eyeLabel} eye. Extract the dB grid now. Output only the JSON object.` },
        { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
      ] }
    ],
    max_completion_tokens: 1600
  };
  if (withEffort) payload.reasoning_effort = EFFORT;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });
  const raw = await r.text();
  if (!r.ok) return { ok: false, status: r.status, raw };
  let j; try { j = JSON.parse(raw); } catch { return { ok: false, status: 500, raw }; }
  const text = j && j.choices && j.choices[0] && j.choices[0].message ? (j.choices[0].message.content || "") : "";
  return { ok: true, text };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 허용됩니다." });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "서버에 OPENAI_API_KEY가 없습니다. Vercel 환경변수를 확인하세요." });

  try {
    const body = await readBody(req);
    const imageDataUrl = body && body.imageDataUrl;
    const eye = body && body.eye;
    if (!imageDataUrl || !/^data:image\//.test(imageDataUrl))
      return res.status(400).json({ error: "이미지 데이터가 없습니다." });
    const eyeLabel = eye === "L" ? "LEFT (OS)" : "RIGHT (OD)";

    // 1차: 빠른 모드(reasoning_effort)
    let a = await callChat(apiKey, imageDataUrl, eyeLabel, true);
    // reasoning_effort 파라미터를 거부하면(400) 없이 재시도
    if (!a.ok && a.status === 400 && /reasoning/i.test(a.raw || "")) {
      a = await callChat(apiKey, imageDataUrl, eyeLabel, false);
    }
    if (a.ok) {
      const obj = extractJSON(a.text);
      if (obj && Array.isArray(obj.grid)) return res.status(200).json({ grid: obj.grid });
      return res.status(502).json({ error: "AI가 dB 격자를 반환하지 않았습니다. 다시 시도하거나 수동 입력하세요.", raw: (a.text || "").slice(0, 300) });
    }

    const st = a.status;
    const msg = st === 401 ? "OpenAI API 키가 잘못되었거나 만료되었습니다."
      : st === 429 ? "OpenAI 사용량 한도 또는 크레딧 부족입니다."
      : st === 404 ? "모델(" + MODEL + ")을 찾을 수 없습니다. 환경변수 OPENAI_MODEL을 확인하세요."
      : "OpenAI 오류 " + st;
    return res.status(502).json({ error: msg, detail: (a.raw || "").slice(0, 400) });
  } catch (e) {
    return res.status(500).json({ error: "서버 처리 오류: " + (e && e.message ? e.message : String(e)) });
  }
};
