# Ruby-Health
Where I am building my medical claims management tool :)

## MVP demo app

A working prototype of Ruby's core mechanism: transcript → clinical fact extraction → ICD-10/CPT code suggestions → claim template → editable review. This is a demo/prototype, **not** the HIPAA-compliant production system — no compliance infrastructure, and only synthetic/sample encounters, never real patient data.

Build plan: see the "Ruby Health — MVP Demo App: Build Plan" Notion page.

### Running locally

```bash
cd backend
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npm install
npm start
```

Then open http://localhost:3000 — paste a synthetic transcript and submit to see the raw clinical-fact extraction JSON from Claude.

### Status

- [x] Piece 1: project scaffold (backend + minimal frontend skeleton)
- [x] Piece 2: paste transcript → raw Claude extraction JSON, end to end
- [ ] Piece 3: ICD-10/CPT code-suggestion step
- [ ] Piece 4: claim-template population + editable review screen
- [ ] Piece 5: step-by-step reveal UI
- [ ] Piece 6: live mic capture via Web Speech API
- [ ] Piece 7 (later, optional): deploy as a shareable link

