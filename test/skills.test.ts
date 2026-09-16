import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  importSkill,
  importSkillFile,
  importSkillPackage,
  initSkills,
  isReadOnlySkillRoot,
  isSafeSkillId,
  listSkills,
  MAX_SKILL_BYTES,
  MAX_SKILL_DIRECTORY_ENTRIES,
  readSkill,
  removeSkill,
  skillsDirectory,
  standardSkillRoots,
} from '../src/main/skills.js';
import { DIR_LINK, makeTempDir, removeTempDir } from './helpers.js';

let root: string;
let home: string;
let codexHome: string;
let oldHome: string | undefined;
let oldUserProfile: string | undefined;
let oldCodexHome: string | undefined;
let oldProgramData: string | undefined;

async function writeCodexSkill(directory: string, name: string, description = `${name} description`): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n# ${name}\n`,
    'utf8',
  );
}

beforeEach(async () => {
  oldHome = process.env.HOME;
  oldUserProfile = process.env.USERPROFILE;
  oldCodexHome = process.env.CODEX_HOME;
  oldProgramData = process.env.ProgramData;
  root = await makeTempDir('cos-skills-');
  home = path.join(root, 'home');
  codexHome = path.join(root, 'codex-home');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = codexHome;
  if (process.platform === 'win32') process.env.ProgramData = path.join(root, 'program-data');
  await initSkills(root);
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
  if (oldProgramData === undefined) delete process.env.ProgramData; else process.env.ProgramData = oldProgramData;
  await removeTempDir(root);
});

it('initializes the strict managed library and exposes it as the writable /skills root', async () => {
  expect(skillsDirectory()).toBe(path.join(root, 'skills'));
  expect(await fs.readdir(path.join(root, 'skills'))).toEqual([]);
  const library = await listSkills();
  expect(library.skills).toEqual([]);
  expect(library.errors).toEqual([]);
  expect(library.roots).toEqual([
    { name: 'skills', path: path.join(root, 'skills'), scope: 'managed', source: 'managed', managed: true, readOnly: false },
  ]);
  expect(standardSkillRoots()).toEqual([{ name: 'skills', path: path.join(root, 'skills') }]);
  expect(isReadOnlySkillRoot('skills')).toBe(false);
});

it('preserves single-file managed import compatibility while adding exact identity fields', async () => {
  const source = path.join(root, 'selected.md');
  const text = [
    '---',
    'name: "Deploy Notes"',
    'description: >-',
    '  Safe guidance for',
    '  release checks.',
    'hook: $(Write-Output should-never-run)',
    '---',
    '# Instructions',
    'Run the checks described here.',
    '',
  ].join('\n');
  await fs.writeFile(source, text, 'utf8');

  const imported = await importSkillFile(source);
  expect(imported).toMatchObject({
    id: 'deploy-notes',
    managedId: 'deploy-notes',
    command: '/deploy-notes',
    name: 'Deploy Notes',
    description: 'Safe guidance for release checks.',
    scope: 'managed',
    source: 'managed',
    managed: true,
    allowImplicitInvocation: true,
  });
  expect(imported.key).toContain('SKILL.md');

  const installed = await readSkill('deploy-notes');
  expect(installed.text).toBe(text);
  expect(installed.file).toBe(path.join(root, 'skills', 'deploy-notes', 'SKILL.md'));
  expect(installed.directory).toBe(path.join(root, 'skills', 'deploy-notes'));
});

