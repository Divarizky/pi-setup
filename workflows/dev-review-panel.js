/**
 * dev-review-panel.js — Parallel code-review panel aligned with dev/code-review axes.
 *
 * Correctness/Safety escalates to sonnet-5-5; Standards & Spec run on haiku-5-5 high.
 * args: { target?: string, spec?: string }
 */
export const meta = {
  name: 'dev-review-panel',
  description: 'Parallel code review across Correctness/Safety (sonnet-5-5) and Standards/Spec (haiku-5-5)',
  phases: [{ title: 'Review' }, { title: 'Synthesize' }],
};

const target = args?.target ?? 'git diff --staged';
const specNote = args?.spec ? `\n\nSpec / Done criteria:\n${args.spec}` : '';

phase('Review');

const [correctness, standardsSpec] = await parallel([
  () =>
    agent(
      `Audit Correctness/Safety for: ${target}. Focus on bugs, regressions, security, data loss, concurrency, and cross-boundary tracing.${specNote}`,
      {
        label: 'review:correctness',
        subagent_type: 'reviewer',
        model: 'zenith-router/cc/claude-sonnet-5-5',
        effort: 'medium',
      },
    ),
  () =>
    agent(
      `Audit Standards and Spec compliance for: ${target}. Report clear rule violations, smell baseline issues, and missing Done criteria.${specNote}`,
      {
        label: 'review:standards-spec',
        subagent_type: 'reviewer',
        model: 'zenith-router/cc/claude-haiku-5-5',
        effort: 'high',
      },
    ),
]);

if (correctness === null && standardsSpec === null) {
  log('both review axes failed');
  return { reviewed: 0, verdict: null };
}

phase('Synthesize');

const verdict = await agent(
  [
    `Reconcile these review findings for ${target}. Deduplicate overlaps, preserve P0-P3 severity and confidence tags, and output final PASS/FAIL verdict.`,
    correctness ? `\n## Correctness & Safety\n${correctness}` : '',
    standardsSpec ? `\n## Standards & Spec\n${standardsSpec}` : '',
  ]
    .filter(Boolean)
    .join('\n'),
  {
    label: 'synthesize',
    subagent_type: 'reviewer',
    model: 'zenith-router/cc/claude-haiku-5-5',
    effort: 'medium',
  },
);

return {
  reviewed: [correctness, standardsSpec].filter(Boolean).length,
  correctness,
  standardsSpec,
  verdict,
};
