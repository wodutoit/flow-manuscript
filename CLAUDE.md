# flow-manuscript — Project Instructions

## Scope: stay inside this folder

You are working exclusively on the **flow-manuscript** project


**Hard boundaries — do not cross:**

- Operate ONLY within the `flow-manuscript` folder and its subdirectories.
- If a task appears to require access outside this folder, STOP and ask before proceeding — do not assume it's allowed.
- Treat `flow-manuscript` as the project root. All relative paths resolve from here.

## Startup: load context automatically

At the **start of every new conversation**, before doing any requested work:

1. Read this file (`CLAUDE.md`) in full.
2. List the contents of the `.claude` folder inside this project and read every context file present there (e.g. `.md`, `.txt`, `.json`, or any notes/config files).
3. Read `README.md` in the project root if present.
4. Briefly confirm to me what context you loaded, then proceed.

Do this without being asked. I should never have to instruct you to load project context — it happens on the first turn of each chat.

## Notes

- Context files live in the `.spec/` folder. Add project background, conventions, and standing instructions there.
- If `.spec/` is empty, note that no additional context files were found and continue.
