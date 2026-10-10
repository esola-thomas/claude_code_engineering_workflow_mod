// Policy coverage (metric M7): every matrix rule 1-10 has a case where it decides and a
// near miss where it does not; the Bash classifier has >= 60 cases, >= 25 of them
// bypass attempts that must never come out 'read_only'; >= 10 destructive or network
// commands are denied even in IMPLEMENT.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALWAYS_DENIED_TOOLS,
  NETWORK_PROGRAMS,
  NETWORK_READ_TOOLS,
  OUTBOUND_TOOLS,
  OWN_TOOL_PREFIX,
  READONLY_AGENT_TYPES,
  READONLY_OWN_TOOLS,
  SAFE_TOOLS,
  WRITE_TOOLS,
  classifyBash,
  evaluateToolCall,
} from '../../src/policies.ts'
import type { BashClass, PolicyCall, PolicyContext } from '../../src/policies.ts'
import { ACTIVE_PHASES } from '../../src/types.ts'
import type { Phase, Profile, ToolVerdict } from '../../src/types.ts'
import { deepFreeze, makeProfile } from '../support/fixtures.ts'

// ---------------------------------------------------------------------------
// Profiles, contexts and assertions
// ---------------------------------------------------------------------------

const basePolicies = makeProfile().policies

function profileWith(policies: Partial<Profile['policies']> = {}, validationCommands: string[] = ['npm test']): Profile {
  return deepFreeze(
    makeProfile({
      policies: { ...basePolicies, ...policies },
      validation: { commands: validationCommands, timeout_ms: 300000 },
    }),
  )
}

/** deny_by_default, validation command "npm test". */
const PROFILE = profileWith()
const NETWORK_ALLOWED = profileWith({ external_network: 'allow' })
const WRITE_IN_EXPLORE = profileWith({ allow_write_in_explore: true })

function classify(command: string, profile: Profile = PROFILE): BashClass {
  return classifyBash(command, profile)
}

function context(phase: Phase | null, overrides: Partial<PolicyContext> = {}): PolicyContext {
  return deepFreeze({ phase, profile: PROFILE, root: '/repo', agentType: null, ...overrides })
}

function call(tool: string, input: Record<string, unknown> = {}, resolvedPath?: string): PolicyCall {
  return deepFreeze(resolvedPath === undefined ? { tool, input } : { tool, input, resolvedPath })
}

function evaluate(
  phase: Phase | null,
  tool: string,
  input: Record<string, unknown> = {},
  options: { profile?: Profile; agentType?: string | null; resolvedPath?: string } = {},
): ToolVerdict {
  const ctx = context(phase, { profile: options.profile ?? PROFILE, agentType: options.agentType ?? null })
  return evaluateToolCall(ctx, call(tool, input, options.resolvedPath))
}

function bash(phase: Phase | null, command: string, options: { profile?: Profile; agentType?: string | null } = {}): ToolVerdict {
  return evaluate(phase, 'Bash', { command }, options)
}

function assertAllowed(verdict: ToolVerdict, message?: string): void {
  assert.deepEqual(verdict, { allow: true }, message)
}

/** Asserts a denial in the "ewm: ..." format and that the reason contains every fragment. Returns the reason. */
function assertDenied(verdict: ToolVerdict, ...fragments: string[]): string {
  if (verdict.allow) assert.fail(`expected a denial, got allow (${fragments.join(', ')})`)
  assert.ok(verdict.reason.startsWith('ewm: '), `reason must start with "ewm: ": ${verdict.reason}`)
  for (const fragment of fragments) {
    assert.ok(verdict.reason.includes(fragment), `reason should mention ${JSON.stringify(fragment)}: ${verdict.reason}`)
  }
  return verdict.reason
}

function expectClass(cases: readonly string[], expected: BashClass, profile: Profile = PROFILE): void {
  for (const command of cases) {
    it(`${JSON.stringify(command)} is ${expected}`, () => {
      assert.equal(classify(command, profile), expected)
    })
  }
}

/** Single-quotes a string for sh (used to build nested `sh -c` commands). */
function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** `sh -c '...sh -c 'inner'...'` nested `levels` deep: the inner command runs at nesting depth `levels`. */
function nestShells(levels: number, inner: string): string {
  return levels === 0 ? inner : `sh -c ${shQuote(nestShells(levels - 1, inner))}`
}

const IMPLEMENT_ONLY_PHASES: readonly Phase[] = ['INTAKE', 'EXPLORE', 'UNDERSTAND', 'PLAN', 'VALIDATE']

// ---------------------------------------------------------------------------
// Bash cases
// ---------------------------------------------------------------------------

const READ_ONLY_CASES = [
  // the plain basics
  'ls',
  'ls -la',
  'cat README.md',
  'head -n 20 src/a.ts',
  'tail -n 5 log.txt',
  'wc -l src/a.ts',
  'pwd',
  'echo hello',
  "printf '%s\\n' hi",
  'stat src/a.ts',
  'du -sh .',
  'df -h',
  'which node',
  'type ls',
  'basename src/a.ts',
  'dirname src/a.ts',
  'realpath .',
  'readlink -f link',
  'cut -d, -f1 a.csv',
  'tr a-z A-Z',
  'diff a b',
  'cmp a b',
  'comm a b',
  'nl a',
  'column -t a',
  'true',
  'false',
  'test -f a',
  'jq . a.json',
  // search
  'grep -rn foo src',
  'egrep -n "a|b" f',
  'fgrep x f',
  'rg foo src 2>/dev/null',
  'rg -n --glob "*.ts" foo',
  "find src -name '*.ts'",
  'find . -type f -newer a',
  'tree -L 2',
  'file a.bin',
  // sort and uniq without an output file
  'sort a',
  'sort -u -k2 a',
  'uniq a',
  'uniq -c a',
  'uniq -f 1 a',
  // git, read-only subcommands
  'git status',
  'git status -sb',
  'git log --oneline -5',
  'git diff HEAD~1 -- src',
  'git show HEAD --stat',
  'git blame -L 1,5 src/a.ts',
  'git ls-files',
  'git ls-tree HEAD',
  'git grep -n foo',
  'git rev-parse HEAD',
  'git describe --tags',
  'git shortlog -sn',
  'git cat-file -p HEAD',
  'git branch',
  'git branch -a',
  'git branch -vv',
  'git branch --show-current',
  'git branch --list',
  'git remote',
  'git remote -v',
  'git tag',
  'git tag -l',
  'git tag --list',
  'git config --get user.name',
  'git config --get-all remote.origin.fetch',
  'git config --list',
  'git --no-pager log',
  'git -C sub status',
  // pipelines and lists of read-only commands
  'cat a | wc -l',
  'grep -rn foo src | head -20',
  'ls && pwd',
  'ls; pwd',
  'cat a || echo none',
  'ls\npwd',
  'ls 2>&1',
  'ls 2>/dev/null | head',
  '2>/dev/null ls',
  'ls 2> /dev/null',
  'ls \\\n -la',
  // braces without a comma or ".." are literal; globs behind a directory prefix start with it
  'git log HEAD@{1}',
  'git diff @{u}',
  'git rev-parse HEAD@{2.days.ago}',
  'git log HEAD@{1} --format=%h,%s',
  'echo {a b,c}',
  "echo '{a,b}'",
  'echo "{a,b}"',
  'echo \\{a,b\\}',
  'rg foo src/*.ts',
  'rg foo ./*',
  'git log -- src/*.ts',
  'find src -name "*.ts"',
  "find . -name '*.md'",
  'rg "a.*b" .',
  'grep foo *',
  'ls *.ts',
  'cat *',
  'wc -l *.ts',
  // a comment is not code, whatever it contains
  "ls # it's the list; rm -rf x",
  'git status # then git push',
  'echo a#b',
  // quoting keeps operators and dollars inert
  "echo 'a | b ; c > d'",
  'echo "a && b"',
  "echo '$HOME'",
  'echo \\$HOME',
  'grep "foo$" f',
  "grep 'foo$' f",
]

