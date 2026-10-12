"""
Match names against the CLM users list.

Scoring is Hound's (matcher.py): every candidate form of the query name
(_candidates) is scored against every user name with max(token_sort_ratio, ratio).
This version scores all users at once with rapidfuzz's cdist, and adds what a
plain best score misses:

- an email in the cell is looked up directly;
- active users win over inactive ones scoring about the same;
- a match to an inactive user, to a name several users share, or one that is
  nearly tied with a different user goes to Review instead of Matched.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from rapidfuzz import fuzz
from rapidfuzz.process import cdist

from .matcher import _candidates, _normalize

THRESHOLD_HIGH = 0.85  # Matched
THRESHOLD_MEDIUM = 0.60  # Review; below this: Not Found
ACTIVE_PREFERENCE = 0.03  # an active user this close to the best inactive one wins
TIE_MARGIN = 0.02  # a different name this close to the best one makes it ambiguous

MATCHED, REVIEW, NOT_FOUND = "Matched", "Review", "Not Found"


@dataclass
class User:
    name: str
    email: str = ""
    active: bool = True
    department: str = ""
    role: str = ""


@dataclass
class Suggestion:
    name: str
    score: float
    users: int
    active: bool


@dataclass
class NameMatch:
    query: str
    name: str | None
    score: float
    status: str
    notes: list[str] = field(default_factory=list)
    alternatives: list[Suggestion] = field(default_factory=list)
    email: str | None = None


def is_active(value: object) -> bool:
    return str(value or "").strip().lower() not in ("no", "false", "inactive", "0", "n")


class UserMatcher:
    def __init__(self, users: list[User]):
        groups: dict[str, list[User]] = {}
        for u in users:
            norm = _normalize(u.name)
            if norm:
                groups.setdefault(norm, []).append(u)
        self._norms = list(groups)
        self._groups = [groups[n] for n in self._norms]
        self._active = np.array([any(u.active for u in g) for g in self._groups], dtype=bool)
        self._by_email = {u.email.strip().lower(): u for u in users if u.email.strip()}
        self._cache: dict[str, NameMatch] = {}

    def match(self, query: object) -> NameMatch:
        text = str(query or "").strip()
        if text not in self._cache:
            self._cache[text] = self._match(text)
        return self._cache[text]

    def _display(self, i: int) -> str:
        group = self._groups[i]
        active = [u for u in group if u.active]
        return (active or group)[0].name.strip()

    def _match(self, text: str) -> NameMatch:
        if not text:
            return NameMatch(text, None, 0.0, NOT_FOUND, ["Empty cell"])
        if "@" in text and (u := self._by_email.get(text.lower())):
            status, notes = MATCHED, ["Matched by email"]
            if not u.active:
                status, notes = REVIEW, notes + ["Inactive user"]
            return NameMatch(text, u.name.strip(), 1.0, status, notes, email=u.email)
        if not self._norms:
            return NameMatch(text, None, 0.0, NOT_FOUND, ["The users list is empty"])

        cands = _candidates(text)
        sort = cdist(cands, self._norms, scorer=fuzz.token_sort_ratio, workers=-1)
        seq = cdist(cands, self._norms, scorer=fuzz.ratio, workers=-1)
        scores = np.maximum(sort, seq).max(axis=0) / 100.0  # best candidate per user name

        best = int(scores.argmax())
        best_score = float(scores[best])
        notes: list[str] = []
        if not self._active[best] and self._active.any():
            active_scores = np.where(self._active, scores, -1.0)
            alt = int(active_scores.argmax())
            if active_scores[alt] >= best_score - ACTIVE_PREFERENCE and active_scores[alt] >= THRESHOLD_MEDIUM:
                best, best_score = alt, float(active_scores[alt])

        top = np.argsort(-scores)[:4]
        alternatives = [
            Suggestion(self._display(int(i)), round(float(scores[i]), 4), len(self._groups[int(i)]), bool(self._active[int(i)]))
            for i in top
            if scores[i] >= THRESHOLD_MEDIUM
        ]

        if best_score < THRESHOLD_MEDIUM:
            return NameMatch(text, None, round(best_score, 4), NOT_FOUND, [], alternatives)

        status = MATCHED if best_score >= THRESHOLD_HIGH else REVIEW
        group = self._groups[best]
        if not self._active[best]:
            notes.append("Inactive user")
            status = REVIEW
        if len(group) > 1:
            notes.append(f"{len(group)} users have this name")
            status = REVIEW
        rival = next(
            (i for i in top if int(i) != best and scores[i] >= best_score - TIE_MARGIN), None
        )
        # An exact match beats a near one, but not another exact one ("Ali Syed" vs "Syed Ali").
        if rival is not None and (best_score < 1.0 or scores[rival] >= 1.0):
            notes.append(f'Also close to "{self._display(int(rival))}"')
            status = REVIEW
        email = group[0].email if len(group) == 1 else None
        return NameMatch(text, self._display(best), round(best_score, 4), status, notes, alternatives, email)
