const CODE_SUGGESTION_TOOL = {
  name: "record_code_suggestions",
  description:
    "Record candidate ICD-10 diagnosis codes and CPT procedure codes suggested for a claim, based on extracted clinical facts.",
  input_schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string", description: "The code itself, e.g. 'J02.0' or '87880'." },
            codeType: { type: "string", enum: ["ICD-10", "CPT"] },
            description: { type: "string", description: "The official or plain-language meaning of the code." },
            confidence: {
              type: "string",
              enum: ["high", "medium"],
              description:
                "'high' when the facts directly and unambiguously support this code, 'medium' when it's a reasonable inference but something relevant wasn't explicitly stated (e.g. visit complexity, a measured value).",
            },
            rationale: {
              type: "string",
              description:
                "One or two sentences tying this specific code to specific facts from the extraction. If the facts are too thin to be confident, say so here instead of guessing.",
            },
          },
          required: ["code", "codeType", "description", "confidence", "rationale"],
        },
      },
    },
    required: ["suggestions"],
  },
};

const SYSTEM_PROMPT = `You suggest candidate ICD-10 diagnosis codes and CPT procedure/service codes for a claim, based on structured clinical facts already extracted from a patient encounter. These are suggestions for a human reviewer to sanity-check before a claim is submitted -- not a certified coding determination, and not validated against a real coding rule set. Only suggest codes that are reasonably supported by the given facts. If a fact is too vague to support a confident code, either omit it or say so plainly in the rationale rather than guessing. Call the record_code_suggestions tool exactly once.`;

export async function suggestCodes(anthropic, model, facts) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [CODE_SUGGESTION_TOOL],
    tool_choice: { type: "tool", name: CODE_SUGGESTION_TOOL.name },
    messages: [
      {
        role: "user",
        content: `Extracted clinical facts:\n\n${JSON.stringify(facts, null, 2)}`,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return structured code suggestion output.");
  }
  return Array.isArray(toolUse.input?.suggestions) ? toolUse.input.suggestions : [];
}