/** The bypass attempts of the task brief plus more: none may ever be 'read_only'. */
const BYPASS_CASES = [
  // separators and lists
  'ls; rm -rf x',
  'cat a && touch b',
  'ls & rm x',
  'ls | tee f',
  'ls\nrm x',
  // substitution, expansion and variables
  'echo $(rm x)',
  'echo `id`',
  'echo "$(id)"',
  'echo "`id`"',
  'echo $HOME',
  'echo "${HOME}"',
  'echo $0',
  'echo $((1+2))',
  "echo $'a'",
  'echo $"a"',
  'ls $(pwd)',
  // redirection
  'cat a > b',
  'cat a >> b',
  'cat < /etc/passwd',
  'cat /dev/tcp/x/80 <&0',
  'cat <<< hi',
  'cat <<EOF\nx\nEOF',
  'diff <(ls) <(ls)',
  'ls > /dev/null',
  'ls 2> out',
  'ls 2>>log',
  'ls &> out',
  'ls >&2',
  // subshells
  '(ls)',
  // find
  'find . -exec rm {} \\;',
  'find . -execdir sh -c x {} +',
  'find . -ok rm {} \\;',
  'find . -delete',
  'find . -fprint out',
  'find . -fprintf out x',
  'find . -fls out',
  // sed, awk and friends are not allowlisted
  'sed -n p f',
  "awk '{print}' f",
  'xargs cat',
  'tee out.txt',
  'python3 x.py',
  'node -e 1',
  'touch f',
  'mkdir d',
  'cp a b',
  'mv a b',
  'rm x',
  'cd src && ls',
  // git: global options, write options, write subcommands
  'git -c core.pager=sh log',
  'git --git-dir=/x log',
  'git --exec-path=/x log',
  'git --work-tree=/x status',
  'git log --output=x',
  'git log --out=x',
  'git show --output x',
  'git diff --ext-diff',
  'git show --textconv HEAD',
  'git diff --upload-pack=x',
  'git grep -Ocat x',
  'git grep -n -O x',
  'git grep --open-files-in-pager=less x',
  'git branch -D x',
  'git branch newname',
  'git branch -m a b',
  'git tag v1',
  'git tag -d v1',
  'git remote add o u',
  'git config user.name x',
  'git config --global user.name x',
  'git config --unset user.name',
  'git config --get --add a b',
  'git commit -m x',
  'git stash',
  // options that write or execute
  'rg --pre cat x',
  'rg --pre=cat x',
  'rg --hostname-bin=x foo',
  'sort -o out f',
  'sort -ro out f',
  'sort --output=out f',
  'sort --out=out f',
  'sort --compress-program=sh f',
  'uniq a b',
  'uniq -c a b',
  'uniq -f 1 a b',
  'tree -o out',
  'tree -ao out',
  'file -C -m x',
  'file -bC',
  'file --compile',
  // assignments, wrappers, shells, paths
  'FOO=1 ls',
  'env ls',
  'time ls',
  'nice ls',
  'command ls',
  'exec ls',
  'timeout 5 ls',
  'nohup ls',
  'sudo ls',
  'bash -c ls',
  'sh -c ls',
  'eval ls',
  '/bin/rm x',
  '/usr/bin/ls',
  './ls',
  // redirections other than exactly 2>/dev/null and 2>&1
  'ls 2>/dev/nullx',
  'ls 2>/dev/null/x',
  'ls 2>/dev/null>out',
  'ls 2>&10',
  'ls 2>&1>out',
  'ls 2>/dev/stderr',
  'ls 2>/dev/tty',
  'ls a2>/dev/null',
  'ls 1>/dev/null',
  'ls 22>/dev/null',
  'ls "2">/dev/null',
  'ls x>/dev/null',
  // grouping characters, even unbalanced
  '(ls',
  'ls )',
  // brace expansion turns one word into several, so it can supply options and extra arguments
  'sort {-o,out} f',
  'sort {--output=out,f}',
  'rg {--pre,cat} x',
  'git log {--output,x}',
  'git log --{output=x,oneline}',
  'find . {-exec,rm,{},\\;}',
  'find . -{delete,x}',
  'uniq {a,b}',
  'uniq {a,b} -Cfetch',
  'file -{C,b}',
  'ls {a,b}',
  'ls {1..3}',
  'ls a{b,c}d',
  'echo {"a",b}',
  // a glob without a directory prefix can expand to a file named like an option (wildcard injection)
  'rg foo *',
  'rg foo *.ts',
  'find * -name x',
  'git log -- *.ts',
  'git grep foo -- ?x',
  'sort [a-z]*',
  'uniq *',
  'tree *',
  'file *',
  'sort -[o] f',
  'sort [-]o f',
  'rg foo [-]-pre=cat',
  // git: a subcommand that is, or may hide behind, an expansion
  "git '$x' show --oneline",
  'git $x show',
  'git $(echo -C .) status',
  'git grep -nOless x',
  // a # inside a word is not a comment, and a comment ends at the newline
  'ls a#b; rm x',
  'ls # comment\nrm x',
  'ls "x # y" ; rm z',
  // not parseable
  "ls 'unterminated",
  'ls "unterminated',
  'ls \\',
  '',
  '   ',
]

/** Commands that must classify as 'destructive' (and be denied in IMPLEMENT). */
const DESTRUCTIVE_CASES = [
  // git push, with every way of reaching it
  'git push',
  'git push origin main',
  'git push --force',
  '/usr/bin/git push',
  './git push',
  'GIT push',
  'git -C . push',
  'git -c a=b push',
  'git --no-pager push',
  'git -C . -c a=b --no-pager push',
  'git --git-dir=.git push',
  'git --git-dir .git --work-tree . push',
  'git --namespace=n push',
  'git -P push',
  'git --bare push',
  'git --exec-path=/x push',
  'env git push',
  'env -i FOO=1 git push',
  'env -u HOME git push',
  'FOO=1 git push',
  'command git push',
  'command -p git push',
  'exec git push',
  'nohup git push',
  'nice git push',
  'nice -n 10 git push',
  'time git push',
  'timeout 5 git push',
  'timeout -s KILL 5 git push',
  'timeout --foreground 5s git push',
  'xargs git push',
  'xargs -n1 git push',
  'xargs -I{} git push {}',
  // shells and eval
  "bash -c 'git push'",
  'sh -c "rm -rf x"',
  "zsh -c 'git push'",
  "dash -c 'git push'",
  "ksh -c 'git push'",
  "bash -lc 'git push'",
  "bash -ec 'git push'",
  "bash --norc -c 'git push'",
  "bash -o pipefail -c 'git push'",
  "sh -c 'git push' _ arg",
  "env bash -c 'git push'",
  "env -S 'git push'",
  'eval git push',
  "eval 'git push'",
  'eval "rm -rf x"',
  // other git
  'git reset --hard',
  'git reset --hard HEAD~1',
  'git reset HEAD~1 --hard',
  'git reset --ha',
  'git clean -f',
  'git clean -fd',
  'git clean -fdx',
  'git clean -df',
  'git clean -xdf',
  'git clean --force',
  'git clean -d',
  'git clean -x',
  'git checkout .',
  'git checkout -- .',
  'git checkout HEAD -- .',
  'git restore .',
  'git restore --staged .',
  // rm -rf in every spelling
  'rm -rf x',
  'rm -fr x',
  'rm -r -f build',
  'rm -R -f x',
  'rm -Rf x',
  'rm -rfv x',
  'rm -vrf x',
  'rm --recursive --force x',
  'rm -r --force x',
  'rm --recursive -f x',
  '/bin/rm -rf x',
  '/BIN/RM -rf x',
  'xargs rm -rf',
  'xargs -I {} rm -rf {}',
  'timeout 5 rm -rf x',
  // find
  'find . -delete',
  'find . -name x -delete',
  'find . -exec git push \\;',
  'find . -execdir rm -rf {} +',
  'find . -ok rm -rf {} \\;',
  // privileged, disks
  'sudo ls',
  'sudo -u root ls',
  'doas ls',
  'env sudo ls',
  '/usr/bin/sudo ls',
  'mkfs /dev/sda',
  'mkfs.ext4 /dev/sda1',
  'dd if=/dev/zero of=/dev/sda',
  'dd of=x',
  'shred f',
  // hidden in lists, keywords, groups, quotes
  'ls; git push',
  'ls && git push',
  'ls || git push',
  'ls | git push',
  'ls & git push',
  'ls\ngit push',
  'ls; rm -rf x',
  '! git push',
  'if true; then git push; fi',
  'while true; do rm -rf x; done',
  '{ git push; }',
  '(git push)',
  "'git' push",
  '"git" push',
  'g""it push',
  '\\git push',
  // hidden in substitutions, process substitution, heredocs
  'echo "$(git push)"',
  'echo $(rm -rf x)',
  'echo `git push`',
  'echo "`git push`"',
  'ls $(sudo ls)',
  'VAR=$(git push)',
  'diff <(git push) b',
  'bash <<EOF\ngit push\nEOF',
  'cat <<EOF | sh\nrm -rf x\nEOF',
  'git commit -m "$(cat <<\'EOF\'\nit\'s fine\nEOF\n)" && git push',
  // the shell runs what it can read before a syntax error, so unterminated quotes and trailing backslashes do not hide a command
  'git push \\',
  "git push\necho 'unterminated",
  'git push\necho "unterminated',
  'git push; echo "unterminated',
  'echo "$(git push',
  'echo `git push',
  "git push # don't",
  "git push # it's fine\nls",
  "ls # note\ngit push",
  // a number after a redirection operator is its target, not a file descriptor: the command after it still runs
  'git <& 2>&1 push',
  'git > 2>&1 push',
  // an expansion at command position may vanish, letting the next word run
  '$X git push',
  '$(echo) git push',
  'git $X push',
  'git $(echo -C .) push',
  'FOO=$(true) rm -rf x',
  'rm$X -rf y',
  // ANSI-C quoting decodes before the shell runs it
  "git $'\\x70ush'",
  "git $'pu\\163h'",
  "git $'p\\u0075sh'",
]

const NETWORK_CASES = [
  'curl https://x',
  'wget x',
  'nc host 80',
  'ncat host 80',
  'netcat host 80',
  'ssh host',
  'scp a host:b',
  'sftp host',
  'rsync a host:b',
  'telnet host',
  'ftp host',
  'socat - TCP:host:80',
  '/usr/bin/curl x',
  'CURL x',
  'env curl x',
  'timeout 5 curl x',
  'xargs curl',
  "bash -c 'curl x'",
  'ls | nc host 80',
  'ls && curl x',
  'echo "$(curl x)"',
  'curl$X x',
  'curl x \\',
  '<& 2>&1 wget x',
  "curl x\necho 'unterminated",
  '$X curl x',
  'git fetch',
  'git fetch origin',
  'git pull',
  'git clone https://x',
  'git ls-remote origin',
  'git submodule update',
  'git submodule update --init',
  'git remote update',
  'git -C . fetch',
  'git --no-pager pull',
]

