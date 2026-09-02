require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    geminiConfigured: Boolean(API_KEY),
    model: MODEL
  });
});

app.post("/api/waste/analyze", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요."
      });
    }

    const name = String(req.body?.name || "").trim();
    const actions = Array.isArray(req.body?.actions)
      ? req.body.actions.map(v => String(v).trim()).filter(Boolean)
      : [];

    if (!name) {
      return res.status(400).json({ error: "닉네임을 입력해주세요." });
    }

    if (actions.length === 0) {
      return res.status(400).json({ error: "행동을 하나 이상 입력해주세요." });
    }

    if (actions.length > 20) {
      return res.status(400).json({ error: "행동은 최대 20개까지 입력할 수 있습니다." });
    }

    const prompt = `
너는 친구들끼리 가볍게 즐기는 '폐급리스트' 게임의 분석 AI다.

중요:
- 실제 사람을 심각하게 모욕하거나 괴롭히기 위한 표현은 피한다.
- 범죄 사실, 질병, 정치성향, 인종/민족, 종교, 성적 지향 등 민감한 추정은 하지 않는다.
- 입력된 행동만 근거로 판단한다.
- 점수는 '행동의 황당함/민폐 정도'를 게임 점수로 표현한다.
- 심각한 비난보다는 친구끼리 웃을 수 있는 가벼운 표현을 사용한다.
- 점수는 0~100 사이 정수이며, 높을수록 게임상 '폐급도'가 높다.
- 반드시 JSON만 반환한다.

분석 대상:
닉네임: ${JSON.stringify(name)}
행동 목록:
${actions.map((a, i) => `${i + 1}. ${a}`).join("\n")}
`;

    const responseSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        score: { type: "integer", minimum: 0, maximum: 100 },
        grade: { type: "string", enum: ["S", "A", "B", "C", "D"] },
        title: { type: "string" },
        summary: { type: "string" },
        comment: { type: "string" },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              score: { type: "integer", minimum: 0, maximum: 100 },
              reason: { type: "string" }
            },
            required: ["action", "score", "reason"]
          }
        }
      },
      required: ["name", "score", "grade", "title", "summary", "comment", "actions"]
    };

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;

    const geminiResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 1200,
          responseMimeType: "application/json",
          responseSchema
        }
      })
    });

    const raw = await geminiResponse.text();

    if (!geminiResponse.ok) {
      let detail = raw;
      try {
        detail = JSON.parse(raw);
      } catch {}
      return res.status(geminiResponse.status).json({
        error: "Gemini API 호출에 실패했습니다.",
        detail
      });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: "Gemini 응답을 JSON으로 읽지 못했습니다.",
        raw
      });
    }

    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return res.status(502).json({
        error: "Gemini가 분석 결과를 반환하지 않았습니다.",
        detail: body
      });
    }

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "Gemini가 유효한 JSON을 반환하지 않았습니다.",
        rawText: text
      });
    }

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "서버 내부 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`1-2 Gemini 테스트 서버: http://localhost:${PORT}`);
  console.log(`모델: ${MODEL}`);
});