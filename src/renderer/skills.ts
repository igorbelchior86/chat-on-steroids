import { t, ui } from './i18n.js';
import { $, el, icon, run } from './dom.js';
import type { SkillLibrary, SkillSummary } from '../shared/skills.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface SkillsDraftScope {
  sessionId: string | null;
  projectId: string | null;
}

export interface SkillsRendererApi {
  skillsList: (scope: SkillsDraftScope) => Promise<Reply<SkillLibrary>>;
  skillsImport: (scope: SkillsDraftScope) => Promise<Reply<SkillLibrary | null>>;
  skillsOpenFolder: () => Promise<Reply<void>>;
  skillsRemove: (id: string, scope: SkillsDraftScope) => Promise<Reply<SkillLibrary>>;
}

export interface SkillCommandTrigger {
  lineStart: number;
  lineEnd: number;
  kind: 'prompt' | 'slash';
  query: string;
}

export interface SkillsController {
  onInput: () => void;
  onKeydown: (event: KeyboardEvent) => boolean;
  syncDraft: () => void;
  open: () => void;
  selectedCommands: (draftKey?: string) => string[];
  takeSelection: (draftKey?: string) => { commands: string[]; skills: SkillSummary[] };
  restoreSelection: (draftKey: string, skills: readonly SkillSummary[]) => void;
  forgetDraft: (draftKey: string) => void;
}

interface SkillsOptions {
  api: SkillsRendererApi;
  input: HTMLTextAreaElement;
  getDraftIdentity: () => string;
  getDraftKey: () => string;
  getScope: () => SkillsDraftScope;
}

interface DialogState {
  epoch: number;
  identity: string;
  scope: SkillsDraftScope;
  trigger: SkillCommandTrigger | null;
}

interface InlineState {
  epoch: number;
  identity: string;
  scope: SkillsDraftScope;
  trigger: SkillCommandTrigger;
  skills: SkillSummary[];
  selected: number;
  loading: boolean;
}

function lineBounds(text: string, caret: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const next = text.indexOf('\n', caret);
  return { start, end: next < 0 ? text.length : next };
}

/**
 * Slash completion is deliberately limited to the initial command block. A prose,
 * quote, fence, blank separator or other non-command line ends that block.
 */
export function skillCommandTrigger(text: string, caret: number): SkillCommandTrigger | null {
  if (caret < 0 || caret > text.length) return null;
  const { start, end } = lineBounds(text, caret);
  const beforeLine = text.slice(0, start);
  if (beforeLine) {
    const prior = beforeLine.endsWith('\n') ? beforeLine.slice(0, -1) : beforeLine;
    if (prior.split('\n').some(line => !/^\/(?:prompt(?:[ \t]+\S+)?|[^\s/]+)[ \t]*$/.test(line))) return null;
  }
  const beforeCaret = text.slice(start, caret);
  const afterCaret = text.slice(caret, end);
  if (afterCaret.trim() || !/^\/[^\s/]*$/.test(beforeCaret)) return null;
  const query = beforeCaret.slice(1);
  return { lineStart: start, lineEnd: end, kind: query === 'prompt' ? 'prompt' : 'slash', query };
}

function currentTrigger(text: string, trigger: SkillCommandTrigger): SkillCommandTrigger | null {
  if (trigger.lineStart < 0 || trigger.lineStart > text.length) return null;
  const end = text.indexOf('\n', trigger.lineStart);
  const lineEnd = end < 0 ? text.length : end;
  const line = text.slice(trigger.lineStart, lineEnd);
  if (trigger.kind === 'prompt') {
    if (line.trim() !== '/prompt') return null;
    return { ...trigger, lineEnd, query: 'prompt' };
  }
  if (!/^\/[^\s/]*$/.test(line)) return null;
  return { ...trigger, lineEnd, query: line.slice(1) };
}

function removeTriggerLine(text: string, trigger: SkillCommandTrigger | null): string {
  if (!trigger) return text;
  const current = currentTrigger(text, trigger);
  if (!current) return text;
  let end = current.lineEnd;
  if (text[end] === '\n') end++;
  return text.slice(0, current.lineStart) + text.slice(end);
}

