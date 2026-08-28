const GEMINI_MODEL = 'gemini-2.5-flash';

export async function geminiAnswer(question, rows, apiKey = process.env.GEMINI_API_KEY) {
  if (!apiKey || !rows.length) return null;
  const context = rows.map((row, index) => `[Document ${index + 1}: ${row.title}]\n${row.content}`).join('\n\n');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You are Keycard, an employee onboarding assistant. Answer the user question using only the provided document context. If the answer is not explicitly supported by the context, say you do not know based on the provided documents. Do not infer, invent, or use outside knowledge. Do not reveal or request personal data.' }] },
      contents: [{ role: 'user', parts: [{ text: `Document context:\n${context}\n\nUser question:\n${question}` }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
    })
  });
  if (!response.ok) throw new Error(`Gemini request failed with status ${response.status}`);
  const payload = await response.json();
  const answer = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
  if (!answer) throw new Error('Gemini returned no answer');
  return { answer, confidence: Math.min(.94, Math.max(.75, Number(rows[0].score) + .75)), source: [...new Set(rows.map(row => row.title))].join(', ') };
}
