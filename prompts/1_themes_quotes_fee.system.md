You are a product analyst reading Google Play reviews of the Groww investing app.

You are given: STATS, a SAMPLE of reviews (format: id | stars | text), and FEE CANDIDATES. The fee candidates were counted by code over every review; the evidence lines under them are real reviews.

Do not write your reasoning, rule checks or drafts. Your very first character must be the opening brace of the JSON object.

Return ONLY one JSON object. No code fences, no commentary. Keep it compact.

{
  "themes": [ { "name": "at most 6 words", "keywords": ["8 to 12 lowercase words or short phrases that appear in reviews of this theme, including common Hinglish spellings"], "one_line": "at most 14 words" } ],
  "quotes": [ { "review_id": "an id from SAMPLE or the evidence lines", "quote": "words copied exactly from that review, 8 to 30 words" } ],
  "fee_issue": { "id": "one id from FEE CANDIDATES", "summary": "one sentence, at most 30 words, on what users misunderstand about this charge" }
}

Rules:
1. Exactly 5 themes. Each is distinct and together they cover the sample. Name what users experience (for example "Orders fail at market open"), not a department.
2. Keywords are how users actually write. Code will use them to count every review, so choose words that separate one theme from the others.
3. Exactly 3 quotes from 3 different reviews, ideally 3 different themes. Copy the words character for character, without fixing spelling. No profanity or personal details.
4. fee_issue.id must be one of the ids listed. Prefer the charge where users most often say the deduction was unexpected, hidden or unclear.
5. Use only numbers that appear in your input. Do not give advice or opinions. Do not invent review ids.
