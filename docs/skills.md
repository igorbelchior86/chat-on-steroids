# Skills

Skills are reusable instruction packages for ChatGPT. CoS keeps its own managed library and also discovers standard Codex skill locations.

## Add and select a skill

Open **+ → Skills** in the composer and choose **Import skill**. You can select a Markdown `.md`/`.txt` file or a complete skill package directory containing `SKILL.md`. Package imports copy supporting folders such as `scripts/`, `references/`, `assets/` and `agents/` into the managed library. An existing managed skill is never overwritten.

Choose **Use**, or type **/** at the beginning of the composer. The picker searches command, name, description, scope and source. Arrow keys plus Enter/Tab select a result; Escape closes suggestions.

```text
/code-review
Review the changes in this project.
```

Several leading command lines can select several skills. `/prompt code-review` and `/prompt /code-review` remain supported. Commands in quoted text, code blocks or later task prose are not treated as skill selectors. If two discovered skills would have the same command, CoS gives them deterministic qualified commands instead of choosing one silently.

## Discovery locations

For the current project scope CoS discovers skills from:

- `.agents/skills` from the repository root through the selected project directory
- `.codex/skills` in the selected project directory
- `~/.agents/skills`
- legacy `$CODEX_HOME/skills` (normally `~/.codex/skills`)
- `$CODEX_HOME/skills/.system`
- `/etc/codex/skills` on macOS/Linux, or `%ProgramData%\OpenAI\Codex\skills` on Windows

Discovery is recursive to a bounded depth and uses the canonical `SKILL.md` path as identity. User, Repo and Admin skill-directory links may target another location and are deduplicated/cycle-checked; System skill links are ignored. Repo discovery starts from the approved project, but an allowed skill-directory link can resolve outside it without widening the project's ordinary Core filesystem root. Standard global aliases reject structured Core file mutations; command execution keeps its existing shell semantics.

## File format and metadata

External Codex skills use `SKILL.md` with YAML frontmatter and a non-empty description. `name` can fall back to the package directory name.

```markdown
---
name: code-review
description: Review changes for correctness, regressions and missing tests.
---
Read the changed implementation and its callers. Run the smallest relevant tests.
```

Managed single-file imports retain compatibility with plain Markdown/text and can infer the name from a Markdown title or filename.

A package may include `agents/openai.yaml`. CoS reads the Codex interface fields `display_name`, `short_description`, `default_prompt`, tool dependencies and `policy.allow_implicit_invocation`. Metadata is inert: selecting a skill does not execute scripts or hooks.

## Codex skill configuration

CoS honors supported skill settings from applicable Codex `config.toml` layers: the platform admin config, user `$CODEX_HOME/config.toml`, then project `.codex/config.toml` files from the repository root through the selected project. Higher and more specific layers override earlier values.

```toml
[skills]
include_instructions = true
max_context_tokens = 10000

[skills.bundled]
enabled = true

[[skills.config]]
name = "code-review"
enabled = false

[[skills.config]]
path = "/absolute/path/to/a/SKILL.md"
enabled = true
```

Each `[[skills.config]]` entry must select exactly one skill by `name` or canonical `path`. Disabled skills are omitted from the picker and cannot be invoked. `skills.bundled.enabled = false` suppresses system/bundled skills. `skills.include_instructions = false` removes the implicit skill catalogue from the main prompt while explicit `/command` selection remains available. `skills.max_context_tokens` bounds that catalogue. Malformed or unrelated TOML does not make otherwise valid skills unusable.

## Prompt delivery

The first outgoing message contains Core instructions and, when enabled, a bounded implicit skill index, then complete explicitly selected skill instructions, optional project `AGENTS.md`, and your message. A selected follow-up adds its skill instructions without repeating the main setup. Prepared delivery text is retained for retries, so later edits cannot change a message already prepared for delivery.

The complete message remains within the 96,000 UTF-16-character limit and the transport UTF-8 byte limit. `AGENTS.md` is shortened first. Explicit skill bodies and user text are never silently cut; an explicit selection that cannot fit produces an error.

## Managed library and safety

The managed folder is `<CoS user data>/skills/<id>/`. **Open skill directory** opens that location. Managed `SKILL.md` files remain bounded UTF-8 text, and package import is bounded by entry count and total bytes. Binary skill text, unsafe names and escaping package links are rejected.

The model can install user-requested content into the managed skill root using existing Core file tools. Standard global Codex aliases reject structured Core file mutations; the existing command permission remains shell-equivalent. Skills do not add MCP tools, enable plugins, grant permissions or automatically run `scripts/`; required tools must already be available.

**Remove** is offered only for managed skills. It removes the managed `SKILL.md` and removes the directory only when empty; unrelated supporting files remain. External discovered skills are managed at their source location, not deleted by CoS.
