import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { checkBrief, REQUIRED_SECTIONS } from '../scripts/check-brief.mjs';

const root = resolve(import.meta.dirname, '..');
const template = readFileSync(join(root, 'clients/_template/BRIEF.md'), 'utf8');
const filled = template.replace('CLIENT NAME', 'Acme Fitness').replaceAll('TODO', 'Answered.');

test('the blank template is reported as incomplete', () => {
  const result = checkBrief(template);
  assert.equal(result.ok, false);
  for (const name of REQUIRED_SECTIONS) assert.ok(result.errors.includes(`Unanswered section: ${name}`));
  assert.ok(result.errors.some(e => e.includes('CLIENT NAME')));
});
test('a fully answered brief passes', () => {
  assert.deepEqual(checkBrief(filled), { ok: true, errors: [] });
});
test('one unanswered or missing section fails the brief', () => {
  const oneTodo = filled.replace(/(## Call to action[\s\S]*?)Answered\./, '$1TODO');
  assert.deepEqual(checkBrief(oneTodo).errors, ['Unanswered section: Call to action']);
  const missing = filled.replace('## Main objection', '## Something else');
  assert.ok(checkBrief(missing).errors.includes('Missing section: Main objection'));
});
