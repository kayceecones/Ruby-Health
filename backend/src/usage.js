// Token accounting for every model call.
//
// Cost per claim should be a number you can look up, not one you re-derive.
// Every pipeline stage routes its response through recordUsage, so a new stage
// cannot silently escape accounting.

const totals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  byStage: {},
};

function blankStage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Record the token usage from one Messages API response.
 *
 * @param {string} stage   pipeline stage name, e.g. "extract"
 * @param {string} model   the model the call was made against
 * @param {object} response the raw SDK response (its `usage` block is read)
 * @returns {object} the usage figures for this single call
 */
export function recordUsage(stage, model, response) {
  const u = (response && response.usage) || {};

  const call = {
    stage,
    model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    // Zero cache reads across repeated identical prefixes means a silent
    // invalidator is at work -- that is the signal worth watching here.
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };

  const stageTotals = totals.byStage[stage] || (totals.byStage[stage] = blankStage());
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    totals[key] += call[key];
    stageTotals[key] += call[key];
  }
  totals.calls += 1;
  stageTotals.calls += 1;

  console.log(JSON.stringify({ type: "usage", ...call }));

  return call;
}

/** Running totals since the process started. */
export function usageTotals() {
  return JSON.parse(JSON.stringify(totals));
}

/** Reset the counters. Used by tests. */
export function resetUsage() {
  totals.calls = 0;
  totals.inputTokens = 0;
  totals.outputTokens = 0;
  totals.cacheReadTokens = 0;
  totals.cacheWriteTokens = 0;
  totals.byStage = {};
}
