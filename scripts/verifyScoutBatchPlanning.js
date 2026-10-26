import assert from "node:assert/strict";
import { planScoutBatches } from "../pipeline.js";

const cand = (n) => "x".repeat(n);
const base = { safePromptChars: 50000, minBudgetChars: 20000, maxBatches: 8 };

// The real failure: fixed context (46.9k) nearly fills the 50k budget. 81 candidates of ~2.4k chars each.
const many = Array.from({ length: 81 }, () => cand(2400));
const oldBehaviour = planScoutBatches(many, { ...base, fixedChars: 46872, minBudgetChars: 3000, maxBatches: Infinity });
assert.ok(oldBehaviour.totalBatches >= 60, `old 3,000-char floor should give ~1 candidate per batch, got ${oldBehaviour.totalBatches}`);

const planned = planScoutBatches(many, { ...base, fixedChars: 46872 });
assert.equal(planned.availableForCandidates, 20000);
assert.ok(planned.batches.length <= 8, "capped at 8 batches");
assert.ok(planned.batches[0].length >= 8, "batches hold several candidates, not one");
assert.equal(planned.droppedCandidates, 81 - planned.batches.reduce((n, b) => n + b.length, 0));
assert.ok(planned.droppedCandidates > 0, "tail beyond the cap is dropped");

// Candidates stay best-first: the kept batches are a prefix of the input order.
const ordered = Array.from({ length: 40 }, (_, i) => `c${String(i).padStart(2, "0")}` + cand(2400));
const out = planScoutBatches(ordered, { ...base, fixedChars: 47000, maxBatches: 2 });
assert.deepEqual(out.batches.flat(), ordered.slice(0, out.batches.flat().length));

// Plenty of room: the normal budget wins over the floor and nothing is capped or dropped.
const small = planScoutBatches(Array.from({ length: 6 }, () => cand(1500)), { ...base, fixedChars: 10000 });
assert.equal(small.availableForCandidates, 40000);
assert.equal(small.batches.length, 1);
assert.equal(small.droppedCandidates, 0);

// An oversized single candidate still forms its own batch, and empty input yields no batches.
assert.equal(planScoutBatches([cand(30000)], { ...base, fixedChars: 47000 }).batches.length, 1);
assert.equal(planScoutBatches([], { ...base, fixedChars: 47000 }).batches.length, 0);

// maxBatches of 0 / non-finite means "no cap".
assert.equal(planScoutBatches(many, { ...base, fixedChars: 46872, maxBatches: 0 }).droppedCandidates, 0);

console.log("verifyScoutBatchPlanning: ok");
