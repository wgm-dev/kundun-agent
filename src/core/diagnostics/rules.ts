// Heuristic, per-language diagnostic rules (README §16). These are SUGGESTIONS,
// not a compiler or analyzer: rules NEVER execute project code, never resolve
// imports, and operate purely on the raw source text line-by-line with regular
// expressions. They are deliberately conservative and approximate — false
// positives are tolerated, executing untrusted code is not.
//
// Every rule function is pure and total: given (content, lines) it returns a
// flat array of findings and never throws. Line numbers are 1-based to match
// editor/CLI conventions; an optional column is 1-based as well.
//
// Pure functions only — no I/O, no DB, no timestamps. The engine owns reading
// files, persistence, and timestamps.

import type { SupportedLanguage } from '../../storage/types.js';

/**
 * A single heuristic finding produced by a language rule. `source` is always
 * 'kundun-heuristic' so consumers can distinguish these from (future) real
 * analyzer output. `column` is omitted (rather than set to undefined) when a
 * rule cannot pinpoint a column — this respects exactOptionalPropertyTypes.
 */
export interface DiagnosticFinding {
  severity: 'info' | 'warning' | 'error' | 'critical';
  code: string;
  message: string;
  line: number;
  column?: number;
  source: 'kundun-heuristic';
}

/**
 * A language rule set: given the full file content and its lines (already split
 * on '\n'), return every finding. `content` is provided for the rare rule that
 * needs cross-line context; most rules only consult `lines`.
 */
export type LanguageRules = (content: string, lines: string[]) => DiagnosticFinding[];

/** Shared `source` value for every heuristic finding. */
const SOURCE = 'kundun-heuristic' as const;

/**
 * Build a finding, omitting `column` when undefined so the result satisfies
 * exactOptionalPropertyTypes (we never assign `undefined` to the optional key).
 */
function finding(
  severity: DiagnosticFinding['severity'],
  code: string,
  message: string,
  line: number,
  column?: number,
): DiagnosticFinding {
  const base: DiagnosticFinding = { severity, code, message, line, source: SOURCE };
  if (column !== undefined) {
    return { ...base, column };
  }
  return base;
}

/**
 * Strip the most common single-line comment forms so rules do not fire on code
 * that is merely mentioned in a comment. This is a heuristic: it does not handle
 * block comments or strings, which is acceptable for line-based suggestions.
 * Returns the line with a trailing `//`, `#`, or `--` comment removed.
 */
function stripLineComment(line: string, ...markers: string[]): string {
  let out = line;
  for (const marker of markers) {
    const idx = out.indexOf(marker);
    if (idx >= 0) {
      out = out.slice(0, idx);
    }
  }
  return out;
}

/** True when any line within `radius` of `index` matches `re`. */
function hasNearbyLine(lines: string[], index: number, radius: number, re: RegExp): boolean {
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length - 1, index + radius);
  for (let i = start; i <= end; i += 1) {
    const candidate = lines[i];
    if (candidate !== undefined && re.test(candidate)) {
      return true;
    }
  }
  return false;
}

// --- PHP --------------------------------------------------------------------