it('accepts legacy managed plain Markdown/text and stabilizes filename fallback', async () => {
  const markdown = path.join(root, 'guide.md');
  await fs.writeFile(markdown, '# Better Guide\n\nDo this carefully.\n', 'utf8');
  expect(await importSkill(markdown)).toMatchObject({ id: 'better-guide', name: 'Better Guide', description: 'Do this carefully.' });

  const plain = path.join(root, 'My Plain Skill.txt');
  const original = 'Use this exact instruction text.\nSecond line stays here.\n';
  await fs.writeFile(plain, original, 'utf8');
  expect(await importSkillFile(plain)).toMatchObject({
    id: 'my-plain-skill',
    name: 'My Plain Skill',
    description: 'Use this exact instruction text. Second line stays here.',
  });
  const installed = await readSkill('my-plain-skill');
  expect(installed.text.endsWith(original)).toBe(true);

  const legacyId = path.join(root, 'Review.v2_Foo.md');
  await fs.writeFile(legacyId, '# Review.v2_Foo\n\nKeep legacy id normalization.\n', 'utf8');
  expect(await importSkillFile(legacyId)).toMatchObject({
    id: 'review.v2_foo',
    managedId: 'review.v2_foo',
    command: '/review.v2_foo',
  });
});

it('discovers repo ancestor, project .codex, user, legacy and bundled Codex roots', async () => {
  const repo = path.join(root, 'repo');
  const scoped = path.join(repo, 'packages', 'app');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(scoped, { recursive: true });
  await writeCodexSkill(path.join(repo, '.agents', 'skills', 'root-skill'), 'Root Skill');
  await writeCodexSkill(path.join(repo, 'packages', '.agents', 'skills', 'package-skill'), 'Package Skill');
  await writeCodexSkill(path.join(scoped, '.agents', 'skills', 'scoped-skill'), 'Scoped Skill');
  await writeCodexSkill(path.join(repo, '.codex', 'skills', 'ancestor-codex-skill'), 'Ancestor Codex Skill');
  await writeCodexSkill(path.join(scoped, '.codex', 'skills', 'project-skill'), 'Project Skill');
  await writeCodexSkill(path.join(home, '.agents', 'skills', 'user-skill'), 'User Skill');
  await writeCodexSkill(path.join(codexHome, 'skills', 'legacy-skill'), 'Legacy Skill');
  await writeCodexSkill(path.join(codexHome, 'skills', '.system', 'system-skill'), 'System Skill');

  const library = await listSkills({ projectPath: scoped });
  const byName = new Map(library.skills.map(skill => [skill.name, skill]));
  expect(byName.get('Root Skill')).toMatchObject({ source: 'repo-agents', scope: 'repo' });
  expect(byName.get('Package Skill')).toMatchObject({ source: 'repo-agents', scope: 'repo' });
  expect(byName.get('Scoped Skill')).toMatchObject({ source: 'repo-agents', scope: 'repo' });
  expect(byName.get('Project Skill')).toMatchObject({ source: 'project-codex', scope: 'repo' });
  expect(byName.get('Ancestor Codex Skill')).toBeUndefined();
  expect(byName.get('User Skill')).toMatchObject({ source: 'user-agents', scope: 'user' });
  expect(byName.get('Legacy Skill')).toMatchObject({ source: 'codex-home', scope: 'user' });
  expect(byName.get('System Skill')).toMatchObject({ source: 'bundled', scope: 'system' });
  expect(library.skills.every(skill => skill.managed === (skill.scope === 'managed'))).toBe(true);
});

it('requires Codex frontmatter externally while leaving managed legacy parsing intact', async () => {
  const bad = path.join(home, '.agents', 'skills', 'bad');
  await fs.mkdir(bad, { recursive: true });
  await fs.writeFile(path.join(bad, 'SKILL.md'), '# Plain external skill\nNo frontmatter.\n');
  const missingDescription = path.join(home, '.agents', 'skills', 'no-description');
  await fs.mkdir(missingDescription, { recursive: true });
  await fs.writeFile(path.join(missingDescription, 'SKILL.md'), '---\nname: No Description\n---\nBody\n');
  const fallback = path.join(home, '.agents', 'skills', 'folder-fallback');
  await fs.mkdir(fallback, { recursive: true });
  await fs.writeFile(path.join(fallback, 'SKILL.md'), '---\ndescription: Uses folder name\n---\nBody\n');

  const library = await listSkills();
  expect(library.errors.join('\n')).toMatch(/bad.*missing YAML frontmatter/i);
  expect(library.errors.join('\n')).toMatch(/no-description.*description/i);
  expect(library.skills.find(skill => skill.name === 'folder-fallback')).toMatchObject({ description: 'Uses folder name' });
});