function leadingDirectiveBlock(text: string, knownCommands: ReadonlySet<string>): { end: number; commands: Set<string> } {
  const commands = new Set<string>();
  let offset = 0;
  while (offset < text.length) {
    const next = text.indexOf('\n', offset);
    const lineEnd = next < 0 ? text.length : next;
    const line = text.slice(offset, lineEnd).replace(/\r$/, '');
    const prompt = /^\/prompt[ \t]+([^\s]+)[ \t]*$/.exec(line);
    const shorthand = /^(\/[^\s/]+)[ \t]*$/.exec(line);
    const promptToken = prompt?.[1];
    const promptCommand = promptToken ? (promptToken.startsWith('/') ? promptToken : `/${promptToken}`) : undefined;
    const command = promptCommand ?? (shorthand && knownCommands.has(shorthand[1]!) ? shorthand[1] : undefined);
    if (!command) break;
    commands.add(command);
    offset = next < 0 ? lineEnd : next + 1;
  }
  return { end: offset, commands };
}

/** Pure insertion helper used by both the full picker and inline slash completion. */
export function insertSkillCommand(
  text: string,
  command: string,
  knownCommands: Iterable<string>,
  trigger: SkillCommandTrigger | null = null
): { text: string; caret: number } {
  const known = new Set(knownCommands);
  let next = removeTriggerLine(text, trigger);
  const block = leadingDirectiveBlock(next, known);
  if (block.commands.has(command)) return { text: next, caret: block.end };
  const directive = `${command}\n`;
  if (block.end === 0) return { text: directive + next, caret: directive.length };
  const separator = next[block.end - 1] === '\n' ? '' : '\n';
  const insertion = `${separator}${directive}`;
  next = next.slice(0, block.end) + insertion + next.slice(block.end);
  return { text: next, caret: block.end + insertion.length };
}

function skillTitle(skill: SkillSummary): string {
  return skill.displayName?.trim() || skill.name;
}

function skillDescription(skill: SkillSummary): string {
  return skill.shortDescription?.trim() || skill.description;
}

function skillOrigin(skill: SkillSummary): string {
  return `${skill.scope} · ${skill.source}`;
}

function skillScopeLabel(skill: SkillSummary): string {
  if (skill.scope === 'repo') return t("Project");
  if (skill.scope === 'system') return t("System");
  if (skill.scope === 'admin') return t("Admin");
  return t("Personal");
}

function sameScope(a: SkillsDraftScope, b: SkillsDraftScope): boolean {
  return a.sessionId === b.sessionId && a.projectId === b.projectId;
}

function filtered(skills: SkillSummary[], query: string): SkillSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return skills;
  return skills.filter(skill => [
    skill.command,
    skill.name,
    skill.displayName,
    skill.description,
    skill.shortDescription,
    skill.scope,
    skill.source
  ].filter(Boolean).join('\n').toLocaleLowerCase().includes(needle));
}

