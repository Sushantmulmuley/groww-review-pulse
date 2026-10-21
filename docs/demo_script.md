# Demo video script (under 3 minutes)

Record the screen with your voice. Have these tabs open first: n8n (main workflow), n8n (MCP server workflow), the Google Doc, Gmail Drafts, and Gmail inbox.

**0:00 – 0:20 | What this is**
"This is Vitals, a weekly review pulse for Groww. It reads 12 weeks of public Play Store reviews, writes a short product note and a neutral fee explainer, waits for my approval, and only then logs to a Google Doc and creates a Gmail draft. It never sends email."

**0:20 – 0:50 | The two workflows**
Show the MCP server workflow: "This exposes exactly two tools, append to doc and create email draft. There is no send tool."
Show the main workflow: "Reviews go in, code cleans them and removes personal data, the model proposes themes and quotes, code counts and checks everything, then the approval step."

**0:50 – 1:20 | Run it**
Click Execute workflow. While it runs: "The model proposes. The code decides: counts, ranking, quote checks, the 250-word limit."

**1:20 – 2:00 | Approval gate**
Open the approval email. Scroll it. "Nothing has been written yet. I see the exact Doc entry and email subject, plus the automatic checks: words, bullets, links, quotes verified word for word." Click **Approve and log**.

**2:00 – 2:30 | Results**
Show the Doc entry: "All six fields: date, top themes, weekly pulse, fee issue, explanation bullets, source links."
Show Gmail Drafts: "A draft, not sent."

**2:30 – 2:50 | Findings and close**
"The top pain themes are support, app reliability and charges. The fee issue found from the data is charges deducted on a trade: 26 of 127 mentions call it hidden or unexpected. The explainer comes only from Groww's official pages, with sources and a last-checked date."
