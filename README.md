# Vitals: weekly product pulse from app reviews

*Every number, verified.* Built for the Groww Play Store reviews.

An approval-gated AI workflow. It turns public Groww Play Store reviews into a weekly product pulse and a neutral fee explainer. After a human approves, it logs both to a Google Doc and creates a Gmail **draft**. It never sends email.

**Fee issue found (12 weeks, 25 Jul to 16 Oct 2026):** *charges deducted on a trade*. 26 of the 127 reviews that name it call it hidden or unexpected (20.5%). The trend is flat. Next in line is brokerage, with 10 of 99.

## Live app
**Vitals** (read-only viewer): https://sushantmulmuley.github.io/groww-review-pulse/
It loads the CSV and the fact bank, applies the model's recorded replies from the real n8n run (`docs/data/snapshot.json`), and recomputes every number, quote check and the Doc entry in your browser with the same `lib.js` the workflow uses. It also runs 21 live checks and shows the SHA-256 fingerprint of the exact text that was approved. Approval and publishing happen in n8n, not on this page. `tests/snapshot.test.js` asserts that the recomputed Doc entry equals the entry n8n wrote.

## How it works

```
reviews.csv -> clean + PII strip (code) -> Gemini: themes, quotes, fee issue
            -> code checks -> Gemini: pulse + explainer -> code checks
            -> Gmail "Ask for approval" -> Approved? -> AI Agent -> MCP server
                                                                    |- append_to_doc
                                                                    '- create_email_draft
```

The model proposes and the code decides:
- Themes are counted over **all** reviews by keyword tagging. The top 3 are ranked by **1-2 star review count** (ties: higher share of unhappy reviewers, then size), so the pulse leads with pain, not with "nice app".
- Quotes must be verbatim substrings of real reviews, or they are dropped.
- The fee issue is picked by counted confusion (a review names a charge and says it is hidden, unexpected, unexplained and so on).
- The explainer is built only from `data/fee_facts.json`, which comes from official Groww pages. Banned advice words are stripped, and any number not in the inputs is rejected.
- The pulse is capped at 250 words, with 3 actions. The explainer has at most 6 bullets and exactly 2 source links, plus a "Last checked" date.
- If the model returns garbage, deterministic fallback text is used and a flag is raised.
- Emails, PAN, phone numbers and 12-digit IDs are redacted before anything reaches the model.

## Where MCP approval happens
1. **Gmail "Ask for approval" node** (`sendAndWait`). It emails the approver the pulse and explainer with Approve / Decline buttons.
2. **`Approved?` IF node.** Only the approved branch reaches the AI Agent. The decline branch ends at `Rejected`. A test asserts that nothing else connects to the agent.
3. The agent can call only two MCP tools, `append_to_doc` and `create_email_draft`. The Gmail tool is the draft operation only.

## How to run
1. `pip install google-play-scraper`, then `python scripts/export_reviews.py --max 15000 --weeks 12` (writes `data/reviews.csv`). Or use the CSV in this repo.
2. Try it with no model or n8n: `node run_local.js data/reviews.csv` (writes `outputs/local_*`).
3. In n8n Cloud, import `n8n/mcp-server.json`, connect Gmail and Google Docs credentials, set the Google Doc URL on `append_to_doc`, and **activate** it. Copy its production MCP URL.
4. Import `n8n/review-pulse-main.json`. Connect Gemini (free key from aistudio.google.com) and Gmail. Then replace these placeholders:
   - Config node: `csvUrl` (raw GitHub URL of `data/reviews.csv`), `approverEmail`, `draftTo`
   - MCP Client node: the production MCP URL from step 3
5. Click **Run**. Open the approval email and approve. Check the Google Doc and the Gmail Drafts folder.
6. Tests: `node --test tests/lib.test.js tests/workflow.test.js`

## Repo map
| Path | What |
|---|---|
| `code/lib.js` | All logic. Inlined into the n8n Code nodes by `build_workflow.js` |
| `prompts/` | The three system prompts |
| `data/reviews.csv` | 12,770 public reviews (hashed ids, no names). `reviews_sample.csv` is a 50-row sample |
| `data/fee_facts.json` | Fact bank from official pages, last checked 17 Oct 2026 |
| `sources.csv` | Source URLs |
| `outputs/` | Pulse, doc entry, email draft |
| `tests/` | 26 tests. `fixture_reviews.csv` is synthetic and used for tests only |

## Honest limits
- Review text is user-written and unverified. Counts come from keyword tagging, so spot-check them.
- Fee facts are copied from public pages and can go stale, so re-check the "Last checked" date.
- The agent fills the MCP tool arguments. Check the doc entry and the draft by eye.

## Acknowledgements
- The milestone brief from NextLeap's PM Fellowship defines the required tools, outputs and approval step.
- The cohort's shared Build Guide inspired several design principles used here: let the model propose and let code count, rank themes by 1-2 star reviews, verify quotes word for word, and give the Gmail tool no way to send.
