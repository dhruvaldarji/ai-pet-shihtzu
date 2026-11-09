import { readFile } from 'node:fs/promises';
import { expect, test } from 'bun:test';
import { validatePolicy } from './pr-policy';

test('one Conventional Commit relative to the PR base passes', () => {
  expect(() => validatePolicy('fix(installer)!: preserve backups', ['fix: preserve backups'], 1)).not.toThrow();
  expect(() => validatePolicy('ci: check a stack layer', ['ci: check a stack layer'], 1)).not.toThrow();
});

test('empty or multiple commit layers fail', () => {
  for (const subjects of [[], ['fix: first', 'fix: second']]) {
    expect(() => validatePolicy('fix: valid title', subjects, 1)).toThrow('exactly one commit');
  }
});

test('both title and actual subject must be compliant', () => {
  for (const invalid of ['Update README', 'fix:no space', 'fix: ', 'fix(): empty scope', 'fix: title\nextra']) {
    expect(() => validatePolicy(invalid, ['fix: valid subject'], 1)).toThrow('PR title');
    expect(() => validatePolicy('fix: valid title', [invalid], 1)).toThrow('Commit subject');
  }
});

test('merge and root commits cannot masquerade as single-commit PRs', () => {
  for (const parents of [0, 2]) expect(() => validatePolicy('fix: valid', ['fix: valid'], parents)).toThrow('merge or root');
});

const workflow = await readFile(new URL('../.github/workflows/pr-policy.yml', import.meta.url), 'utf8');

function extractWorkflowScript(source: string) {
  const lines = source.split(/\r?\n/);
  const marker = lines.indexOf('          script: |');
  if (marker === -1) throw new Error('Workflow script block not found');
  const script: string[] = [];
  for (const line of lines.slice(marker + 1)) {
    if (line === '') {
      script.push('');
      continue;
    }
    if (!line.startsWith('            ')) break;
    script.push(line.slice(12));
  }
  return script.join('\n').trimEnd();
}

const workflowScript = extractWorkflowScript(workflow);
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

type ComparedCommit = {
  sha: string;
  commit: { message: string };
  parents: { sha: string }[];
};

function comparedCommit(subject = 'fix: valid subject', parents = [baseSha], sha = headSha): ComparedCommit {
  return { sha, commit: { message: `${subject}\n\nbody` }, parents: parents.map(parent => ({ sha: parent })) };
}

async function runWorkflow(options: {
  title?: string;
  base?: string;
  head?: string;
  totalCommits?: number;
  commits?: ComparedCommit[];
  apiFailure?: boolean;
} = {}) {
  const calls: unknown[] = [];
  const failures: string[] = [];
  const info: string[] = [];
  const github = {
    rest: {
      repos: {
        compareCommitsWithBasehead: async (args: unknown) => {
          calls.push(args);
          if (options.apiFailure) throw new Error('private API response details');
          return {
            data: {
              total_commits: options.totalCommits ?? 1,
              commits: options.commits ?? [comparedCommit()],
            },
          };
        },
      },
    },
  };
  const context = {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    payload: {
      pull_request: {
        title: options.title ?? 'fix: valid PR title',
        base: { sha: options.base ?? baseSha },
        head: { sha: options.head ?? headSha },
      },
    },
  };
  const core = {
    info: (message: string) => info.push(message),
    setFailed: (message: string) => failures.push(message),
  };
  const execute = new Function(
    'github',
    'context',
    'core',
    `return (async () => {\n${workflowScript}\n})();`,
  ) as (github: unknown, context: unknown, core: unknown) => Promise<void>;
  await execute(github, context, core);
  return { calls, failures, info };
}

test('embedded workflow script accepts one valid commit and compares the event SHAs', async () => {
  const result = await runWorkflow();
  expect(result.failures).toEqual([]);
  expect(result.info).toEqual(['PR policy passed']);
  expect(result.calls).toEqual([{
    owner: 'test-owner',
    repo: 'test-repo',
    basehead: `${baseSha}...${headSha}`,
    per_page: 2,
  }]);
});

test('embedded workflow script rejects zero and multiple commits, including a truncated page', async () => {
  const cases = [
    { totalCommits: 0, commits: [] },
    { totalCommits: 2, commits: [comparedCommit(), comparedCommit('fix: second', [baseSha], 'c'.repeat(40))] },
    { totalCommits: 3, commits: [comparedCommit(), comparedCommit('fix: second', [baseSha], 'c'.repeat(40))] },
  ];
  for (const scenario of cases) {
    const result = await runWorkflow(scenario);
    expect(result.failures).toEqual(['PR policy validation failed']);
  }
});

test('embedded workflow script validates title, SHA, subject and head identity', async () => {
  const invalidTitle = await runWorkflow({ title: 'Update README' });
  expect(invalidTitle.failures).toEqual(['PR policy validation failed']);
  expect(invalidTitle.calls).toEqual([]);

  for (const metadata of [{ base: 'invalid' }, { head: 'invalid' }]) {
    const invalidSha = await runWorkflow(metadata);
    expect(invalidSha.failures).toEqual(['PR policy validation failed']);
    expect(invalidSha.calls).toEqual([]);
  }

  const invalidSubject = await runWorkflow({ commits: [comparedCommit('Update README')] });
  expect(invalidSubject.failures).toEqual(['PR policy validation failed']);

  const wrongHead = await runWorkflow({ commits: [comparedCommit('fix: valid subject', [baseSha], 'c'.repeat(40))] });
  expect(wrongHead.failures).toEqual(['PR policy validation failed']);
});

test('embedded workflow script rejects root and merge commits', async () => {
  for (const parents of [[], [baseSha, 'c'.repeat(40)]]) {
    const result = await runWorkflow({ commits: [comparedCommit('fix: valid subject', parents)] });
    expect(result.failures).toEqual(['PR policy validation failed']);
  }
});

test('embedded workflow script sanitizes API errors', async () => {
  const result = await runWorkflow({ apiFailure: true });
  expect(result.failures).toEqual(['PR policy validation failed']);
  expect(result.failures.join(' ')).not.toContain('private API response details');
});

test('workflow is read-only and its policy does not depend on the package command', async () => {
  expect(workflow).toContain('  pull_request_target:\n');
  expect(workflow.match(/^permissions:\n((?: {2}[^\n]+\n)+)/m)?.[1]).toBe('  contents: read\n');
  expect(workflow).toContain('actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b');
  expect(workflow).not.toContain('actions/checkout');
  expect(workflow).not.toMatch(/^\s+-\s+run:/m);
  expect(workflow).not.toContain('secrets.');
  expect(workflowScript).not.toContain('bun run check:pr');
  expect(workflowScript).not.toContain('${{');

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  packageJson.scripts['check:pr'] = 'echo bypass';
  const result = await runWorkflow({ title: 'Update README' });
  expect(packageJson.scripts['check:pr']).toBe('echo bypass');
  expect(result.failures).toEqual(['PR policy validation failed']);
});