it('assigns bare commands only to unique names and deterministic qualified aliases to duplicates', async () => {
  await writeCodexSkill(path.join(home, '.agents', 'skills', 'one'), 'Review');
  await writeCodexSkill(path.join(codexHome, 'skills', 'two'), 'Review');
  await writeCodexSkill(path.join(home, '.agents', 'skills', 'deploy'), 'Deploy');

  const first = await listSkills();
  const second = await listSkills();
  const firstReview = first.skills.filter(skill => skill.name === 'Review');
  const secondReview = second.skills.filter(skill => skill.name === 'Review');
  expect(first.skills.find(skill => skill.name === 'Deploy')?.command).toBe('/deploy');
  expect(firstReview).toHaveLength(2);
  expect(firstReview.every(skill => /^\/review--(?:user)-[0-9a-f]{8}$/.test(skill.command))).toBe(true);
  expect(firstReview.map(skill => skill.command)).toEqual(secondReview.map(skill => skill.command));
  expect(new Set(firstReview.map(skill => skill.command)).size).toBe(2);

  const selected = firstReview[0]!;
  expect((await readSkill(selected.key, { by: 'key' })).key).toBe(selected.key);
  expect((await readSkill(selected.command, { by: 'command' })).key).toBe(selected.key);
  expect((await readSkill(selected.command.slice(1), { by: 'command' })).key).toBe(selected.key);
});

it('follows external User/Repo skill-directory links with canonical dedupe and ignores System links', async () => {
  const repo = path.join(root, 'repo-links');
  const scoped = path.join(repo, 'app');
  const userRoot = path.join(home, '.agents', 'skills');
  const repoRoot = path.join(repo, '.agents', 'skills');
  const systemRoot = path.join(codexHome, 'skills', '.system');
  const userOutside = path.join(root, 'user-shared-skill');
  const repoOutside = path.join(root, 'repo-shared-skill');
  const systemOutside = path.join(root, 'system-shared-skill');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(scoped, { recursive: true });
  await writeCodexSkill(userOutside, 'User Linked Skill');
  await writeCodexSkill(repoOutside, 'Repo Linked Skill');
  await writeCodexSkill(systemOutside, 'System Linked Skill');
  await fs.mkdir(userRoot, { recursive: true });
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(systemRoot, { recursive: true });
  await fs.symlink(userOutside, path.join(userRoot, 'linked-user'), DIR_LINK);
  await fs.symlink(repoOutside, path.join(repoRoot, 'linked-repo'), DIR_LINK);
  await fs.symlink(systemOutside, path.join(systemRoot, 'linked-system'), DIR_LINK);
  // The external target links back to an already-seen discovery directory. Canonical dedupe must end the cycle.
  await fs.symlink(userRoot, path.join(userOutside, 'back-to-root'), DIR_LINK);

  const library = await listSkills({ projectPath: scoped });
  expect(library.skills.filter(skill => skill.name === 'User Linked Skill')).toHaveLength(1);
  expect(library.skills.find(skill => skill.name === 'User Linked Skill')).toMatchObject({ scope: 'user', source: 'user-agents' });
  expect(library.skills.filter(skill => skill.name === 'Repo Linked Skill')).toHaveLength(1);
  expect(library.skills.find(skill => skill.name === 'Repo Linked Skill')).toMatchObject({ scope: 'repo', source: 'repo-agents' });
  expect(library.skills.some(skill => skill.name === 'System Linked Skill')).toBe(false);
});