// ---------------------------------------------------------------------------
// Tool lists (contract)
// ---------------------------------------------------------------------------

describe('policy constants', () => {
  it('match the contract', () => {
    assert.deepEqual([...WRITE_TOOLS], ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
    assert.deepEqual([...ALWAYS_DENIED_TOOLS], ['EnterWorktree', 'ExitWorktree'])
    assert.equal(OWN_TOOL_PREFIX, 'mcp__ewm__')
    assert.deepEqual([...READONLY_OWN_TOOLS], ['mcp__ewm__status'])
    assert.deepEqual([...READONLY_AGENT_TYPES], ['ewm:repo-scout', 'ewm:docs-scout', 'ewm:reviewer'])
    // CR18: the original twelve come first, then the programs the security review added.
    assert.deepEqual([...NETWORK_PROGRAMS].slice(0, 12), ['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp', 'socat'])
    for (const program of ['ping', 'dig', 'nslookup', 'whois', 'traceroute', 'tftp', 'lftp', 'aria2c', 'gh']) {
      assert.ok(NETWORK_PROGRAMS.includes(program), program)
    }
    assert.deepEqual([...SAFE_TOOLS], [
      'Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead', 'ToolSearch', 'Agent', 'Task', 'Skill', 'AskUserQuestion', 'TodoWrite',
      'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'TaskStop', 'EnterPlanMode', 'ExitPlanMode', 'ListAgents',
    ])
    assert.deepEqual([...NETWORK_READ_TOOLS], ['WebFetch', 'WebSearch'])
    assert.deepEqual([...OUTBOUND_TOOLS], [
      'WebFetch', 'WebSearch', 'Artifact', 'ArtifactData', 'ArtifactComments', 'SendFile', 'SendUserFile', 'SendMessage',
      'PushNotification', 'RemoteTrigger', 'PublishPlugin', 'DesignSync',
    ])
  })

  it('are frozen', () => {
    for (const list of [WRITE_TOOLS, SAFE_TOOLS, NETWORK_READ_TOOLS, OUTBOUND_TOOLS, ALWAYS_DENIED_TOOLS, READONLY_OWN_TOOLS, READONLY_AGENT_TYPES, NETWORK_PROGRAMS]) {
      assert.ok(Object.isFrozen(list))
    }
  })
})

// ---------------------------------------------------------------------------
// classifyBash
// ---------------------------------------------------------------------------

describe('classifyBash: metric M7 coverage', () => {
  it('has at least 60 cases overall', () => {
    const total = READ_ONLY_CASES.length + BYPASS_CASES.length + DESTRUCTIVE_CASES.length + NETWORK_CASES.length
    assert.ok(total >= 60, String(total))
  })

  it('has at least 25 bypass attempts', () => {
    assert.ok(BYPASS_CASES.length >= 25, String(BYPASS_CASES.length))
  })

  it('has at least 10 destructive or network commands', () => {
    assert.ok(DESTRUCTIVE_CASES.length + NETWORK_CASES.length >= 10)
  })
})

describe('classifyBash: read_only', () => {
  expectClass(READ_ONLY_CASES, 'read_only')
})

describe('classifyBash: bypass attempts are never read_only', () => {
  for (const command of BYPASS_CASES) {
    it(`${JSON.stringify(command)}`, () => {
      assert.notEqual(classify(command), 'read_only')
    })
  }

  it('the quoted/escaped forms of the same dangers are read_only only when inert', () => {
    assert.equal(classify("echo '$(rm x)'"), 'read_only')
    assert.equal(classify("echo '`id`'"), 'read_only')
    assert.equal(classify('echo "a > b"'), 'read_only')
    assert.equal(classify('echo "a; rm x"'), 'read_only')
    assert.equal(classify('echo a\\;b'), 'read_only')
    assert.equal(classify('echo a\\>b'), 'read_only')
  })
})

describe('classifyBash: destructive', () => {
  expectClass(DESTRUCTIVE_CASES, 'destructive')

  it('beats network and read_only when a list mixes them', () => {
    assert.equal(classify('git fetch && rm -rf x'), 'destructive')
    assert.equal(classify('curl x | sudo sh'), 'destructive')
    assert.equal(classify('ls; git push'), 'destructive')
  })

  it('is not triggered by the words appearing as data or as safer variants', () => {
    for (const command of [
      'echo git push',
      'echo sudo',
      'grep "git push" f',
      "grep 'rm -rf' f",
      'git reset --soft HEAD~1',
      'git reset HEAD file',
      'git clean -n',
      'git clean',
      'git checkout main',
      'git checkout -- file',
      'git restore file',
      'git stash drop',
      'git branch -D x',
      'git commit -m "git push"',
      'rm x',
      'rm -r x',
      'rm -f x',
      'dd if=a',
      'find . -name x',
      'find . -exec rm {} \\;',
    ]) {
      assert.notEqual(classify(command), 'destructive', command)
    }
  })
})

describe('classifyBash: network', () => {
  expectClass(NETWORK_CASES, 'network')

  it('is not triggered by the words appearing as data or by local git', () => {
    for (const command of [
      'echo curl',
      'grep curl f',
      'git log',
      'git remote -v',
      'git remote add o u',
      'git submodule status',
      'git status',
      'npm install',
    ]) {
      assert.notEqual(classify(command), 'network', command)
    }
  })

  it('beats read_only in a list', () => {
    assert.equal(classify('ls; curl x'), 'network')
    assert.equal(classify('git fetch; ls'), 'network')
  })
})

describe('classifyBash: unwrapping', () => {
  it('reads through env options, assignments and other wrappers', () => {
    assert.equal(classify('env -i -u A -C /tmp B=1 C=2 git push'), 'destructive')
    assert.equal(classify('nice -n -5 timeout -k 1 5 xargs -0 -P 4 -I{} rm -rf {}'), 'destructive')
    assert.equal(classify('time -p git push'), 'destructive')
    assert.equal(classify('exec -a name git push'), 'destructive')
    assert.equal(classify('env env env git push'), 'destructive')
  })

  it('reads through git global options with values', () => {
    assert.equal(classify('git -C /a -C b -c k=v -c k2=v2 --git-dir=x --work-tree y --namespace n push'), 'destructive')
  })

  it('keeps the program a wrapper runs even when option values look like programs', () => {
    assert.equal(classify('timeout -s git 5 rm -rf x'), 'destructive')
    assert.notEqual(classify('timeout -s KILL 5 ls'), 'destructive')
  })

  it('sees commands in find -exec like xargs', () => {
    assert.equal(classify('find . -type f -exec sh -c "git push" {} +'), 'destructive')
    assert.equal(classify('find . -exec echo {} \\; -exec git push \\;'), 'destructive')
  })
})

describe('classifyBash: shells and eval recurse up to depth 3', () => {
  it('classifies the command inside sh -c at depth 1, 2 and 3', () => {
    assert.equal(classify(nestShells(1, 'git push')), 'destructive')
    assert.equal(classify(nestShells(2, 'git push')), 'destructive')
    assert.equal(classify(nestShells(3, 'git push')), 'destructive')
  })

  it("leaves anything deeper as 'other'", () => {
    assert.equal(classify(nestShells(4, 'git push')), 'other')
    assert.equal(classify(nestShells(5, 'rm -rf x')), 'other')
  })

  it('counts eval like a shell level', () => {
    assert.equal(classify('eval eval eval git push'), 'destructive')
    assert.equal(classify('eval "eval \\"eval \\\\\\"eval git push\\\\\\"\\""'), 'other')
  })

  it('still sees a destructive command next to a too-deep one', () => {
    assert.equal(classify(`${nestShells(4, 'git push')}; rm -rf x`), 'destructive')
  })

  it('treats a shell that runs a script, not a command string, as other', () => {
    assert.equal(classify('bash script.sh'), 'other')
    assert.equal(classify('sh'), 'other')
  })
})

describe('classifyBash: substitutions and heredocs', () => {
  it('scans command substitutions even inside double quotes', () => {
    assert.equal(classify('echo "x $(git push) y"'), 'destructive')
    assert.equal(classify('echo $(echo $(echo $(rm -rf x)))'), 'destructive')
  })

  it('does not scan single-quoted text', () => {
    assert.equal(classify("echo '$(git push)'"), 'read_only')
  })

  it('treats a commit-message heredoc with an apostrophe as parseable', () => {
    const commit = "git commit -m \"$(cat <<'EOF'\nFix the user's bug\nEOF\n)\""
    assert.equal(classify(commit), 'other')
    assert.equal(classify(`${commit} && git push`), 'destructive')
  })

  it('checks heredoc body lines as commands, since a heredoc can feed a shell (conservative)', () => {
    assert.equal(classify("cat <<'EOF'\ngit push is documented here\nEOF"), 'destructive')
    assert.equal(classify("cat <<'EOF'\nhello\nEOF"), 'other')
    assert.equal(classify("cat <<-EOF\n\tgit push\n\tEOF"), 'destructive')
  })

  it('stops the heredoc body at the delimiter', () => {
    assert.equal(classify('cat <<EOF\nhello\nEOF\nrm -rf x'), 'destructive')
  })

  it('gives up (other) on runaway substitution nesting', () => {
    const deep = '$('.repeat(12) + 'git push' + ')'.repeat(12)
    assert.equal(classify(`echo ${deep}`), 'other')
  })
})

describe('classifyBash: case and quoting', () => {
  it('reads program names case-insensitively for destructive detection only', () => {
    assert.equal(classify('GIT push'), 'destructive')
    assert.equal(classify('LS'), 'other')
    assert.equal(classify('GIT status'), 'other')
  })

  it('keeps quoted separators inside the word', () => {
    assert.equal(classify('echo "ls;rm -rf x"'), 'read_only')
    assert.equal(classify("echo 'a&&b'"), 'read_only')
  })

  it('handles an escaped newline as a continuation', () => {
    assert.equal(classify('git \\\npush'), 'destructive')
    assert.equal(classify('ls \\\n-la'), 'read_only')
  })
})

describe('classifyBash: unparseable input is other', () => {
  expectClass(['', '   ', "echo 'x", 'echo "x', 'ls \\', '$(', 'echo `ls', 'echo $(ls'], 'other')
})

describe('classifyBash: validation', () => {
  // CR11 (docs/ARCHITECTURE.md): the whitespace-normalized text equals a profile entry exactly. Extra arguments change what runs
  // (`npm test --help` exits 0 without testing, `pytest --junitxml=src/app.py` writes a file), so they are not 'validation'.
  it('matches the exact command, whitespace-normalized', () => {
    assert.equal(classify('npm test'), 'validation')
    assert.equal(classify('  npm   test  '), 'validation')
    assert.equal(classify('npm\ttest'), 'validation')
  })

  it('does not match the command followed by arguments (CR11)', () => {
    for (const command of [
      'npm test -- --grep x',
      'npm test --help',
      'npm test -u',
      'npm test --script-shell=./x.sh',
      'npm test --update-snapshot',
      'npm test a',
    ]) {
      assert.equal(classify(command), 'other', command)
    }
    const pytest = profileWith({}, ['npm test', 'pytest'])
    for (const command of ['pytest --collect-only', 'pytest --junitxml=src/app.py', 'pytest -q tests/']) {
      assert.equal(classifyBash(command, pytest), 'other', command)
    }
  })

  it('rejects look-alikes and any shell metacharacter', () => {
    for (const command of [
      'npm test; rm x',
      'npm testing',
      'npm test > out',
      'npm test | cat',
      'npm test && ls',
      'npm test & ls',
      'npm test $(id)',
      'npm test `id`',
      "npm test 'a b'",
      'npm test "a"',
      'npm test\nrm x',
      'npm test \\',
      'npm test (x)',
      'npm test x)',
      'npm test < in',
      'npm',
      'npm tes',
      'xnpm test',
      'npm run test',
      'FOO=1 npm test',
    ]) {
      assert.equal(classify(command), 'other', command)
    }
  })

  it('never lets a destructive or network wrapper pass as validation', () => {
    assert.equal(classify('sudo npm test'), 'destructive')
    assert.equal(classify('env curl x'), 'network')
  })

  it('needs a non-empty profile command', () => {
    assert.equal(classifyBash('npm test', profileWith({}, [])), 'other')
    assert.equal(classifyBash('anything', profileWith({}, ['', '  '])), 'other')
    assert.equal(classifyBash('', profileWith({}, ['', '  '])), 'other')
    assert.equal(classifyBash('   ', profileWith({}, ['', '  '])), 'other')
  })

  it('supports several profile commands and normalizes their spaces', () => {
    const profile = profileWith({}, ['npm test', 'pytest  -q', 'make check'])
    assert.equal(classifyBash('pytest -q', profile), 'validation')
    assert.equal(classifyBash('pytest   -q', profile), 'validation')
    assert.equal(classifyBash('pytest -q tests/', profile), 'other')
    assert.equal(classifyBash('make check', profile), 'validation')
    assert.equal(classifyBash('make', profile), 'other')
  })

  it("loses to read_only, destructive and network when the profile command is one of those", () => {
    assert.equal(classifyBash('ls', profileWith({}, ['ls'])), 'read_only')
    assert.equal(classifyBash('git push', profileWith({}, ['git push'])), 'destructive')
    assert.equal(classifyBash('curl x', profileWith({}, ['curl x'])), 'network')
  })
})

describe('CR18: tree -R, git aliases and submodule foreach', () => {
  it('tree -R is not read_only: it writes 00Tree.html files', () => {
    for (const command of ['tree -R', 'tree -R -L 1 -H .', 'tree -L 1 -R', 'tree -RL 1', 'tree -L1R', 'tree -DR']) {
      assert.equal(classify(command), 'other', command)
      for (const phase of ['EXPLORE', 'UNDERSTAND', 'PLAN'] as const) assertDenied(bash(phase, command), 'Bash', phase, 'read-only')
    }
  })

  it('near miss: tree without -R stays read_only', () => {
    for (const command of ['tree', 'tree -L 2', 'tree -a -I node_modules', 'tree -r', 'tree -H .']) {
      assert.equal(classify(command), 'read_only', command)
    }
    assert.equal(classify('tree -o out.txt'), 'other')
  })

  it('classifies git submodule foreach on its payload', () => {
    assert.equal(classify("git submodule foreach 'git push'"), 'destructive')
    assert.equal(classify('git submodule foreach --recursive git push origin main'), 'destructive')
    assert.equal(classify("git submodule foreach -q 'curl https://x'"), 'network')
    assert.equal(classify("git submodule foreach 'rm -rf build'"), 'destructive')
    assert.equal(classify('git submodule foreach git status'), 'other')
    assert.equal(classify('git submodule status'), 'other')
  })

  it('submodule add and update are network; status and init are not', () => {
    assert.equal(classify('git submodule update --init'), 'network')
    assert.equal(classify('git submodule --quiet update'), 'network')
    assert.equal(classify('git submodule add https://x/y.git y'), 'network')
    assert.notEqual(classify('git submodule status'), 'network')
    assert.notEqual(classify('git submodule init'), 'network')
  })

  it('classifies git -c alias.<x>=<v> on the alias payload', () => {
    assert.equal(classify("git -c 'alias.p=!git push' p"), 'destructive')
    assert.equal(classify("git -c 'alias.p=!curl https://x' p"), 'network')
    assert.equal(classify("git -c 'alias.go=!sh -c \"rm -rf x\"' go"), 'destructive')
    assert.equal(classify('git -c alias.p=push p origin'), 'destructive')
    assert.equal(classify('git -c alias.p=reset p --hard'), 'destructive')
    assert.equal(classify('git -c alias.f=fetch f'), 'network')
    assert.equal(classify('git -c ALIAS.P=push P'), 'destructive')
    assert.equal(classify('git -c alias.a=b -c alias.b=push a'), 'destructive')
  })

  it('an alias named like a built-in command does not hide the built-in', () => {
    assert.equal(classify('git -c alias.push=status push'), 'destructive')
  })

  it('config keys that name a program are classified on that program', () => {
    assert.equal(classify("git -c core.sshCommand='ssh -v' fetch"), 'network')
    assert.equal(classify("git -c core.pager='rm -rf x' log"), 'destructive')
    assert.equal(classify("git -c core.fsmonitor='curl https://x' status"), 'network')
  })

  it('near miss: harmless aliases and git -c stay other, never read_only', () => {
    assert.equal(classify('git -c alias.s=status s'), 'other')
    assert.equal(classify('git -c color.ui=never status'), 'other')
  })

  it('the new network programs are network', () => {
    for (const command of ['ping -c 1 x', 'dig example.com', 'nslookup example.com', 'whois x', 'traceroute x', 'gh pr list', 'aria2c http://x', 'lftp x']) {
      assert.equal(classify(command), 'network', command)
      assertDenied(bash('IMPLEMENT', command), 'Bash', 'deny_by_default')
    }
  })
})

describe('D14: the shell cannot build the name .ewm unseen in IMPLEMENT', () => {
  const BUILDERS = [
    "sed -i 's/IMPLEMENT/PAUSED/' .e*m/tasks/TASK-001/task.json",
    "sed -i s/IMPLEMENT/PAUSED/ .e?m/tasks/TASK-001/task.json",
    "echo '{}' > .e[w]m/tasks/TASK-001/task.json",
    "echo '{}' > .e[!x]m/tasks/TASK-001/task.json",
    "echo '{}' > .{e,x}wm/tasks/TASK-001/task.json",
    "echo '{}' > .{e..f}wm/x",
    "echo '{}' > .e*/x",
    'echo {} > .ew*',
    "echo x > ./.e*m/project.yaml",
    "d=.e; echo '{}' > ${d}wm/tasks/TASK-001/task.json",
    "d=.e; echo '{}' > \"${d}wm/tasks/TASK-001/task.json\"",
    'echo x > .e${x}',
    'echo x > .${a}wm/y',
    'echo x > .e$(echo w)m/y',
    'echo x > .e`echo w`m/y',
    'a=.e; b=wm; cp x $a$b/y',
    'p=ewm; cp x .$p/y',
    "python3 -c \"open('.e'+'wm/tasks/TASK-001/task.json','w')\"",
    "python3 -c \"open('.e' 'wm/x','w')\"",
    'ln -s .e?m link',
    'ln -s .e*m link',
    'cp x .e""wm/y',
    "cp x .e''wm/y",
    'cp x .e\\wm/y',
    'cp x ".ew"m/y',
    'cp x .E*M/y',
    'shopt -s dotglob; cp x *',
    "bash -c 'cp x .e*m/y'",
    "sh -c \"d=.e; cp x \\${d}wm/y\"",
    "eval 'cp x .e*m/y'",
    "python3 - <<'EOF'\nopen('.e'+'wm/x','w')\nEOF",
  ]

  it('denies every builder as a non-read-only command that mentions .ewm', () => {
    for (const command of BUILDERS) {
      assertDenied(bash('IMPLEMENT', command), 'Bash', '.ewm')
      assertDenied(evaluate('IMPLEMENT', 'Monitor', { command }), 'Monitor', '.ewm')
    }
  })

  it('denies them in the other phases too (the read-only rule or the .ewm rule)', () => {
    for (const command of BUILDERS) {
      for (const phase of IMPLEMENT_ONLY_PHASES) assertDenied(bash(phase, command), 'Bash', phase)
    }
  })

  it('is not read_only, so the reading of the state stays possible but the writing does not', () => {
    assertAllowed(bash('IMPLEMENT', 'ls .e*m/tasks'))
    assertAllowed(bash('EXPLORE', 'cat .e?m/project.yaml'))
    assertDenied(bash('IMPLEMENT', 'cp x .e?m/project.yaml'), 'Bash', '.ewm')
  })

  it('near miss: ordinary commands with globs, variables, braces and quotes are not taken for .ewm', () => {
    for (const command of [
      'cp *.ts dist/',
      'git add *',
      'git add .',
      'rm -f build/*.o',
      'mv .env.local .env',
      'cp .gitignore .gitignore.bak',
      'chmod +x scripts/*.sh',
      'sed -i s/a.*b/c/ src/a.ts',
      "sed -i 's/.*foo//' src/a.ts",
      'cp $SRC/a.ts $DEST/',
      'cd $HOME && npm test',
      'export PATH=$PATH:bin',
      'FOO=e npm test',
      'x=1 npm test',
      'DIR=. make build',
      'mkdir -p out/{a,b}',
      'cp src/{a,b}.ts dist/',
      'echo ${HOME}/x > out.txt',
      'npm run build -- --out=${OUT_DIR}',
      'cat package.json > "$TMPDIR/p.json"',
      "node -e 'console.log(1 + 2)'",
      'git commit -m "add .env.example, docs"',
      'python3 -c "print(1+1)"',
      'npm install --save-dev eslint',
      'touch ewm.txt',
      'echo "a.e wm"',
    ]) {
      assertAllowed(bash('IMPLEMENT', command), command)
    }
  })
})

describe('classifyBash: purity', () => {
  it('does not touch a frozen profile and is deterministic', () => {
    const frozen = deepFreeze(makeProfile({ validation: { commands: ['npm test'], timeout_ms: 1 } }))
    for (const command of [...READ_ONLY_CASES, ...BYPASS_CASES, ...DESTRUCTIVE_CASES, ...NETWORK_CASES]) {
      assert.equal(classifyBash(command, frozen), classifyBash(command, frozen))
    }
  })
})

// ---------------------------------------------------------------------------
// evaluateToolCall: the matrix, rule by rule
// ---------------------------------------------------------------------------

describe('rule 1: inert without a running task', () => {
  const INERT: (Phase | null)[] = [null, 'PAUSED', 'DONE']

  it('allows even rm -rf /, writes to .ewm and always-denied tools', () => {
    for (const phase of INERT) {
      assertAllowed(bash(phase, 'rm -rf /'), String(phase))
      assertAllowed(bash(phase, 'git push --force'), String(phase))
      assertAllowed(evaluate(phase, 'Write', { file_path: '.ewm/x' }), String(phase))
      assertAllowed(evaluate(phase, 'Write', { file_path: '/repo/.ewm/tasks/TASK-001/task.json' }, { resolvedPath: '/repo/.ewm/tasks/TASK-001/task.json' }), String(phase))
      assertAllowed(evaluate(phase, 'EnterWorktree'), String(phase))
      assertAllowed(evaluate(phase, 'WebFetch', { url: 'https://x' }), String(phase))
      assertAllowed(evaluate(phase, 'Skill', { skill: 'ewm' }), String(phase))
      assertAllowed(evaluate(phase, 'mcp__x__y'), String(phase))
      assertAllowed(evaluate(phase, 'Write', {}, { agentType: 'ewm:reviewer' }), String(phase))
    }
  })

  it('near miss: every active phase is not inert', () => {
    for (const phase of ACTIVE_PHASES) {
      assertDenied(bash(phase, 'rm -rf /'), 'Bash', phase)
    }
  })
})

describe('rule 2: read-only agents', () => {
  const AGENTS = [...READONLY_AGENT_TYPES]

  it('deny writes in every active phase, including IMPLEMENT', () => {
    for (const agentType of AGENTS) {
      for (const phase of ACTIVE_PHASES) {
        for (const tool of WRITE_TOOLS) {
          assertDenied(evaluate(phase, tool, { file_path: '/repo/src/a.ts' }, { agentType, resolvedPath: '/repo/src/a.ts' }), tool, phase, agentType)
        }
      }
    }
  })

  it('allow the safe reading tools', () => {
    for (const agentType of AGENTS) {
      for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead', 'ToolSearch', 'AskUserQuestion', 'TodoWrite', 'TaskGet', 'TaskList']) {
        assertAllowed(evaluate('IMPLEMENT', tool, {}, { agentType }), `${agentType} ${tool}`)
        assertAllowed(evaluate('EXPLORE', tool, {}, { agentType }), `${agentType} ${tool}`)
      }
    }
  })

  it('deny delegation and skills', () => {
    for (const agentType of AGENTS) {
      for (const tool of ['Agent', 'Task', 'Skill']) {
        assertDenied(evaluate('IMPLEMENT', tool, { skill: 'ewm:explore' }, { agentType }), tool, agentType)
        assertDenied(evaluate('EXPLORE', tool, {}, { agentType }), tool)
      }
    }
  })

  it('allow only the status tool of the mod', () => {
    for (const agentType of AGENTS) {
      assertAllowed(evaluate('EXPLORE', 'mcp__ewm__status', {}, { agentType }))
      assertAllowed(evaluate('IMPLEMENT', 'mcp__ewm__status', {}, { agentType }))
      for (const name of ['record_finding', 'advance', 'question', 'decision', 'set_plan', 'write_map', 'run_validation', 'update_step', 'set_intake']) {
        assertDenied(evaluate('EXPLORE', `mcp__ewm__${name}`, {}, { agentType }), `mcp__ewm__${name}`, agentType)
        assertDenied(evaluate('IMPLEMENT', `mcp__ewm__${name}`, {}, { agentType }), `mcp__ewm__${name}`)
      }
    }
  })

  it('allow Bash and Monitor only for read-only commands', () => {
    for (const agentType of AGENTS) {
      for (const phase of ['EXPLORE', 'IMPLEMENT'] as const) {
        assertAllowed(bash(phase, 'git log', { agentType }), `${agentType} ${phase}`)
        assertAllowed(bash(phase, 'rg foo src | head -5', { agentType }))
        assertAllowed(evaluate(phase, 'Monitor', { command: 'tail -f log.txt' }, { agentType }))
        assertDenied(bash(phase, 'rm x', { agentType }), 'Bash', phase, agentType)
        assertDenied(bash(phase, 'git push', { agentType }), 'Bash')
        assertDenied(bash(phase, 'python3 x.py', { agentType }), 'Bash')
        assertDenied(bash(phase, 'npm test', { agentType }), 'Bash')
        assertDenied(bash(phase, 'ls > out', { agentType }), 'Bash')
        assertDenied(evaluate(phase, 'Monitor', { command: 'node server.js' }, { agentType }), 'Monitor')
        assertDenied(evaluate(phase, 'Monitor', { command: 'tail -f log.txt', ws: 'wss://x' }, { agentType }), 'Monitor')
      }
    }
  })

  it('deny everything else: unknown, outbound, third-party and worktree tools', () => {
    for (const agentType of AGENTS) {
      for (const tool of ['CronCreate', 'WebFetch', 'WebSearch', 'EnterWorktree', 'mcp__x__y', 'SendMessage', 'Artifact']) {
        assertDenied(evaluate('IMPLEMENT', tool, {}, { agentType, profile: NETWORK_ALLOWED }), tool, agentType)
        assertDenied(evaluate('EXPLORE', tool, {}, { agentType, profile: profileWith({ allowed_mcp_tools: ['mcp__x__*'] }) }), tool)
      }
    }
  })

  it('near miss: the same calls from the main loop are not held to this rule', () => {
    assertAllowed(evaluate('IMPLEMENT', 'Write', { file_path: '/repo/src/a.ts' }, { resolvedPath: '/repo/src/a.ts' }))
    assertAllowed(evaluate('EXPLORE', 'Agent'))
    assertAllowed(evaluate('EXPLORE', 'Skill', { skill: 'ewm:explore' }))
    assertAllowed(evaluate('EXPLORE', 'mcp__ewm__record_finding'))
    assertAllowed(bash('IMPLEMENT', 'python3 x.py'))
    assertAllowed(evaluate('IMPLEMENT', 'CronCreate'))
  })

  it('near miss: other agent types and look-alike names are not read-only agents', () => {
    for (const agentType of ['general-purpose', 'ewm:implementer', 'ewm:reviewer2', 'EWM:reviewer', 'reviewer', '']) {
      assertAllowed(evaluate('IMPLEMENT', 'Write', { file_path: '/repo/src/a.ts' }, { agentType, resolvedPath: '/repo/src/a.ts' }), agentType)
      assertAllowed(evaluate('IMPLEMENT', 'Agent', {}, { agentType }), agentType)
    }
  })

  it('stays inert when the task is paused, even for a read-only agent', () => {
    assertAllowed(evaluate('PAUSED', 'Write', { file_path: '/repo/src/a.ts' }, { agentType: 'ewm:reviewer' }))
    assertAllowed(evaluate(null, 'Bash', { command: 'rm x' }, { agentType: 'ewm:repo-scout' }))
  })
})

