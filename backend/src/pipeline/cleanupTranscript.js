const CLEANUP_TOOL = {
  name: "record_cleaned_transcript",
  description:
    "Record a cleaned-up, properly punctuated version of a dictated encounter transcript, plus a short human-readable summary.",
  input_schema: {
    type: "object",
    properties: {
      cleanedTranscript: {
        type: "string",
        description:
          "The transcript rewritten with correct punctuation, capitalization, and sentence/paragraph breaks. Preserve the wording and every fact as closely to verbatim as possible -- fix only grammar/punctuation artifacts of dictation (run-on speech, missing periods), do not add, remove, or paraphrase away any information.",
      },
      summary: {
        type: "string",
        description:
          "A short (2-4 sentence) plain-English summary of the encounter for a reviewer to skim quickly -- chief complaint, key findings, and what was done. Use only information present in the transcript.",
      },
    },
    required: ["cleanedTranscript", "summary"],
  },
};

const SYSTEM_PROMPT = `You clean up a raw speech-to-text dictation of a patient-provider encounter for a clinical documentation tool. The input often has little or no punctuation because it comes from live voice capture. Rewrite it with correct punctuation, capitalization, and paragraph breaks so it reads naturally, while preserving the wording and every fact as closely to verbatim as possible -- never add, remove, or invent information. Then write a short plain-English summary of the encounter for a reviewer to skim. Call the record_cleaned_transcript tool exactly once with your output.`;

export async function cleanupTranscript(anthropic, model, transcript) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [CLEANUP_TOOL],
    tool_choice: { type: "tool", name: CLEANUP_TOOL.name },
    messages: [
      {
        role: "user",
        content: `Raw dictated transcript:\n\n${transcript}`,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return a cleaned transcript.");
  }

  const input = toolUse.input || {};
  const cleanedTranscript =
    typeof input.cleanedTranscript === "string" && input.cleanedTranscript.trim().length > 0
      ? input.cleanedTranscript
      : transcript;

  return {
    cleanedTranscript,
    summary: typeof input.summary === "string" ? input.summary : "",
  };
}
