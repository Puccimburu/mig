"""
Fuzzy name-matching engine for the Hound pipeline.

Handles the full range of name format variations found in the input:
  - Comma-inverted:          "Sen, Sudipta"       → try "Sudipta Sen"
  - Comma + dept suffix:     "Chandni Gurnani, PICG" → try "Chandni Gurnani"
  - Comma + extra name part: "Lad, Niranjan Manohar" → try "Niranjan Manohar Lad"
  - Extra middle names:      "Mitika Sharad Jawharkar" → matches "Mitika Jawharkar"
  - Trailing dots/spaces:    "Amit Kumar ."
  - Double spaces:           "Amit  Chhatpar"
  - Dots in initials:        "P.K. Kedhari Sundaram"
  - Word-order swaps:        "Karthikeyan, Jeyakar" ↔ "Jeyakar Karthikeyan"

Strategy: generate several normalized candidate forms for the input name,
score every (candidate, database_name) pair with three rapidfuzz metrics,
and take the best score across all combinations.
"""

import re
from dataclasses import dataclass
from typing import Optional

from rapidfuzz import fuzz


@dataclass
class MatchResult:
    matched_name: Optional[str]    # canonical name from the database, or None
    score: float                   # best score (0–1)
    method: str                    # which scoring variant won (for the report)
    candidate_used: str            # which candidate form of the query matched best


def _normalize(name: str) -> str:
    """Lowercase, replace dots with spaces, collapse whitespace."""
    name = str(name).strip()
    name = re.sub(r'\.+', ' ', name)      # P.K. → P K
    name = re.sub(r'\s+', ' ', name)      # collapse multiple spaces
    return name.lower().strip()


def _score_pair(a: str, b: str) -> tuple[float, str]:
    """Score two already-normalized name strings.

    Uses token_sort_ratio (handles word-order swaps) and plain ratio
    (character-level similarity).  token_set_ratio is intentionally excluded:
    it scores 1.0 whenever one string's tokens are a subset of the other's,
    causing common surnames like 'syed ali' to falsely match 'arif ali syed'.
    Returns (best_score, method_label).
    """
    sort_s = fuzz.token_sort_ratio(a, b) / 100   # handles word-order swaps
    seq_s  = fuzz.ratio(a, b) / 100              # character-level similarity
    if sort_s >= seq_s:
        return sort_s, f'sort={sort_s:.2f}'
    return seq_s, f'seq={seq_s:.2f}'


def _candidates(raw: str) -> list[str]:
    """Generate all reasonable normalized forms of an input name to try.

    We never assume which comma-separated part is the "real" name -- we try
    all combinations and let the match score pick the best. This naturally
    handles both inversion ("Sen, Sudipta") and department-suffix cases
    ("Chandni Gurnani, PICG") without needing a hard-coded department list.
    """
    raw = str(raw).strip().rstrip('. ')   # strip trailing dot or space

    forms = []

    if ',' in raw:
        parts = [p.strip() for p in raw.split(',')]
        # Try every meaningful combination of the comma-delimited parts.
        before = parts[0]
        rest   = ' '.join(parts[1:]).strip()

        forms.append(before)                              # "Chandni Gurnani"
        forms.append(rest)                                # "PICG"  /  "Sudipta"
        forms.append(f'{before} {rest}')                  # "Chandni Gurnani PICG"
        forms.append(f'{rest} {before}')                  # "Sudipta Sen"  ← inversion
        # For "Lad, Niranjan Manohar" the inverted form above gives "Niranjan Manohar Lad" ✓
        # For multi-part rest like "Syed Ahmed Hassan" also join with before at end.
        if len(parts) > 2:
            # Also try just first + second part (ignore third "department" token)
            forms.append(f'{parts[1].strip()} {before}')
            forms.append(f'{before} {parts[1].strip()}')
    else:
        forms.append(raw)

    # For every form that has more than 2 tokens, also add a first+last shortcut
    # so "Mitika Sharad Jawharkar" → "Mitika Jawharkar" is tried explicitly.
    extra = []
    for f in forms:
        tokens = _normalize(f).split()
        if len(tokens) > 2:
            extra.append(f'{tokens[0]} {tokens[-1]}')
    forms.extend(extra)

    # Normalize all, deduplicate, remove empties.
    # Drop single-token candidates for multi-word inputs: a lone surname token
    # scores 1.0 via token_set_ratio against any DB entry sharing that surname,
    # causing false positives.  The correct multi-token inverted form is always
    # also present in `forms`, so nothing is lost.
    original_token_count = len(_normalize(raw).split())
    seen, out = set(), []
    for f in forms:
        n = _normalize(f)
        if not n or n in seen:
            continue
        seen.add(n)
        if len(n.split()) == 1 and original_token_count > 1:
            continue   # single-token form from a multi-word input — skip
        out.append(n)
    return out if out else [_normalize(raw)]  # fallback for degenerate inputs


class NameMatcher:
    """Pre-indexes the database names for fast repeated lookups."""

    def __init__(self, db_names: list[str]):
        # Store (original_name, normalized_name) pairs.
        self._db: list[tuple[str, str]] = []
        seen = set()
        for name in db_names:
            norm = _normalize(str(name).strip())
            if norm and norm not in seen:
                self._db.append((name.strip(), norm))
                seen.add(norm)

    def match(self, query: str) -> MatchResult:
        """Find the best matching database name for `query`."""
        if not query or not str(query).strip():
            return MatchResult(None, 0.0, 'empty-query', '')

        candidates = _candidates(query)

        best_score     = 0.0
        best_db_name   = None
        best_method    = ''
        best_candidate = ''

        for cand in candidates:
            for orig_name, norm_name in self._db:
                score, method = _score_pair(cand, norm_name)
                if score > best_score:
                    best_score     = score
                    best_db_name   = orig_name
                    best_method    = method
                    best_candidate = cand
                if score == 1.0:
                    # Perfect match -- no need to continue.
                    return MatchResult(orig_name, 1.0, method, cand)

        return MatchResult(best_db_name, best_score, best_method, best_candidate)