describe('rule 3: the mod\'s own tools', () => {
  it('allows every mcp__ewm__ tool in every active phase, under any network policy', () => {
    for (const phase of ACTIVE_PHASES) {
      for (const name of ['record_finding', 'advance', 'status', 'run_validation', 'set_plan']) {
        assertAllowed(evaluate(phase, `mcp__ewm__${name}`), `${phase} ${name}`)
        assertAllowed(evaluate(phase, `mcp__ewm__${name}`, {}, { profile: NETWORK_ALLOWED }))
      }
    }
  })

  it('near miss: look-alike prefixes are third-party tools', () => {
    assertDenied(evaluate('IMPLEMENT', 'mcp__ewm2__status'), 'mcp__ewm2__status')
    assertDenied(evaluate('IMPLEMENT', 'mcp__other__ewm__status'), 'mcp__other__ewm__status')
    assertDenied(evaluate('EXPLORE', 'mcp__ewm'), 'mcp__ewm')
    assertDenied(evaluate('EXPLORE', 'xmcp__ewm__status'), 'xmcp__ewm__status')
    assertDenied(evaluate('EXPLORE', 'Xmcp__ewm__record_finding'), 'EXPLORE')
  })
})

describe('rule 4: tools that move the session', () => {
  it('denies EnterWorktree and ExitWorktree in every active phase', () => {
    for (const phase of ACTIVE_PHASES) {
      for (const tool of ALWAYS_DENIED_TOOLS) {
        assertDenied(evaluate(phase, tool), tool, phase)
        assertDenied(evaluate(phase, tool, {}, { profile: NETWORK_ALLOWED }), tool)
      }
    }
  })

  it('near miss: other plan/mode tools are not denied by it', () => {
    assertAllowed(evaluate('EXPLORE', 'EnterPlanMode'))
    assertAllowed(evaluate('IMPLEMENT', 'ExitPlanMode'))
    assertAllowed(evaluate('IMPLEMENT', 'Worktree'))
  })
})

