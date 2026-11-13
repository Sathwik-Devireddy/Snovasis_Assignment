#!/usr/bin/env bash
# Verifies the kit is internally consistent. Exit 0 = OK.
set -u
cd "$(dirname "$0")/.."
fail=0
bad(){ echo "PROBLEM: $*"; fail=1; }

# 1. Backticked doc paths must exist (planned deliverables and placeholders are skipped).
while IFS= read -r ref; do
  case "$ref" in *'<'*|*'NNN'*|*'*'*|*'nn'*|*'ADR-0'*|docs/ACCEPTANCE.md|docs/AUTHZ_MATRIX.md|docs/API.md|docs/MUTATION_LOG.md|docs/schema-draft.sql) continue;; esac
  [ -e "$ref" ] || bad "missing file referenced: $ref"
done < <(grep -rhoE '`(docs|phases|agents|templates|\.claude)/[A-Za-z0-9_./-]+\.md`' --include=*.md . | tr -d '`' | sort -u)

# 2. Phases 00-15 exist.
for n in 00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15; do
  ls phases/PHASE-$n-*.md >/dev/null 2>&1 || bad "missing phase $n"
done

# 3. Frontmatter present; name matches folder/file; description present.
for f in .claude/skills/*/SKILL.md; do
  d=$(basename "$(dirname "$f")")
  head -1 "$f" | grep -q '^---$' || bad "no frontmatter: $f"
  grep -q "^name: $d\$" "$f" || bad "skill name does not match folder: $f"
  grep -q '^description: .\{20,\}' "$f" || bad "skill missing description: $f"
done
for f in .claude/agents/*.md; do
  n=$(basename "$f" .md)
  head -1 "$f" | grep -q '^---$' || bad "no frontmatter: $f"
  grep -q "^name: $n\$" "$f" || bad "agent name does not match file: $f"
  r=$(grep -oE 'agents/[0-9]+-[a-z-]+-agent\.md' "$f" | head -1)
  [ -e "$r" ] || bad "agent wrapper points to missing role file: $f -> $r"
done
for f in .claude/commands/*.md; do head -1 "$f" | grep -q '^---$' || bad "no frontmatter: $f"; done

# 4. Every skill named on a phase "Skills:" line must exist.
while IFS= read -r s; do
  [ -f ".claude/skills/$s/SKILL.md" ] || bad "phase references unknown skill: $s"
done < <(grep -h '\*\*Skills:\*\*' phases/*.md | sed 's/.*\*\*Skills:\*\* *//; s/\.$//' | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | sort -u)

# 5. Skills named in CLAUDE.md / commands must exist.
for s in $(grep -ohE '`[a-z]+(-[a-z]+)+`' CLAUDE.md .claude/commands/*.md phases/*.md | tr -d '`' | sort -u); do
  case "$s" in phase-runner|ledger-posting|idempotent-money-command|concurrency-test-writing|mutation-check|threat-register|prompts-log|clean-architecture-guard|api-doc-sync|frontend-design)
    [ -f ".claude/skills/$s/SKILL.md" ] || bad "skill referenced but missing: $s";; esac
done

# 6. Threat IDs cited in phases must exist in THREATS.md.
for t in $(grep -ohE 'T-0[0-9]{2}' phases/*.md docs/*.md | sort -u); do
  grep -q "| $t |" THREATS.md || bad "threat cited but not in THREATS.md: $t"
done

# 7. Stack consistency: no Flask/SQLAlchemy outside the review notes.
if grep -rniE 'flask application|sqlalchemy' --include=*.md . | grep -vE 'PACK_REVIEW|PROPOSED_DEFAULTS' | grep -q .; then bad "stale Flask/SQLAlchemy reference"; fi

# 8. No obvious secrets.
grep -rnE '(password|secret|token)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9+/]{16,}' . >/dev/null 2>&1 && bad "possible secret"

[ $fail -eq 0 ] && echo "kit OK" || echo "kit has problems"
exit $fail