it('layers Codex skills config low-to-high and exposes effective catalog settings', async () => {
  const repo = path.join(root, 'repo-config');
  const scoped = path.join(repo, 'packages', 'app');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(scoped, { recursive: true });
  await writeCodexSkill(path.join(home, '.agents', 'skills', 'layered'), 'Layered Skill');
  const disabledByPath = path.join(scoped, '.agents', 'skills', 'path-disabled');
  await writeCodexSkill(disabledByPath, 'Path Disabled');
  await writeCodexSkill(path.join(codexHome, 'skills', '.system', 'system'), 'System Skill');

  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    '[skills]',
    'include_instructions = false',
    'max_context_tokens = 111',
    '[skills.bundled]',
    'enabled = false',
    '[[skills.config]]',
    'name = "Layered Skill"',
    'enabled = false',
  ].join('\n'));
  await fs.mkdir(path.join(repo, '.codex'), { recursive: true });
  await fs.writeFile(path.join(repo, '.codex', 'config.toml'), [
    '[skills]',
    'include_instructions = true',
    'max_context_tokens = 222',
    '[skills.bundled]',
    'enabled = true',
    '[[skills.config]]',
    'name = "Layered Skill"',
    'enabled = true',
  ].join('\n'));
  await fs.mkdir(path.join(scoped, '.codex'), { recursive: true });
  await fs.writeFile(path.join(scoped, '.codex', 'config.toml'), [
    '[skills]',
    'max_context_tokens = 333',
    '[[skills.config]]',
    'path = "../.agents/skills/path-disabled/SKILL.md"',
    'enabled = false',
    '[[skills.config]]',
    'name = "Layered Skill"',
    'path = "../.agents/skills/path-disabled/SKILL.md"',
    'enabled = false',
  ].join('\n'));

  const library = await listSkills({ projectPath: scoped });
  expect(library.includeInstructions).toBe(true);
  expect(library.maxContextTokens).toBe(333);
  expect(library.skills.some(skill => skill.name === 'Layered Skill')).toBe(true);
  expect(library.skills.some(skill => skill.name === 'Path Disabled')).toBe(false);
  expect(library.skills.some(skill => skill.name === 'System Skill')).toBe(true);
});

it('suppresses bundled skills and prevents disabled skills from resolving by key or command', async () => {
  const userSkill = path.join(home, '.agents', 'skills', 'disabled');
  await writeCodexSkill(userSkill, 'Disabled Skill');
  await writeCodexSkill(path.join(codexHome, 'skills', '.system', 'system'), 'System Skill');
  const before = await listSkills();
  const selected = before.skills.find(skill => skill.name === 'Disabled Skill')!;

  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    '[skills.bundled]',
    'enabled = false',
    '[[skills.config]]',
    'name = "Disabled Skill"',
    'enabled = false',
  ].join('\n'));

  const after = await listSkills();
  expect(after.skills.some(skill => skill.name === 'Disabled Skill')).toBe(false);
  expect(after.skills.some(skill => skill.name === 'System Skill')).toBe(false);
  expect(after.roots?.some(candidate => candidate.scope === 'system')).toBe(false);
  await expect(readSkill(selected.key, { by: 'key' })).rejects.toThrow(/not found/i);
  await expect(readSkill(selected.command, { by: 'command' })).rejects.toThrow(/not found/i);
});

it('fails open on oversized or malformed Codex config without hiding discovered skills', async () => {
  await writeCodexSkill(path.join(home, '.agents', 'skills', 'visible'), 'Visible Skill');
  await fs.writeFile(path.join(codexHome, 'config.toml'), Buffer.alloc(256 * 1024 + 1, 0x61));
  expect((await listSkills()).skills.some(skill => skill.name === 'Visible Skill')).toBe(true);
  await fs.writeFile(path.join(codexHome, 'config.toml'), '[skills]\ninclude_instructions = definitely\n[[skills.config]]\nname = "Visible Skill"\n');
  expect((await listSkills()).skills.some(skill => skill.name === 'Visible Skill')).toBe(true);
});