describe('rule 5: the /ewm command is the person\'s', () => {
  it("denies Skill { skill: 'ewm' } in every active phase", () => {
    for (const phase of ACTIVE_PHASES) {
      assertDenied(evaluate(phase, 'Skill', { skill: 'ewm' }), 'Skill', phase, '/ewm')
    }
  })

  it('denies spelling variants of the command', () => {
    for (const skill of ['/ewm', ' ewm ', 'EWM', 'ewm:ewm']) {
      assertDenied(evaluate('IMPLEMENT', 'Skill', { skill }), 'Skill')
    }
  })

  it("near miss: stage skills such as 'ewm:explore' are allowed", () => {
    for (const phase of ACTIVE_PHASES) {
      for (const skill of ['ewm:explore', 'ewm:intake', 'ewm:plan', 'ewm:implement', 'ewm:validate', 'ewm:understand']) {
        assertAllowed(evaluate(phase, 'Skill', { skill }), `${phase} ${skill}`)
      }
    }
    assertAllowed(evaluate('EXPLORE', 'Skill', { skill: 'ewmx' }))
    assertAllowed(evaluate('EXPLORE', 'Skill', { skill: 'other:ewm' }))
    assertAllowed(evaluate('EXPLORE', 'Skill', {}))
  })
})

describe('rule 6: workflow state is written only by the mod', () => {
  const STATE = '/repo/.ewm/tasks/TASK-001/task.json'

  it('denies every write tool on a resolved path under <root>/.ewm/ in every active phase', () => {
    for (const phase of ACTIVE_PHASES) {
      for (const tool of WRITE_TOOLS) {
        assertDenied(evaluate(phase, tool, { file_path: STATE }, { resolvedPath: STATE }), tool, phase, '.ewm')
      }
    }
  })

  it('denies NotebookEdit through notebook_path', () => {
    assertDenied(evaluate('IMPLEMENT', 'NotebookEdit', { notebook_path: '/repo/.ewm/n.ipynb' }, { resolvedPath: '/repo/.ewm/n.ipynb' }), 'NotebookEdit')
    assertDenied(evaluate('IMPLEMENT', 'NotebookEdit', { notebook_path: '.ewm/n.ipynb' }), 'NotebookEdit')
  })

  it('denies a raw path with a .ewm segment when nothing was resolved', () => {
    for (const raw of ['.ewm/x', './.ewm/x', '.ewm', 'src/../.ewm/x', '/repo/.ewm/tasks/x', '.EWM/x', '.ewm\\x']) {
      assertDenied(evaluate('IMPLEMENT', 'Write', { file_path: raw }), 'Write', '.ewm')
      assertDenied(evaluate('IMPLEMENT', 'Edit', { file_path: raw }), 'Edit')
    }
  })

  it('treats a write with no usable path as inside .ewm (fail closed)', () => {
    assertDenied(evaluate('IMPLEMENT', 'Write', {}), 'Write')
    assertDenied(evaluate('IMPLEMENT', 'Write', { file_path: '' }), 'Write')
    assertDenied(evaluate('IMPLEMENT', 'Write', { file_path: 42 }), 'Write')
  })

  it('also checks the raw path when the resolved one looks outside (a symlinked .ewm)', () => {
    assertDenied(evaluate('IMPLEMENT', 'Write', { file_path: '.ewm/x' }, { resolvedPath: '/data/elsewhere/x' }), 'Write')
  })

  it('also checks the resolved path when the raw one looks outside (a symlink into .ewm, a symlinked root)', () => {
    assertDenied(evaluate('IMPLEMENT', 'Write', { file_path: 'link/task.json' }, { resolvedPath: STATE }), 'Write')
    assertDenied(evaluate('IMPLEMENT', 'Write', { file_path: 'x' }, { resolvedPath: '/data/proj/.ewm/tasks/x' }), 'Write')
  })

  it('applies even when EXPLORE allows repository writes', () => {
    assertDenied(evaluate('EXPLORE', 'Write', { file_path: STATE }, { profile: WRITE_IN_EXPLORE, resolvedPath: STATE }), 'Write')
  })

  it('near miss: a normal repository file is allowed in IMPLEMENT (and denied in EXPLORE by rule 10)', () => {
    for (const tool of WRITE_TOOLS) {
      assertAllowed(evaluate('IMPLEMENT', tool, { file_path: '/repo/src/a.ts' }, { resolvedPath: '/repo/src/a.ts' }), tool)
      assertDenied(evaluate('EXPLORE', tool, { file_path: '/repo/src/a.ts' }, { resolvedPath: '/repo/src/a.ts' }), tool, 'EXPLORE')
    }
  })

  it('near miss: a raw path without a .ewm segment is allowed in IMPLEMENT', () => {
    assertAllowed(evaluate('IMPLEMENT', 'Write', { file_path: 'src/a.ts' }))
    assertAllowed(evaluate('IMPLEMENT', 'Edit', { file_path: '/repo/src/a.ts' }))
  })

  it('near miss: names that merely contain "ewm" are not the state directory', () => {
    for (const path of ['/repo/.ewmx/a', '/repo/my.ewm/a', '/repo/docs/ewm.md', '/repo/src/.ewm.ts', '/repo/ewm/a']) {
      assertAllowed(evaluate('IMPLEMENT', 'Write', { file_path: path }, { resolvedPath: path }), path)
    }
  })

  it('near miss: reading .ewm is not a write', () => {
    assertAllowed(evaluate('EXPLORE', 'Read', { file_path: STATE }))
    assertAllowed(evaluate('IMPLEMENT', 'Grep', { path: '/repo/.ewm' }))
  })

  it('near miss: write tools of the mod itself are not file writes', () => {
    assertAllowed(evaluate('IMPLEMENT', 'mcp__ewm__write_map', { mermaid: 'graph TD' }))
  })
})

