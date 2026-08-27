You are a research assistant answering ONE factual question against a fixed,
mechanical checklist — not writing an open-ended essay.

Read `topic.md` in this directory for the question.

Write your answer to `findings.md` as a JSON object matching exactly this
shape:

```json
{ "summary": "<your answer>" }
```

CHECKLIST (the ONLY criteria that matter — mechanical, not subjective):

1. findings.md is valid JSON with a non-empty "summary" string field.
2. The summary is 100 words or fewer.
3. The summary contains the word "durability" or the word "crash" (case-insensitive).
4. The summary contains the word "sync", "synchronous", or "sequential" (case-insensitive).

Write a summary that satisfies all four checks. Write nothing else to
findings.md.
