// Grounding check for medical-necessity quotes.
//
// The extraction step presents medicalNecessityLanguage as direct quotation from
// the encounter, and that text flows into the claim as the justification for why
// care was needed. A paraphrase that drifts is an attestation you cannot support
// in an audit, so every quote is checked against the transcript it claims to come
// from before a reviewer ever sees it.
//
// This is deterministic: no model call, no tokens, runs in microseconds.

export const GROUNDING = {
  VERIFIED: "verified", // appears in the transcript essentially verbatim
  PARAPHRASED: "paraphrased", // close, but reworded -- must not be shown as a quote
  UNSUPPORTED: "unsupported", // the transcript does not carry this claim
};

// Recall threshold above which a reworded quote counts as a paraphrase of the
// transcript rather than an unsupported statement. A heuristic -- tune it
// against the evaluation set rather than by intuition.
const PARAPHRASE_RECALL = 0.85;

// Below this many content words, bag-of-words recall is too easy to pass by
// accident, so a short quote has to match exactly or not at all.
const MIN_CONTENT_TOKENS = 3;

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words short enough to be filler carry no evidence that a quote came from the
// transcript, so recall is measured over the rest.
function contentTokens(text) {
  return normalize(text)
    .split(" ")
    .filter((t) => t.length >= 3);
}

/**
 * Check one quote against the transcript.
 *
 * @param {string} quote
 * @param {string} transcript
 * @returns {{quote: string, status: string, recall: number}}
 */
export function verifyQuote(quote, transcript) {
  const normalizedQuote = normalize(quote);
  const normalizedTranscript = normalize(transcript);

  if (!normalizedQuote) {
    return { quote, status: GROUNDING.UNSUPPORTED, recall: 0 };
  }

  if (normalizedTranscript.includes(normalizedQuote)) {
    return { quote, status: GROUNDING.VERIFIED, recall: 1 };
  }

  const quoteTokens = contentTokens(quote);
  if (quoteTokens.length < MIN_CONTENT_TOKENS) {
    return { quote, status: GROUNDING.UNSUPPORTED, recall: 0 };
  }

  const transcriptTokens = new Set(contentTokens(transcript));
  const hits = quoteTokens.filter((t) => transcriptTokens.has(t)).length;
  const recall = hits / quoteTokens.length;

  return {
    quote,
    status: recall >= PARAPHRASE_RECALL ? GROUNDING.PARAPHRASED : GROUNDING.UNSUPPORTED,
    recall: Math.round(recall * 100) / 100,
  };
}

/**
 * Check every medical-necessity quote on an extraction result.
 *
 * Returned in the same order as facts.medicalNecessityLanguage, and each entry
 * carries its own quote text so the two cannot silently drift apart.
 */
export function verifyNecessityQuotes(facts, transcript) {
  const quotes = Array.isArray(facts?.medicalNecessityLanguage) ? facts.medicalNecessityLanguage : [];
  return quotes.map((quote) => verifyQuote(quote, transcript));
}