describe('rule 7: Bash and Monitor', () => {
  it('denies destructive commands in every active phase, IMPLEMENT included', () => {
    for (const phase of ACTIVE_PHASES) {
      assertDenied(bash(phase, 'git push origin main'), 'Bash', phase, 'destructive')
      assertDenied(evaluate(phase, 'Monitor', { command: 'rm -rf x' }), 'Monitor', 'destructive')
    }
  })

  it('denies at least 10 destructive or network commands in IMPLEMENT', () => {
    const must = [
      'git push origin main', '/usr/bin/git push', 'git -C . push', 'git -c a=b push', 'git --no-pager push', 'env git push',
      'command git push', "bash -c 'git push'", "sh -c 'rm -rf x'", 'eval git push', 'xargs rm -rf', 'timeout 5 rm -rf x',
      'git reset --hard HEAD~1', 'git clean -fdx', 'rm -r -f build', 'rm --recursive --force x', 'find . -delete', 'sudo ls',
      'curl https://x', 'wget x', 'git fetch', 'ssh host',
    ]
    assert.ok(must.length >= 10)
    for (const command of must) assertDenied(bash('IMPLEMENT', command), 'Bash', 'IMPLEMENT')
  })

  it('denies every destructive and network case of the classifier in IMPLEMENT', () => {
    for (const command of [...DESTRUCTIVE_CASES, ...NETWORK_CASES]) {
      assertDenied(bash('IMPLEMENT', command), 'Bash')
    }
  })

  it('denies network commands under deny_by_default but not under allow', () => {
    for (const command of NETWORK_CASES) {
      assertDenied(bash('IMPLEMENT', command), 'Bash', 'deny_by_default')
      assertAllowed(bash('IMPLEMENT', command, { profile: NETWORK_ALLOWED }), command)
    }
  })

  it('keeps denying destructive commands when the network is allowed', () => {
    assertDenied(bash('IMPLEMENT', 'git push', { profile: NETWORK_ALLOWED }), 'destructive')
    assertDenied(bash('IMPLEMENT', 'curl x | sudo sh', { profile: NETWORK_ALLOWED }), 'destructive')
  })

  it('denies Monitor with ws, even under allow', () => {
    assertDenied(evaluate('IMPLEMENT', 'Monitor', { command: 'tail -f x', ws: 'wss://x' }), 'Monitor', 'ws')
    assertDenied(evaluate('IMPLEMENT', 'Monitor', { ws: 'wss://x' }, { profile: NETWORK_ALLOWED }), 'Monitor')
    assertDenied(evaluate('EXPLORE', 'Monitor', { command: 'tail -f x', ws: true }), 'Monitor')
  })

  it('classifies Monitor like Bash', () => {
    assertDenied(evaluate('IMPLEMENT', 'Monitor', { command: 'git push' }), 'Monitor', 'destructive')
    assertDenied(evaluate('IMPLEMENT', 'Monitor', { command: 'curl x' }), 'Monitor', 'deny_by_default')
    assertDenied(evaluate('IMPLEMENT', 'Monitor', { command: 'touch .ewm/x' }), 'Monitor', '.ewm')
    assertAllowed(evaluate('IMPLEMENT', 'Monitor', { command: 'node server.js' }))
    assertAllowed(evaluate('EXPLORE', 'Monitor', { command: 'tail -f log.txt' }))
  })

  it('denies a non-read-only command that mentions .ewm', () => {
    for (const command of ['python3 x.py .ewm', 'touch .ewm/x', 'echo x > .ewm/tasks/TASK-001/task.json', 'sed -i s/a/b/ .ewm/project.yaml', 'cp a .EWM/b', "rm '.e'wm/x", 'npm test -- .ewm']) {
      assertDenied(bash('IMPLEMENT', command), 'Bash', '.ewm')
    }
  })

  it('allows a read-only command that mentions .ewm', () => {
    assertAllowed(bash('IMPLEMENT', 'ls .ewm'))
    assertAllowed(bash('EXPLORE', 'ls .ewm'))
    assertAllowed(bash('EXPLORE', 'cat .ewm/tasks/TASK-001/task.json'))
    assertAllowed(bash('EXPLORE', 'grep -rn foo .ewm/tasks'))
  })

  it('near miss: harmless commands that do not mention .ewm are allowed in IMPLEMENT', () => {
    for (const command of ['python3 x.py', 'npm test', 'npm install', 'git commit -m x', 'make build', 'rm x', 'git branch -D x', 'touch ewm.txt']) {
      assertAllowed(bash('IMPLEMENT', command), command)
    }
  })

  it('near miss: a network command under allow is let through by rule 7, then decided by rule 10', () => {
    assertAllowed(bash('IMPLEMENT', 'curl x', { profile: NETWORK_ALLOWED }))
    assertDenied(bash('EXPLORE', 'curl x', { profile: NETWORK_ALLOWED }), 'Bash', 'EXPLORE', 'read-only')
  })

  it('treats a missing or non-string command as other', () => {
    assertAllowed(evaluate('IMPLEMENT', 'Bash', {}))
    assertAllowed(evaluate('IMPLEMENT', 'Bash', { command: 42 }))
    assertDenied(evaluate('EXPLORE', 'Bash', {}), 'Bash', 'EXPLORE')
  })
})

