"""
Fail-closed Peach Payments result code mapper.
Based on verified skill reference patterns (references/result-codes.md, scripts/map-result-code.js).

Rules:
- ANY whitespace (leading/trailing/embedded, incl. "\\n") -> error.
- 000.400.101 and 000.400.102 are intermediate 3DS-step codes, NOT success.
- 000.100.2xx is the chargeback/reversal family, NOT success.
- Unknown codes fail closed to "error".
- Missing/empty code is treated as "pending" (session open).
"""

import re

SUCCESS = re.compile(r"^(000\.000\.|000\.100\.1|000\.[36])")
SUCCESS_REVIEW = re.compile(r"^(000\.400\.0[0-24-9]|000\.400\.100|000\.400\.1[12]0)")
PENDING = re.compile(r"^(000\.200)")
PENDING_EXT = re.compile(r"^(800\.400\.5|100\.400\.500)")
REQUIRES_MORE = re.compile(r"^(300\.100\.100|900\.100\.[34])")
CANCELLED = re.compile(r"^(100\.396\.101|100\.396\.104)")
CODE_SHAPE = re.compile(r"^\d{3}\.\d{3}\.\d{3}$")
WHITESPACE = re.compile(r"\s")


def map_result_code(raw: str | None) -> str:
    """
    Maps a raw Peach result code string to a status category.
    Returns: "captured" | "review" | "pending" | "requires_more" | "canceled" | "error"
    """
    if raw is None or raw == "":
        return "pending"
    code = str(raw)
    if WHITESPACE.search(code) or not CODE_SHAPE.match(code):
        return "error"
    if SUCCESS.match(code):
        return "captured"
    if SUCCESS_REVIEW.match(code):
        return "review"
    if PENDING.match(code) or PENDING_EXT.match(code):
        return "pending"
    if REQUIRES_MORE.match(code):
        return "requires_more"
    if CANCELLED.match(code):
        return "canceled"
    return "error"


def is_success_result_code(raw: str | None) -> bool:
    """Convenience helper to determine if a code represents captured payment."""
    return map_result_code(raw) == "captured"
