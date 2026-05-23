---
id: skill_doc_generator
name: Doc Generator
description: Generate or update documentation for a module, function, or API based on the source code and existing comments.
risk: medium
allowedActions:
  - file_read
  - file_write
triggerTerms:
  - generate docs
  - write documentation
  - document this
  - add jsdoc
  - update readme
---

# Doc Generator Skill

Automatically produce or refresh documentation for the specified code.

## Steps

1. Identify the target:
   - If the user named a file or function, use that.
   - Otherwise, infer the most relevant target from recently changed files (`git diff --name-only HEAD`), record that choice as an assumption, and proceed.
2. Read the source file(s) in full.
3. Determine the documentation style appropriate for the language:
   - TypeScript / JavaScript → JSDoc comments + optional README section
   - Python → Google-style docstrings
   - Other → plain Markdown in a `docs/` file
4. Draft documentation covering:
   - **Purpose** — what the module/function does
   - **Parameters** — name, type, description for each
   - **Returns** — type and meaning
   - **Throws / Errors** — conditions under which errors are raised
   - **Example** — at least one usage example
5. Insert the documentation into the source file or create/update the relevant Markdown file.
6. Use the normal Harness approval flow for any write; do not ask prose follow-up questions before proposing the action.

## Constraints

- Never alter business logic — only add or update comments and documentation.
- Do not overwrite existing documentation that is more detailed than what you would produce.
- Keep JSDoc concise; avoid multi-paragraph comment blocks.
