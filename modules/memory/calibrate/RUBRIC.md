# Labelling rubric — sameness fixture (138a)

Written **before** any pair was read, and fixed for the duration of a labelling pass. A rubric
written while labelling drifts to fit the pairs, and the drift leaves no trace.

The labeller works from `sheet.ndjson`, which contains **no similarity scores**. That is
structural, not a request: see `pairs.ts`.

---

## The question being answered

Not "are these texts similar" — an estimator answers that. The label answers:

> **Would representing this pair by ONE of its two members lose something a reader needs?**

That is the decision the ladder, the collapse and the reflex all actually make.

## The three labels

**`same`** — the pair refers to one fact. Keeping only the fuller or newer member loses nothing
material. Includes:
- re-saves and rephrasings of one fact;
- a **superset**: A states everything B does plus more (represent by A);
- the same fact at different lengths or formality.

**`different`** — the members assert facts that are not substitutable. Dropping either loses
information. Includes pairs that share a topic, vocabulary, or file references while making
distinct claims — this is the population the near-duplicate floor most often gets wrong, because
shared jargon inflates lexical overlap.

**`contradicts`** — same subject, incompatible assertion. Near-identical text meaning opposite
things. Scored as a false merge (and reported separately) if a floor folds it, because a merged
contradiction is worse than a lost duplicate: the survivor asserts the opposite of something the
corpus also held, with nothing marking the disagreement.

## Tie-breaks, fixed in advance

1. **Unsure between `same` and `different` → `different`.** The asymmetry that governs the
   objective function governs the labels too: a wrong `same` teaches the floor to merge.
2. **Superset with a genuinely new distinct fact → `different`.** "More detail about the same
   thing" is `same`; "also asserts a second thing" is not.
3. **Same topic, different instance → `different`.** Two incidents of one class, two machines,
   two dates.
4. **One is an index/pointer to the other → `different`.** A pointer and its target are not one
   fact.
5. **Cannot tell from the excerpt → leave `label: null`.** Unlabelled rows are dropped and
   counted, never defaulted; see `joinLabels`. Guessing to fill the sheet is the one action that
   corrupts the instrument silently.

## Provenance to record with the pass

- how many pairs were labelled, and by whom (single-source or reviewed);
- how many were left `null`;
- that the boundary-band labels are the least reliable, because that is where one labeller is
  weakest — and that band is exactly where the floor lands.

Natural pairs (mined: same slug, same scope, different body) ship **unlabelled** and are held
out as a control. A calibrated floor that splits them indicts these hand labels.
