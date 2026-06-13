// File classification gate for the scanner walk. Decides whether a given
// relative path should be indexed, and if not, why. Combines four layers in a
// fixed order: a best-effort sensitive-file denylist, user exclude globs, the
// project .gitignore, and an optional include allowlist.
//
// All paths handled here use forward slashes and are relative to the project
// root. picomatch matchers and the ignore() instance are built ONCE per
// matcher so per-file classification stays cheap.

import pm from 'picomatch';
import ignore from 'ignore';

/**
 * Best-effort denylist of files that must never be read or indexed because
 * they commonly hold secrets, credentials, or opaque local data. Matching is
 * case-insensitive. This is a safety net, not a guarantee.
 */
export const SENSITIVE_PATTERNS: string[] = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*.keystore',
  '**/secrets/**',
  '**/*secret*',
  '**/*credential*',
  'id_rsa',
  'id_dsa',
  '**/.aws/credentials',
  '*.tfstate',
  '**/*.sqlite',
  '*.dump',
  '*.bak',
];

/** Why a path was excluded from indexing. */
export type SkipReason =
  | 'sensitive_file'
  | 'excluded'
  | 'gitignored'
  | 'binary'
  | 'too_large'
  | 'not_included';

/** Outcome of classifying a single relative path. */
export interface Classification {
  included: boolean;
  skipReason?: SkipReason;
}

export interface IgnoreMatcherOptions {
  projectRoot: string;
  include: string[];
  exclude: string[];
  gitignoreContent?: string | null;
}

export interface IgnoreMatcher {
  /** Classify a forward-slash, root-relative path. */
  classify(relPath: string): Classification;
  /** Cheap directory-level prune check for the filesystem walk. */
  isExcludedDir(relDirPath: string): boolean;
}

// picomatch options shared by every matcher: forward-slash paths, dotfiles
// included (we want to match .env, .aws, etc.), case-insensitive throughout.
const PM_OPTIONS: pm.PicomatchOptions = { dot: true, nocase: true };

/** Strip leading/trailing slashes so include/exclude entries normalize cleanly. */
function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

// Expand a single exclude/dir entry into the set of globs that should match it
// whether it names a file, a directory, or a directory anywhere in the tree.
// Example: "node_modules" expands to the bare name, "node_modules/**", and
// "**/node_modules/**". An entry that already contains glob metacharacters is
// used verbatim (assumed to be an intentional pattern, not a bare name).
function expandEntry(entry: string): string[] {
  const trimmed = trimSlashes(entry);
  if (trimmed === '') {
    return [];
  }
  // If the caller already wrote a glob, respect it as-is.
  if (/[*?[\]{}()!+@]/.test(trimmed)) {
    return [trimmed];
  }
  return [trimmed, `${trimmed}/**`, `**/${trimmed}/**`];
}

/** Build a single picomatch predicate from a list of glob patterns. */
function buildMatcher(patterns: string[]): (input: string) => boolean {
  if (patterns.length === 0) {
    return () => false;
  }
  return pm(patterns, PM_OPTIONS);
}

/**
 * Expand an include root into globs that match the root itself and anything
 * beneath it: "src" -> equals "src" OR matches "src/**". A glob include entry
 * is used verbatim.
 */
function expandIncludeRoot(entry: string): string[] {
  const trimmed = trimSlashes(entry);
  if (trimmed === '') {
    return [];
  }
  if (/[*?[\]{}()!+@]/.test(trimmed)) {
    return [trimmed];
  }
  return [trimmed, `${trimmed}/**`];
}

/**
 * Build the file-classification gate. picomatch matchers and the ignore()
 * instance are constructed here once and closed over by classify/isExcludedDir.
 */
export function createIgnoreMatcher(opts: IgnoreMatcherOptions): IgnoreMatcher {
  const sensitiveMatch = buildMatcher(SENSITIVE_PATTERNS);

  const expandedExcludes = opts.exclude.flatMap(expandEntry);
  const excludeMatch = buildMatcher(expandedExcludes);

  const expandedIncludes = opts.include.flatMap(expandIncludeRoot);
  const includeMatch = buildMatcher(expandedIncludes);
  const hasInclude = expandedIncludes.length > 0;

  // The ignore() instance is reused across calls. .gitignore semantics are
  // delegated wholesale to the `ignore` package.
  const gitignore = ignore();
  const gitignoreContent = opts.gitignoreContent;
  if (typeof gitignoreContent === 'string' && gitignoreContent.length > 0) {
    gitignore.add(gitignoreContent);
  }

  function classify(relPath: string): Classification {
    const rel = trimSlashes(relPath.replace(/\\/g, '/'));

    // 1) Sensitive denylist wins over everything else.
    if (sensitiveMatch(rel)) {
      return { included: false, skipReason: 'sensitive_file' };
    }

    // 2) User exclude globs.
    if (excludeMatch(rel)) {
      return { included: false, skipReason: 'excluded' };
    }

    // 3) .gitignore. `ignore` throws on empty/absolute paths, so guard first.
    if (rel !== '' && gitignore.ignores(rel)) {
      return { included: false, skipReason: 'gitignored' };
    }

    // 4) Include allowlist (only enforced when the caller supplied one).
    if (hasInclude && !includeMatch(rel)) {
      return { included: false, skipReason: 'not_included' };
    }

    return { included: true };
  }

  // Directory pruning during the walk: a directory is prunable if its path (or
  // any ancestor) is excluded or sensitive. We do NOT prune on gitignore here
  // because negated rules (!) can re-include nested paths; classify() handles
  // gitignore precisely at the file level.
  function isExcludedDir(relDirPath: string): boolean {
    const rel = trimSlashes(relDirPath.replace(/\\/g, '/'));
    if (rel === '') {
      return false;
    }
    return sensitiveMatch(rel) || excludeMatch(rel);
  }

  return { classify, isExcludedDir };
}
