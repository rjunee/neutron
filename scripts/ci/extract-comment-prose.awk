# scripts/ci/extract-comment-prose.awk
#
# Comment/prose extractor for the public leak-gate subset (Tier-2 vocabulary).
#
# WHY THIS EXISTS: the Tier-2 vocabulary gate bans multi-instance vocabulary in
# PROSE only. It scans a comment / doc-string / markdown *view* of each file —
# never identifiers or string literals — so it can flag conceptual prose while
# leaving the real code surface (field names, aliases, wire symbols) untouched.
#
# OUTPUT: `path:lineno:comment-text` records on stdout, one per source line that
# carries comment/prose text. Feed via the gate's run_grep over this view.
#
# COVERAGE by extension:
#   .md .markdown .mdx .txt            — whole file is prose
#   .ts .tsx .js .jsx .mjs .cjs        — // line comments, /* */ block comments,
#                                        leading-* JSDoc continuation lines;
#                                        `://` (URL scheme) is NOT a comment
#   .sql                               — text after `--`
#   .sh .bash .yml .yaml .toml         — text after `#` (not `#!` shebang)
#   anything else                      — skipped (code-only; out of C4-c scope)
#
# Limitations (acceptable for a leak gate): does not model strings, so a `//`
# or `/*` inside a JS string literal is treated as a comment. The `://` guard
# kills the dominant URL false-positive; anything else is allowlistable.

function ext(f,   n, a) { n = split(f, a, "."); return (n > 1) ? tolower(a[n]) : "" }

FNR == 1 { inblock = 0; e = ext(FILENAME) }

{
  line = $0
  out = ""

  if (e == "md" || e == "markdown" || e == "mdx" || e == "txt") {
    out = line
  } else if (e == "sql") {
    i = index(line, "--")
    if (i > 0) out = substr(line, i + 2)
  } else if (e == "sh" || e == "bash" || e == "yml" || e == "yaml" || e == "toml") {
    # `#` comment, but not a `#!` shebang on line 1.
    i = index(line, "#")
    if (i > 0 && !(FNR == 1 && substr(line, i, 2) == "#!")) out = substr(line, i + 1)
  } else if (e == "ts" || e == "tsx" || e == "js" || e == "jsx" || e == "mjs" || e == "cjs") {
    rest = line
    if (inblock) {
      end = index(rest, "*/")
      if (end > 0) { out = out " " substr(rest, 1, end - 1); rest = substr(rest, end + 2); inblock = 0 }
      else { out = out " " rest; rest = "" }
    }
    while (rest != "") {
      lc = find_line_comment(rest)   # index of `//` not preceded by `:`
      bc = index(rest, "/*")
      if (lc > 0 && (bc == 0 || lc < bc)) {
        out = out " " substr(rest, lc + 2); rest = ""; break
      } else if (bc > 0) {
        after = substr(rest, bc + 2)
        end = index(after, "*/")
        if (end > 0) { out = out " " substr(after, 1, end - 1); rest = substr(after, end + 2) }
        else { out = out " " after; inblock = 1; rest = "" }
      } else { rest = "" }
    }
  } else {
    out = ""
  }

  if (out ~ /[^ \t]/) printf "%s:%d:%s\n", FILENAME, FNR, out
}

# Return 1-based index of the first `//` whose preceding char is not `:`
# (so `https://` / `git://` schemes are not mistaken for line comments), else 0.
function find_line_comment(s,   pos, off, prev) {
  off = 0
  while (1) {
    pos = index(substr(s, off + 1), "//")
    if (pos == 0) return 0
    pos = pos + off            # absolute index in s
    prev = (pos > 1) ? substr(s, pos - 1, 1) : ""
    if (prev != ":") return pos
    off = pos + 1              # skip this `//` and keep searching
  }
}