// SQL keyword that introduces a query string we care about concatenating into.
const PHP_SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM|INTO)\b/i;
// A PHP variable concatenated into a string with the `.` operator.
const PHP_CONCAT_VAR = /['"]\s*\.\s*\$|\$\w+\s*\.\s*['"]/;
const PHP_RAW_INPUT = /\$_(GET|POST|REQUEST|COOKIE|SERVER)\b/;
const PHP_ECHO = /\b(echo|print)\b/;
const PHP_HTMLSPECIALCHARS = /\bhtmlspecialchars\b|\bhtmlentities\b/;
const PHP_DANGEROUS_CALL = /\b(eval|exec|shell_exec|system|passthru|popen|proc_open|unlink)\s*\(/;

/**
 * PHP heuristics: SQL strings concatenated with variables (possible injection),
 * raw superglobal input usage, echo/print of dynamic data without escaping, and
 * dangerous file/exec calls.
 */
export const phpRules: LanguageRules = (_content, lines) => {
  const findings: DiagnosticFinding[] = [];

  lines.forEach((rawLine, i) => {
    const line = stripLineComment(rawLine, '//', '#');
    const lineNo = i + 1;

    // SQL query built by string concatenation with a PHP variable.
    if (PHP_SQL_KEYWORD.test(line) && PHP_CONCAT_VAR.test(line)) {
      findings.push(
        finding(
          'error',
          'php/sql-concat',
          'SQL query appears to be built by concatenating variables; use prepared statements / bound parameters instead.',
          lineNo,
        ),
      );
    }

    // Raw request input used directly.
    const rawInput = PHP_RAW_INPUT.exec(line);
    if (rawInput !== null) {
      findings.push(
        finding(
          'warning',
          'php/raw-input',
          `Raw request input (${rawInput[0]}) used directly; validate and sanitize before use.`,
          lineNo,
          rawInput.index + 1,
        ),
      );
    }

    // echo/print of dynamic content without an obvious escaping call.
    if (PHP_ECHO.test(line) && line.includes('$') && !PHP_HTMLSPECIALCHARS.test(line)) {
      findings.push(
        finding(
          'warning',
          'php/unescaped-output',
          'Output of dynamic data without htmlspecialchars/htmlentities may allow XSS.',
          lineNo,
        ),
      );
    }

    // Dangerous file/exec call. Treat calls passing a variable as more severe.
    const danger = PHP_DANGEROUS_CALL.exec(line);
    if (danger !== null) {
      const argsLooksDynamic = /\$/.test(line.slice(danger.index));
      findings.push(
        finding(
          argsLooksDynamic ? 'error' : 'warning',
          'php/dangerous-call',
          `Dangerous call (${danger[1] ?? danger[0]}); avoid passing untrusted input to it.`,
          lineNo,
          danger.index + 1,
        ),
      );
    }
  });

  return findings;
};

// --- Go ---------------------------------------------------------------------

// Approximate "ignored error" pattern: discarding a value into `_` on an
// assignment, e.g. `x, _ := f()` or `_, _ = f()`. This is a heuristic and will
// also flag intentional discards.
const GO_IGNORED_ERR = /(^|[,(]\s*)_\s*(:?=)/;
const GO_FUNC_LITERAL = /\bgo\s+func\s*\(/;

/**
 * Go heuristics: ignored errors (values discarded into `_`) and bare goroutine
 * launches via `go func(` without obvious surrounding synchronization.
 */
export const goRules: LanguageRules = (_content, lines) => {
  const findings: DiagnosticFinding[] = [];

  lines.forEach((rawLine, i) => {
    const line = stripLineComment(rawLine, '//');
    const lineNo = i + 1;

    if (GO_IGNORED_ERR.test(line)) {
      findings.push(
        finding(
          'info',
          'go/ignored-error',
          'A value is discarded into `_`; if this is an error return, consider handling it.',
          lineNo,
        ),
      );
    }

    const goFunc = GO_FUNC_LITERAL.exec(line);
    if (goFunc !== null) {
      // Warn when there is no nearby WaitGroup / context / channel hint.
      const synchronized = hasNearbyLine(
        lines,
        i,
        3,
        /\b(sync\.WaitGroup|wg\.Add|wg\.Done|context\.|ctx\b|<-|chan\b)/,
      );
      if (!synchronized) {
        findings.push(
          finding(
            'warning',
            'go/goroutine-no-sync',
            'Goroutine launched without nearby synchronization (WaitGroup/context/channel); it may leak or race.',
            lineNo,
            goFunc.index + 1,
          ),
        );
      }
    }
  });

  return findings;
};

// --- TypeScript / JavaScript ------------------------------------------------

const TS_EXPLICIT_ANY = /:\s*any\b|\bas\s+any\b/;
const TS_TS_IGNORE = /\/\/\s*@ts-ignore\b|\/\/\s*@ts-nocheck\b/;
const JS_FETCH = /\bfetch\s*\(/;
const JS_TRY = /\btry\b\s*\{/;
const JS_CATCH = /\.catch\s*\(|\bcatch\b\s*\(/;
const JS_EVAL = /\beval\s*\(/;

/**
 * Findings shared by TypeScript and JavaScript: `fetch(` without nearby
 * try/catch or `.catch`, and use of `eval(`.
 */
function jsCommonRules(lines: string[]): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];

  lines.forEach((rawLine, i) => {
    const line = stripLineComment(rawLine, '//');
    const lineNo = i + 1;

    if (JS_FETCH.test(line)) {
      const guarded =
        JS_CATCH.test(line) ||
        line.includes('await') ||
        hasNearbyLine(lines, i, 4, JS_TRY) ||
        hasNearbyLine(lines, i, 4, JS_CATCH);
      if (!guarded) {
        findings.push(
          finding(
            'info',
            'js/unhandled-fetch',
            'fetch() without nearby try/catch or .catch(); network errors may go unhandled.',
            lineNo,
          ),
        );
      }
    }

    if (JS_EVAL.test(line)) {
      findings.push(
        finding('warning', 'js/eval', 'Use of eval() is dangerous and should be avoided.', lineNo),
      );
    }
  });

  return findings;
}

/**
 * TypeScript heuristics: explicit `: any` / `as any`, `// @ts-ignore`, plus the
 * JS-common fetch/eval checks.
 */
export const typescriptRules: LanguageRules = (_content, lines) => {
  const findings: DiagnosticFinding[] = [];

  lines.forEach((rawLine, i) => {
    const line = stripLineComment(rawLine, '//');
    const lineNo = i + 1;

    if (TS_EXPLICIT_ANY.test(line)) {
      findings.push(
        finding(
          'info',
          'ts/explicit-any',
          'Explicit `any` weakens type safety; prefer a precise type or `unknown`.',
          lineNo,
        ),
      );
    }

    if (TS_TS_IGNORE.test(rawLine)) {
      findings.push(
        finding(
          'warning',
          'ts/ts-ignore',
          '@ts-ignore / @ts-nocheck suppresses type errors; fix the underlying type instead.',
          lineNo,
        ),
      );
    }
  });

  findings.push(...jsCommonRules(lines));
  return findings;
};

/**
 * JavaScript heuristics: the JS-common fetch/eval checks, plus a hint when
 * `as any` style casts leak into `.js` via JSDoc-less code is out of scope, so
 * we only run the shared checks here.
 */
export const javascriptRules: LanguageRules = (_content, lines) => {
  return jsCommonRules(lines);
};

// --- C# ---------------------------------------------------------------------

const CS_ASYNC_VOID = /\basync\s+void\b/;
const CS_RESULT = /\.Result\b/;
const CS_WAIT = /\.Wait\s*\(\s*\)/;
const CS_AWAIT = /\bawait\b/;
const CS_CANCELLATION = /CancellationToken/;

/**
 * C# heuristics: `async void` methods, blocking `.Result` / `.Wait()` (deadlock
 * risk), and `await`ed calls that pass no CancellationToken (cancellation hint).
 */
export const csharpRules: LanguageRules = (_content, lines) => {
  const findings: DiagnosticFinding[] = [];

  lines.forEach((rawLine, i) => {
    const line = stripLineComment(rawLine, '//');
    const lineNo = i + 1;

    if (CS_ASYNC_VOID.test(line)) {
      findings.push(
        finding(
          'warning',
          'cs/async-void',
          '`async void` cannot be awaited and swallows exceptions; return Task instead (except event handlers).',
          lineNo,
        ),
      );
    }

    if (CS_RESULT.test(line)) {
      findings.push(
        finding(
          'warning',
          'cs/blocking-result',
          'Blocking on `.Result` can deadlock; prefer `await`.',
          lineNo,
        ),
      );
    }

    if (CS_WAIT.test(line)) {
      findings.push(
        finding(
          'warning',
          'cs/blocking-wait',
          'Blocking on `.Wait()` can deadlock; prefer `await`.',
          lineNo,
        ),
      );
    }

    // Heuristic: an awaited call with no CancellationToken anywhere nearby.
    if (CS_AWAIT.test(line) && !CS_CANCELLATION.test(line)) {
      const tokenNearby = hasNearbyLine(lines, i, 2, CS_CANCELLATION);
      if (!tokenNearby) {
        findings.push(
          finding(
            'info',
            'cs/missing-cancellation',
            'Awaited operation has no nearby CancellationToken; consider supporting cancellation.',
            lineNo,
          ),
        );
      }
    }
  });

  return findings;
};

// --- C / C++ ----------------------------------------------------------------

const CPP_UNSAFE_FN = /\b(strcpy|strcat|sprintf|gets|scanf)\s*\(/;
const CPP_RAW_NEW = /\bnew\b\s+[A-Za-z_]/;
const CPP_RAW_DELETE = /\bdelete\b(\s*\[\s*\])?\s+[A-Za-z_]/;

/**
 * C/C++ heuristics: unsafe C string/IO functions (buffer overflow risk) and raw
 * `new` / `delete` (prefer RAII / smart pointers).
 */
export const cppRules: LanguageRules = (_content, lines) => {
  const findings: DiagnosticFinding[] = [];

  lines.forEach((rawLine, i) => {
    const line = stripLineComment(rawLine, '//');
    const lineNo = i + 1;

    const unsafe = CPP_UNSAFE_FN.exec(line);
    if (unsafe !== null) {
      findings.push(
        finding(
          'error',
          'cpp/unsafe-function',
          `Unsafe function (${unsafe[1] ?? unsafe[0]}) risks buffer overflow; use a bounded variant (e.g. strncpy/snprintf).`,
          lineNo,
          unsafe.index + 1,
        ),
      );
    }

    if (CPP_RAW_NEW.test(line)) {
      findings.push(
        finding(
          'warning',
          'cpp/raw-new',
          'Raw `new`; prefer smart pointers (std::make_unique/std::make_shared) for ownership safety.',
          lineNo,
        ),
      );
    }

    if (CPP_RAW_DELETE.test(line)) {
      findings.push(
        finding(
          'warning',
          'cpp/raw-delete',
          'Raw `delete`; prefer RAII / smart pointers to avoid leaks and double-free.',
          lineNo,
        ),
      );
    }
  });

  return findings;
};

// --- SQL --------------------------------------------------------------------

const SQL_SELECT_STAR = /\bSELECT\s+\*/i;
const SQL_UPDATE = /\bUPDATE\b/i;
const SQL_DELETE = /\bDELETE\s+FROM\b/i;
const SQL_WHERE = /\bWHERE\b/i;
const SQL_CONCAT = /\|\||['"]\s*\+\s*|\+\s*['"]/;

/**
 * SQL heuristics: `SELECT *`, single-line UPDATE/DELETE without a WHERE clause
 * (accidental full-table mutation), and dynamic SQL built by concatenation.
 */
export const sqlRules: LanguageRules = (_content, lines) => {
  const findings: DiagnosticFinding[] = [];

  lines.forEach((rawLine, i) => {
    const line = stripLineComment(rawLine, '--');
    const lineNo = i + 1;

    if (SQL_SELECT_STAR.test(line)) {
      findings.push(
        finding(
          'warning',
          'sql/select-star',
          '`SELECT *` returns every column; list the columns you need explicitly.',
          lineNo,
        ),
      );
    }

    // Single-line heuristic only: an UPDATE/DELETE that has no WHERE on the
    // same line. Multi-line statements are out of scope for line-based rules.
    if ((SQL_UPDATE.test(line) || SQL_DELETE.test(line)) && !SQL_WHERE.test(line)) {
      findings.push(
        finding(
          'warning',
          'sql/missing-where',
          'UPDATE/DELETE without a WHERE clause on this line affects every row; confirm this is intended.',
          lineNo,
        ),
      );
    }

    if (SQL_CONCAT.test(line) && /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)\b/i.test(line)) {
      findings.push(
        finding(
          'warning',
          'sql/dynamic-concat',
          'SQL appears to be built by string concatenation; use parameterized queries to avoid injection.',
          lineNo,
        ),
      );
    }
  });

  return findings;
};

/**
 * Registry of rule sets keyed by language. Languages without an entry simply
 * produce no diagnostics. Partial by design — not every supported language has
 * heuristics.
 */
export const RULES_BY_LANGUAGE: Partial<Record<SupportedLanguage, LanguageRules>> = {
  php: phpRules,
  go: goRules,
  typescript: typescriptRules,
  javascript: javascriptRules,
  csharp: csharpRules,
  cpp: cppRules,
  sql: sqlRules,
};