describe('rule 8: network-facing tools', () => {
  it('denies every outbound tool under deny_by_default, even in IMPLEMENT', () => {
    for (const tool of OUTBOUND_TOOLS) {
      assertDenied(evaluate('IMPLEMENT', tool), tool, 'IMPLEMENT', 'deny_by_default')
      assertDenied(evaluate('EXPLORE', tool), tool)
    }
  })

  it("allows outbound tools in IMPLEMENT under 'allow'", () => {
    for (const tool of OUTBOUND_TOOLS) {
      assertAllowed(evaluate('IMPLEMENT', tool, {}, { profile: NETWORK_ALLOWED }), tool)
    }
  })

  it('denies a third-party MCP tool unless allowed_mcp_tools has it exactly', () => {
    assertDenied(evaluate('IMPLEMENT', 'mcp__x__y'), 'mcp__x__y', 'allowed_mcp_tools')
    const exact = profileWith({ allowed_mcp_tools: ['mcp__x__y'] })
    assertAllowed(evaluate('IMPLEMENT', 'mcp__x__y', {}, { profile: exact }))
    assertAllowed(evaluate('EXPLORE', 'mcp__x__y', {}, { profile: exact }))
    assertDenied(evaluate('IMPLEMENT', 'mcp__x__z', {}, { profile: exact }), 'mcp__x__z')
    assertDenied(evaluate('IMPLEMENT', 'mcp__x__yy', {}, { profile: exact }), 'mcp__x__yy')
  })

  it("allows a third-party MCP tool through a 'prefix*' entry", () => {
    const prefixed = profileWith({ allowed_mcp_tools: ['mcp__x__*'] })
    assertAllowed(evaluate('IMPLEMENT', 'mcp__x__y', {}, { profile: prefixed }))
    assertAllowed(evaluate('PLAN', 'mcp__x__anything', {}, { profile: prefixed }))
    assertDenied(evaluate('IMPLEMENT', 'mcp__xy__z', {}, { profile: prefixed }), 'mcp__xy__z')
    assertDenied(evaluate('IMPLEMENT', 'mcp__other__y', {}, { profile: prefixed }), 'mcp__other__y')
  })

  it("allows any MCP tool under 'allow' in IMPLEMENT only; before IMPLEMENT and in VALIDATE it must be listed (CR12)", () => {
    assertAllowed(evaluate('IMPLEMENT', 'mcp__x__y', {}, { profile: NETWORK_ALLOWED }))
    for (const phase of IMPLEMENT_ONLY_PHASES) {
      assertDenied(evaluate(phase, 'mcp__x__y', {}, { profile: NETWORK_ALLOWED }), 'mcp__x__y', phase, 'allowed_mcp_tools')
      const listed = profileWith({ external_network: 'allow', allowed_mcp_tools: ['mcp__x__y', 'mcp__docs__*'] })
      assertAllowed(evaluate(phase, 'mcp__x__y', {}, { profile: listed }), phase)
      assertAllowed(evaluate(phase, 'mcp__docs__search', {}, { profile: listed }), phase)
      assertDenied(evaluate(phase, 'mcp__x__z', {}, { profile: listed }), 'mcp__x__z', phase)
    }
  })

  it('near miss: non-MCP, non-outbound tools are untouched by it', () => {
    assertAllowed(evaluate('IMPLEMENT', 'Read'))
    assertAllowed(evaluate('IMPLEMENT', 'Agent'))
    assertAllowed(evaluate('IMPLEMENT', 'CronCreate'))
  })

  it('CR2: WebFetch and WebSearch run in every active phase under allow, and stay denied under deny_by_default', () => {
    for (const phase of ACTIVE_PHASES) {
      for (const tool of NETWORK_READ_TOOLS) {
        assertAllowed(evaluate(phase, tool, {}, { profile: NETWORK_ALLOWED }), `${phase} ${tool}`)
        assertDenied(evaluate(phase, tool), tool, phase, 'deny_by_default')
      }
    }
  })

  it('CR2 near miss: the other outbound tools are still not on the pre-IMPLEMENT allowlist (rule 10)', () => {
    for (const tool of OUTBOUND_TOOLS.filter((name) => !NETWORK_READ_TOOLS.includes(name))) {
      for (const phase of IMPLEMENT_ONLY_PHASES) {
        assertDenied(evaluate(phase, tool, {}, { profile: NETWORK_ALLOWED }), tool, phase)
      }
    }
  })

  it('CR2: read-only agents do not get the network tools', () => {
    for (const tool of NETWORK_READ_TOOLS) {
      assertDenied(evaluate('EXPLORE', tool, {}, { profile: NETWORK_ALLOWED, agentType: 'ewm:repo-scout' }), tool, 'ewm:repo-scout')
    }
  })
})

describe('rule 9: IMPLEMENT allows the rest', () => {
  it('allows writes, ordinary Bash and unknown tools', () => {
    assertAllowed(evaluate('IMPLEMENT', 'Write', { file_path: '/repo/src/a.ts' }, { resolvedPath: '/repo/src/a.ts' }))
    assertAllowed(evaluate('IMPLEMENT', 'Edit', { file_path: '/repo/src/a.ts' }, { resolvedPath: '/repo/src/a.ts' }))
    assertAllowed(evaluate('IMPLEMENT', 'MultiEdit', { file_path: '/repo/src/a.ts' }, { resolvedPath: '/repo/src/a.ts' }))
    assertAllowed(evaluate('IMPLEMENT', 'NotebookEdit', { notebook_path: '/repo/n.ipynb' }, { resolvedPath: '/repo/n.ipynb' }))
    assertAllowed(bash('IMPLEMENT', 'python3 x.py'))
    assertAllowed(bash('IMPLEMENT', 'npm test'))
    assertAllowed(evaluate('IMPLEMENT', 'CronCreate'))
    assertAllowed(evaluate('IMPLEMENT', 'SomeFutureTool', { a: 1 }))
    assertAllowed(evaluate('IMPLEMENT', 'Monitor', { command: 'node server.js' }))
  })

  it('near miss: the same calls are denied in every other active phase', () => {
    for (const phase of IMPLEMENT_ONLY_PHASES) {
      assertDenied(evaluate(phase, 'Write', { file_path: '/repo/src/a.ts' }, { resolvedPath: '/repo/src/a.ts' }), 'Write', phase)
      assertDenied(bash(phase, 'python3 x.py'), 'Bash', phase)
      assertDenied(evaluate(phase, 'CronCreate'), 'CronCreate', phase)
      assertDenied(evaluate(phase, 'Monitor', { command: 'node server.js' }), 'Monitor', phase)
    }
  })
})

