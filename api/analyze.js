// api/analyze.js — Vercel Serverless Function
// 브라우저가 보낸 험프리 30-2 결과지 이미지를 GPT-5.5로 판독해
// 30-2 dB 격자(행별 4,6,8,10,10,10,10,8,6,4)를 JSON으로 돌려준다.
// OpenAI API 키는 이 서버 코드(환경변수)에서만 쓰이며 브라우저에 노출되지 않는다.

const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

const SYSTEM_PROMPT = `You extract Humphrey 30-2 static perimetry threshold (dB) values from an image.
Read ONLY the numeric threshold plot (the grid of dB numbers divided by the cross axes).
Ignore the grayscale map, total/pattern deviation plots, probability symbols, GHT, VFI, MD, PSD, and any patient identifiers.
The 30-2 numeric grid has 10 rows top-to-bottom; the number of points per row is exactly: 4, 6, 8, 10, 10, 10, 10, 8, 6, 4.
Read each row left-to-right. A value shown as a parenthesized 0, "<0", or a point too depressed to be seen must be 0. If a cell is truly unreadable, use null.
Return ONLY a JSON object, no prose, no markdown:
{"grid":[[..4..],[..6..],[..8..],[..10..],[..10..],[..10..],[..10..],[..8..],[..6..],[..4..]]}
Row lengths must be exactly 4,6,8,10,10,10,10,8,6,4. Never include names, dates, or IDs.`;

function extractJSON(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch { return null; }
}

module.exports = async (req, res) => {
  // CORS (같은 도메인 배포면 불필요하지만, 커스텀 프론트 대비 허용)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 허용됩니다." });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "서버에 OPENAI_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요." });

  try {
    // 본문 파싱 (Vercel은 JSON 자동 파싱하지만 안전하게 처리)
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const { imageDataUrl, eye } = body || {};
    if (!imageDataUrl || !/^data:image\//.test(imageDataUrl)) {
      return res.status(400).json({ error: "이미지 데이터가 없습니다." });
    }

    const userText = `This is the ${eye === "L" ? "LEFT (OS)" : "RIGHT (OD)"} eye Humphrey 30-2 result. Extract the dB grid as specified.`;

    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } }
          ]
        }
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 1500
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const errText = await r.text();
      const msg = r.status === 401 ? "OpenAI API 키가 잘못되었거나 만료되었습니다."
        : r.status === 429 ? "OpenAI 사용량 한도(또는 크레딧 부족)입니다."
        : `OpenAI 오류 ${r.status}`;
      return res.status(502).json({ error: msg, detail: errText.slice(0, 300) });
    }

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const obj = extractJSON(text);
    if (!obj || !Array.isArray(obj.grid)) {
      return res.status(502).json({ error: "판독 결과를 해석하지 못했습니다. 다시 시도하거나 수동 입력하세요.", raw: text.slice(0, 300) });
    }
    return res.status(200).json({ grid: obj.grid });
  } catch (e) {
    return res.status(500).json({ error: "서버 처리 오류: " + (e.message || e) });
  }
};