it('parses agents/openai.yaml interface, implicit policy and dependencies fail-open', async () => {
  const directory = path.join(home, '.agents', 'skills', 'metadata');
  await writeCodexSkill(directory, 'Metadata Skill', 'Long description');
  await fs.mkdir(path.join(directory, 'agents'), { recursive: true });
  await fs.writeFile(path.join(directory, 'agents', 'openai.yaml'), [
    'interface:',
    '  display_name: "Metadata UI"',
    '  short_description: "Short UI text"',
    '  default_prompt: "Use $metadata-skill now"',
    'dependencies:',
    '  tools:',
    '    - type: "mcp"',
    '      value: "github"',
    '      description: "GitHub tools"',
    '      transport: "streamable_http"',
    '      url: "https://example.invalid/mcp"',
    'policy:',
    '  allow_implicit_invocation: false',
  ].join('\n'));
  const skill = (await listSkills()).skills.find(candidate => candidate.name === 'Metadata Skill');
  expect(skill).toMatchObject({
    displayName: 'Metadata UI',
    shortDescription: 'Short UI text',
    defaultPrompt: 'Use $metadata-skill now',
    allowImplicitInvocation: false,
    dependencies: [{
      type: 'mcp', value: 'github', description: 'GitHub tools', transport: 'streamable_http', url: 'https://example.invalid/mcp',
    }],
  });

  await fs.writeFile(path.join(directory, 'agents', 'openai.yaml'), 'not: [valid enough to matter\n');
  expect((await listSkills()).skills.find(candidate => candidate.name === 'Metadata Skill')).toBeDefined();
});

it('exposes existing global roots as canonical read-only aliases', async () => {
  await writeCodexSkill(path.join(home, '.agents', 'skills', 'user'), 'User');
  await writeCodexSkill(path.join(codexHome, 'skills', 'legacy'), 'Legacy');
  await writeCodexSkill(path.join(codexHome, 'skills', '.system', 'system'), 'System');
  const roots = standardSkillRoots();
  expect(roots.map(root => root.name)).toEqual(['skills', 'skill-user', 'skill-codex', 'skill-system']);
  expect(roots.slice(1).every(root => isReadOnlySkillRoot(root.name))).toBe(true);
});