describe('rule 10: the other phases are an allowlist', () => {
  it('allows every SAFE_TOOL in every pre-IMPLEMENT phase', () => {
    for (const phase of IMPLEMENT_ONLY_PHASES) {
      for (const tool of SAFE_TOOLS) assertAllowed(evaluate(phase, tool), `${phase} ${tool}`)
    }
  })

  it('allows an allowlisted MCP tool and denies the same tool when it is not listed', () => {
    const listed = profileWith({ allowed_mcp_tools: ['mcp__docs__search'] })
    for (const phase of IMPLEMENT_ONLY_PHASES) {
      assertAllowed(evaluate(phase, 'mcp__docs__search', {}, { profile: listed }), phase)
      assertDenied(evaluate(phase, 'mcp__docs__search'), 'mcp__docs__search', phase)
    }
  })

  it('CR1: TaskOutput and TaskStop are safe tools, for the lead and for the read-only agents', () => {
    for (const phase of ACTIVE_PHASES) {
      for (const tool of ['TaskOutput', 'TaskStop']) {
        assertAllowed(evaluate(phase, tool), `${phase} ${tool}`)
        assertAllowed(evaluate(phase, tool, {}, { agentType: 'ewm:reviewer' }), `${phase} ${tool} reviewer`)
      }
    }
  })

  it('denies write tools, and says how to get to IMPLEMENT', () => {
    for (const phase of IMPLEMENT_ONLY_PHASES) {
      for (const tool of WRITE_TOOLS) {
        const reason = assertDenied(evaluate(phase, tool, { file_path: '/repo/src/a.ts' }, { resolvedPath: '/repo/src/a.ts' }), tool, phase)
        assert.match(reason, /IMPLEMENT/)
      }
    }
    assert.match(assertDenied(evaluate('PLAN', 'Write', { file_path: '/repo/a' }, { resolvedPath: '/repo/a' })), /\/ewm approve/)
    assert.match(assertDenied(evaluate('VALIDATE', 'Write', { file_path: '/repo/a' }, { resolvedPath: '/repo/a' })), /mcp__ewm__advance/)
  })

  it('allows repository writes only in EXPLORE with allow_write_in_explore', () => {
    assertAllowed(evaluate('EXPLORE', 'Write', { file_path: '/repo/src/a.ts' }, { profile: WRITE_IN_EXPLORE, resolvedPath: '/repo/src/a.ts' }))
    assertAllowed(evaluate('EXPLORE', 'Edit', { file_path: '/repo/src/a.ts' }, { profile: WRITE_IN_EXPLORE, resolvedPath: '/repo/src/a.ts' }))
    for (const phase of ['INTAKE', 'UNDERSTAND', 'PLAN', 'VALIDATE'] as const) {
      assertDenied(evaluate(phase, 'Write', { file_path: '/repo/src/a.ts' }, { profile: WRITE_IN_EXPLORE, resolvedPath: '/repo/src/a.ts' }), 'Write', phase)
    }
    assert.match(
      assertDenied(evaluate('EXPLORE', 'Write', { file_path: '/repo/a' }, { resolvedPath: '/repo/a' })),
      /allow_write_in_explore/,
    )
  })

  it('allows only read-only Bash and Monitor commands', () => {
    for (const phase of IMPLEMENT_ONLY_PHASES) {
      for (const command of ['ls -la', 'git log --oneline -5', 'grep -rn foo src | head -20', 'rg foo src 2>/dev/null']) {
        assertAllowed(bash(phase, command), `${phase} ${command}`)
        assertAllowed(evaluate(phase, 'Monitor', { command }), `${phase} Monitor ${command}`)
      }
      for (const command of ['touch f', 'python3 x.py', 'ls > out', 'sed -n p f', 'cat a && touch b', 'echo $HOME']) {
        assertDenied(bash(phase, command), 'Bash', phase, 'read-only')
        assertDenied(evaluate(phase, 'Monitor', { command }), 'Monitor', phase)
      }
    }
  })

  it('allows the validation class only in VALIDATE, and points at run_validation', () => {
    assertAllowed(bash('VALIDATE', 'npm test'))
    assertDenied(bash('VALIDATE', 'npm test -- --grep x'), 'Bash', 'VALIDATE', 'mcp__ewm__run_validation') // CR11: no extra arguments
    assertDenied(bash('VALIDATE', 'npm test --help'), 'Bash', 'VALIDATE')
    assertAllowed(evaluate('VALIDATE', 'Monitor', { command: 'npm test' }))
    for (const phase of ['INTAKE', 'EXPLORE', 'UNDERSTAND', 'PLAN'] as const) {
      assertDenied(bash(phase, 'npm test'), 'Bash', phase)
    }
    assertDenied(bash('VALIDATE', 'npm test; rm x'), 'Bash', 'mcp__ewm__run_validation')
    assertDenied(bash('VALIDATE', 'npm test > out'), 'Bash', 'VALIDATE')
    assertDenied(bash('VALIDATE', 'npm testing'), 'Bash', 'VALIDATE')
  })

  it('denies unknown tools by name, phase and rule', () => {
    for (const phase of IMPLEMENT_ONLY_PHASES) {
      for (const tool of ['CronCreate', 'CronDelete', 'SomeFutureTool']) {
        const reason = assertDenied(evaluate(phase, tool), `ewm: ${tool} is not allowed in ${phase}`)
        assert.match(reason, /\/ewm pause/)
      }
    }
  })

  it('denies Monitor with a non-read-only command', () => {
    assertDenied(evaluate('EXPLORE', 'Monitor', { command: 'node server.js' }), 'Monitor', 'EXPLORE')
  })

  it('near miss: IMPLEMENT allows what rule 10 denies', () => {
    assertAllowed(evaluate('IMPLEMENT', 'CronCreate'))
    assertAllowed(bash('IMPLEMENT', 'touch f'))
  })
})

describe('deny reasons', () => {
  const SAMPLE: { phase: Phase; tool: string; input: Record<string, unknown>; resolvedPath?: string; profile?: Profile; agentType?: string }[] = [
    { phase: 'IMPLEMENT', tool: 'Bash', input: { command: 'git push' } },
    { phase: 'IMPLEMENT', tool: 'Bash', input: { command: 'curl x' } },
    { phase: 'IMPLEMENT', tool: 'Bash', input: { command: 'touch .ewm/x' } },
    { phase: 'IMPLEMENT', tool: 'Monitor', input: { ws: 'wss://x' } },
    { phase: 'IMPLEMENT', tool: 'Write', input: { file_path: '.ewm/x' } },
    { phase: 'IMPLEMENT', tool: 'WebFetch', input: {} },
    { phase: 'IMPLEMENT', tool: 'mcp__x__y', input: {} },
    { phase: 'IMPLEMENT', tool: 'EnterWorktree', input: {} },
    { phase: 'IMPLEMENT', tool: 'Skill', input: { skill: 'ewm' } },
    { phase: 'EXPLORE', tool: 'Write', input: { file_path: '/repo/a' }, resolvedPath: '/repo/a' },
    { phase: 'PLAN', tool: 'Bash', input: { command: 'touch f' } },
    { phase: 'VALIDATE', tool: 'CronCreate', input: {} },
    { phase: 'IMPLEMENT', tool: 'Write', input: { file_path: '/repo/a' }, agentType: 'ewm:reviewer' },
    { phase: 'EXPLORE', tool: 'mcp__ewm__record_finding', input: {}, agentType: 'ewm:repo-scout' },
  ]

  it('start with "ewm: ", name the tool and the phase, and say how to proceed', () => {
    for (const sample of SAMPLE) {
      const reason = assertDenied(
        evaluate(sample.phase, sample.tool, sample.input, { profile: sample.profile, agentType: sample.agentType ?? null, resolvedPath: sample.resolvedPath }),
        sample.tool,
      )
      assert.ok(reason.includes(sample.phase) || sample.agentType !== undefined, `names the phase: ${reason}`)
      assert.match(reason, /\/ewm (pause|approve|resume)|mcp__ewm__|Return what you found|run it themselves|\/ewm/, `says how to proceed: ${reason}`)
    }
  })
})

describe('evaluateToolCall: purity', () => {
  it('works on frozen inputs and gives the same verdict twice', () => {
    const ctx = context('EXPLORE')
    const writeCall = call('Write', { file_path: '/repo/src/a.ts' }, '/repo/src/a.ts')
    assert.deepEqual(evaluateToolCall(ctx, writeCall), evaluateToolCall(ctx, writeCall))
    assert.equal(evaluateToolCall(ctx, writeCall).allow, false)
  })
})
