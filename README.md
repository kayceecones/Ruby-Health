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

Then open http://localhost:3000 — four tabs (Transcript, Facts, Codes, Claim & Review) share one underlying data model, so you can jump to any tab directly. Every action button (Extract, Suggest codes, Populate claim) only does its own step and never navigates you anywhere — it runs against whatever is currently in the shared data (whether that got there via Claude or by hand-editing) and stays put so you stay in control of where you are.

### Status

- [x] Piece 1: project scaffold (backend + minimal frontend skeleton)
- [x] Piece 2: paste transcript → raw Claude extraction JSON, end to end
- [x] Piece 3: ICD-10/CPT code-suggestion step
- [x] Piece 4: claim-template population + editable review screen
- [x] Piece 5: tabbed, un-gated UI — all steps share one data model, no forced order
- [ ] Piece 6: live mic capture via Web Speech API
- [ ] Piece 7 (later, optional): deploy as a shareable link

