# Skills

Each skill is a directory holding a `SKILL.md`, e.g. `.agents/skills/<name>/SKILL.md`. Pi discovers
them from this directory at session start; this README is not a skill.

Only two kinds of skill belong here:
- in-house: written for this workspace;
- vendored: copied from an upstream repo at a pinned commit, with the source URL and commit SHA
  recorded at the top of its `SKILL.md`.

Never install a skill by pointing at a moving branch.