export function createSkills(options: SkillsOptions): SkillsController {
  const { api, input, getDraftIdentity, getDraftKey, getScope } = options;
  const dialog = $<HTMLDialogElement>('skillsDialog');
  const search = $<HTMLInputElement>('skillsSearch');
  const list = $('skillsList');
  const status = $('skillsStatus');
  const autocomplete = $('skillAutocomplete');
  const selectedHost = $('composerSelectedSkills');
  let library: SkillLibrary | null = null;
  let libraryScopeKey: string | null = null;
  const libraryCache = new Map<string, SkillLibrary>();
  const libraryEpochs = new Map<string, number>();
  const libraryLoads = new Map<string, Promise<SkillLibrary | null>>();
  let dialogEpoch = 0;
  let inlineEpoch = 0;
  let dialogLoadFailed = false;
  let dialogState: DialogState | null = null;
  let inlineState: InlineState | null = null;
  const selectedByDraft = new Map<string, SkillSummary[]>();

  const currentScope = (): SkillsDraftScope => ({ ...getScope() });
  const scopeKey = (scope: SkillsDraftScope): string => `${scope.sessionId ?? ''}\u0000${scope.projectId ?? ''}`;
  const scopeAlive = (scope: SkillsDraftScope): boolean => sameScope(scope, currentScope());
  const alive = (state: DialogState): boolean => dialogState?.epoch === state.epoch
    && dialog.open
    && state.identity === getDraftIdentity()
    && scopeAlive(state.scope);

  const cachedLibrary = (scope: SkillsDraftScope): SkillLibrary | null => {
    const key = scopeKey(scope);
    const cached = libraryCache.get(key) ?? null;
    if (cached && scopeAlive(scope)) { library = cached; libraryScopeKey = key; }
    return cached;
  };

  const loadLibrary = (scope: SkillsDraftScope, force = false): Promise<SkillLibrary | null> => {
    const key = scopeKey(scope);
    const existingLoad = libraryLoads.get(key);
    if (existingLoad) return existingLoad;
    if (!force) {
      const cached = cachedLibrary(scope);
      if (cached) return Promise.resolve(cached);
    }
    const epoch = (libraryEpochs.get(key) ?? 0) + 1;
    libraryEpochs.set(key, epoch);
    const pendingLoad = run(api.skillsList(scope)).then(next => {
      if (libraryLoads.get(key) === pendingLoad) libraryLoads.delete(key);
      if (next && libraryEpochs.get(key) === epoch) {
        libraryCache.set(key, next);
        if (scopeAlive(scope)) { library = next; libraryScopeKey = key; }
      }
      return next;
    });
    libraryLoads.set(key, pendingLoad);
    return pendingLoad;
  };

  const dispatchInput = (): void => { input.dispatchEvent(new window.Event('input', { bubbles: true })); };

  const selectedFor = (key = getDraftKey()): SkillSummary[] => selectedByDraft.get(key) ?? [];

  const renderSelected = (): void => {
    const key = getDraftKey();
    const selected = selectedFor(key);
    selectedHost.replaceChildren();
    selectedHost.hidden = !selected.length;
    for (const skill of selected) {
      const row = el('div', 'composer-selected-skill');
      row.dataset.skillCommand = skill.command;
      row.dataset.skillKey = skill.key;
      const glyph = icon('i-skill', 'ico composer-selected-skill-icon');
      glyph.setAttribute('aria-hidden', 'true');
      const title = el('span', 'composer-selected-skill-title', skillTitle(skill));
      const remove = el('button', 'composer-selected-skill-remove') as HTMLButtonElement;
      remove.type = 'button';
      remove.append(icon('i-x', 'ico'));
      ui(remove, 'aria-label', () => t("Remove {0}", [skillTitle(skill)]));
      remove.addEventListener('click', () => {
        const current = selectedFor(key).filter(entry => entry.key !== skill.key);
        if (current.length) selectedByDraft.set(key, current); else selectedByDraft.delete(key);
        if (getDraftKey() === key) renderSelected();
        input.focus();
      });
      row.append(glyph, title, remove);
      selectedHost.append(row);
    }
  };

  const apply = (skill: SkillSummary, identity: string, scope: SkillsDraftScope, trigger: SkillCommandTrigger | null): boolean => {
    if (identity !== getDraftIdentity() || !scopeAlive(scope)) return false;
    const key = getDraftKey();
    const current = selectedFor(key);
    if (!current.some(entry => entry.key === skill.key)) selectedByDraft.set(key, [...current, skill]);
    const next = removeTriggerLine(input.value, trigger);
    input.value = next;
    const caret = Math.min(trigger?.lineStart ?? next.length, next.length);
    input.setSelectionRange(caret, caret);
    renderSelected();
    dispatchInput();
    input.focus();
    return true;
  };

  const hideInline = (): void => {
    inlineEpoch++;
    inlineState = null;
    autocomplete.hidden = true;
    autocomplete.replaceChildren();
    input.removeAttribute('aria-controls');
    input.removeAttribute('aria-activedescendant');
    input.removeAttribute('aria-expanded');
  };

  const liveInlineTrigger = (state: InlineState): SkillCommandTrigger | null => {
    if (state.identity !== getDraftIdentity() || !scopeAlive(state.scope)) return null;
    const current = skillCommandTrigger(input.value, input.selectionStart);
    return current?.kind === 'slash' && current.lineStart === state.trigger.lineStart ? current : null;
  };

  const optionId = (index: number): string => `slashAutocompleteOption-${index}`;

  const addSectionTitle = (section: HTMLElement, label: string): void => {
    section.append(el('div', 'slash-menu-section-title', label));
  };

  const addSkillRow = (section: HTMLElement, skill: SkillSummary, index: number, selected: number, state: InlineState): void => {
    const row = el('button', 'skill-autocomplete-option slash-menu-option') as HTMLButtonElement;
    row.type = 'button'; row.id = optionId(index); row.dataset.kind = 'skill'; row.dataset.skillCommand = skill.command;
    row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected));
    row.title = `${skill.command} · ${skillOrigin(skill)}`;
    const glyph = icon('i-skill', 'ico slash-menu-icon'); glyph.setAttribute('aria-hidden', 'true');
    const copy = el('span', 'slash-menu-copy');
    copy.append(el('strong', '', skillTitle(skill)), el('small', '', skillDescription(skill)));
    row.append(glyph, copy, el('span', 'slash-menu-meta', skillScopeLabel(skill)));
    row.addEventListener('pointerdown', event => event.preventDefault());
    row.addEventListener('click', () => {
      const trigger = liveInlineTrigger(state);
      if (!trigger) { hideInline(); return; }
      if (apply(skill, state.identity, state.scope, trigger)) hideInline();
    });
    section.append(row);
  };

  const renderInline = (state: InlineState): void => {
    if (inlineState?.epoch !== state.epoch || state.identity !== getDraftIdentity() || !scopeAlive(state.scope)) return;
    autocomplete.replaceChildren();
    input.setAttribute('aria-controls', 'skillAutocomplete');
    input.setAttribute('aria-expanded', 'true');
    const entries = state.skills;
    state.selected = entries.length ? Math.min(Math.max(0, state.selected), entries.length - 1) : 0;
    let optionIndex = 0;

    const skills = el('section', 'slash-menu-section');
    addSectionTitle(skills, t("Skills"));
    if (state.loading) skills.append(el('p', 'slash-menu-empty', () => t("Loading skills…")));
    else if (!state.skills.length) {
      skills.append(el('p', 'slash-menu-empty', () => library?.skills.length ? t("No skills match your search.") : t("No installed skills.")));
    } else {
      for (const skill of state.skills) addSkillRow(skills, skill, optionIndex++, state.selected, state);
    }
    autocomplete.append(skills);
    autocomplete.hidden = false;
    if (entries.length) input.setAttribute('aria-activedescendant', optionId(state.selected));
    else input.removeAttribute('aria-activedescendant');
  };

  const renderDialog = (state: DialogState): void => {
    if (!alive(state)) return;
    const skills = filtered(library?.skills ?? [], search.value);
    list.replaceChildren();
    status.textContent = '';
    if (library?.directory) ui(status, 'title', () => t("Skill directory: {0}", [library!.directory]));
    if (!library) {
      if (dialogLoadFailed) {
        const failure = el('div', 'skills-empty skills-load-error');
        const retry = el('button', 'btn', () => t("Retry")) as HTMLButtonElement;
        retry.type = 'button';
        retry.addEventListener('click', () => void loadDialog(state));
        failure.append(
          el('strong', '', () => t("Skills could not be loaded.")),
          el('span', '', () => t("Check the error above, then try again.")),
          retry
        );
        list.append(failure);
      } else list.append(el('p', 'skills-empty', () => t("Loading skills…")));
      return;
    }
    if (library.errors.length) {
      const errors = el('div', 'skills-errors'); errors.setAttribute('role', 'status');
      errors.append(el('strong', '', () => t("Some skill files could not be loaded.")));
      for (const error of library.errors) errors.append(el('div', '', error));
      list.append(errors);
    }
    if (!skills.length) {
      const empty = el('div', 'skills-empty');
      empty.append(
        el('strong', '', () => search.value.trim() ? t("No skills match your search.") : t("No skills yet.")),
        el('span', '', () => search.value.trim() ? t("Try another name or description.") : t("Import a text skill file to add one."))
      );
      list.append(empty); return;
    }
    for (const skill of skills) {
      const row = el('article', 'skill-row'); row.dataset.skillKey = skill.key; row.dataset.skillCommand = skill.command;
      const copy = el('div', 'skill-row-copy');
      const title = skillTitle(skill);
      const heading = el('div', 'skill-row-heading'); heading.append(el('strong', '', title), el('code', '', skill.command));
      copy.append(heading, el('p', '', skill.description), el('p', 'skill-row-source', skillOrigin(skill)));
      const actions = el('div', 'skill-row-actions');
      if (skill.managed && skill.managedId) {
        const remove = el('button', 'btn skill-remove', () => t("Remove")) as HTMLButtonElement;
        remove.type = 'button'; ui(remove, 'aria-label', () => t("Remove {0}", [title]));
        remove.addEventListener('click', async () => {
          const owner = dialogState;
          if (!owner || !alive(owner)) return;
          remove.disabled = true;
          const next = await run(api.skillsRemove(skill.managedId!, owner.scope));
          if (!alive(owner)) return;
          if (next) publishLibrary(next);
          if (!next) remove.disabled = false;
        });
        actions.append(remove);
      }
      const use = el('button', 'btn btn-solid skill-use', () => t("Use")) as HTMLButtonElement;
      use.type = 'button'; ui(use, 'aria-label', () => t("Use {0}", [title]));
      use.addEventListener('click', () => {
        const owner = dialogState;
        if (!owner || !alive(owner)) return;
        if (apply(skill, owner.identity, owner.scope, owner.trigger)) dialog.close();
      });
      actions.append(use); row.append(copy, actions); list.append(row);
    }
  };

  const publishLibrary = (next: SkillLibrary, scope = dialogState?.scope ?? currentScope()): void => {
    const key = scopeKey(scope);
    libraryEpochs.set(key, (libraryEpochs.get(key) ?? 0) + 1);
    libraryCache.set(key, next);
    dialogLoadFailed = false;
    if (scopeAlive(scope)) { library = next; libraryScopeKey = key; }
    const current = dialogState;
    if (current && alive(current)) renderDialog(current);
  };

  const openDialog = (trigger: SkillCommandTrigger | null = null): void => {
    hideInline();
    const state: DialogState = { epoch: ++dialogEpoch, identity: getDraftIdentity(), scope: currentScope(), trigger };
    dialogState = state;
    search.value = '';
    const cached = cachedLibrary(state.scope);
    if (!cached) { library = null; libraryScopeKey = null; }
    dialogLoadFailed = false;
    $<HTMLButtonElement>('skillsImport').disabled = false;
    $<HTMLButtonElement>('skillsOpenFolder').disabled = false;
    if (cached) renderDialog(state);
    else list.replaceChildren(el('p', 'skills-empty', () => t("Loading skills…")));
    if (!dialog.open) dialog.showModal();
    search.focus();
    void loadDialog(state);
  };

  const loadDialog = async (state: DialogState): Promise<void> => {
    if (!alive(state)) return;
    dialogLoadFailed = false;
    const cached = cachedLibrary(state.scope);
    if (!cached) { library = null; libraryScopeKey = null; renderDialog(state); }
    const next = await loadLibrary(state.scope, true);
    if (!alive(state)) { if (dialogState?.epoch === state.epoch && dialog.open) dialog.close(); return; }
    if (next) { dialogLoadFailed = false; renderDialog(state); return; }
    dialogLoadFailed = true;
    renderDialog(state);
  };

  const refreshInline = (trigger: SkillCommandTrigger): void => {
    if (dialog.open) return;
    const identity = getDraftIdentity();
    const scope = currentScope();
    const cached = cachedLibrary(scope);
    const state: InlineState = {
      epoch: ++inlineEpoch,
      identity,
      scope,
      trigger,
      skills: filtered(cached?.skills ?? [], trigger.query),
      selected: 0,
      loading: !cached
    };
    inlineState = state;
    renderInline(state);
    void loadLibrary(scope, true).then(next => {
      if (inlineState?.epoch !== state.epoch || identity !== getDraftIdentity() || !scopeAlive(scope)) return;
      if (!next) { hideInline(); return; }
      const current = skillCommandTrigger(input.value, input.selectionStart);
      if (!current || current.kind !== 'slash' || current.lineStart !== trigger.lineStart) { hideInline(); return; }
      state.trigger = current;
      state.skills = filtered(next.skills, current.query);
      state.loading = false;
      renderInline(state);
    });
  };

  const onInput = (): void => {
    if (dialog.open) return;
    const trigger = skillCommandTrigger(input.value, input.selectionStart);
    if (!trigger) { hideInline(); return; }
    if (trigger.kind === 'prompt') { openDialog(trigger); return; }
    const active = inlineState;
    if (active && !autocomplete.hidden && active.identity === getDraftIdentity() && scopeAlive(active.scope) && active.trigger.lineStart === trigger.lineStart) {
      active.trigger = trigger;
      active.selected = 0;
      if (library && libraryScopeKey === scopeKey(active.scope)) active.skills = filtered(library.skills, trigger.query);
      renderInline(active);
      return;
    }
    refreshInline(trigger);
  };

  const onKeydown = (event: KeyboardEvent): boolean => {
    if (event.isComposing) return false;
    const trigger = skillCommandTrigger(input.value, input.selectionStart);
    if (trigger?.kind === 'prompt' && ['Enter', 'Tab'].includes(event.key)) {
      event.preventDefault(); openDialog(trigger); return true;
    }
    const state = inlineState;
    if (!state || autocomplete.hidden) return false;
    if (event.key === 'Escape') { event.preventDefault(); hideInline(); return true; }
    const current = liveInlineTrigger(state);
    if (!current) { hideInline(); return false; }
    const entries = state.skills;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (entries.length) {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.selected = (state.selected + delta + entries.length) % entries.length;
        renderInline(state);
      }
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const entry = entries[state.selected];
      if (entry && apply(entry, state.identity, state.scope, current)) hideInline();
      return true;
    }
    return false;
  };

  $('composerSkills').addEventListener('click', () => openDialog());
  $('skillsClose').addEventListener('click', () => dialog.close());
  search.addEventListener('input', () => { if (dialogState) renderDialog(dialogState); });
  search.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      const first = list.querySelector<HTMLButtonElement>('.skill-use');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const uses = [...list.querySelectorAll<HTMLButtonElement>('.skill-use')];
    const current = uses.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0 || !uses.length) return;
    event.preventDefault(); uses[(current + (event.key === 'ArrowDown' ? 1 : -1) + uses.length) % uses.length]!.focus();
  });
  $('skillsImport').addEventListener('click', async () => {
    const state = dialogState; if (!state || !alive(state)) return;
    const button = $<HTMLButtonElement>('skillsImport'); button.disabled = true;
    try {
      const next = await run(api.skillsImport(state.scope));
      if (!alive(state)) return;
      if (next) publishLibrary(next);
    } finally { if (alive(state)) button.disabled = false; }
  });
  $('skillsOpenFolder').addEventListener('click', async () => {
    const state = dialogState; if (!state || !alive(state)) return;
    const button = $<HTMLButtonElement>('skillsOpenFolder'); button.disabled = true;
    try { await run(api.skillsOpenFolder()); }
    finally { if (alive(state)) button.disabled = false; }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    const state = dialogState; dialogEpoch++; dialogState = null;
    if (state?.identity === getDraftIdentity()) input.focus();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); dialog.close(); }
  });

  // Warm the current scope before the user types `/`. The first completion can then
  // paint from memory immediately while its fresh disk projection updates in background.
  void loadLibrary(currentScope());

  return {
    open: () => openDialog(),
    onInput,
    onKeydown,
    selectedCommands: (draftKey = getDraftKey()) => selectedFor(draftKey).map(skill => skill.command),
    takeSelection: (draftKey = getDraftKey()) => {
      const skills = [...selectedFor(draftKey)];
      if (skills.length) selectedByDraft.delete(draftKey);
      if (draftKey === getDraftKey()) renderSelected();
      return { commands: skills.map(skill => skill.command), skills };
    },
    restoreSelection: (draftKey, skills) => {
      if (!skills.length) return;
      const current = selectedFor(draftKey);
      const keys = new Set(current.map(skill => skill.key));
      selectedByDraft.set(draftKey, [...skills.filter(skill => !keys.has(skill.key)), ...current]);
      if (draftKey === getDraftKey()) renderSelected();
    },
    forgetDraft: (draftKey) => {
      selectedByDraft.delete(draftKey);
      if (draftKey === getDraftKey()) renderSelected();
    },
    syncDraft: () => {
      hideInline();
      renderSelected();
      const scope = currentScope();
      if (!cachedLibrary(scope)) void loadLibrary(scope);
      if (dialogState && (dialogState.identity !== getDraftIdentity() || !scopeAlive(dialogState.scope)) && dialog.open) dialog.close();
    }
  };
}