it('imports a whole package, materializes safe internal links, preserves resources, and rejects escaping links', async () => {
  const packageDir = path.join(root, 'package-source');
  await writeCodexSkill(packageDir, 'Package Import');
  await fs.mkdir(path.join(packageDir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(packageDir, 'references'), { recursive: true });
  await fs.writeFile(path.join(packageDir, 'scripts', 'run.py'), 'print("ok")\n');
  await fs.writeFile(path.join(packageDir, 'references', 'guide.md'), 'guide\n');
  await fs.symlink(path.join(packageDir, 'references'), path.join(packageDir, 'linked-references'), DIR_LINK);

  const imported = await importSkill(packageDir);
  expect(imported).toMatchObject({ managed: true, managedId: 'package-import', id: 'package-import' });
  const installed = path.join(root, 'skills', 'package-import');
  expect(await fs.readFile(path.join(installed, 'scripts', 'run.py'), 'utf8')).toBe('print("ok")\n');
  expect(await fs.readFile(path.join(installed, 'linked-references', 'guide.md'), 'utf8')).toBe('guide\n');
  expect((await fs.lstat(path.join(installed, 'linked-references'))).isSymbolicLink()).toBe(false);

  const escaping = path.join(root, 'escape-package');
  const outside = path.join(root, 'outside-dir');
  await writeCodexSkill(escaping, 'Escape Package');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside');
  await fs.symlink(outside, path.join(escaping, 'escape-dir'), DIR_LINK);
  await expect(importSkillPackage(escaping)).rejects.toThrow(/link escapes/i);
  await expect(fs.stat(path.join(root, 'skills', 'escape-package'))).rejects.toThrow();
});

it('refreshes managed skills from disk and refuses import collisions', async () => {
  const skillDir = path.join(root, 'skills', 'disk-skill');
  await fs.mkdir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: Disk Skill\ndescription: Fresh from disk\n---\nBody\n');
  expect((await listSkills()).skills).toContainEqual(expect.objectContaining({ id: 'disk-skill', name: 'Disk Skill', description: 'Fresh from disk' }));
  const source = path.join(root, 'Disk Skill.md');
  await fs.writeFile(source, '# Disk Skill\nreplacement');
  await expect(importSkillFile(source)).rejects.toThrow(/already exists/);
  expect(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('Fresh from disk');
});

it('reserves safe managed ids and rejects binary, invalid UTF-8 and oversized imports', async () => {
  expect(isSafeSkillId('good-skill')).toBe(true);
  expect(isSafeSkillId('prompt')).toBe(false);
  expect(isSafeSkillId('../escape')).toBe(false);
  expect(isSafeSkillId('CON')).toBe(false);

  const reserved = path.join(root, 'prompt.md');
  await fs.writeFile(reserved, '# prompt\n');
  await expect(importSkillFile(reserved)).rejects.toThrow(/safe skill id/);
  const binary = path.join(root, 'binary.md');
  await fs.writeFile(binary, Buffer.from([0x23, 0x20, 0x78, 0x0a, 0x00, 0x01]));
  await expect(importSkillFile(binary)).rejects.toThrow(/binary|control/);
  const invalidUtf8 = path.join(root, 'invalid.md');
  await fs.writeFile(invalidUtf8, Buffer.from([0x23, 0x20, 0x78, 0x0a, 0xc3, 0x28]));
  await expect(importSkillFile(invalidUtf8)).rejects.toThrow(/UTF-8/);
  const oversized = path.join(root, 'large.md');
  await fs.writeFile(oversized, Buffer.alloc(MAX_SKILL_BYTES + 1, 0x61));
  await expect(importSkillFile(oversized)).rejects.toThrow(/exceeds/);
});

it('keeps managed roots strict against linked skill directories for list/read/remove', async () => {
  const outside = path.join(root, 'outside-skill');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'SKILL.md'), '# Outside\n');
  const linked = path.join(root, 'skills', 'linked-skill');
  await fs.symlink(outside, linked, DIR_LINK);
  expect((await listSkills()).errors.join('\n')).toMatch(/linked-skill.*unsafe/i);
  await expect(readSkill('linked-skill')).rejects.toThrow(/not found|unsafe/i);
  await expect(removeSkill('linked-skill')).rejects.toThrow(/unsafe/);
  expect(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe('# Outside\n');
});

it('removes only managed SKILL.md and preserves package resources', async () => {
  const directory = path.join(root, 'skills', 'with-support');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'SKILL.md'), '# With Support\nMain text\n');
  await fs.writeFile(path.join(directory, 'notes.txt'), 'keep me');
  await removeSkill('with-support');
  await expect(fs.stat(path.join(directory, 'SKILL.md'))).rejects.toThrow();
  expect(await fs.readFile(path.join(directory, 'notes.txt'), 'utf8')).toBe('keep me');
  expect((await listSkills()).errors.join('\n')).toMatch(/with-support.*missing SKILL\.md/i);
});

it('bounds managed directory enumeration and reports unscanned entries', async () => {
  const directory = path.join(root, 'skills');
  await Promise.all(
    Array.from({ length: MAX_SKILL_DIRECTORY_ENTRIES + 1 }, (_, index) =>
      fs.mkdir(path.join(directory, `entry-${String(index).padStart(4, '0')}`)),
    ),
  );
  const library = await listSkills();
  expect(library.skills).toEqual([]);
  expect(library.errors.join('\n')).toMatch(new RegExp(`more than ${MAX_SKILL_DIRECTORY_ENTRIES} entries`));
});
