/**
 * gated-implement.js — Loop engineering implementasi: build -> gate -> resume (maks 3x) -> debugger RCA.
 *
 * args: { task?: string, test?: string, maxRetries?: number }
 */
export const meta = {
  name: 'gated-implement',
  description: 'Implement task with deterministic gate, bounded resume loop, and debugger RCA fallback',
  phases: [{ title: 'Build' }, { title: 'Verify' }, { title: 'Debug' }],
};

const task = args?.task ?? 'Implement the requested change and add tests.';
const testCommand = args?.test ?? 'node ~/.agents/skills/dev/scripts/checks.mjs';
const maxRetries = typeof args?.maxRetries === 'number' && args.maxRetries > 0 ? args.maxRetries : 3;

phase('Build');
let result = await agent(task, {
  label: 'build',
  subagent_type: 'build',
  gate: testCommand,
});

if (result !== null) {
  phase('Verify');
  const verified = await agent(
    `Run \`${testCommand}\` and verify acceptance criteria. Change nothing.`,
    { label: 'verify', subagent_type: 'verifier', gate: testCommand },
  );
  return { passed: verified !== null, attempts: 1, summary: result, verification: verified };
}

for (let attempt = 2; attempt <= maxRetries; attempt++) {
  log(`Attempt ${attempt}/${maxRetries}: ${testCommand} failed — resuming build`);
  result = await agent(
    `\`${testCommand}\` failed. Read the failure output above, fix the root cause, and stop.`,
    { label: 'build', resume: 'build' },
  );

  phase('Verify');
  const verified = await agent(
    `Run \`${testCommand}\` and report the exact result. Change nothing.`,
    { label: `verify-${attempt}`, subagent_type: 'verifier', gate: testCommand },
  );
  if (verified !== null) {
    return { passed: true, attempts: attempt, summary: result, verification: verified };
  }
}

phase('Debug');
log(`Reached max ${maxRetries} failed cycles — escalating to debugger for RCA`);
const rca = await agent(
  `\`${testCommand}\` failed after ${maxRetries} build attempts for task: ${task}. Isolate the root cause without editing files.`,
  { label: 'debugger-rca', subagent_type: 'debugger' },
);

return { passed: false, attempts: maxRetries, summary: result, rca };
